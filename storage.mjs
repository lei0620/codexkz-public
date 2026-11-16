import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {localBackupStamp,requiresExplicitBackup} from './backup-roots.mjs';

export function writeAtomicJson(file,value,{write=fs.writeFileSync,rename=fs.renameSync,pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)}={}){
  const retry=operation=>{const delays=[10,30,80,160,320];for(let attempt=0;;attempt++){try{return operation();}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=delays.length)throw error;pause(delays[attempt]);}}};
  const text=JSON.stringify(value,null,2);retry(()=>write(file+'.tmp',text));retry(()=>rename(file+'.tmp',file));
}

export function stateBackupPath(root,source,stamp,backupRoot){
  if(!/^[a-zA-Z0-9_-]+$/.test(stamp))throw new Error('备份时间标识无效');
  if(backupRoot){
    if(!path.isAbsolute(backupRoot))throw Error('备份目录必须为绝对路径');
    const disk=path.parse(path.resolve(source)).root;
    return path.join(backupRoot,stamp+'_看板数据升级',disk.replace(/[^a-zA-Z0-9]/g,'')||'root',path.relative(disk,path.resolve(source)));
  }
  if(requiresExplicitBackup(source))throw Error('请先配置本机备份目录');
  return path.join(root,'备份',stamp+'_看板数据升级',path.basename(source));
}
export function backupExistingState(root,source,backupRoot){
  const target=stateBackupPath(root,source,localBackupStamp(),backupRoot);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
  const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(hash(source)!==hash(target))throw new Error('状态备份校验失败，已停止升级');
  return target;
}
