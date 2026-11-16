import {normalize,queuedThreadReason,queuedJobLocalReason,parallelConflict,sourcePathsOverlap} from './core.mjs';
import {handoffPending} from './handoff-state.mjs';
import {attachmentPrompt} from './attachments.mjs';
import {workspaceReason} from './workspace.mjs';
import {moduleKey} from './execution.mjs';

const active=new Set(['queued','sending','submitted','running','uncertain']);
const action=(kind,label,extra={})=>({kind,label,...extra});
const recheck=action('recheck','重新检查');
const settings=action('settings','打开项目设置');
const review=action('review','核对原执行');
const edit=action('edit','修改任务或附件');
const bounded=async work=>{let timer;try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('本次核对超时，结果仍未知；可手动重新检查')),8000);})]);}finally{clearTimeout(timer);}};

// Display timeouts do not cancel RPCs. Keep their slots until the actual read
// settles, including across repeated checks, and track them for normal close.
export class ExecutionReadChecks{
  constructor({limit=16,track=p=>p}={}){this.limit=limit;this.track=track;this.pending=new Map();}
  get size(){return this.pending.size;}
  run(key,read){
    if(!this.pending.has(key)){
      if(this.size>=this.limit)return Promise.reject(Error('仍有目标核对在途，请稍后重新检查'));
      const operation=Promise.resolve().then(read).finally(()=>this.pending.delete(key));this.pending.set(key,this.track(operation));
    }
    return this.pending.get(key);
  }
}

