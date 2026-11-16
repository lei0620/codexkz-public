import fs from 'node:fs';
import path from 'node:path';
import {acquireDataLock,ownsDataLock} from './data-lock.mjs';
import {safeLocalPath,sourceRoot} from './maintenance-policy.mjs';
import {separateRoots,fileRecord,copyFiles,writeFresh,writeFreshJson,inspectFiles} from './migration-files.mjs';
import {parseSource,diagnoseState} from './migration-model.mjs';
import {handoffPending} from './handoff-state.mjs';
import {pendingInitialDispatches} from './dispatch-state.mjs';
import {DirectProjectSync} from './project-sync-direct.mjs';
import {configureBackupRoot,validateBackupRoot} from './backup-roots.mjs';
import {backupRestartState} from './restart.mjs';

const marker='.migration-incomplete';
function inventory(root){
  const base=path.join(root,'data'),files=[],directories=[];
  function walk(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const full=path.join(dir,entry.name),relative=path.relative(base,full).replaceAll('\\','/');
      if(entry.isSymbolicLink())throw Error('数据目录包含链接，已停止迁移');
      if(entry.isDirectory()){directories.push(relative);walk(full);}
      else if(entry.isFile())files.push(fileRecord(root,relative,'file'));
      else throw Error('数据目录包含非常规文件，已停止迁移');
      if(files.length+directories.length>20000)throw Error('数据文件过多，已停止迁移');
    }
  }
  walk(base);files.sort((a,b)=>a.relative.localeCompare(b.relative));directories.sort();
  return {files,directories};
}
function assertQuiescent(root){
  const dir=path.join(root,'data');
  if(fs.existsSync(path.join(dir,'state.json.tmp'))||fs.existsSync(path.join(dir,'panel.sqlite'))||fs.existsSync(path.join(dir,'storage-mode.json')))throw Error('数据存在未提交状态或非 JSON 存储，不能自动迁移');
  const state=parseSource(fs.readFileSync(path.join(dir,'state.json')));
  if(!state||!Array.isArray(state.jobs)||!Array.isArray(state.tasks)||!Array.isArray(state.automation?.plans)||!state.automation?.routes||!state.sync)throw Error('数据结构不完整，不能自动迁移');
  if(state.jobs.some(j=>j.awaitingUser||['queued','sending','submitted','running','uncertain'].includes(j.status))||state.automation.plans.some(p=>p.status==='active')||pendingInitialDispatches(state).length||state.tasks.some(t=>t.initialDispatch||handoffPending(t))||Object.values(state.threadRequests??{}).some(r=>['creating','pending','uncertain'].includes(r.status))||['waiting','ready'].includes(state.maintenance?.status)||state.sync.autoEnabled===true)throw Error('存在执行、接续、维护或自动同步，请先处理后再迁移');
  const diagnosis=diagnoseState(state);
  if(diagnosis.errors.length||inspectFiles(root,diagnosis.state).errors.length)throw Error('源状态或附件校验失败，不能自动迁移');
  const sync=new DirectProjectSync({root});
  if(sync.fault||sync.hasWork())throw Error('同步回执异常、仍在处理或待核对，不能自动迁移');
}
function copySnapshot(source,target,snapshot){
  fs.mkdirSync(target);writeFresh(path.join(target,marker),'数据尚未校验完成\n');fs.mkdirSync(path.join(target,'data'));
  for(const directory of snapshot.directories)fs.mkdirSync(path.join(target,'data',...directory.split('/')),{recursive:true});
  copyFiles(source,target,snapshot.files);
  if(JSON.stringify(inventory(target))!==JSON.stringify(snapshot))throw Error('迁移副本核验失败');
}

