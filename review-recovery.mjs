import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {normalize,queuedThreadReason} from './core.mjs';
import {pendingInitialDispatches} from './dispatch-state.mjs';
import {handoffPending} from './handoff-state.mjs';

// Only settled, identified deliveries are eligible. Unknown creation and
// in-flight submissions retain their own recovery protocol.
export function automaticUncertainCandidate(state,job,projects){
  if(job?.status!=='uncertain'||typeof job.threadId!=='string'||!job.threadId.trim()||typeof job.path!=='string'||!job.path||job.operation||job.connectionTest||!Number.isFinite(Date.parse(job.sentAt)))return false;
  const receipt=job.receipt;
  if(receipt?.threadId!==undefined&&receipt.threadId!==job.threadId||receipt?.hostId!==undefined&&receipt.hostId!=='local')return false;
  if(!(typeof job.turnId==='string'&&job.turnId.trim())&&receipt?.threadId!==job.threadId)return false;
  if(!projects.some(p=>p.projectId===job.projectId&&p.hostId==='local'&&normalize(p.path)===normalize(job.path)))return false;
  const task=job.taskId&&state.tasks.find(t=>t.id===job.taskId);
  if(job.taskId&&(!task||task.currentJobId!==job.id||task.projectId!==job.projectId||task.status!=='review'||task.archivedAt||task.initialDispatch||handoffPending(task)))return false;
  if(pendingInitialDispatches(state).some(r=>r.projectId===job.projectId||r.threadId===job.threadId))return false;
  if(state.tasks.some(t=>handoffPending(t)&&(t.projectId===job.projectId||t.handoff?.summaryJobId===job.id||t.handoff?.sourceJobId===job.id)))return false;
  return !state.jobs.some(j=>j.id!==job.id&&['sending','submitted','running'].includes(j.status)&&(j.projectId===job.projectId||j.threadId===job.threadId));
}

// Use the same positive terminal evidence as dispatch. Index placeholders alone
// never prove idle, and a real SDK activity observation remains authoritative.
export function recoveryThreadView(result,id){
  const t=result?.thread,status=t?.status?.type??t?.status;
  if(t?.id!==id||t.kind!=='codex'||t.hostId!=='local'||!t.cwd)return result;
  if((status==='notLoaded'||status==='active'&&t.activityUnknown===true)&&!queuedThreadReason({threadId:id,path:t.cwd},result))return {...result,thread:{...t,status:'idle'},recoveryEvidence:'verified-terminal-window'};
  return result;
}

// The recent-list API omits older chats. Ask for this exact thread's live
// activity without requesting its transcript, then recheck indexed ownership.
export async function scopedIdleThread(bridge,reader,id){
  let before;try{before=reader.identity?.(id);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!before||before.id!==id||before.archived!==false||!before.cwd||!before.file)return null;
  let snapshot;try{snapshot=await bridge.call('wait_threads',{targets:[{threadId:id,hostId:'local'}],timeoutMs:0},{timeoutMs:10000});}catch(error){
    if([401,403].includes(Number(error.status??error.statusCode))||['EACCES','EPERM'].includes(error.code)||/permission|denied|forbidden|unauthori[sz]ed|not authori[sz]ed|not allowed|授权|拒绝/i.test(error.message))throw error;
    if(error.code===-32601||/当前桌面版本未提供工具|unexpected tool wait_threads|tool unavailable|(?:tool|method).*(?:not found|not supported|unsupported)/i.test(error.message))return null;
    throw error;
  }
  const unverified=()=>Error('定向活动状态尚未核实，不能解除原执行占用');
  if(!snapshot||snapshot.errors!==undefined&&(!Array.isArray(snapshot.errors)||snapshot.errors.length)||!Array.isArray(snapshot.polls)||snapshot.polls.length!==1)throw unverified();
  const polls=snapshot.polls.filter(p=>p.thread?.id===id);
  if(polls.length!==1)throw unverified();
  const poll=polls[0],status=poll.thread.status?.type??poll.thread.status;
  if(poll.schemaVersion!==1||poll.thread.hostId!=='local'||status!=='idle'||typeof poll.latestTurn?.id!=='string'||!poll.latestTurn.id.trim()||!['completed','failed','interrupted'].includes(poll.latestTurn.status))throw unverified();
  let after;try{after=reader.identity?.(id);}catch{throw Error('活动核对期间原对话归属已变化，未解除执行占用');}
  if(!after||after.id!==id||after.archived!==false||normalize(after.cwd)!==normalize(before.cwd)||normalize(after.file)!==normalize(before.file))throw Error('活动核对期间原对话归属已变化，未解除执行占用');
  return {thread:{id,kind:'codex',hostId:'local',cwd:after.cwd,status:'idle'},turns:[],page:{},recoveryEvidence:'scoped-idle-snapshot'};
}