// Read-only inspection. Every action goes through its existing command and
// checks fresh state again. This response is never an execution permission.
export async function inspectExecution({state,catalog,taskId,projectId,root,queue,gate,storageFault,connected,readTarget,readRemote,modelReason}){
  const task=state.tasks.find(t=>t.id===taskId&&t.projectId===projectId);
  if(!task)throw Error('任务不存在或不属于当前项目');
  const project=catalog.projects.find(p=>p.projectId===projectId),job=state.jobs.find(j=>j.id===task.currentJobId),issues=[];
  const add=(code,title,message,actions=[],blocking=true)=>{if(!issues.some(i=>i.code===code))issues.push({code,title,message,actions,blocking});};
  const open=id=>action('open','打开原对话',{threadId:id});
  if(storageFault)add('STORAGE_FAULT','存储状态待恢复','存储写入状态尚未确认。请从设置查看故障与备份恢复入口，恢复后重新检查。',[settings,recheck]);
  if(gate==='MAINTENANCE_WAIT')add(gate,'正在等待更新','可取消尚未开始的更新等待，保留原任务和暂停安排。',[action('cancel-maintenance','取消更新等待'),recheck]);
  else if(gate)add(gate,'当前操作尚未结束',gate==='STORAGE_FAULT'?'同步回执或存储异常，请查看诊断后恢复。':'同步或提交正在进行，结束后可手动重新检查；不会重复发送。',[settings,recheck]);
  if(!connected)add('CONNECTION','桌面连接待恢复','重新连接只刷新状态，不发送当前任务。',[action('refresh','重新连接'),recheck]);
  const defaultError=modelReason?.(null);if(defaultError)add('MODEL_DEFAULT','默认模型配置待核对',defaultError,[settings,recheck]);
  const identity=workspaceReason(state,project);if(identity)add('PROJECT','项目或源码目录待核对',identity,[settings,recheck]);
  if(task.archivedAt)add('ARCHIVED','任务已移出或被领取','先核对同步归属和原记录；其他电脑的领取需要在原电脑核对。不会抢占或重新发送。',task.syncReserved&&task.syncReservationConfirmed&&!task.jobIds?.length?[action('restore-claim','恢复本机已领取卡片'),review]:[settings,review]);
  if(handoffPending(task))add('HANDOFF','任务正在交接','在任务详情核对原交接；仅可取消尚未发送或已明确结束的交接。',[review]);
  if(task.initialDispatch)add('INITIAL_UNKNOWN','首条提交待核对','可能已经创建对话或发送。请在安排管理中选择实际创建的原对话确认，保留原请求标识。',[action('plan','核对原安排'),recheck]);
  if(['discussion','confirmation'].includes(task.workflowStage))add('WORKFLOW','任务方案待确认','在任务编辑中确认方案后再执行，保留原需求和历史。',[edit]);
  if(task.pendingParentId||task.pendingDependencies?.length)add('DEPENDENCY','关联任务尚未接续','先完成本机父任务和依赖接续。',[review]);
  if(task.syncReserved&&!task.syncReservationConfirmed)add('CLAIM','本机领取记录待核对','先核对远端领取；已执行或未知发送不会因解除领取而重发。',[action('claim','核对同步领取'),review]);
  else if(task.syncReserved)add('CLAIM_OWNED','本机领取已确认','当前未发送任务可沿用本机领取继续安排，发送前仍复核远端；取消排队也会保留该领取。',[],false);
  if(job&&active.has(job.status))add('CURRENT_JOB',job.status==='uncertain'?'原执行结果未确认':job.status==='queued'?'当前任务已排队':'原执行尚未结束',job.message||'保留原请求，避免重复提交。',job.status==='queued'?[action('cancel-queued','退回待执行',{jobId:job.id}),recheck]:[open(job.threadId),review,recheck]);
  else if(task.status!=='todo')add('TASK_STATE','当前任务需要处理原结果','可在详情中填写反馈并“稍后处理”回到待执行；已完成结果和原轮次继续保留。',[review]);
  try{attachmentPrompt(root,task.attachments??[]);}catch(error){add('ATTACHMENT','附件需要修复',error.message+'。在任务编辑中重新添加，或明确移除不再需要的附件。',[edit]);}
  const plan=state.automation.plans.find(p=>['active','paused'].includes(p.status)&&p.nodes.some(n=>n.taskId===task.id&&!n.jobId&&!n.skipped));
  if(plan?.status==='paused')add('PAUSED','原安排已暂停','当前项尚未发送，可单独手动执行；其余任务继续暂停。',[action('execute','手动执行当前项',{pausedPlanId:plan.id})],false);
  else if(plan)add('PLAN_ACTIVE','当前项已在执行安排中','从原安排查看等待原因；可停止尚未发送的安排后重新选择。',[action('plan','查看原安排')]);
  const routes=Object.values(state.automation.routes??{}).filter(r=>r.projectId===projectId&&(task.sectionId?r.sectionId===task.sectionId:r.unit===task.execution?.unit)&&r.threadId);
  const routed=!!(task.execution||task.sectionId);
  const target=(job&&(active.has(job.status)||task.status!=='todo')?job.threadId:null)??task.pendingContinuation?.threadId??(task.execution?.mode==='fixed'?task.execution.threadId:routed?(routes.length===1?routes[0].threadId:null):state.bindings[projectId]);
  const projected=queue.tasks.find(t=>t.id===task.id)??task;
  const virtual={...projected,status:'queued',taskId:task.id,threadId:target,allowParallel:routed&&task.execution?.parallel!==false,workUnit:routed?moduleKey(task):undefined,writePaths:task.execution?.writePaths??[]};
  for(const other of queue.jobs.filter(j=>j.taskId!==task.id&&active.has(j.status)&&j.status!=='queued')){
    const reason=parallelConflict(virtual,other,queue.tasks);if(!reason)continue;
    const related=other.projectId===projectId||sourcePathsOverlap(virtual,other);if(related)add('RELATED_'+other.id,'相关范围仍被占用',reason+(other.taskTitle?'：'+other.taskTitle:''),other.threadId?[open(other.threadId),recheck]:[recheck]);
  }
  if(job?.status==='queued'){const reason=queuedJobLocalReason(job,queue);if(reason)add('QUEUE_REASON','排队条件尚未满足',reason,[action('cancel-queued','退回待执行',{jobId:job.id}),recheck]);}
  if(!target&&!routed&&!job)add('BINDING','尚未选择执行对话','在项目设置选择并保存本项目的执行对话，再重新检查。',[settings]);
  if(routed&&!target)add('ALLOCATION','执行时分配目标','本项尚未分配对话；执行时仍会核对版块、目录和实际模型。',[edit],false);
  if(target){
    const known=catalog.threads.find(t=>t.id===target);
    if(known&&(known.kind!=='codex'||known.hostId!=='local'||normalize(known.cwd)!==normalize(task.path)))add('TARGET_PROJECT','执行对话归属不匹配','请重新选择本机同项目对话，不能沿用其他项目的绑定。',[settings,edit]);
    else if(readTarget){try{
      const view=await bounded(()=>readTarget(target));const reason=queuedThreadReason({threadId:target,path:task.path},view);
      if(reason)add('TARGET_STATE','执行对话尚未就绪',reason,[open(target),recheck]);
      else if(view.turns?.[0]?.status==='waitingForInput')add('TARGET_INPUT','原对话正在等待回答','请打开原对话完成回答，然后重新检查。',[open(target),recheck]);
      const mismatch=modelReason?.(target);if(mismatch)add('MODEL','执行模型待核对',mismatch,[settings,edit,recheck]);
    }catch(error){add('TARGET_READ','无法确认原对话状态',error.message+'。请打开原对话完成核对，再重新检查；不会根据日志缺失推定已结束。',[open(target),recheck]);}}
  }
  if(task.syncId&&task.status==='todo'&&!task.archivedAt){
    if(!readRemote)add('SYNC_CONFIG','待办同步位置尚未确认','请先在设置核对同步仓库与登录。',[settings]);
    else try{const remote=await bounded(readRemote),record=remote.records.find(r=>r.id===task.syncId),base=state.sync.base.find(r=>r.id===task.syncId),owned=task.syncReserved&&task.syncReservationConfirmed;const changed=!record||(owned?!record.deleted||record.logicalId!==state.workspace.mappings[projectId]?.logicalId:record.deleted||JSON.stringify(record)!==JSON.stringify(base));if(changed)add('REMOTE_CHANGED','远端待办已变化或被领取','先手动同步并核对归属；其他电脑的领取需要在原电脑核对，不会在这里抢占或重复发送。',[action('sync','手动同步'),recheck]);}
    catch(error){add('REMOTE_READ','远端领取检查未完成',error.message+'。检查网络和仓库登录后可手动重试，保留原卡和领取结果。',[settings,recheck]);}
  }
  const canSubmit=!issues.some(i=>i.blocking),allocationRequired=routed&&!target;
  return {taskId,projectId,checkedAt:new Date().toISOString(),targetThreadId:target??null,issues,ready:canSubmit&&!allocationRequired,canSubmit,allocationRequired,manualPausedPlanId:plan?.status==='paused'?plan.id:null,executionRequired:true};
}
