import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// This store is only for non-sensitive, signed update metadata. The service's
// existing data lock owns the directory for the lifetime of this store.
export function releaseCheckStore(dataRoot){
  const file=path.join(dataRoot,'data','release-check.json');
  async function checkFile(){
    try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024)throw Error('更新记录不是可验证的普通文件');return true;}
    catch(error){if(error.code==='ENOENT')return false;throw error;}
  }
  return {
    async read(){if(!await checkFile())return null;const bytes=await fs.readFile(file);if(bytes.length>128*1024)throw Error('更新记录过大');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));},
    async write(value){
      const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>128*1024)throw Error('更新记录过大');
      await checkFile();const temporary=file+'.'+randomUUID()+'.tmp';let handle;
      try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await checkFile();await fs.rename(temporary,file);}
      finally{await handle?.close();}
    }
  };
}
