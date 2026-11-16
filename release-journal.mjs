import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ownsDataLock} from './data-lock.mjs';
import {parseSource} from './json-safe.mjs';
import {compareReleaseVersions} from './release-manifest.mjs';
import {safeLocalPath} from './maintenance-policy.mjs';
import {verifyBackupMatchesSource} from './installed-migration.mjs';

const phases={created:['backed-up','cancelled'], 'backed-up':['switching','cancelled'],switching:['started','rollback-required'],started:['confirmed','rollback-required'],'rollback-required':['rolled-back'],confirmed:[],cancelled:[],'rolled-back':[]};
const terminal=new Set(['confirmed','cancelled','rolled-back']);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
function requireLease(root,lease){
  if(!path.isAbsolute(root??'')||/^(?:e:|\\\\)/i.test(root))throw Error('升级记录目录无效');
  root=safeLocalPath(root,{directory:true});root=fs.realpathSync.native(root);if(!ownsDataLock(lease,path.join(root,'data')))throw Error('升级记录需要持有对应的数据锁');return root;
}
function directory(parent,name,create){
  const target=path.join(parent,name);
  try{const stat=fs.lstatSync(target);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync.native(target)!==target)throw Error('升级记录目录被重定向');}
  catch(error){if(error.code!=='ENOENT'||!create)throw error;fs.mkdirSync(target);}
  return target;
}
function transactionRoot(root,create){return directory(directory(root,'updates',create),'transactions',create);}
function slot(value){return value==='initial'||typeof value==='string'&&/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value);}
function validatePhase(phase,data,created){
  if(phase==='created'){
    if(!exact(data,['stageId','oldVersion','newVersion','sha256'])||!/^stage-[a-zA-Z0-9]{6}$/.test(data.stageId??'')||!/^[a-f0-9]{64}$/.test(data.sha256??'')||compareReleaseVersions(data.newVersion,data.oldVersion)<=0)throw Error('升级意图无效');
  }else if(phase==='backed-up'){
    if(!exact(data,['backupPath'])||typeof data.backupPath!=='string'||!path.isAbsolute(data.backupPath)||/^(?:e:|\\\\)/i.test(data.backupPath))throw Error('备份记录无效');
  }else if(phase==='switching'){
    if(!exact(data,['oldSlot','newSlot'])||!slot(data.oldSlot)||!slot(data.newSlot)||data.oldSlot!=='initial'&&data.oldSlot!=='v'+created.oldVersion||data.newSlot!=='v'+created.newVersion||data.oldSlot===data.newSlot)throw Error('版本切换记录无效');
  }else if(phase==='started'){
    if(!exact(data,['instanceId'])||typeof data.instanceId!=='string'||!/^[a-f0-9-]{36}$/i.test(data.instanceId))throw Error('启动记录无效');
  }else if(phase==='rollback-required'){
    if(!exact(data,['reason'])||typeof data.reason!=='string'||!data.reason.trim()||data.reason.length>300)throw Error('回退原因无效');
  }else if(!['confirmed','cancelled','rolled-back'].includes(phase)||!exact(data,[]))throw Error('升级阶段无效');
}
function transactionDirectory(root,id,create=false){
  if(!/^tx-[a-f0-9-]{36}$/i.test(id??''))throw Error('升级记录标识无效');
  const parent=transactionRoot(root,create),target=path.join(parent,id);
  if(create){fs.mkdirSync(target);return target;}
  const stat=fs.lstatSync(target);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync.native(target)!==target)throw Error('升级记录目录无效');return target;
}
function readDirectory(dir){
  const names=fs.readdirSync(dir).sort();if(!names.length||names.length>8)throw Error('升级记录不完整');
  const records=[];let previous=null,created;
  for(const [index,name] of names.entries()){
    if(name!==String(index).padStart(3,'0')+'.json')throw Error('升级记录顺序异常');
    const file=path.join(dir,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error('升级记录文件无效');
    const bytes=fs.readFileSync(file),row=parseSource(bytes);
    if(!exact(row,['version','sequence','phase','at','previous','data'])||row.version!==1||row.sequence!==index||row.previous!==previous||typeof row.at!=='string'||Number.isNaN(Date.parse(row.at))||!Object.hasOwn(phases,row.phase))throw Error('升级记录损坏');
    if(index===0&&row.phase!=='created'||index>0&&!phases[records.at(-1).phase].includes(row.phase))throw Error('升级阶段顺序异常');
    validatePhase(row.phase,row.data,created);if(index===0)created=row.data;
    records.push(row);previous=digest(bytes);
  }
  return {records,previous,phase:records.at(-1).phase,created};
}
function append(dir,sequence,phase,data,previous){
  const record={version:1,sequence,phase,at:new Date().toISOString(),previous,data},file=path.join(dir,String(sequence).padStart(3,'0')+'.json'),fd=fs.openSync(file,'wx');
  try{fs.writeFileSync(fd,JSON.stringify(record)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export function listReleaseTransactions({root,lease}){
  root=requireLease(root,lease);let parent;
  try{parent=transactionRoot(root,false);}catch(error){if(error.code==='ENOENT')return [];throw error;}
  return fs.readdirSync(parent).sort().map(id=>({id,...readDirectory(transactionDirectory(root,id))}));
}
export function beginReleaseTransaction({root,lease,stageId,oldVersion,newVersion,sha256}){
  root=requireLease(root,lease);const data={stageId,oldVersion,newVersion,sha256};validatePhase('created',data);
  if(listReleaseTransactions({root,lease}).some(item=>!terminal.has(item.phase)))throw Error('存在未完成的升级，需要先核对或恢复');
  const id='tx-'+randomUUID(),dir=transactionDirectory(root,id,true);append(dir,0,'created',data,null);return {id,phase:'created'};
}
export function advanceReleaseTransaction({root,lease,id,phase,data={}}){
  root=requireLease(root,lease);const dir=transactionDirectory(root,id),current=readDirectory(dir);
  if(!phases[current.phase].includes(phase))throw Error('升级阶段不能跳跃或重复');
  validatePhase(phase,data,current.created);
  if(phase==='backed-up')verifyBackupMatchesSource({source:root,backup:data.backupPath,lease});
  append(dir,current.records.length,phase,data,current.previous);
  return {id,phase};
}
