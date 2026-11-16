import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {localBackupStamp} from './backup-roots.mjs';
const exec=promisify(execFile);

export function backupRestartState(source,backupRoot,reason='重启面板'){
  if(typeof backupRoot!=='string'||!path.isAbsolute(backupRoot))throw Error('请先配置本机备份目录');
  if(typeof reason!=='string'||!/^[\p{L}\p{N}_-]{1,40}$/u.test(reason))throw Error('备份任务名称无效');
  const absolute=path.resolve(source),diskRoot=path.parse(absolute).root;
  const folder=localBackupStamp()+'_'+reason+'_'+randomUUID().slice(0,8);
  const target=path.join(backupRoot,folder,diskRoot.replace(/[^a-zA-Z0-9]/g,'')||'root',path.relative(diskRoot,absolute));
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(absolute,target,fs.constants.COPYFILE_EXCL);
  const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(hash(absolute)!==hash(target))throw Error('重启备份校验失败，已保留当前服务');
  return target;
}
export async function checkRestartCode(root,{installed=false}={}){
  try{await exec(process.execPath,installed?[path.join(root,'scripts','check-installed.mjs'),root]:[path.join(root,'scripts','check.mjs')],{cwd:root,windowsHide:true,timeout:120000,maxBuffer:1024*1024});}
  catch(error){throw Object.assign(Error(error.killed?'更新检查超过两分钟，旧服务已保留，请稍后重试':installed?'安装文件检查未通过，旧服务已保留；请核对或重新安装程序':'代码或文档检查未通过，旧服务已保留；请先运行 npm run check 修复'),{code:error.killed?'RESTART_CHECK_TIMEOUT':'RESTART_CHECK_FAILED'});}
}
