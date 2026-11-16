import fs from 'node:fs';
import path from 'node:path';
import {acquireDataLock} from '../data-lock.mjs';
import {safeLocalPath} from '../maintenance-policy.mjs';
import {listReleaseTransactions,advanceReleaseTransaction} from '../release-journal.mjs';
import {rollbackProgramRelease} from '../release-activation.mjs';

const [installRoot,dataRoot,...extra]=process.argv.slice(2);
if(!path.isAbsolute(installRoot??'')||!path.isAbsolute(dataRoot??'')||extra.length)throw Error('需要安装目录和数据目录的本机绝对路径');
const root=safeLocalPath(dataRoot,{directory:true}),ready=safeLocalPath(path.join(root,'.installed-data-ready'));
if(fs.existsSync(path.join(root,'.migration-incomplete'))||fs.readFileSync(ready,'utf8')!=='codexkz-installed-data-v1\n')throw Error('数据目录尚未准备完成');
const lease=await acquireDataLock(path.join(root,'data'));
try{
  const pending=listReleaseTransactions({root,lease}).filter(tx=>!['confirmed','cancelled','rolled-back'].includes(tx.phase));
  if(pending.length!==1)throw Error('未完成升级记录不唯一，请人工核对，未修改程序或数据');
  const tx=pending[0];
  if(['created','backed-up'].includes(tx.phase))advanceReleaseTransaction({root,lease,id:tx.id,phase:'cancelled'});
  else rollbackProgramRelease({installRoot,dataRoot:root,lease,id:tx.id,reason:'使用者明确请求恢复旧程序'});
  console.log('已取消未完成升级或恢复旧程序；数据未自动恢复，原备份保留。');
}finally{await lease.release();}
