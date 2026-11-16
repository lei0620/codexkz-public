import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256,migrationError} from './migration-model.mjs';
import {writeFresh} from './migration-files.mjs';
import {configuredBackupRoot,requiresExplicitBackup,validateMaintenancePolicy,readMaintenancePolicy} from './backup-roots.mjs';
import {backupRestartState} from './restart.mjs';

export const policyName='maintenance-config.json';
export const retainedPolicy=()=>({version:1,retention:{history:'all',backups:'all',tombstones:'all'},schedule:{mode:'manual',enabled:false}});
export function safeLocalPath(input,{missing=false,directory=false}={}){
  if(typeof input!=='string'||!input||/^(?:e:|\\\\)/i.test(input))throw migrationError('UNSAFE_PATH','只允许获准本机路径，禁止E盘和网络路径');
  const absolute=path.resolve(input),root=path.parse(absolute).root;let current=root;
  for(const part of path.relative(root,absolute).split(path.sep).filter(Boolean)){
    current=path.join(current,part);let stat;try{stat=fs.lstatSync(current);}catch(error){if(error.code==='ENOENT'&&missing)continue;throw error;}
    if(stat.isSymbolicLink())throw migrationError('UNSAFE_PATH','路径不能经过符号链接或目录重定向');
    if(current!==absolute&&!stat.isDirectory())throw migrationError('UNSAFE_PATH','路径父级不是目录');
    if(current===absolute&&(directory?!stat.isDirectory():!stat.isDirectory()&&!stat.isFile()))throw migrationError('UNSAFE_PATH','路径类型无效');
  }
  return absolute;
}
export function within(parent,child){const relative=path.relative(parent,child);return !relative||!relative.startsWith('..')&&!path.isAbsolute(relative);}
export function sourceRoot(input){const root=safeLocalPath(input,{directory:true});safeLocalPath(path.join(root,'data'),{directory:true});return root;}
export function validatePolicy(value,root){
  return validateMaintenancePolicy(root,value);
}
export function readPolicy(root){
  root=sourceRoot(root);return readMaintenancePolicy(root);
}
export function configurePolicy(root,backupRoot){
  root=sourceRoot(root);const policy=validatePolicy({...retainedPolicy(),backupRoot},root),file=path.join(root,'data',policyName),bytes=Buffer.from(JSON.stringify(policy,null,2)+'\n');
  if(fs.existsSync(file)){
    safeLocalPath(file);const original=fs.readFileSync(file);if(original.equals(bytes))return {policy,changed:false};
    if(requiresExplicitBackup(file)){
      const target=backupRestartState(file,configuredBackupRoot(root)??backupRoot,'修改维护配置');
      if(sha256(fs.readFileSync(target))!==sha256(original))throw migrationError('BACKUP_FAILED','C盘配置备份校验失败');
    }
  }
  const temporary=file+'.'+randomUUID()+'.tmp';writeFresh(temporary,bytes);fs.renameSync(temporary,file);return {policy,changed:true};
}
