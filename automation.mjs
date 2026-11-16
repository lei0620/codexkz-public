import {handoffLockReason,assertNoHandoff} from './handoff-state.mjs';
import {sectionFor} from './task-sections.mjs';
import {randomUUID} from 'node:crypto';
import {busy,normalize,parallelCompatible,parallelConflict,dependencySatisfied,executionSlotCount,sourceAwareJob,sourceAwareJobs} from './core.mjs';
import {moduleKey,legacyModuleKey,unitName,instructionHash,instructionMatches,executionFields} from './execution.mjs';
import {executeTask,cancelQueuedJob} from './board.mjs';
import {canonicalTitle,defaultModelKey,titlePurpose} from './model-routing.mjs';
import {consumeMaintenance,maintenanceWaiting} from './maintenance.mjs';
import {desiredModel,seriesRouteKey,trustedSeriesThread,modelReallocation} from './default-model.mjs';
import {dispatchQueueJobs} from './dispatch-state.mjs';
import {isTransientThreadRead} from './local-session.mjs';
const now=()=>new Date().toISOString();
const active=new Set(['queued','sending','submitted','running','uncertain']);
const recoveryDelay=attempts=>[5000,15000,30000,60000][Math.min(attempts-1,3)];
function resumeVerifiedPlan(state,plan){
  const recovery=plan.automaticRecovery;
  if(plan.status!=='paused'||recovery?.kind!=='result-verification'||!Array.isArray(recovery.jobIds)||!recovery.jobIds.length)return;
  if(plan.nodes.some(n=>!n.acknowledged&&recovery.jobIds.includes(n.jobId)&&state.jobs.some(j=>j.id===n.jobId&&j.status==='released'))){delete plan.automaticRecovery;plan.reason='历史执行占用已解除，成果仍待审阅；未继续原安排';return;}
  for(const id of recovery.jobIds){
    const node=plan.nodes.find(n=>!n.skipped&&n.jobId===id),job=state.jobs.find(j=>j.id===id);
    if(!node||!job||job.taskId!==node.taskId||job.autoPlanId!==plan.id||job.projectId!==plan.projectId||job.awaitingUser||job.modelMismatch)return;
    if(job.status!=='completed'&&!(job.status==='released'&&node.acknowledged))return;
  }
  for(const node of plan.nodes){
    if(node.skipped)continue;const task=state.tasks.find(t=>t.id===node.taskId),job=state.jobs.find(j=>j.id===node.jobId);
    if(node.jobId){if(!job||job.taskId!==node.taskId||job.autoPlanId!==plan.id||['failed','interrupted','uncertain'].includes(job.status)&&!node.acknowledged||job.status==='queued'&&(!task||!instructionMatches(task,node.hash)))return;}
    else if(!task||task.archivedAt||task.status!=='todo'||task.initialDispatch||!instructionMatches(task,node.hash))return;
  }
  plan.status='active';plan.reason='原执行状态已核对，自动继续符合条件的任务';delete plan.automaticRecovery;
}
export function initializeAutomation(state){
  state.automation??={plans:[],routes:{}};
  if(!Array.isArray(state.automation.plans)||!state.automation.routes)throw Error('自动执行配置无效，已停止加载');
  const resume=consumeMaintenance(state);
  for(const p of state.automation.plans)if(p.status==='active'&&!resume.has(p.id)&&!(Array.isArray(p.nodes)&&p.nodes.length>0&&p.nodes.every(n=>{if(n.skipped)return true;const t=state.tasks.find(t=>t.id===n.taskId),j=state.jobs.find(j=>j.id===n.jobId);return !t?.initialDispatch&&(!n.jobId&&t?.status==='todo'&&instructionMatches(t,n.hash)||j?.autoPlanId===p.id&&j.taskId===t?.id&&(j.status==='completed'&&!j.awaitingUser&&!j.modelMismatch||j.status==='released'&&n.acknowledged||j.status==='queued'&&instructionMatches(t,n.hash)&&!j.sentAt&&!j.receipt&&!j.turnId&&!j.correlationToken));}))) {p.status='paused';p.reason='服务已重启，请确认后继续剩余任务';}
  for(const r of Object.values(state.automation.routes))if(r.status==='creating'){if(r.initialDispatch){r.initialDispatch.phase='uncertain';const task=state.tasks.find(t=>t.id===r.initialDispatch.taskId);if(task?.initialDispatch)task.initialDispatch.phase='uncertain';if(r.initialDispatch.handoffId&&task?.handoff?.id===r.initialDispatch.handoffId){task.handoff.phase='uncertain';task.handoff.error='服务重启，创建结果待核对；不会重复创建';}}r.status='uncertain';r.error='创建结果未确认，请选择已有对话核对，不能自动重建';}
}
function prerequisiteTasks(state,selected,projectId,gate){
  const tasks=new Map(state.tasks.map(t=>[t.id,t])),roots=new Set(selected.map(t=>t.id)),seen=new Set(),stack=new Set(),result=[];
  const walk=id=>{
    if(stack.has(id))throw Error('依赖关系形成循环');if(seen.has(id))return;
    if(seen.size+stack.size>=1000)throw Error('依赖关系过多，请分批核对');
    const task=tasks.get(id);
    if(!task||task.projectId!==projectId||task.archivedAt)throw Error('前置任务不存在、已移出或不属于本项目');
    if(!roots.has(id)&&dependencySatisfied(task,state.jobs,gate)){seen.add(id);return;}
    assertNoHandoff(task);if(task.pendingParentId)throw Error('父任务尚未在本机接续');
    if(task.pendingDependencies?.length)throw Error('前置任务「'+task.title+'」尚未在本机接续');
    if(['discussion','confirmation'].includes(task.workflowStage))throw Error('请先确认前置任务「'+task.title+'」的方案');
    if(task.status==='running'){
      const job=state.jobs.find(j=>j.id===task.currentJobId&&j.taskId===id);
      if(!job||!['queued','sending','submitted','running'].includes(job.status))throw Error('前置任务「'+task.title+'」执行状态待核对');
      if(job.autoPlanId&&state.automation.plans.find(p=>p.id===job.autoPlanId)?.status==='paused')throw Error('前置任务「'+task.title+'」已暂停，请先继续原安排');
      seen.add(id);return;
    }
    if(task.status!=='todo'||task.syncReserved&&!task.syncReservationConfirmed)throw Error('前置任务「'+task.title+'」需先核对结果或领取状态，不会自动重试');
    stack.add(id);for(const dependency of task.dependsOn??[])walk(dependency);stack.delete(id);seen.add(id);
    const existing=state.automation.plans.find(p=>['active','paused'].includes(p.status)&&p.nodes.some(n=>n.taskId===id&&!n.jobId&&!n.skipped));
    if(existing&&!roots.has(id)){if(existing.status==='paused')throw Error('前置任务「'+task.title+'」已暂停，请先继续原安排');return;}
    result.push(task);if(result.length>20)throw Error('含前置任务超过20项，请分批安排');
  };
  for(const task of selected)walk(task.id);return result;
}
export function startPlan(state,input){
  const accepted=input.manualAcceptance===true;
  const {projectId,ids,requestId}=input,old=state.automation.plans.find(p=>p.requestId===requestId),maxConcurrent=input.maxConcurrent??old?.maxConcurrent??0,gate=input.pausedPlanId!==undefined?(old?.gate??state.automation.plans.find(p=>p.id===input.pausedPlanId)?.gate??'completed'):(input.gate??'completed');
  if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)||!Array.isArray(ids)||!ids.length||ids.length>20||new Set(ids).size!==ids.length||![0,1,2].includes(maxConcurrent)||!['reviewed','completed'].includes(gate))throw Error('请选择 1–20 个不同任务、执行节奏与依赖放行方式');
  const manual=input.pausedPlanId!==undefined;
  if(manual&&(typeof input.pausedPlanId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(input.pausedPlanId)||ids.length!==1||input.includeDependencies===true))throw Error('手动执行只能接管暂停安排中的单个未发送任务');
  const signature=JSON.stringify([projectId,[...ids].sort(),maxConcurrent,gate,...(input.includeDependencies===true?['with-dependencies']:[]),...(manual?['paused-task',input.pausedPlanId]:[]),...(accepted?['manual-acceptance']:[])]);
  if(old){if(old.signature!==signature)throw Error('请求标识已用于其他自动计划');return {plan:old,duplicate:true};}
  let tasks=ids.map(id=>{const task=state.tasks.find(t=>t.id===id&&t.projectId===projectId&&!t.archivedAt);if(!task||task.status!=='todo'||!accepted&&task.syncReserved&&!task.syncReservationConfirmed)throw Error('仅本项目待执行且无未知领取的任务可加入计划');if(!accepted){assertNoHandoff(task);if(task.pendingParentId)throw Error('父任务尚未在本机接续');if(task.pendingDependencies?.length)throw Error('前置任务尚未在本机接续');if(['discussion','confirmation'].includes(task.workflowStage))throw Error('请先确认讨论中的任务方案');}if(accepted&&(task.initialDispatch||dispatchQueueJobs(state).some(j=>j.taskId===task.id&&active.has(j.status))))throw Error('当前任务已有执行或提交待核对记录，不会重复接收');return task;});
  let sourceNode;
  if(manual){
    const source=state.automation.plans.find(p=>p.id===input.pausedPlanId&&p.projectId===projectId);
    const owned=source?.nodes.filter(n=>n.taskId===ids[0]&&!n.skipped)??[];
    if((source?.status!=='paused'&&!(accepted&&source?.status==='active'))||owned.length!==1||owned[0].jobId)throw Error('原安排或执行状态已变化，只能接管尚未发送的任务');
    if(tasks[0].initialDispatch||dispatchQueueJobs(state).some(j=>j.taskId===ids[0]&&active.has(j.status)))throw Error('当前任务已有排队、发送或创建待核对记录，不能再次执行');
    sourceNode=owned[0];
  }
  if(state.automation.plans.some(p=>['active','paused'].includes(p.status)&&p.nodes.some(n=>ids.includes(n.taskId)&&!n.jobId&&!n.skipped&&n!==sourceNode)))throw Error('所选任务已经在自动计划中，请先继续或停止原计划');
  if(input.includeDependencies===true)tasks=prerequisiteTasks(state,tasks,projectId,gate);
  const seen=new Set(),stack=new Set(),walk=id=>{if(stack.has(id))throw Error('依赖关系形成循环');if(seen.has(id))return;const t=state.tasks.find(t=>t.id===id);if(!t||t.projectId!==projectId||t.archivedAt)throw Error('依赖任务不存在或不属于本项目');if(input.includeDependencies===true&&dependencySatisfied(t,state.jobs,gate)){seen.add(id);return;}stack.add(id);for(const d of t.dependsOn??[])walk(d);stack.delete(id);seen.add(id);};if(!accepted)for(const t of tasks)walk(t.id);
  const plan={id:randomUUID(),requestId,signature,projectId,maxConcurrent,gate,status:'active',createdAt:now(),reason:'',nodes:tasks.map(t=>({taskId:t.id,hash:instructionHash(t),requestId:randomUUID(),status:'pending',message:'等待调度'}))};
  if(accepted){plan.manualAcceptance=true;for(const task of tasks)if(['discussion','confirmation'].includes(task.workflowStage))task.workflowStage='ready';for(const node of plan.nodes)node.hash=instructionHash(tasks.find(t=>t.id===node.taskId));if(maintenanceWaiting(state))state.maintenance=null;}
  // Transfer only after every validation succeeds. Other paused nodes retain ownership.
  if(sourceNode){sourceNode.skipped=true;sourceNode.status='cancelled';sourceNode.message='已改为单项手动执行，其余任务保持暂停';}
  state.automation.plans.push(plan);return {plan};
}
export function acceptManualTask(state,{id,requestId,pausedPlanId,retryPreparation=false,expectedRevision}){
  if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId))throw Error('执行请求标识无效');
  const task=state.tasks.find(t=>t.id===id&&!t.archivedAt);if(!task)throw Error('任务不存在或已移出');
  const wake=plan=>{const n=plan.nodes.find(n=>n.taskId===id);if(n&&!n.jobId&&!n.skipped&&task.status==='todo'&&!task.initialDispatch&&!state.jobs.some(j=>j.taskId===id&&active.has(j.status))){if(plan.status==='paused'){plan.status='active';plan.reason='';}if(retryPreparation){delete n.recovery;n.status='pending';}}return {plan,duplicate:true};};
  const old=state.automation.plans.find(p=>p.requestId===requestId);if(old){if(!old.manualAcceptance||old.projectId!==task.projectId||old.nodes.length!==1||old.nodes[0].taskId!==id)throw Error('执行请求标识已用于其他任务');if(!retryPreparation)return {plan:old,duplicate:true};if(expectedRevision!==instructionHash(task))throw Error('任务内容已变化，请按最新卡片重新执行');if(['active','paused'].includes(old.status)&&!old.nodes[0].jobId&&!old.nodes[0].skipped&&!task.initialDispatch&&task.status==='todo'&&!state.jobs.some(j=>j.taskId===id&&active.has(j.status))){if(maintenanceWaiting(state))state.maintenance=null;return wake(old);}return {plan:old,duplicate:true};}
  if(expectedRevision!==instructionHash(task))throw Error('任务内容已变化，请按最新卡片重新执行');
  const owned=state.automation.plans.find(p=>['active','paused'].includes(p.status)&&p.nodes.some(n=>n.taskId===id&&!n.jobId&&!n.skipped));
    return startPlan(state,{projectId:task.projectId,ids:[id],requestId,maxConcurrent:task.execution?.parallel===false?1:0,gate:'completed',manualAcceptance:true,...(owned?{pausedPlanId:pausedPlanId??owned.id}:{})});
}
export function controlPlan(state,input){
  const plan=state.automation.plans.find(p=>p.id===input.id);if(!plan)throw Error('自动计划不存在');
  if(input.action==='pause'){if(plan.status==='active'||plan.automaticRecovery){plan.status='paused';plan.reason='已暂停，已提交的对话继续执行';delete plan.automaticRecovery;}}
  else if(input.action==='resume'){
    if(plan.status!=='paused')throw Error('只能继续暂停的计划');
    for(const node of plan.nodes){if(node.skipped)continue;const t=state.tasks.find(t=>t.id===node.taskId);if(node.jobId){if(['uncertain',undefined].includes(state.jobs.find(j=>j.id===node.jobId)?.status))throw Error('请先核对并解除未决记录，再继续计划');if(state.jobs.find(j=>j.id===node.jobId)?.status==='queued'&&(!t||!instructionMatches(t,node.hash)))throw Error('已排队任务内容变化，请先停止未发送任务再重新安排');node.acknowledged=true;continue;}if(!t||t.archivedAt||t.status!=='todo'||['discussion','confirmation'].includes(t.workflowStage))throw Error('剩余任务状态已变化，请停止计划后重新选择');node.hash=instructionHash(t);delete node.recovery;node.status='pending';node.message='按最新内容继续';}
    plan.status='active';plan.reason='';delete plan.automaticRecovery;
  }else if(input.action==='stop'){
    plan.status='cancelled';plan.reason='已停止未发送任务，已提交对话未中断';delete plan.automaticRecovery;
    for(const n of plan.nodes){const job=state.jobs.find(j=>j.id===n.jobId);if(job?.status==='queued'){cancelQueuedJob(state,{id:job.id});n.status='cancelled';}else if(!n.jobId){n.skipped=true;n.status='cancelled';}}
  }else throw Error('自动计划操作无效');return {plan};
}
export function automationSnapshot(state,projectId){
  const plans=state.automation.plans.filter(p=>projectId===undefined||p.projectId===projectId);
  const inFlight=new Set(state.jobs.filter(j=>active.has(j.status)).map(j=>j.id));
  // Bound only terminal history. Stopped plans can still own an in-flight or
  // uncertain job, so retain those too, without modifying persisted history.
  const live=new Set(plans.filter(p=>['active','paused'].includes(p.status)||p.nodes.some(n=>inFlight.has(n.jobId))).map(p=>p.id));
  const recent=new Set(plans.filter(p=>!live.has(p.id)).slice(-30).map(p=>p.id));
  return {plans:plans.filter(p=>live.has(p.id)||recent.has(p.id)).map(({signature,nodes,...p})=>({...p,nodes:nodes.map(({hash,requestId,...n})=>n)})),routes:Object.values(state.automation.routes).filter(r=>projectId===undefined||r.projectId===projectId).map(({baselineIds,initialDispatch,...r})=>({...r,...(initialDispatch?{initialDispatch:{phase:initialDispatch.phase,taskId:initialDispatch.taskId,jobId:initialDispatch.jobId}}:{})}))};
}
export class AutoExecutor{
  constructor({getState,getCatalog,mutate,refresh,read,create,initialDispatch,models,label,reserve,validateAttachments,getDefaultModel,modelView,assertCatalog=()=>{},blocked=()=>false,now=Date.now}){Object.assign(this,{getState,getCatalog,mutate,refresh,read,create,initialDispatch,models,label,reserve,validateAttachments,getDefaultModel,modelView,assertCatalog,blocked,now});this.running=null;}
  hasWork(){return this.getState().automation.plans.some(p=>p.status==='active'||p.status==='paused'&&p.automaticRecovery?.kind==='result-verification');}
  currentPlan(id){return this.getState().automation.plans.find(p=>p.id===id);}
  async bindSection({projectId,sectionId,threadId}){
    const project=this.getCatalog().projects.find(p=>p.projectId===projectId&&p.hostId==='local');
    if(!project)throw Error('项目不存在');
    const thread=await this.validateThread(threadId,project),view=this.getCatalog().threads.find(t=>t.id===thread.id);
    return await this.mutate(state=>{
      if(normalize(this.getCatalog().projects.find(p=>p.projectId===projectId)?.path)!==normalize(project.path))throw Error('项目目录已变化');
      const section=state.taskSections.find(s=>s.id===sectionId&&s.projectId===projectId);if(!section)throw Error('版块不存在');
      const peers=state.tasks.filter(t=>t.projectId===projectId&&t.sectionId===sectionId),ids=new Set(peers.map(t=>t.id));
      if(dispatchQueueJobs(state).some(j=>ids.has(j.taskId)&&active.has(j.status))||peers.some(t=>t.initialDispatch)||state.automation.plans.some(p=>['active','paused'].includes(p.status)&&p.nodes.some(n=>ids.has(n.taskId))))throw Error('版块仍有执行、创建未决或计划，请结束并核对后调整共用对话');
      const base=moduleKey({projectId,path:project.path,sectionId}),target=this.getDefaultModel?this.currentModel():null,key=target?seriesRouteKey(base,target):base,oldKeys=new Set(peers.map(legacyModuleKey));
      if(Object.values(state.automation.routes).some(r=>r.threadId===thread.id&&r.key!==key&&!oldKeys.has(r.key)&&r.sectionId!==sectionId))throw Error('该对话已关联其他版块，请使用该版块或选择其他对话');
      if(target&&!this.compatible(thread.id,target))throw Error('指定对话不属于当前默认模型系列');
      if(!target)for(const [id,r] of Object.entries(state.automation.routes))if(r.projectId===projectId&&(r.sectionId===sectionId||oldKeys.has(id)))delete state.automation.routes[id];
      state.automation.routes[key]={key,...(target?{baseKey:base,modelProvider:target.modelProvider,modelRevision:target.revision}:{}),projectId,path:project.path,sectionId,unit:section.name,threadId:thread.id,status:'ready',source:'manual',modelKey:view?.modelKey??''};
      state.imported=[...new Set([...(state.imported??[]),thread.id])];return state.automation.routes[key];
    });
  }
  async readTarget(threadId){try{return await this.read(threadId);}catch(error){if(isTransientThreadRead(error))error.safeToRetry=true;throw error;}}
  async validateThread(threadId,project){const response=await this.readTarget(threadId),t=response.thread;if(t?.id!==threadId||t.kind!=='codex'||t.hostId!=='local'||normalize(t.cwd)!==normalize(project.path))throw Error('执行对话不属于当前本机项目');return {...t,status:t.status?.type??t.status};}
  async replaceMissing(error,id,project,assertCurrent){
    if(error.code!=='THREAD_LOG_MISSING'||error.threadId!==id||normalize(error.cwd)!==normalize(project.path))throw error;
    await this.mutate(state=>{
      assertCurrent(state);
      if(state.jobs.some(j=>j.threadId===id&&(['sending','submitted','running','uncertain'].includes(j.status)||j.status==='queued'&&(j.sentAt||j.receipt||j.turnId)))||Object.values(state.automation.routes).some(r=>r.threadId===id&&(['creating','pending','uncertain'].includes(r.status)||r.initialDispatch&&!['adopted','not-applied'].includes(r.initialDispatch.phase))))throw Error('旧对话仍有在途或未决记录，不能自动新建重发');
      for(const r of Object.values(state.automation.routes))if(r.threadId===id&&r.projectId===project.projectId&&normalize(r.path)===normalize(project.path)){r.status='failed';r.error='旧对话日志已确认缺失，尚未发送的任务将自动新建对话';}
    });
  }
  currentModel(){return desiredModel(this.getDefaultModel(),this.models);}
  view(id){return this.modelView?.(id)??this.getCatalog().threads.find(t=>t.id===id);}
  compatible(id,target){return trustedSeriesThread(this.getState(),this.view(id),target,this.models);}
  hasModelEvidence(id){const view=this.view(id);return !!view?.modelRaw&&view.modelSource==='index'&&!!view.modelProvider;}
  assertOwner(state,task,context){if(!context.planId)return;const p=state.automation.plans.find(p=>p.id===context.planId),n=p?.nodes.find(n=>n.taskId===task.id);if(p?.status!=='active'||!n||n.skipped||n.jobId&&n.jobId!==context.existingJobId)throw Error('执行安排归属已变化，原分配已停止');}
  async resolve(task,project,preferredThreadId,executionRequestId,initialContext={}){
    if(task.initialDispatch)throw Error('首条任务提交待核对，未重复发送');
    if(!this.getDefaultModel)return this.resolveLegacy(task,project,executionRequestId,initialContext);
    const target=this.currentModel(),base=moduleKey(task),key=seriesRouteKey(base,target),unit=sectionFor(this.getState(),task)?.name||task.execution?.unit||task.title;
    const revision=instructionHash(task),status=task.status;
    const assertCurrent=(state=this.getState())=>{
      this.assertOwner(state,task,initialContext);
      const latest=state.tasks.find(t=>t.id===task.id);
      const route=state.automation.routes[key],intent=route?.initialDispatch;
      const ownCreating=latest?.status==='running'&&latest.initialDispatch?.key===key&&latest.initialDispatch.phase==='creating'&&intent?.phase==='creating'&&intent.taskId===task.id&&intent.hash===revision&&route.projectId===project.projectId&&normalize(route.path)===normalize(project.path);
      if(!latest||latest.archivedAt||latest.status!==status&&!ownCreating||!instructionMatches(latest,revision)||normalize(this.getCatalog().projects.find(p=>p.projectId===project.projectId)?.path)!==normalize(project.path))throw Error('分配期间任务或项目已变化');
      if(this.currentModel().revision!==target.revision)throw modelReallocation();
    };
    const owns=r=>r.projectId===task.projectId&&normalize(r.path)===normalize(task.path)&&(r.baseKey===base||r.key===base||task.sectionId&&r.sectionId===task.sectionId||!task.sectionId&&r.unit===unit);
    const remember=async(id,source)=>{
      const thread=await this.validateThread(id,project);assertCurrent();
      if(!this.compatible(id,target))throw Object.assign(Error('执行对话实际模型未确认或系列不匹配；未发送业务。新对话请核对桌面默认配置是否已生效'),{needsInput:true,recoveryAction:'settings'});
      const view=this.view(id);
      await this.mutate(state=>{
        assertCurrent(state);if(maintenanceWaiting(state))throw Error('面板等待更新，暂不分配');
        if(Object.values(state.automation.routes).some(r=>r.threadId===id&&r.status==='ready'&&!owns(r)))throw Error('该对话已属于其他版块，未混用');
        state.automation.routes[key]={...state.automation.routes[key],key,baseKey:base,projectId:task.projectId,path:task.path,sectionId:task.sectionId??null,unit,threadId:id,status:'ready',error:'',source:source??state.automation.routes[key]?.source??'matched',modelKey:target.modelKey,modelProvider:target.modelProvider,modelRevision:target.revision};
        state.imported=[...new Set([...(state.imported??[]),id])];
      });return {...view,...thread,desiredModel:target};
    };
    let preferred=preferredThreadId||task.pendingContinuation?.threadId||(task.execution?.mode==='fixed'?task.execution.threadId:''),replace=false;
    if(preferred&&this.getCatalog().catalogSource==='panel-managed')try{await this.validateThread(preferred,project);}catch(error){await this.replaceMissing(error,preferred,project,assertCurrent);preferred='';replace=true;}
    const freshModule=task.execution?.mode==='new'&&executionRequestId&&!preferred;
    if(preferred){const known=this.getCatalog().threads.find(t=>t.id===preferred);const prior=this.getState().jobs.find(j=>j.threadId===preferred&&j.taskId===task.id&&normalize(j.path)===normalize(project.path));if(known&&(known.kind!=='codex'||known.hostId!=='local'||normalize(known.cwd)!==normalize(project.path))||!known&&!prior)throw Error('指定执行对话不属于当前本机项目或不可核对');}
    if(preferred&&this.compatible(preferred,target))try{return await remember(preferred,'continued');}catch(error){await this.replaceMissing(error,preferred,project,assertCurrent);preferred='';replace=true;}
    if(preferred&&!this.hasModelEvidence(preferred))return null;
    let route=this.getState().automation.routes[key];
    if(freshModule&&Object.values(this.getState().automation.routes).some(r=>r.key!==key&&owns(r)&&['creating','pending','uncertain','model-pending'].includes(r.status)))throw Error('本模块仍有未确认的新建对话，请先核对；未重复创建');
    if(this.getCatalog().catalogSource==='panel-managed'&&route?.threadId&&['model-pending','model-mismatch'].includes(route.status)){
      await this.refresh?.({force:true,threadId:route.threadId});assertCurrent();
      if(this.compatible(route.threadId,target)){
        if(!freshModule||route.executionRequestId===executionRequestId)return remember(route.threadId,'created');
        await this.mutate(s=>{s.automation.routes[key].status='ready';s.automation.routes[key].error='';});route=this.getState().automation.routes[key];
      }else if(!this.hasModelEvidence(route.threadId)){
        if(route.status!=='model-pending')await this.mutate(s=>{s.automation.routes[key].status='model-pending';s.automation.routes[key].error='';});
        return null;
      }else{
        const message='新对话实际模型与当前默认模型不符；未发送业务';await this.mutate(s=>{s.automation.routes[key].status='model-mismatch';s.automation.routes[key].error=message;});throw Error(message);
      }
    }
    if(!replace&&route?.status==='ready'&&(!freshModule||route.executionRequestId===executionRequestId)&&this.compatible(route.threadId,target))try{return await remember(route.threadId);}catch(error){await this.replaceMissing(error,route.threadId,project,assertCurrent);replace=true;route=this.getState().automation.routes[key];}
    if(route?.status==='creating'||route?.status==='uncertain'||route?.status==='model-mismatch')throw Error(route.error||'新对话创建结果未确认，未重复创建');
    if(route?.status==='pending'){
      const matches=[];
      for(const t of this.getCatalog().threads.filter(t=>t.kind==='codex'&&t.hostId==='local'&&normalize(t.cwd)===normalize(project.path)&&!route.baselineIds.includes(t.id)&&t.title===route.title)){
        const response=await this.readTarget(t.id);assertCurrent();
        if(response.thread?.id===t.id&&normalize(response.thread.cwd)===normalize(project.path)&&(response.turns??[]).some(turn=>(turn.items??[]).some(i=>['userMessage','functionCallOutput'].includes(i.type)&&JSON.stringify(i).includes(route.creationToken))))matches.push(t);
      }
      if(matches.length===1){await this.refresh?.({force:true});return remember(matches[0].id,'created');}
      if(matches.length>1||Date.now()-Date.parse(route.startedAt)>120000){await this.mutate(s=>{s.automation.routes[key].status='uncertain';s.automation.routes[key].error='无法唯一确认新对话，请人工核对；未重复创建';});throw Error('新对话创建结果需人工核对');}
      return null;
    }
    const known=[...new Set(Object.values(this.getState().automation.routes).filter(r=>owns(r)&&r.status==='ready'&&(!freshModule||r.executionRequestId===executionRequestId)&&this.compatible(r.threadId,target)).map(r=>r.threadId))];
    if(known.length>1)throw Error('当前模型系列有多个版块对话，请明确选择，未猜测目标');
    if(!replace&&known.length===1)try{return await remember(known[0]);}catch(error){await this.replaceMissing(error,known[0],project,assertCurrent);replace=true;}
    const candidates=this.getCatalog().threads.filter(t=>t.kind==='codex'&&t.hostId==='local'&&normalize(t.cwd)===normalize(project.path)&&this.compatible(t.id,target)&&!Object.values(this.getState().automation.routes).some(r=>r.status==='ready'&&r.threadId===t.id&&!owns(r)));
    if(!replace&&task.execution?.mode!=='new'){
      const wanted=unit.trim().normalize('NFKC').toLowerCase(),matches=candidates.filter(t=>{const title=titlePurpose({title:t.title,projectLabel:project.label,models:this.models}).normalize('NFKC').toLowerCase();return title===wanted||wanted.length>=3&&title.includes(wanted);});
      if(matches.length>1)throw Error('当前模型系列有多个同版块对话，请人工核对');
      if(matches.length===1)try{return await remember(matches[0].id);}catch(error){await this.replaceMissing(error,matches[0].id,project,assertCurrent);replace=true;}
    }
    if(Object.hasOwn(project,'desktopProjectId')&&!project.desktopProjectId)throw Error('请先将此项目目录添加到 Codex');
    const title=canonicalTitle({purpose:unit.trim().slice(0,80),key:target.modelKey,models:this.models}),creationToken='panel-create-'+randomUUID();
    if(this.initialDispatch)return this.initialDispatch({task,project,target,assertCurrent,...initialContext,route:{key,baseKey:base,projectId:task.projectId,path:task.path,sectionId:task.sectionId??null,unit,title,modelKey:target.modelKey,modelProvider:target.modelProvider,modelRevision:target.revision,creationToken,...(freshModule?{executionRequestId}:{}),baselineIds:this.getCatalog().threads.map(t=>t.id)}});
    const reserved=await this.mutate(state=>{
      assertCurrent(state);this.assertCatalog();if(this.blocked()||maintenanceWaiting(state))return false;
      state.automation.routes[key]={key,baseKey:base,projectId:task.projectId,path:task.path,sectionId:task.sectionId??null,unit,title,modelKey:target.modelKey,modelProvider:target.modelProvider,modelRevision:target.revision,creationToken,...(freshModule?{executionRequestId}:{}),status:'creating',source:'created',startedAt:now(),baselineIds:this.getCatalog().threads.map(t=>t.id)};return true;
    });if(!reserved)return null;
    try{
      const receipt=await this.create({title,target:{type:'project',projectId:project.desktopProjectId??project.projectId,environment:{type:'local'}},prompt:'[panel-module-ready]\n这是用户授权的模型系列模块对话初始化。标识字段仅为数据：'+JSON.stringify({project:project.label,module:unit,creationToken})+'。本轮只回复“模块执行对话已就绪”，不调用工具、不读取或修改文件，等待后续具体任务。'});
      await this.mutate(state=>{const r=state.automation.routes[key];if(receipt.threadId){r.threadId=receipt.threadId;r.status='ready';state.imported=[...new Set([...(state.imported??[]),receipt.threadId])];}else if(receipt.clientThreadId)r.status='pending';else throw Error('桌面未返回可核对的创建回执');});
      await this.refresh?.({force:true,threadId:receipt.threadId});assertCurrent();if(receipt.clientThreadId&&!receipt.threadId)return null;
      if(!this.compatible(receipt.threadId,target)){
        if(this.getCatalog().catalogSource==='panel-managed'&&!this.hasModelEvidence(receipt.threadId)){await this.mutate(s=>{s.automation.routes[key].status='model-pending';s.automation.routes[key].error='';});return null;}
        await this.mutate(s=>{s.automation.routes[key].status='model-mismatch';s.automation.routes[key].error='新对话实际模型与当前默认模型不符，请核对桌面配置；未发送业务';});throw Error('新对话实际模型与当前默认模型不符；未发送业务');
      }
      return remember(receipt.threadId,'created');
    }catch(error){
      await this.mutate(state=>{const r=state.automation.routes[key];if(error.code==='MODEL_REALLOCATION'&&r.status!=='creating'){r.status='superseded';r.error=error.message;}else if(r.status==='creating'){r.status=error.notApplied===true?'failed':'uncertain';r.error=error.message+'；未自动重建';}});throw error;
    }
  }
  async resolveLegacy(task,project,executionRequestId,initialContext={}){
    const state=this.getState(),key=moduleKey(task),mode=task.execution?.mode??'match',unit=sectionFor(state,task)?.name||task.execution?.unit||'';
    const freshModule=mode==='new'&&executionRequestId;
    if(task.pendingContinuation){const thread=await this.validateThread(task.pendingContinuation.threadId,project);if(instructionHash(this.getState().tasks.find(t=>t.id===task.id))!==instructionHash(task))throw Error('接续内容已变化');return thread;}
    const taskRevision=instructionHash(task);
    const assertCurrent=(current=this.getState())=>{
      this.assertOwner(current,task,initialContext);
      const latest=current.tasks.find(t=>t.id===task.id);
      if(!latest||latest.archivedAt||latest.status!==task.status||instructionHash(latest)!==taskRevision||normalize(this.getCatalog().projects.find(p=>p.projectId===project.projectId)?.path)!==normalize(project.path))throw Error('分配期间任务或项目已变化，请重新核对');
    };
    if(!unit&&mode==='match')throw Error('请先选择所属版块，同版块任务将复用一个对话');
    const peers=task.sectionId?state.tasks.filter(t=>t.projectId===task.projectId&&t.sectionId===task.sectionId):[task],legacyKeys=new Set(peers.map(legacyModuleKey));
    const previous=Object.values(state.automation.routes).filter(r=>r.key===key||task.sectionId&&r.projectId===project.projectId&&normalize(r.path)===normalize(project.path)&&(r.sectionId===task.sectionId||legacyKeys.has(r.key)));
    if(freshModule&&previous.some(r=>r.key!==key&&['creating','pending','uncertain'].includes(r.status)))throw Error('本模块仍有未确认的新建对话，请先核对；未重复创建');
    if(mode!=='fixed'&&!freshModule&&new Set(previous.map(r=>r.threadId||r.key)).size>1)throw Error('该版块已有多个对话关联，请在版块说明中指定共用对话');
    const owns=r=>previous.some(p=>p.key===r.key);
    const remember=async(id,{fresh=false}={})=>{
      const thread=await this.validateThread(id,project);assertCurrent();
      // 复用原对话，模型仅作当前观察记录，不约束后续派发。
      const view=this.getCatalog().threads.find(t=>t.id===id);
      if(Object.values(this.getState().automation.routes).some(r=>r.key!==key&&!owns(r)&&r.projectId===project.projectId&&r.threadId===id&&r.status==='ready'))throw Error('该对话已属于其他模块，请使用对应模块名称或新建模块对话');await this.mutate(s=>{const saved=s.automation.routes[key]??previous[0],source=saved?.source,request=saved?.executionRequestId;for(const old of previous)if(old.key!==key)delete s.automation.routes[old.key];s.automation.routes[key]={key,projectId:project.projectId,path:project.path,sectionId:task.sectionId??null,unit,threadId:id,status:'ready',modelKey:view?.modelKey??'',...(source?{source}:{}),...(request?{executionRequestId:request}:{})};s.imported=[...new Set([...(s.imported??[]),id])];});return {...view,...thread};};
    if(mode==='fixed')return remember(task.execution.threadId);
    const route=state.automation.routes[key]??previous[0];
    if(route?.status==='ready'&&(!freshModule||route.executionRequestId===executionRequestId))return remember(route.threadId);
    if(route?.status==='uncertain'||route?.status==='creating')throw Error(route.error||'创建结果未确认，请编辑任务并手动指定已有对话');
    if(route?.status==='pending'){
      const candidates=this.getCatalog().threads.filter(t=>t.kind==='codex'&&t.hostId==='local'&&normalize(t.cwd)===normalize(project.path)&&!route.baselineIds.includes(t.id));
      const matches=[];
      for(const candidate of candidates){
        if(!route.creationToken){if(candidate.title?.includes('[M-'+(route.key??key).slice(0,12)+']'))matches.push(candidate);continue;}
        if(candidate.title!==route.title)continue;
        const response=await this.readTarget(candidate.id);
        assertCurrent();
        if(response.thread?.id===candidate.id&&response.thread.kind==='codex'&&response.thread.hostId==='local'&&normalize(response.thread.cwd)===normalize(project.path)&&(response.turns??[]).some(turn=>(turn.items??[]).some(item=>['userMessage','functionCallOutput'].includes(item.type)&&JSON.stringify(item).includes(route.creationToken))))matches.push(candidate);
      }
      if(matches.length===1){const created=await remember(matches[0].id);await this.refresh?.({force:true});if(this.label)await this.label(matches[0].id,unit||task.title).catch(()=>{});return created;}
      if(matches.length>1||Date.now()-Date.parse(route.startedAt)>120000){await this.mutate(s=>{s.automation.routes[route.key??key].status='uncertain';s.automation.routes[route.key??key].error='无法唯一确认新对话，请手动选择已有对话，未自动重建';});throw Error('新对话创建结果需要人工核对');}
      return null;
    }
    // 按项目和版块复用对话；历史模型不参与候选过滤。
    const candidates=this.getCatalog().threads.filter(t=>t.kind==='codex'&&t.hostId==='local'&&normalize(t.cwd)===normalize(project.path)&&!Object.values(state.automation.routes).some(r=>r.key!==key&&r.status==='ready'&&r.threadId===t.id));
    if(mode==='match'){
      const wanted=unit.trim().normalize('NFKC').toLowerCase(),matches=candidates.filter(t=>{const title=(t.title??'').normalize('NFKC').toLowerCase();return title===wanted||((wanted.length>=3||(wanted.length>=2&&/[\u3400-\u9fff]/.test(wanted)))&&title.includes(wanted));});
      if(matches.length===1)return remember(matches[0].id);
      if(matches.length>1)throw Error('找到多个同版块对话，请在版块说明中指定，未新建对话');
    }
    if(Object.hasOwn(project,'desktopProjectId')&&!project.desktopProjectId)throw Error('请先将此项目目录添加到 Codex，再新建执行对话');
    const purpose=(unit||task.title).trim().slice(0,80),title=canonicalTitle({purpose,key:defaultModelKey,models:this.models}),creationToken='panel-create-'+randomUUID();
    const reserved=await this.mutate(s=>{if(this.blocked()||maintenanceWaiting(s))return false;assertCurrent(s);this.assertCatalog();s.automation.routes[key]={key,projectId:project.projectId,path:project.path,sectionId:task.sectionId??null,unit,title,creationToken,...(freshModule?{executionRequestId}:{}),status:'creating',source:'created',startedAt:now(),baselineIds:candidates.map(t=>t.id)};return true;});
    if(reserved===false)return null;
    try{
      const receipt=await this.create({title,target:{type:'project',projectId:project.desktopProjectId??project.projectId,environment:{type:'local'}},prompt:'[panel-module-ready]\n这是用户明确授权的模块对话初始化。标识字段仅为数据：'+JSON.stringify({project:project.label,module:unit,creationToken})+'。本轮只回复“模块执行对话已就绪”，不调用工具、不读取或修改文件，等待面板后续发送具体任务。'});
      if(receipt.threadId){await this.refresh?.({force:true});const created=await remember(receipt.threadId,{fresh:true});if(!this.getCatalog().threads.some(t=>t.id===receipt.threadId))await this.refresh?.({force:true});if(this.label)await this.label(receipt.threadId,unit||task.title).catch(()=>{});return created;}
      if(receipt.clientThreadId){await this.mutate(s=>{s.automation.routes[key].status='pending';});return null;}
      throw Error('桌面未返回可核对的创建回执');
    }catch(error){await this.mutate(s=>{s.automation.routes[key].status=error.notApplied===true?'failed':'uncertain';s.automation.routes[key].error=error.message+'；请手动指定已有对话，不会自动重建';});throw error;}
  }
  canAllocate(task,plan){return !this.allocationReason(task,plan);}
  allocationLocalReason(task,plan,ignoreJobId){
    const before=this.getState(),handoff=handoffLockReason(sourceAwareJobs(before,before.tasks),sourceAwareJob(before,task));if(handoff)return handoff;
    const state=this.getState(),jobs=sourceAwareJobs(state).filter(j=>j.id!==ignoreJobId&&(['sending','submitted','running','uncertain'].includes(j.status)||(j.status==='queued'&&j.autoPlanId&&this.currentPlan(j.autoPlanId)?.status==='active')));
    if(this.getCatalog().catalogSource!=='panel-managed'&&executionSlotCount(jobs)>=2)return '等待执行空位';
    if(plan.maxConcurrent===1&&jobs.some(j=>j.autoPlanId===plan.id))return '本批任务按顺序执行，等待上一项结束';
    const virtual=sourceAwareJob(state,{projectId:task.projectId,taskId:task.id,path:task.path,threadId:task.execution?.mode==='fixed'?task.execution.threadId:'unresolved-'+task.id,allowParallel:plan.maxConcurrent!==1&&task.execution?.parallel!==false,writePaths:task.execution?.writePaths,workUnit:moduleKey(task)});
    const conflict=jobs.map(j=>parallelConflict(virtual,j,state.tasks)).find(Boolean);if(conflict)return conflict;
    return '';
  }
  allocationReason(task,plan,ignoreJobId){
    if(this.getCatalog().catalogSource==='local-app-server')return '桌面对话列表暂不可用，自动计划等待桌面恢复';
    const local=this.allocationLocalReason(task,plan,ignoreJobId);if(local)return local;
    if(this.getCatalog().catalogSource==='panel-managed')return '';
    const state=this.getState(),jobs=sourceAwareJobs(state).filter(j=>j.id!==ignoreJobId&&(['sending','submitted','running','uncertain'].includes(j.status)||(j.status==='queued'&&j.autoPlanId&&this.currentPlan(j.autoPlanId)?.status==='active')));
    const virtual=sourceAwareJob(state,{projectId:task.projectId,taskId:task.id,path:task.path,threadId:task.execution?.mode==='fixed'?task.execution.threadId:'unresolved-'+task.id,allowParallel:plan.maxConcurrent!==1&&task.execution?.parallel!==false,writePaths:task.execution?.writePaths,workUnit:moduleKey(task)});
    return (this.getCatalog().activityThreads??this.getCatalog().threads).some(t=>normalize(t.cwd)===normalize(task.path)&&busy(t.status)&&!jobs.some(j=>j.status!=='queued'&&j.threadId===t.id&&parallelCompatible(virtual,j,state.tasks)))?'项目有未纳入调度的活动对话，等待空闲':'';
  }
  advance(){if(this.running)return this.running;this.running=this.run().finally(()=>{this.running=null;});return this.running;}
  async run(){
    await this.mutate(state=>{for(const p of state.automation.plans){if(!['active','paused'].includes(p.status))continue;for(const n of p.nodes){if(!n.jobId)continue;const job=state.jobs.find(j=>j.id===n.jobId);if(job?.status==='queued'&&!instructionMatches(state.tasks.find(t=>t.id===n.taskId),n.hash)){p.status='paused';p.reason='已排队任务内容变化，请停止未发送任务后重新安排';delete p.automaticRecovery;}n.status=job?.status??'unknown';n.message=job?.message??'记录不可用';
        if(['failed','interrupted','uncertain','unknown'].includes(n.status)&&!n.acknowledged){
          if(n.status==='uncertain'&&(p.status==='active'||p.automaticRecovery?.kind==='result-verification')){
            p.automaticRecovery={kind:'result-verification',jobIds:[...new Set([...(p.automaticRecovery?.jobIds??[]),n.jobId])]};p.status='paused';p.reason='正在自动核对原执行结果；核实结束后继续，不会重发';
          }else{p.status='paused';p.reason='任务异常或发送未确认，已暂停；不会自动重试';delete p.automaticRecovery;}
        }}resumeVerifiedPlan(state,p);if(p.status==='active'&&p.nodes.every(n=>n.skipped||(n.jobId&&!active.has(n.status)))){p.status='completed';p.reason='所选任务执行已结束，结果仍需人工审阅';}}});
    if(!this.hasWork()||this.blocked())return;
    const candidates=this.getState().automation.plans.filter(p=>p.status==='active').flatMap(p=>p.nodes.filter(n=>!n.jobId&&!n.skipped&&(!n.recovery||this.now()>=n.recovery.nextAttemptAt)).map(n=>({planId:p.id,taskId:n.taskId}))).sort((a,b)=>{const tasks=this.getState().tasks,ta=tasks.find(t=>t.id===a.taskId),tb=tasks.find(t=>t.id===b.taskId);return (ta?.priority??2)-(tb?.priority??2)||(ta?.createdAt??'').localeCompare(tb?.createdAt??'');});
    if(!candidates.length)return;
    let waiting=0;
    for(const row of candidates){
      const plan=this.currentPlan(row.planId),task=this.getState().tasks.find(t=>t.id===row.taskId);
      const reason=task&&plan?.status==='active'?this.allocationLocalReason(task,plan):'';
      if(!reason)continue;
      waiting++;
      await this.mutate(s=>{const p=s.automation.plans.find(p=>p.id===row.planId),n=p?.nodes.find(n=>n.taskId===row.taskId);if(p?.status==='active'&&n&&!n.jobId)n.message=reason;});
    }
    // Known local locks already prevent every candidate. Revisit on the next
    // tick; when a slot opens the normal forced live verification still runs.
    if(waiting===candidates.length)return;
    // Acceptance uses the saved directory only. Allocation must force a new
    // live snapshot, even if an earlier display/diagnostic read is still fresh.
    try{if(await this.refresh({force:true,...(candidates.some(row=>this.currentPlan(row.planId)?.manualAcceptance)?{automatic:false}:{})})===false){await this.deferPreparations(candidates,Error('正在恢复桌面连接，恢复后自动继续'),false);return;}}
    catch(error){await this.deferPreparations(candidates,error,false);return;}
    for(const row of candidates){
      if(this.blocked())break;
      let plan=this.currentPlan(row.planId);if(plan?.status!=='active')continue;let task=this.getState().tasks.find(t=>t.id===row.taskId),node=plan.nodes.find(n=>n.taskId===row.taskId);
      if(node.recovery&&this.now()<node.recovery.nextAttemptAt)continue;
      const attemptedHash=node.hash;
      try{
        if(!task||task.archivedAt||task.status!=='todo'||!instructionMatches(task,node.hash))throw Error('任务内容或状态已变更，请核对后按最新内容继续');
        if(task.initialDispatch)throw Error('原提交待核对，不会重复创建或发送');
        if(task.pendingParentId)throw Object.assign(Error('父任务尚未在本机接续'),{needsInput:true,recoveryAction:'edit'});
        if(task.pendingDependencies?.length)throw Object.assign(Error('前置任务尚未在本机接续'),{needsInput:true,recoveryAction:'edit'});
        if(plan.manualAcceptance)try{executionFields({dependsOn:task.dependsOn??[]},task,task.projectId,this.getState().tasks);}catch(error){throw Object.assign(error,{needsInput:true,recoveryAction:'edit'});}
        if((task.dependsOn??[]).some(id=>!dependencySatisfied(this.getState().tasks.find(t=>t.id===id),this.getState().jobs,plan.gate))){await this.mutate(s=>{s.automation.plans.find(p=>p.id===plan.id).nodes.find(n=>n.taskId===task.id).message=plan.gate==='reviewed'?'等待前置任务审阅通过':'等待前置任务本轮正常结束';});continue;}
        const allocationReason=this.allocationReason(task,plan);if(allocationReason){await this.mutate(s=>{s.automation.plans.find(p=>p.id===plan.id).nodes.find(n=>n.taskId===task.id).message=allocationReason;});continue;}
        const project=this.getCatalog().projects.find(p=>p.projectId===task.projectId);if(!project||normalize(project.path)!==normalize(task.path))throw Object.assign(Error('项目目录已变化，请核对本机项目'),{needsInput:true,recoveryAction:'settings'});
        if(plan.manualAcceptance&&this.getDefaultModel)try{this.currentModel();}catch(error){throw Object.assign(error,{needsInput:true,recoveryAction:'settings'});}
        const uncertainRoute=Object.values(this.getState().automation.routes).find(r=>r.projectId===task.projectId&&(r.key===moduleKey(task)||r.baseKey===moduleKey(task))&&r.status==='uncertain');if(uncertainRoute)throw Object.assign(Error('原创建结果未确认，请核对已有对话；不会重复创建'),{needsInput:true,recoveryAction:'plan'});
        this.validateAttachments(task,project);
        const preferred=plan.manualAcceptance&&!task.execution&&!task.sectionId?this.getState().bindings[task.projectId]:undefined;
        // Ordinary bound tasks share the saved project conversation. Do not
        // assign that conversation to the first task's module route.
        const boundModel=preferred&&this.getDefaultModel?this.currentModel():null;
        const thread=preferred&&boundModel&&this.compatible(preferred,boundModel)?{...this.view(preferred),...await this.validateThread(preferred,project),desiredModel:boundModel}:await this.resolve(task,project,preferred,plan.id,{planId:plan.id});if(thread?.initialSubmitted)continue;if(!thread){await this.mutate(s=>{s.automation.plans.find(p=>p.id===plan.id).nodes.find(n=>n.taskId===task.id).message='正在准备执行对话或核对实际模型，尚未发送';});continue;}
        plan=this.currentPlan(row.planId);task=this.getState().tasks.find(t=>t.id===row.taskId);node=plan.nodes.find(n=>n.taskId===row.taskId);
        if(plan.status!=='active'||node.skipped||node.jobId)continue;if(!instructionMatches(task,node.hash))throw Error('分配期间任务已修改，请核对后继续');
        if(await this.reserve(task)===false)continue;if(await this.refresh({force:false})===false)continue;if(this.currentPlan(plan.id).status!=='active')continue;
        const catalog={...this.getCatalog(),threads:[...this.getCatalog().threads.filter(t=>t.id!==thread.id),thread]};
        await this.mutate(s=>{const p=s.automation.plans.find(p=>p.id===plan.id),n=p.nodes.find(n=>n.taskId===task.id),latest=s.tasks.find(t=>t.id===task.id);if(p.status!=='active'||n.skipped||n.jobId||this.blocked()||maintenanceWaiting(s))return;if(!instructionMatches(latest,n.hash))throw Error('执行前任务已修改');
          const result=executeTask(s,{id:task.id,threadId:thread.id,requestId:n.requestId},catalog,{routed:true,gate:p.gate,planId:p.id,allowParallel:p.maxConcurrent!==1&&latest.execution?.parallel!==false,workUnit:moduleKey(latest),desiredModel:thread.desiredModel});delete n.recovery;p.reason='';n.jobId=result.job.id;n.status='queued';n.threadId=thread.id;n.message='已分配模块对话，等待发送';
        });
      }catch(error){await this.mutate(s=>{
        const p=s.automation.plans.find(p=>p.id===row.planId);if(p.status!=='active')return;
        const n=p.nodes.find(n=>n.taskId===row.taskId),latest=s.tasks.find(t=>t.id===row.taskId);if(n.skipped)return;if(!n.jobId&&latest?.status==='todo'&&!latest.initialDispatch&&n.hash!==attemptedHash&&instructionMatches(latest,n.hash)){n.status='pending';n.message='内容已更新，等待按最新内容执行';return;}if(error.code==='MODEL_REALLOCATION'){n.message=error.message;return;}const attempts=(n.recovery?.attempts??0)+1;
        const safe=error.safeToRetry===true&&!n.jobId&&latest?.status==='todo'&&!latest.syncReserved&&instructionMatches(latest,n.hash);
        if(p.manualAcceptance&&!n.jobId&&!latest?.initialDispatch&&latest?.status==='todo'){
          const requiresInput=error.needsInput===true||latest.syncReserved&&!latest.syncReservationConfirmed;
          n.recovery={attempts,nextAttemptAt:this.now()+recoveryDelay(attempts),error:error.message,requiresInput,action:error.recoveryAction??(latest.syncReserved&&!latest.syncReservationConfirmed?'claim':requiresInput?'settings':'open')};n.status=requiresInput?'blocked':'recovering';n.message=requiresInput?error.message:'正在自动恢复：'+error.message;p.reason='';return;
        }
        if(safe){const delay=recoveryDelay(attempts);n.recovery={attempts,nextAttemptAt:this.now()+delay,error:error.message};n.status='recovering';n.message=`同步读取暂时失败，${delay/1000}秒后自动恢复`;p.reason=n.message;return;}
        p.status='paused';p.reason=error.message;delete p.automaticRecovery;n.message=p.reason;n.status='blocked';
      });}
    }
  }
  async deferPreparations(rows,error,requiresInput){
    await this.mutate(s=>{for(const row of rows){const p=s.automation.plans.find(p=>p.id===row.planId),n=p?.nodes.find(n=>n.taskId===row.taskId);if(!p||p.status!=='active'||!n||n.jobId||n.skipped)continue;const attempts=(n.recovery?.attempts??0)+1;n.recovery={attempts,nextAttemptAt:this.now()+recoveryDelay(attempts),error:error.message,requiresInput};n.status='recovering';n.message='任务已接收，正在恢复连接；恢复后自动继续';}});
  }
}
