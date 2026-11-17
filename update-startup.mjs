import path from 'node:path';
import {ownsDataLock} from './data-lock.mjs';
import {safeLocalPath} from './maintenance-policy.mjs';
import {installedDataRoot} from './installed-paths.mjs';
import {installedReleaseConfig} from './release-config.mjs';
import {verifyInstalledProgram} from './installed-integrity.mjs';
import {inspectActiveVersion} from './release-activation.mjs';
import {verifyBackupMatchesSource} from './installed-migration.mjs';
import {listReleaseTransactions,advanceReleaseTransaction} from './release-journal.mjs';
import {verifyStagedRelease} from './release-staging.mjs';

async function candidate({installRoot,dataRoot,programRoot,lease,id}){
  for(const value of [installRoot,dataRoot,programRoot])if(!path.isAbsolute(value??''))throw Error('安装、数据和程序目录必须是绝对路径');
  installRoot=safeLocalPath(installRoot,{directory:true});dataRoot=installedDataRoot(installRoot,dataRoot);programRoot=safeLocalPath(programRoot,{directory:true});
  if(!ownsDataLock(lease,path.join(dataRoot,'data')))throw Error('新版本启动核对需要数据锁');
  const pending=listReleaseTransactions({root:dataRoot,lease}).filter(tx=>!['confirmed','cancelled','rolled-back'].includes(tx.phase));
  if(pending.length!==1||pending[0].id!==id||pending[0].phase!=='switching')throw Error('升级记录不匹配或不处于待启动阶段');
  const tx=pending[0],change=tx.records.find(row=>row.phase==='switching').data,backupPath=tx.records.find(row=>row.phase==='backed-up').data.backupPath;
  const active=inspectActiveVersion(installRoot),trusted=installedReleaseConfig(path.join(installRoot,'program'));
  if(!trusted||active.program!==programRoot||active.slot!==change.newSlot||active.version!==tx.created.newVersion)throw Error('启动程序与待确认版本不匹配');
  verifyInstalledProgram(path.join(installRoot,'program'));
  const config=installedReleaseConfig(programRoot);
  if(!config.publicKey.export({type:'spki',format:'der'}).equals(trusted.publicKey.export({type:'spki',format:'der'})))throw Error('启动程序的发行公钥不匹配');
  const stage=await verifyStagedRelease({root:dataRoot,stageId:tx.created.stageId,publicKey:trusted.publicKey,version:tx.created.oldVersion,platform:process.platform,arch:process.arch});
  if(!ownsDataLock(lease,path.join(dataRoot,'data'))||stage.version!==active.version||stage.sha256!==tx.created.sha256)throw Error('启动核对期间数据锁或发行文件发生变化');
  return {installRoot,dataRoot,programRoot,tx,backupPath};
}

// Called before opening the candidate's storage or starting any task.
export async function inspectPendingUpdate(input){
  const result=await candidate(input);verifyBackupMatchesSource({source:result.dataRoot,backup:result.backupPath,lease:input.lease});
  return {id:result.tx.id,version:result.tx.created.newVersion};
}

// The caller must keep business writes and automatic dispatch paused until this
// returns. HTTP identity is checked before the journal can become confirmed.
export async function confirmPendingUpdate({...input}){
  const {origin,instanceId,fetchImpl=fetch}=input;
  if(typeof instanceId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(instanceId))throw Error('新服务实例标识无效');
  let url;try{url=new URL(origin);}catch{throw Error('新服务地址无效');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw Error('新服务地址无效');
  const result=await candidate(input),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
  try{
    const response=await fetchImpl(new URL('/api/service/health',url),{signal:controller.signal,redirect:'error'});
    if(!response.ok||!response.body)throw Error('新服务健康检查失败');
    const chunks=[];let total=0;
    for await(const chunk of response.body){total+=chunk.length;if(total>4096){controller.abort();throw Error('新服务健康回执过大');}chunks.push(Buffer.from(chunk));}
    const health=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    if(health.instanceId!==instanceId||health.productVersion!==result.tx.created.newVersion)throw Error('新服务身份或版本不匹配');
    if(!ownsDataLock(input.lease,path.join(result.dataRoot,'data')))throw Error('确认启动时数据锁已失效');
    advanceReleaseTransaction({root:result.dataRoot,lease:input.lease,id:input.id,phase:'started',data:{instanceId}});
    advanceReleaseTransaction({root:result.dataRoot,lease:input.lease,id:input.id,phase:'confirmed'});
    return {id:input.id,version:health.productVersion,instanceId};
  }finally{clearTimeout(timer);}
}
