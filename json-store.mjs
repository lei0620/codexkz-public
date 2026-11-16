import fs from 'node:fs';
import path from 'node:path';
import {backupExistingState,writeAtomicJson} from './storage.mjs';

export function storageError(cause,reading=false){
  if(cause.code==='COMMIT_UNKNOWN')return cause;
  const error=new Error('存储'+(reading?'读取':'提交')+'失败：'+cause.message,{cause});
  error.code=cause instanceof SyntaxError?'CORRUPT':cause.code==='ENOSPC'?'DISK_FULL':'IO_ERROR';
  return error;
}

// Only this adapter knows the panel state filename. Attachments/receipts are
// separate file resources; their metadata is committed through StateStore.
export class JsonBackend{
  #root; #file; #io; #backup; #original; #diskText=null;
  constructor(root,io={},backup=backupExistingState){this.#root=root;this.#file=path.join(root,'data','state.json');this.#io=io;this.#backup=backup;}
  read(){
    let text;
    try{text=(this.#io.read??fs.readFileSync)(this.#file,'utf8');}
    catch(error){if(error.code==='ENOENT')return null;throw storageError(error,true);}
    try{
      this.#diskText=text;this.#original=JSON.parse(text);
      if(this.#original===null)throw new SyntaxError('状态根节点不能为null');
      return structuredClone(this.#original);
    }
    catch(error){throw storageError(error,true);}
  }
  write(value){
    try{
      if(this.#original&&(this.#original.schemaVersion!==value.schemaVersion||!this.#original.workspace)){
        this.#backup(this.#root,this.#file);
        // Keep the guard until commit succeeds; failed writes never publish.
      }
      const write=(file,text)=>{
        const fd=fs.openSync(file,'w');
        try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      };
      writeAtomicJson(this.#file,value,{write:this.#io.write??write,...(this.#io.rename?{rename:this.#io.rename}:{})});
      this.#diskText=JSON.stringify(value,null,2);this.#original=null;
    }catch(error){
      let current=null;
      try{current=fs.readFileSync(this.#file,'utf8');}catch(readError){if(readError.code!=='ENOENT')throw Object.assign(new Error('无法确认存储提交结果，请停止写入并核对原记录',{cause:error}),{code:'COMMIT_UNKNOWN'});}
      if(current!==this.#diskText)throw Object.assign(new Error('存储提交结果未确认，请停止写入并核对原记录',{cause:error}),{code:'COMMIT_UNKNOWN'});
      throw storageError(error);
    }
  }
  backup(backup){return backup(this.#file);}
}
