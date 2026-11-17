import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {safeLocalPath} from './maintenance-policy.mjs';
import {separateRoots,writeFresh} from './migration-files.mjs';
import {backupRestartState} from './restart.mjs';
import {requiresExplicitBackup,validateBackupRoot} from './backup-roots.mjs';

export function installedDataRoot(installRoot,dataRoot,{missing=false}={}){
  if(!path.isAbsolute(installRoot??'')||!path.isAbsolute(dataRoot??''))throw Error('安装和数据目录必须是本机绝对路径');
  const install=safeLocalPath(installRoot,{directory:true});
  const data=safeLocalPath(dataRoot,{missing,directory:true});
  if(path.relative(path.join(install,'userdata'),data))separateRoots(install,data);
  return data;
}

export function installedBackupRoot(installRoot,dataRoot,input){
  const backup=validateBackupRoot(dataRoot,input);
  separateRoots(dataRoot,backup);
  if(path.relative(path.join(installRoot,'backups'),backup))separateRoots(installRoot,backup);
  return backup;
}

function dataSettings(installRoot){return path.join(installRoot,'paiban-data.json');}

export function readInstalledDataRoot(installRoot,fallback){
  const file=dataSettings(installRoot);
  let stat;
  try{stat=fs.lstatSync(file);}catch(error){
    if(error.code!=='ENOENT')throw error;
    return installedDataRoot(installRoot,fallback||path.join(installRoot,'userdata'));
  }
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error('派板数据位置配置无效');
  const config=JSON.parse(fs.readFileSync(file,'utf8'));
  if(config?.version!==1||typeof config.dataRoot!=='string')throw Error('派板数据位置配置无效');
  return installedDataRoot(installRoot,config.dataRoot);
}

export function saveInstalledDataRoot(installRoot,dataRoot,backupRoot){
  dataRoot=installedDataRoot(installRoot,dataRoot);
  const file=dataSettings(installRoot),original=fs.existsSync(file);
  if(original){
    readInstalledDataRoot(installRoot);
    if(requiresExplicitBackup(file))backupRestartState(file,backupRoot,'修改派板数据位置');
  }
  const next=file+'.'+randomUUID()+'.tmp';
  writeFresh(next,JSON.stringify({version:1,dataRoot},null,2)+'\n');
  fs.renameSync(next,file);
}
