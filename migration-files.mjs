import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {attachmentPath} from './attachments.mjs';
import {sha256,migrationError} from './migration-model.mjs';

const base=path.join(path.dirname(fileURLToPath(import.meta.url)),'.panel-test');
export const sourceLimit=64*1024*1024;
export function migrationRoot(root,{missing=false}={}){
  const parent=fs.realpathSync.native(base),absolute=path.resolve(root);
  const real=missing&&!fs.existsSync(absolute)?path.join(fs.realpathSync.native(path.dirname(absolute)),path.basename(absolute)):fs.realpathSync.native(absolute);
  const relative=path.relative(parent,real);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw migrationError('ISOLATION_REQUIRED','R42只允许项目.panel-test内的合成目录');
  if(!missing||fs.existsSync(real)){
    const marker=path.join(real,'.r42-synthetic');if(!fs.existsSync(marker)||fs.lstatSync(marker).isSymbolicLink()||fs.readFileSync(marker,'utf8')!=='migration-isolated-v1')throw migrationError('ISOLATION_REQUIRED','缺少R42合成目录标记');
    const data=path.join(real,'data');if(!fs.existsSync(data)||fs.lstatSync(data).isSymbolicLink()||fs.realpathSync.native(data)!==data)throw migrationError('UNSAFE_PATH','data缺失或被重定向');
  }
  return real;
}
export function separateRoots(source,target){
  const contains=(a,b)=>{const relative=path.relative(a,b);return relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
  if(contains(source,target)||contains(target,source))throw migrationError('TARGET_CONFLICT','来源与输出目录必须彼此独立，不能覆盖或嵌套');
}
export function managedPath(root,relative,{missing=false}={}){
  const parts=relative.split(/[\\/]/);if(parts.some(p=>!p||p==='.'||p==='..'||p.includes(':')))throw migrationError('UNSAFE_PATH','文件相对路径无效');
  let current=path.join(root,'data');
  for(const [i,part] of parts.entries()){
    current=path.join(current,part);
    let stat;try{stat=fs.lstatSync(current);}catch(error){if(missing&&error.code==='ENOENT')continue;throw error;}
    if(stat.isSymbolicLink()||i<parts.length-1&&!stat.isDirectory())throw migrationError('UNSAFE_PATH','受管文件路径被重定向：'+relative);
    if(i===parts.length-1&&!stat.isFile())throw migrationError('UNSAFE_PATH','受管路径不是普通文件：'+relative);
  }
  return current;
}
export function fileRecord(root,relative,kind){
  const file=managedPath(root,relative),stat=fs.statSync(file);
  const limit=kind==='database'?1024*1024*1024:sourceLimit;
  if(stat.size>limit)throw migrationError('LIMIT_EXCEEDED','受管文件超过校验上限：'+relative);
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024),fd=fs.openSync(file,'r');
  try{let total=0;for(;;){const count=fs.readSync(fd,buffer,0,buffer.length,null);if(!count)break;total+=count;if(total>limit)throw migrationError('LIMIT_EXCEEDED','文件增长超过校验上限');hash.update(buffer.subarray(0,count));}if(total!==stat.size)throw migrationError('FILE_MISMATCH','文件在校验期间变化');}finally{fs.closeSync(fd);}
  return {relative:relative.replaceAll('\\','/'),kind,size:stat.size,sha256:hash.digest('hex')};
}
function listFiles(root,directory){
  const start=path.join(root,'data',directory),result=[];if(!fs.existsSync(start))return result;
  function walk(folder){
    if(fs.lstatSync(folder).isSymbolicLink())throw migrationError('UNSAFE_PATH','受管目录被重定向');
    for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
      const full=path.join(folder,entry.name);if(entry.isSymbolicLink())throw migrationError('UNSAFE_PATH','受管目录包含链接');
      if(entry.isDirectory())walk(full);else if(entry.isFile())result.push(path.relative(path.join(root,'data'),full).replaceAll('\\','/'));else throw migrationError('UNSAFE_PATH','受管目录包含非常规文件');
      if(result.length>20000)throw migrationError('LIMIT_EXCEEDED','受管文件超过20000项');
    }
  }
  walk(start);return result;
}
export function inspectFiles(root,state){
  const files=[],errors=[],add=(code,location,message)=>errors.push({code,path:location,message}),metadata=state.attachments??{},expected=new Set();
  const key=value=>process.platform==='win32'?value.toLowerCase():value;
  for(const [id,file] of Object.entries(metadata)){
    try{
      if(!file||file.id!==id||!file.projectId||!Number.isSafeInteger(file.size)||file.size<0||!/^[a-f0-9]{64}$/.test(file.sha256??''))throw Error('附件元数据不完整或ID不匹配');
      const relative=path.relative(path.join(root,'data'),attachmentPath(root,file)).replaceAll('\\','/');expected.add(key(relative));
      const record=fileRecord(root,relative,'attachment');if(record.size!==file.size||record.sha256!==file.sha256)throw Error('附件字节/哈希与元数据不一致');files.push(record);
    }catch(error){add(error.code==='ENOENT'?'MISSING_ATTACHMENT':'INVALID_ATTACHMENT','attachments.'+id,error.message);}
  }
  for(const [name,rows] of [['tasks',state.tasks??[]],['jobs',state.jobs??[]]])for(const owner of rows){
    if(owner.attachments!=null&&!Array.isArray(owner.attachments)){add('INVALID_ATTACHMENT',name+'.'+owner.id+'.attachments','附件快照应为数组');continue;}
    for(const file of owner.attachments??[]){const stored=metadata[file?.id];
      if(!stored)add('ORPHAN_ATTACHMENT_REFERENCE',name+'.'+owner.id+'.attachments','附件快照缺少元数据');
      else if(['projectId','name','size','sha256'].some(key=>file[key]!==stored[key])||stored.projectId!==owner.projectId)add('ATTACHMENT_SNAPSHOT_MISMATCH',name+'.'+owner.id+'.attachments','快照与本机文件元数据不一致');
    }
  }
  try{for(const relative of listFiles(root,'attachments'))if(!expected.has(key(relative)))add('ORPHAN_ATTACHMENT',relative,'文件未在附件元数据中登记，未删除或跳过');}catch(error){add(error.code??'FILE_ERROR','attachments',error.message);}
  for(const [folder,requests] of [['plan-intake',state.planIntakes??[]],['version-intake',state.versionIntakes??[]]]){
    try{for(const relative of listFiles(root,folder)){
      const id=path.basename(relative,'.json');
      if(!relative.endsWith('.json')||!requests.some(r=>r.id===id)){add('ORPHAN_RECEIPT',relative,'回执文件没有对应请求，未删除或跳过');continue;}
      const record=fileRecord(root,relative,'receipt');try{JSON.parse(fs.readFileSync(managedPath(root,relative),'utf8').replace(/^\uFEFF/,''));}catch{add('CORRUPT_RECEIPT',relative,'回执尚未写完或已损坏');continue;}files.push(record);
    }}catch(error){add(error.code??'FILE_ERROR',folder,error.message);}
  }
  if(fs.existsSync(path.join(root,'data','state.json.tmp')))add('UNCOMMITTED_STATE_FILE','state.json.tmp','存在未提交临时状态，请先核对，未自动采用或清除');
  if(fs.existsSync(path.join(root,'data','sqlite-command-ledger.json')))try{files.push(fileRecord(root,'sqlite-command-ledger.json','ledger'));}catch(error){add('INVALID_LEDGER','sqlite-command-ledger.json',error.message);}
  return {files:files.sort((a,b)=>a.relative.localeCompare(b.relative)),errors};
}
export function writeFresh(file,bytes){
  fs.mkdirSync(path.dirname(file),{recursive:true});const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export const writeFreshJson=(file,value)=>writeFresh(file,JSON.stringify(value,null,2)+'\n');
export function copyFiles(source,target,files){
  for(const record of files){
    const from=managedPath(source,record.relative),to=managedPath(target,record.relative,{missing:true});
    fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);
    const fd=fs.openSync(to,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const copied=fileRecord(target,record.relative,record.kind);if(copied.sha256!==record.sha256||copied.size!==record.size)throw migrationError('COPY_MISMATCH','文件复制校验失败：'+record.relative);
  }
}
export function createBundle(root){
  fs.mkdirSync(root);fs.mkdirSync(path.join(root,'data'));writeFresh(path.join(root,'.r42-synthetic'),'migration-isolated-v1');writeFresh(path.join(root,'.r41-synthetic'),'sqlite-isolated-v1');
}
