import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

export const MAX_FILE=10*1024*1024;
export function attachmentFields(state,projectId,ids=[]){
  if(!Array.isArray(ids)||ids.length>8||new Set(ids).size!==ids.length)throw Error('每个任务最多 8 个附件，不能重复');
  const files=ids.map(id=>{const file=state.attachments?.[id];if(!file||file.projectId!==projectId)throw Error('附件不存在或不属于本项目');return file;});
  if(files.reduce((n,f)=>n+f.size,0)>40*1024*1024)throw Error('任务附件总大小不能超过 40 MB');
  return files.map(f=>({...f}));
}
export function saveAttachment(root,input,projects){
  if(!projects.some(p=>p.projectId===input.projectId))throw Error('项目不存在');
  if(typeof input.name!=='string'||!input.name.trim()||input.name.length>180||/[\\/\x00-\x1f<>:"|?*]/.test(input.name)||/[. ]$/.test(input.name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(input.name))throw Error('附件文件名无效');
  if(typeof input.base64!=='string'||input.base64.length>Math.ceil(MAX_FILE/3)*4||input.base64.length%4!==0||! /^[A-Za-z0-9+/]*={0,2}$/.test(input.base64))throw Error('附件内容无效或超过 10 MB');
  const bytes=Buffer.from(input.base64,'base64');if(bytes.length>MAX_FILE)throw Error('单个附件不能超过 10 MB');
  let type='application/octet-stream';
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))type='image/png';
  else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)type='image/jpeg';
  else if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()))type='image/gif';
  else if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')type='image/webp';
  const id=randomUUID(),directory=path.join(root,'data','attachments',id);
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,input.name),bytes,{flag:'wx'});
  return {id,projectId:input.projectId,name:input.name,size:bytes.length,type,sha256:createHash('sha256').update(bytes).digest('hex'),createdAt:new Date().toISOString()};
}
export function attachmentPath(root,file){
  if(!/^[a-f0-9-]{36}$/.test(file.id)||path.basename(file.name)!==file.name||/[\\/]/.test(file.name))throw Error('附件路径无效');
  return path.join(root,'data','attachments',file.id,file.name);
}
export function readAttachment(root,file){
  const bytes=fs.readFileSync(attachmentPath(root,file));
  if(bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('附件缺失或校验失败，请重新添加');
  return bytes;
}
export function attachmentPrompt(root,files){
  for(const file of files)readAttachment(root,file);
  return files.length?'\n\n附件（参考）：\n'+files.map(f=>'['+f.name.replace(/[\\\[\]]/g,'\\$&')+'](<'+attachmentPath(root,f).replaceAll('\\','/')+'>)').join('\n'):'';
}