export function reviewTarget(repository,input,catalog){
  const task=repository.getTask(input.id),job=task?.value.currentJobId?repository.getJob(task.value.currentJobId):null;
  if(!task||task.value.status!=='review'||task.value.archivedAt||!job||job.value.taskId!==task.value.id||job.value.projectId!==task.value.projectId)throw Error('此任务尚未进入待审阅或关联已变化');
  if(input.jobId!==job.value.id)throw Error('审阅轮次已变化，请刷新后核对最新结果');
  const project=catalog.projects.find(p=>p.projectId===task.value.projectId&&p.hostId==='local');
  if(!project||normalize(project.path)!==normalize(job.value.path))throw Error('无法确认本机项目及原对话，请刷新后核对');
  return {task,job,project,expected:[{entity:'tasks',id:task.value.id,revision:task.revision},{entity:'jobs',id:job.value.id,revision:job.revision}]};
}
export function assertReviewTarget(repository,target){
  if(repository.getTask(target.task.value.id)?.revision!==target.task.revision||repository.getJob(target.job.value.id)?.revision!==target.job.revision)throw Error('核对期间任务或轮次已变化，请刷新后重试');
}
export function validateReviewThread(thread,job){
  if(thread?.id!==job.threadId||thread?.kind!=='codex'||thread?.hostId!=='local'||!thread.cwd||normalize(thread.cwd)!==normalize(job.path))throw Error('无法确认原对话属于本机项目，请刷新后核对');
  return typeof thread.status==='string'?thread.status:thread.status?.type;
}
export async function inspectReviewThread(bridge,reader,job,{read}={}){
  const index=reader.identity?.(job.threadId);
  if(index&&(index.id!==job.threadId||normalize(index.cwd)!==normalize(job.path)))throw Error('本机索引与原对话项目不一致');
  if(read&&index?.archived===false){
    let result;try{result=recoveryThreadView(await read(job.threadId),job.threadId);}catch{}
    if(result){const status=validateReviewThread(result.thread,job);if(result.thread.archived!==true&&['idle','active','running','inProgress','waitingForInput'].includes(status))return {thread:result.thread,archived:false,idle:status==='idle'};}
  }
  const listed=await bridge.call('list_threads',{limit:50}),rows=[...(listed.pinnedThreads??[]),...(listed.threads??[])].filter(t=>t.id===job.threadId);
  if(rows.length){
    const statuses=rows.map(t=>validateReviewThread(t,job));
    if(index?.archived||statuses.some(status=>status!==statuses[0]))throw Error('原对话目录状态不一致，请刷新后核对');
    return {thread:rows[0],archived:false,idle:statuses[0]==='idle'};
  }
  let cursor;const seen=new Set();
  for(let i=0;i<10;i++){
    const page=await bridge.call('list_archived_threads',{source:'codex',hostId:'local',limit:50,...(cursor?{cursor}:{})});
    const matches=(page.threads??[]).filter(t=>t.id===job.threadId);
    if(matches.length){
      for(const thread of matches)validateReviewThread(thread,job);
      if(matches.length!==1||index?.archived===false)throw Error('原对话归档状态不一致，请刷新后核对');
      return {thread:matches[0],archived:true,idle:false};
    }
    if(!page.nextCursor)break;
    if(seen.has(page.nextCursor))throw Error('归档目录游标重复，未猜测原对话');
    seen.add(page.nextCursor);cursor=page.nextCursor;
  }
  throw Error('尚未从桌面目录确认原对话，请打开原对话后重新核对');
}

// Copy only files touched by desktop unarchive, before calling that tool.
// The original SQLite files retain their names; an online snapshot supplies a
// consistent recovery copy while the desktop may continue writing its WAL.
export async function backupReviewThread(reader,job,{backupRoot,now=new Date()}={}){
  const identity=reader.identity?.(job.threadId);
  if(!identity?.archived||identity.id!==job.threadId||normalize(identity.cwd)!==normalize(job.path))throw Error('无法核实归档日志，尚未恢复原对话');
  const home=path.dirname(identity.registry),files=[...new Set([identity.file,reader.locate?.(job.threadId),identity.registry,identity.registry+'-wal',identity.registry+'-shm',path.join(home,'session_index.jsonl'),path.join(home,'.codex-global-state.json')].filter(Boolean))];
  if(files.some(file=>!/^c:[\\/]/i.test(file)))throw Error('恢复涉及未授权磁盘，未修改原对话');
  if(typeof backupRoot!=='string'||!path.isAbsolute(backupRoot))throw Error('请先配置本机备份目录，未修改原对话');
  const stamp=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(now).replace(' ','_').replace(':','');
  const destination=path.join(backupRoot,stamp+'_审阅恢复_'+randomUUID().slice(0,8)),entries=[];
  for(const file of files){
    let stat;try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT'&&file!==identity.file&&file!==identity.registry)continue;throw error;}
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('受影响文件不是普通文件，未恢复原对话');
    const resolved=await fs.realpath(file);if(!/^c:[\\/]/i.test(resolved)||normalize(resolved)!==normalize(path.resolve(file)))throw Error('受影响文件路径发生重定向，未恢复原对话');
    const relative=path.win32.relative('C:\\',file),target=path.join(destination,relative),bytes=await fs.readFile(file);
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});
    const sha256=createHash('sha256').update(bytes).digest('hex');
    if(createHash('sha256').update(await fs.readFile(target)).digest('hex')!==sha256)throw Error('备份校验失败，未恢复原对话');
    entries.push({file,relative,size:bytes.length,sha256});
  }
  const {DatabaseSync,backup}=await import('node:sqlite'),db=new DatabaseSync(identity.registry,{readOnly:true});
  const snapshot=path.join(destination,'sqlite-snapshot',path.basename(identity.registry));await fs.mkdir(path.dirname(snapshot),{recursive:true});
  try{if(typeof backup!=='function')throw Error('当前 Node 不支持一致性备份，未恢复原对话');await backup(db,snapshot);}finally{db.close();}
  await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify({threadId:job.threadId,createdAt:now.toISOString(),entries,snapshot},null,2),{flag:'wx'});
  return destination;
}