// This explicit offline operation never replaces source, destination or backup.
// The marker prevents a partial destination from being used as an installation.
export async function migrateInstalledData({source,destination,backup,backupRoot}){
  if(!path.isAbsolute(source??'')||!path.isAbsolute(destination??'')||!path.isAbsolute(backup??''))throw Error('迁移来源、目标和备份目录必须使用本机绝对路径');
  source=sourceRoot(source);destination=safeLocalPath(destination,{missing:true,directory:true});backup=safeLocalPath(backup,{missing:true,directory:true});
  if(backupRoot!==undefined)validateBackupRoot(destination,backupRoot);
  for(const [a,b] of [[source,destination],[source,backup],[destination,backup]])separateRoots(a,b);
  if(fs.existsSync(destination)||fs.existsSync(backup))throw Error('迁移目标或备份位置已存在，未覆盖');
  const lease=await acquireDataLock(path.join(source,'data'));
  try{
    const original=inventory(source);assertQuiescent(source);
    copySnapshot(source,backup,original);
    if(JSON.stringify(inventory(source))!==JSON.stringify(original))throw Error('源数据在备份期间变化，已停止迁移');
    fs.unlinkSync(path.join(backup,marker));
    copySnapshot(source,destination,original);
    if(JSON.stringify(inventory(source))!==JSON.stringify(original))throw Error('源数据在迁移期间变化，目标保持未完成');
    if(backupRoot!==undefined)configureBackupRoot(destination,backupRoot,{backup:(file,target)=>backupRestartState(file,target,'修改备份配置')});
    fs.unlinkSync(path.join(destination,marker));
    writeFresh(path.join(destination,'.installed-data-ready'),'codexkz-installed-data-v1\n');
    return {files:original.files.length,backup,destination};
  }finally{await lease.release();}
}

// The coordinator can retain its own verified lease through version switching.
// Without one this operation is an offline backup and releases its lock when
// done; releasing it is not permission to switch a running application.
export async function backupInstalledData({source,backup,lease}){
  if(!path.isAbsolute(source??'')||!path.isAbsolute(backup??''))throw Error('数据和备份目录必须使用本机绝对路径');
  source=sourceRoot(source);backup=safeLocalPath(backup,{missing:true,directory:true});
  separateRoots(path.join(source,'data'),backup);
  safeLocalPath(path.dirname(backup),{directory:true});
  if(fs.existsSync(backup))throw Error('备份目录已存在，未覆盖');
  const data=path.join(source,'data');
  if(lease&&!ownsDataLock(lease,data))throw Error('数据锁与备份来源不匹配');
  const ownLease=lease?null:await acquireDataLock(data),lock=lease??ownLease;
  try{
    if(!ownsDataLock(lock,data))throw Error('数据锁已失效');
    const original=inventory(source);assertQuiescent(source);
    copySnapshot(source,backup,original);
    if(JSON.stringify(inventory(source))!==JSON.stringify(original))throw Error('源数据在备份期间变化，备份保持未完成');
    writeFreshJson(path.join(backup,'backup-inventory.json'),{version:1,snapshot:original});
    if(JSON.stringify(inventory(backup))!==JSON.stringify(original))throw Error('备份副本校验失败');
    fs.unlinkSync(path.join(backup,marker));
    return {backup,files:original.files.length};
  }finally{if(ownLease)await ownLease.release();}
}

export function verifyInstalledBackup(backup){
  backup=sourceRoot(backup);
  if(fs.existsSync(path.join(backup,marker)))throw Error('备份尚未完成');
  const file=path.join(backup,'backup-inventory.json'),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw Error('备份清单无效');
  const record=parseSource(fs.readFileSync(file));
  if(!record||Object.keys(record).sort().join(',')!=='snapshot,version'||record.version!==1||!record.snapshot||!Array.isArray(record.snapshot.files)||!Array.isArray(record.snapshot.directories))throw Error('备份清单无效');
  if(JSON.stringify(inventory(backup))!==JSON.stringify(record.snapshot))throw Error('备份文件与清单不符');
  return {backup,files:record.snapshot.files.length};
}

export function verifyBackupMatchesSource({source,backup,lease}){
  if(!path.isAbsolute(source??'')||!path.isAbsolute(backup??''))throw Error('数据和备份目录必须使用本机绝对路径');
  source=sourceRoot(source);
  backup=safeLocalPath(backup,{directory:true});separateRoots(path.join(source,'data'),backup);
  if(!ownsDataLock(lease,path.join(source,'data')))throw Error('核对备份需要持有对应的数据锁');
  const verified=verifyInstalledBackup(backup);assertQuiescent(source);
  if(JSON.stringify(inventory(source))!==JSON.stringify(inventory(verified.backup)))throw Error('备份不再匹配当前数据');
  return verified;
}
