import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {safeLocalPath} from './maintenance-policy.mjs';
import {separateRoots} from './migration-files.mjs';
import {acquireDataLock} from './data-lock.mjs';
import {installedReleaseConfig} from './release-config.mjs';
import {verifyInstalledProgram} from './installed-integrity.mjs';
import {inspectActiveVersion} from './release-activation.mjs';
import {listReleaseTransactions} from './release-journal.mjs';
import {verifyStagedRelease} from './release-staging.mjs';

function ordinary(file){const value=safeLocalPath(file),stat=fs.lstatSync(value);if(!stat.isFile()||stat.isSymbolicLink()||fs.realpathSync.native(value)!==value)throw Error('安装运行时不可用');return value;}
function hash(file){const digest=createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.allocUnsafe(1024*1024);try{for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;digest.update(buffer.subarray(0,n));}}finally{fs.closeSync(fd);}return digest.digest('hex');}

// Resolve only a completed, authenticated version. An interrupted transaction
// stops ordinary startup until an explicit recovery action is completed.
export async function resolveInstalledVersion({installRoot,dataRoot}){
  if(!path.isAbsolute(installRoot??'')||!path.isAbsolute(dataRoot??''))throw Error('安装和数据目录必须是绝对路径');
  installRoot=safeLocalPath(installRoot,{directory:true});dataRoot=safeLocalPath(dataRoot,{directory:true});separateRoots(installRoot,dataRoot);
  const ready=ordinary(path.join(dataRoot,'.installed-data-ready'));
  if(fs.existsSync(path.join(dataRoot,'.migration-incomplete'))||fs.readFileSync(ready,'utf8')!=='codexkz-installed-data-v1\n')throw Error('数据尚未准备完成');
  const lease=await acquireDataLock(path.join(dataRoot,'data'));
  try{
    const transactions=listReleaseTransactions({root:dataRoot,lease});
    if(transactions.some(tx=>!['confirmed','cancelled','rolled-back'].includes(tx.phase)))throw Error('存在未完成的升级，请先执行安全恢复；数据未自动恢复');
    const initial=path.join(installRoot,'program'),trusted=installedReleaseConfig(initial);if(!trusted)throw Error('初始发行配置缺失');verifyInstalledProgram(initial);
    const active=inspectActiveVersion(installRoot),release=installedReleaseConfig(active.program);
    const completed=transactions.filter(tx=>['confirmed','rolled-back'].includes(tx.phase)).sort((a,b)=>a.records[0].at<b.records[0].at?-1:a.records[0].at>b.records[0].at?1:0);
    const latest=completed.at(-1),latestChange=latest?.records.find(row=>row.phase==='switching')?.data;
    const expectedSlot=latest?(latest.phase==='confirmed'?latestChange?.newSlot:latestChange?.oldSlot):'initial';
    if(!expectedSlot||active.slot!==expectedSlot)throw Error('当前版本与最近完成的升级记录不一致');
    if(!release.publicKey.export({type:'spki',format:'der'}).equals(trusted.publicKey.export({type:'spki',format:'der'})))throw Error('当前版本公钥不匹配');
    if(active.slot!=='initial'){
      const matching=transactions.filter(tx=>tx.phase==='confirmed'&&tx.created.newVersion===active.version&&tx.records.some(row=>row.phase==='switching'&&row.data.newSlot===active.slot));
      if(matching.length!==1)throw Error('当前版本缺少已确认的升级记录');
      const created=matching[0].created,stage=await verifyStagedRelease({root:dataRoot,stageId:created.stageId,publicKey:trusted.publicKey,version:created.oldVersion,platform:process.platform,arch:process.arch});
      if(stage.version!==active.version||stage.sha256!==created.sha256)throw Error('当前版本与签名发行记录不匹配');
    }
    const runtime=path.dirname(active.program),node=ordinary(path.join(runtime,'runtime','node','node.exe')),pwsh=ordinary(path.join(runtime,'runtime','powershell','pwsh.exe'));
    const pluginNode=ordinary(path.join(active.program,'plugins','leix-panel-probe','runtime','node.exe'));
    if(hash(node)!==hash(pluginNode))throw Error('安装运行时与插件不一致');
    return {version:active.version,slot:active.slot,program:active.program,node,pwsh};
  }finally{await lease.release();}
}
