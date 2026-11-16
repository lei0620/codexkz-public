import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseSource} from './json-safe.mjs';

// Machine-specific backup locations live only in local data, never in a release.
export const requiresExplicitBackup=source=>/^(?:\\\\\?\\)?c:[\\/]/i.test(String(source));
export function validateBackupRoot(root,input){
  if(typeof input!=='string'||!path.isAbsolute(input)||/^(?:e:|\\\\)/i.test(input))throw Error('备份位置必须是已授权的本机绝对目录');
  const target=path.resolve(input),data=path.resolve(root,'data'),relative=path.relative(data,target);
  if(target===path.parse(target).root)throw Error('备份目录不能是磁盘根目录');
  if(!relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw Error('备份位置不能放在运行数据目录内');
  const disk=path.parse(target).root;let current=disk;
  for(const part of path.relative(disk,target).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    try{const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('备份目录包含重定向或非目录');}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return target;
}
function parseBackupRoot(root,bytes){
  const value=parseSource(bytes);
  if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='backupRoot,version'||value.version!==1)throw Error('本机备份配置无效');
  return validateBackupRoot(root,value.backupRoot);
}
export function configuredBackupRoot(root){
  const file=path.join(root,'data','backup-paths.json');let stat;
  try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error('本机备份配置无效');
  return parseBackupRoot(root,fs.readFileSync(file));
}
export function validateMaintenancePolicy(root,value){
  const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
  if(value?.version!==1||!value.retention||Object.keys(value.retention).length!==3||!['history','backups','tombstones'].every(key=>value.retention[key]==='all')||value.schedule?.mode!=='manual'||value.schedule.enabled!==false)fail('POLICY_MISMATCH','当前已确认策略仅为全部保留、手动备份，不启用定时或删除');
  let backupRoot;try{backupRoot=validateBackupRoot(root,value.backupRoot);}catch(error){fail('UNSAFE_PATH',error.message);}
  const relative=path.relative(backupRoot,path.resolve(root));
  if(!relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))fail('UNSAFE_PATH','备份位置不能包含源项目');
  return {version:1,backupRoot,retention:{history:'all',backups:'all',tombstones:'all'},schedule:{mode:'manual',enabled:false}};
}
export function readMaintenancePolicy(root){
  const file=path.join(root,'data','maintenance-config.json');let stat;
  try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')throw Object.assign(Error('请先配置本机备份位置与全部保留、手动备份策略'),{code:'POLICY_REQUIRED'});throw error;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Object.assign(Error('维护配置无效'),{code:'UNSAFE_PATH'});
  return validateMaintenancePolicy(root,parseSource(fs.readFileSync(file)));
}
export function localBackupStamp(now=new Date()){
  const number=value=>String(value).padStart(2,'0');
  return `${now.getFullYear()}-${number(now.getMonth()+1)}-${number(now.getDate())}_${number(now.getHours())}${number(now.getMinutes())}`;
}
export function configureBackupRoot(root,input,{backup}={}){
  const backupRoot=validateBackupRoot(root,input),file=path.join(root,'data','backup-paths.json');
  const previous=configuredBackupRoot(root);
  if(previous===backupRoot)return {backupRoot,changed:false};
  let original;try{original=fs.readFileSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  if((previous===null)!==(original===undefined))throw Error('备份配置已变化，未覆盖');
  if(original&&parseBackupRoot(root,original)!==previous)throw Error('备份配置已变化，未覆盖');
  if(original&&requiresExplicitBackup(file)){
    if(typeof backup!=='function')throw Error('修改备份配置前必须备份原文件');
    backup(file,backupRoot);
    if(!fs.readFileSync(file).equals(original))throw Error('备份配置已变化，未覆盖');
  }
  const temporary=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temporary,'wx');
  try{fs.writeFileSync(fd,JSON.stringify({version:1,backupRoot},null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(original){if(!fs.readFileSync(file).equals(original))throw Error('备份配置已变化，未覆盖');fs.renameSync(temporary,file);}
  else{fs.linkSync(temporary,file);fs.unlinkSync(temporary);}
  return {backupRoot,changed:true};
}
