import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ownsDataLock} from './data-lock.mjs';
import {safeLocalPath} from './maintenance-policy.mjs';
import {separateRoots} from './migration-files.mjs';
import {installedReleaseConfig} from './release-config.mjs';
import {verifyInstalledProgram} from './installed-integrity.mjs';
import {verifyBackupMatchesSource} from './installed-migration.mjs';
import {requiresExplicitBackup,validateBackupRoot} from './backup-roots.mjs';
import {backupRestartState} from './restart.mjs';
import {listReleaseTransactions,advanceReleaseTransaction} from './release-journal.mjs';
import {prepareInstalledVersion} from './release-slot.mjs';
import {parseSource} from './json-safe.mjs';

const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
function context(installRoot,dataRoot,lease){
  if(!path.isAbsolute(installRoot??'')||!path.isAbsolute(dataRoot??''))throw Error('安装和数据目录必须是绝对路径');
  installRoot=safeLocalPath(installRoot,{directory:true});dataRoot=safeLocalPath(dataRoot,{directory:true});separateRoots(installRoot,dataRoot);
  if(!ownsDataLock(lease,path.join(dataRoot,'data')))throw Error('版本切换需要持有对应的数据锁');return {installRoot,dataRoot};
}
function transaction(dataRoot,lease,id){const matches=listReleaseTransactions({root:dataRoot,lease}).filter(row=>row.id===id);if(matches.length!==1)throw Error('升级记录不存在');return matches[0];}
function programPath(installRoot,slot){
  if(slot==='initial')return path.join(installRoot,'program');
  if(!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(slot??''))throw Error('版本槽标识无效');
  return path.join(installRoot,'versions',slot,'program');
}
export function inspectActiveVersion(installRoot){
  const pointer=path.join(installRoot,'current-version.json');let bytes;
  try{const stat=fs.lstatSync(pointer);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error('当前版本记录无效');bytes=fs.readFileSync(pointer);}
  catch(error){if(error.code!=='ENOENT')throw error;}
  let value;if(bytes){value=parseSource(bytes);if(!exact(value,['schemaVersion','slot','productVersion'])||value.schemaVersion!==1)throw Error('当前版本记录无效');}
  else value={schemaVersion:1,slot:'initial',productVersion:null};
  const program=safeLocalPath(programPath(installRoot,value.slot),{directory:true}),config=installedReleaseConfig(program);if(!config)throw Error('当前程序发行配置缺失');
  if(value.productVersion!==null&&value.productVersion!==config.version||value.slot!=='initial'&&value.slot!=='v'+config.version)throw Error('当前程序与版本记录不一致');
  verifyInstalledProgram(program);return {pointer,bytes,slot:value.slot,version:config.version,program};
}
function writePointer(current,slot,version,backupRoot,dataRoot){
  const value=Buffer.from(JSON.stringify({schemaVersion:1,slot,productVersion:version})+'\n'),temp=current.pointer+'.'+randomUUID()+'.tmp';
  const fd=fs.openSync(temp,'wx');try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(current.bytes){
    if(!fs.readFileSync(current.pointer).equals(current.bytes))throw Error('当前版本记录已变化，未覆盖');
    if(requiresExplicitBackup(current.pointer))backupRestartState(current.pointer,validateBackupRoot(dataRoot,backupRoot),'版本记录修改');
    if(!fs.readFileSync(current.pointer).equals(current.bytes))throw Error('当前版本记录已变化，未覆盖');
    fs.renameSync(temp,current.pointer);
  }else{fs.linkSync(temp,current.pointer);fs.unlinkSync(temp);}
}

// Caller owns the data lock and must stop the old service before invoking.
// This changes only the program pointer; it does not start an application or
// restore data. The journal remains pending until startup is independently
// confirmed or the explicit program rollback function completes.
export async function activatePreparedRelease({installRoot,dataRoot,lease,id,powershellPath}){
  ({installRoot,dataRoot}=context(installRoot,dataRoot,lease));const tx=transaction(dataRoot,lease,id);
  if(tx.phase!=='backed-up')throw Error('升级尚未完成备份，不能切换');
  const backupPath=tx.records.find(row=>row.phase==='backed-up').data.backupPath;
  verifyBackupMatchesSource({source:dataRoot,backup:backupPath,lease});
  const current=inspectActiveVersion(installRoot);if(current.version!==tx.created.oldVersion)throw Error('当前版本已变化，未切换');
  const next=await prepareInstalledVersion({installRoot,dataRoot,currentProgram:current.program,stageId:tx.created.stageId,lease,powershellPath});
  if(next.version!==tx.created.newVersion||fs.readFileSync(path.join(next.directory,'.release-ready'),'utf8')!==tx.created.sha256)throw Error('新版本与升级记录不一致，未切换');
  verifyBackupMatchesSource({source:dataRoot,backup:backupPath,lease});
  advanceReleaseTransaction({root:dataRoot,lease,id,phase:'switching',data:{oldSlot:current.slot,newSlot:next.slot}});
  writePointer(current,next.slot,next.version,path.dirname(backupPath),dataRoot);
  return {phase:'switching',version:next.version,slot:next.slot,backupPath};
}

export function rollbackProgramRelease({installRoot,dataRoot,lease,id,reason}){
  ({installRoot,dataRoot}=context(installRoot,dataRoot,lease));let tx=transaction(dataRoot,lease,id);
  if(!['switching','started','rollback-required'].includes(tx.phase))throw Error('当前升级阶段不允许程序回退');
  const change=tx.records.find(row=>row.phase==='switching').data,backupPath=tx.records.find(row=>row.phase==='backed-up').data.backupPath;
  // Until a compatible-data rollback protocol exists, never point old code at
  // data that changed after the verified backup. Recovery is explicit.
  verifyBackupMatchesSource({source:dataRoot,backup:backupPath,lease});
  const current=inspectActiveVersion(installRoot);
  if(![change.oldSlot,change.newSlot].includes(current.slot))throw Error('当前版本与升级记录不一致，未回退');
  if(tx.phase!=='rollback-required'){advanceReleaseTransaction({root:dataRoot,lease,id,phase:'rollback-required',data:{reason}});tx=transaction(dataRoot,lease,id);}
  if(current.slot!==change.oldSlot){
    const oldProgram=safeLocalPath(programPath(installRoot,change.oldSlot),{directory:true}),old=installedReleaseConfig(oldProgram);
    if(!old||old.version!==tx.created.oldVersion)throw Error('旧程序不可用，未回退');verifyInstalledProgram(oldProgram);
    writePointer(current,change.oldSlot,old.version,path.dirname(backupPath),dataRoot);
  }
  advanceReleaseTransaction({root:dataRoot,lease,id,phase:'rolled-back'});
  return {phase:'rolled-back',version:tx.created.oldVersion,backupPath,dataRestored:false};
}
