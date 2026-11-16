import {assertNoHandoff} from './handoff-state.mjs';
import {sectionFields,sectionContext,sectionFor} from './task-sections.mjs';
import {requireTaskGroup} from './task-groups.mjs';
import {randomUUID} from 'node:crypto';
import {normalize,validateBatch,dependencySatisfied} from './core.mjs';
import {executionFields,instructionHash,moduleKey} from './execution.mjs';
import {attachmentFields} from './attachments.mjs';
import {taskPropertyFields,priorityValue} from './properties.mjs';
import {threadModelRecord} from './model-routing.mjs';
import {CURRENT_THREAD_DELIVERY} from './dispatch-state.mjs';
import {taskContentInput} from './source-display.mjs';
import {continueTaskPrompt,openContinuation,roundIdOf} from './public/rounds.js';
import {sameModelSeries} from './default-model.mjs';

export const SCHEMA_VERSION=3;
const activeStatuses=new Set(['queued','sending','submitted','running','uncertain']);
const now=()=>new Date().toISOString();
const fail=message=>{throw new Error(message);};
const requestId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value)?value:fail('缺少有效请求标识，请刷新后重试');
const taskById=(state,id)=>state.tasks.find(t=>t.id===id)??fail('看板任务不存在');
const currentJob=(state,task)=>state.jobs.find(j=>j.id===task.currentJobId&&j.taskId===task.id);

export function migrateState(input){
  if(!input||typeof input!=='object'||!Array.isArray(input.jobs))fail('本机状态格式无效，已停止加载以保护记录');
  if((input.schemaVersion??1)>SCHEMA_VERSION)fail('本机数据版本高于当前程序，请使用新版程序');
  if(input.tasks!==undefined&&!Array.isArray(input.tasks))fail('看板记录格式无效，已停止加载以保护记录');
  return {...input,schemaVersion:SCHEMA_VERSION,tasks:input.tasks??[]};
}

// Persist the proposed state before publishing it. Preserve existing job object
// identities because the queue may be awaiting a desktop response for that job.
export function transactBoard(state,operation,persist){
  const draft=structuredClone(state),result=operation(draft);
  syncTaskStates(draft);persist(draft);
  for(const key of ['tasks','jobs'])draft[key]=draft[key].map(item=>{
    const existing=state[key].find(value=>value.id===item.id);
    return existing?Object.assign(existing,item):item;
  });
  Object.assign(state,draft);return result;
}

function fields(input){
  input=taskContentInput(input);
  const title=typeof input.title==='string'?input.title.trim():'';
  const description=typeof input.description==='string'?input.description.trim():'';
  if(!title||title.length>200)fail('任务标题不能为空且不能超过 200 字符');
  if(description.length>30000)fail('任务内容不能超过 30,000 字符');
  return {title,description};
}

function event(task,type,extra={}){
  const at=now();task.updatedAt=at;
  task.history.push({id:randomUUID(),at,type,status:task.status,...extra});
}

export function createTask(state,input,projects){
  const rid=requestId(input.requestId),values={...fields(input),...sectionFields(state,input,null,input.projectId),...executionFields(input,null,input.projectId,state.tasks),...taskPropertyFields(state,input.projectId,input),attachments:attachmentFields(state,input.projectId,input.attachmentIds)};
  if(input.boardGroupId!=null)values.boardGroupId=input.boardGroupId;
  const {sectionRevision,...signedValues}=values;const signature=JSON.stringify({projectId:input.projectId,...signedValues});
  const existing=state.tasks.find(t=>t.createRequestId===rid);
  if(existing){if(existing.createSignature!==signature)fail('请求标识已用于其他任务内容');return {task:existing,duplicate:true};}
  const project=projects.find(p=>p.projectId===input.projectId);
  if(!project?.path)fail('项目不存在，请刷新项目列表');
  if(values.boardGroupId!==undefined)requireTaskGroup(state,project.projectId,values.boardGroupId);
  const commandPrefix=['workflow-prepare-','github-upload-'].find(prefix=>rid.startsWith(prefix));
  if(commandPrefix){const active=state.tasks.find(t=>t.projectId===project.projectId&&normalize(t.path)===normalize(project.path)&&t.createRequestId?.startsWith(commandPrefix)&&!t.archivedAt&&t.status!=='done');if(active)return {task:active,duplicate:true};}
  const task={id:randomUUID(),projectId:project.projectId,project:project.label,path:project.path,...values,status:'todo',createdAt:now(),updatedAt:now(),jobIds:[],currentJobId:null,history:[],createRequestId:rid,createSignature:signature};
  event(task,'created');state.tasks.push(task);return {task};
}

export function updateTask(state,input){
  const task=taskById(state,input.id);assertNoHandoff(task);
  if(task.initialDispatch||state.jobs.some(j=>j.taskId===task.id&&['sending','submitted','running','uncertain'].includes(j.status)))fail('本轮已发送或提交待核对，不能直接编辑');
  const current=task.currentJobId?state.jobs.find(j=>j.id===task.currentJobId&&j.taskId===task.id):null;
  // 已发送（含未决）不能直接改内容，避免修改落到下一轮而不是本轮；排队未发送可以直接改。
  if(current&&['sending','submitted','running','uncertain'].includes(current.status))fail('本轮已发送，不能直接编辑；请先回退到待执行');
  const queuedJob=current?.status==='queued'?current:null;
  if(queuedJob&&(queuedJob.sentAt||queuedJob.receipt||queuedJob.turnId||queuedJob.correlationToken))fail('排队记录已有提交依据，请先核对，不能直接编辑');
  if(task.archivedAt||task.syncReserved&&!(task.syncReservationConfirmed&&(queuedJob||task.status==='todo')))fail('仅未归档、未领取或本机确认领取且尚未发送的任务可以编辑');
  if(task.status!=='todo'&&!queuedJob)fail('任务已发送或在审阅中，不能直接编辑；请先回退到待执行');
  const values={...fields(input),...sectionFields(state,input,task,task.projectId),...(queuedJob?{}:executionFields(input,task,task.projectId,state.tasks)),...taskPropertyFields(state,task.projectId,input,task),attachments:attachmentFields(state,task.projectId,input.attachmentIds??(task.attachments??[]).map(f=>f.id))};
  const scopeChanged=!queuedJob&&(JSON.stringify(task.execution?.writePaths??[])!==JSON.stringify(values.execution?.writePaths??[])||!!task.execution?.parallel!==!!values.execution?.parallel||JSON.stringify(task.dependsOn??[])!==JSON.stringify(values.dependsOn??task.dependsOn??[]));
  event(task,'edited',{before:{title:task.title,description:task.description,tag:task.tag,priority:task.priority??2,attributes:task.attributes??[],attachments:task.attachments??[]},after:values});
  Object.assign(task,values);
  if(queuedJob){
    // 排队轮次沿用修改后的内容发送；执行安排与依赖保持入队时状态，调整前需先回退到待执行。
    const body=task.description||task.title,feedback=queuedJob.feedbackText??task.reviewNote??'';
    queuedJob.prompt=queuedJob.continuedFromJobId?body+(feedback?'\n\n本次反馈：\n'+feedback:''):body;
    if(queuedJob.currentThreadMode==='queue'||queuedJob.continuedFromJobId)queuedJob.basePrompt=body;
    queuedJob.taskTitle=task.title;queuedJob.taskCode=task.shortId??task.id;queuedJob.taskTag=task.tag;queuedJob.taskPriority=task.priority??2;queuedJob.taskAttributes=structuredClone(task.attributes??[]);queuedJob.attachments=structuredClone(task.attachments??[]);queuedJob.contextSnapshot=sectionContext(state,task);
    const section=sectionFor(state,task);if(section)queuedJob.sectionSnapshot=structuredClone(section);else delete queuedJob.sectionSnapshot;
    delete queuedJob.routedPrompt;delete queuedJob.dispatchPrompt;delete queuedJob.routedDispatchPrompt;
  }
  for(const plan of state.automation?.plans??[])if(['active','paused'].includes(plan.status))for(const node of plan.nodes)if(node.taskId===task.id&&!node.skipped&&(!node.jobId||node.jobId===queuedJob?.id)){
    if(scopeChanged&&plan.status==='active'&&!plan.manualAcceptance){plan.status='paused';plan.reason='执行范围或前置关系已更新，请确认后继续原安排';}
    node.hash=instructionHash(task);delete node.recovery;node.message=plan.status==='paused'?'内容已更新，继续后使用最新内容':'内容已更新，等待按最新内容执行';
  }
  return {task};
}

// This operation is synchronous: callers may refresh first, but must not await
// between checking the persisted request/status and adding the queued attempt.
export function executeTask(state,input,catalog,policy={}){
  const rid=requestId(input.requestId),task=taskById(state,input.id);assertNoHandoff(task);
  if(policy.currentThreadMode!==undefined&&(policy.deliveryKind!==CURRENT_THREAD_DELIVERY||!['queue','steer'].includes(policy.currentThreadMode)))fail('请选择排队或引导');
  const signature=JSON.stringify({projectId:task.projectId,path:task.path,title:task.title,description:task.description,tag:task.tag,reviewNote:task.reviewNote??'',...(task.sectionId?{sectionId:task.sectionId,sectionRevision:sectionFor(state,task)?.revision}:{}),execution:task.execution,dependsOn:task.dependsOn??[],attributes:task.attributes??[],attachments:task.attachments??[],...(policy.deliveryKind?{deliveryKind:policy.deliveryKind}:{}),...(policy.currentThreadMode?{currentThreadMode:policy.currentThreadMode}:{})});
  const existing=state.jobs.find(j=>j.executeRequestId===rid);
  if(existing){
    if(existing.taskId!==task.id||(existing.threadId!==input.threadId&&existing.requestedThreadId!==input.threadId)||existing.executeSignature!==signature)fail('执行请求标识已被其他任务或指令使用');
    return {task,job:existing,duplicate:true};
  }
  if(policy.deliveryKind===CURRENT_THREAD_DELIVERY&&state.automation.plans.some(plan=>['active','paused'].includes(plan.status)&&plan.nodes.some(node=>node.taskId===task.id&&!node.skipped&&!node.jobId)))fail('此任务已有执行安排，请从原安排继续或取消后再发送本对话');
  if(task.pendingParentId)fail('父任务尚未在本机接续，不能执行');
  if(task.pendingDependencies?.length)fail('前置任务尚未在本机接续，不能执行');
  if(['discussion','confirmation'].includes(task.workflowStage))fail('请先确认方案，再手动执行');
  if(!policy.deferDependencies&&(task.dependsOn??[]).some(id=>!dependencySatisfied(state.tasks.find(t=>t.id===id),state.jobs,policy.gate)))fail(policy.gate==='reviewed'?'此安排要求前置任务审阅通过，请先完成依赖':'前置任务本轮尚未确认正常结束，请先完成依赖');
  if(task.status!=='todo'||state.jobs.some(j=>j.taskId===task.id&&activeStatuses.has(j.status)))fail('此任务已执行或仍需审阅，不能重复发送');
  const project=catalog.projects.find(p=>p.projectId===task.projectId);
  if(!project||normalize(project.path)!==normalize(task.path))fail('项目路径已变更，请核对项目后重新创建任务');
  if(!policy.routed&&state.bindings[task.projectId]!==input.threadId)fail('执行对话不是此项目已保存的绑定，请先绑定');
  const previous=task.pendingContinuation?openContinuation(state,task):null;
  if(task.pendingContinuation&&!previous)fail('原接续记录已变化，请核对当前卡片');
  if(previous&&previous.threadId!==input.threadId&&!policy.initialSubmitted&&!(policy.desiredModel&&sameModelSeries(catalog.threads.find(t=>t.id===input.threadId),policy.desiredModel)))fail('请继续当前卡片的原对话');
  const prompt=previous?(previous.threadId!==input.threadId?(task.description||task.title)+(task.reviewNote?'\n\n本次反馈：\n'+task.reviewNote:''):(task.reviewNote||continueTaskPrompt)):(task.description||task.title);
  const [row]=validateBatch([{projectId:task.projectId,threadId:input.threadId,prompt}],catalog.projects,catalog.threads);
  const target=catalog.threads.find(t=>t.id===row.threadId);
  const job={...row,contextSnapshot:sectionContext(state,task),...(sectionFor(state,task)?{sectionSnapshot:structuredClone(sectionFor(state,task))}:{}),autoPlanId:policy.planId,allowParallel:policy.allowParallel===true,writePaths:structuredClone(task.execution?.writePaths??[]),workUnit:policy.workUnit,dependencyIds:[...(task.dependsOn??[])],dependencyGate:policy.gate??'completed',attachments:structuredClone(task.attachments??[]),id:policy.jobId??randomUUID(),taskId:task.id,taskTitle:task.title,taskCode:task.shortId??task.id,taskTag:task.tag,taskPriority:task.priority??2,taskAttributes:structuredClone(task.attributes??[]),...threadModelRecord(target),executeRequestId:rid,executeSignature:signature,batchId:rid,status:'queued',createdAt:now(),message:'已手动执行，等待项目空闲'};
  job.requestedThreadId=input.threadId;job.basePrompt=task.description||task.title;job.feedbackText=previous?task.reviewNote??'':'';
  if(policy.deliveryKind===CURRENT_THREAD_DELIVERY){job.deliveryKind=CURRENT_THREAD_DELIVERY;job.message='已加入本对话队列，等待当前轮次结束';}
  if(policy.currentThreadMode){job.currentThreadMode=policy.currentThreadMode;job.message=policy.currentThreadMode==='steer'?'已接收，准备引导当前聊天':'已加入当前聊天队列';}
  // Derive these inside the enqueue transaction, alongside the job's write paths.
  if(policy.currentThreadMode==='queue'){job.allowParallel=task.execution?.parallel!==false;job.workUnit=moduleKey(task);}
  if(policy.desiredModel)job.modelTarget=structuredClone(policy.desiredModel);
  job.roundId=previous?roundIdOf(previous):job.id;
  if(previous){job.continuedFromJobId=previous.id;job.reviewedJobId=previous.id;job.inputKind='feedback';}else job.inputKind='task';
  state.jobs.push(job);task.jobIds.push(job.id);task.currentJobId=job.id;task.status='running';delete task.historyOnly;delete task.pendingContinuation;task.lastJobStatus='queued';
  event(task,'executed',{jobId:job.id,threadId:job.threadId,jobStatus:job.status});return {task,job};
}

export function syncTaskStates(state){
  for(const task of state.tasks){
    if(task.status==='done'||task.status==='todo')continue;
    const job=currentJob(state,task);if(!job)continue;
    const next=['queued','sending','submitted','running'].includes(job.status)?'running':'review';
    if(task.status!==next||task.lastJobStatus!==job.status){
      task.status=next;task.lastJobStatus=job.status;
      event(task,'execution-status',{jobId:job.id,jobStatus:job.status,message:job.message??'',error:job.error??''});
    }
  }
}

export function cancelQueuedJob(state,{id}){
  const job=state.jobs.find(j=>j.id===id);
  if(!job||job.status!=='queued')fail('仅能取消尚未发送的任务');
  const task=state.tasks.find(t=>t.id===job.taskId&&t.currentJobId===job.id);
  if(task&&state.jobs.some(j=>j.id!==job.id&&j.taskId===task.id&&activeStatuses.has(j.status)))fail('同任务还有在途记录，请先核对');
  if(task?.syncReserved&&!task.syncReservationConfirmed)fail('领取结果尚未确认，请先核对远端状态');
  job.status='cancelled';job.message='已取消排队，未发送';
  if(task){
    task.status='todo';task.currentJobId=null;task.lastJobStatus='cancelled';
    if(job.continuedFromJobId){const previous=state.jobs.find(j=>j.id===job.continuedFromJobId&&j.taskId===task.id);if(previous)task.pendingContinuation={jobId:previous.id,roundId:roundIdOf(previous),threadId:previous.threadId};task.reviewNote=job.prompt===continueTaskPrompt?'':job.prompt;}
    // Cancelling an unsent queue entry does not reopen its remote tombstone.
    // Retain the confirmed local ownership so the user can schedule it again.
    if(!task.syncReservationConfirmed){delete task.syncReserved;delete task.syncReservationConfirmed;}
    event(task,'execution-cancelled',{jobId:job.id});
  }
  return {job,task};
}

function reviewTask(state,id){
  const task=taskById(state,id),job=currentJob(state,task);assertNoHandoff(task);
  if(task.status!=='review'||!job)fail('此任务尚未进入待审阅');
  return {task,job};
}

function note(value,required=false){
  const result=typeof value==='string'?value.trim():'';
  if((required&&!result)||result.length>10000)fail('请填写审阅意见（最多 10,000 字符）');
  return result;
}

export function approveTask(state,input,{manualVerified=false}={}){
  if(input.acceptResult===true){
    const task=taskById(state,input.id),job=currentJob(state,task);assertNoHandoff(task);
    if(task.archivedAt)fail('此任务已移出，请刷新后核对');
    if((input.jobId??null)!==(task.currentJobId??null))fail('审阅轮次已变化，请刷新后核对最新结果');
    if(job&&job.projectId!==task.projectId)fail('本轮记录不属于当前项目');
    if(task.status==='done'&&task.history.some(e=>e.type==='approved'&&e.jobId===(task.currentJobId??null)))return {task,duplicate:true};
    if(task.status!=='review')fail('此任务尚未进入待审阅');
    if(state.jobs.some(j=>j.taskId===task.id&&['queued','sending','submitted','running'].includes(j.status)))fail('任务仍在执行，请等待本轮结束后通过');
    // User acceptance records the review decision only. In particular it must
    // never release an uncertain send or rewrite the original execution status.
    task.status='done';task.completedAt=now();
    event(task,'approved',{jobId:task.currentJobId??null,note:note(input.note)||'用户点击通过',mode:'manual',originalStatus:job?.status??'missing'});
    return {task};
  }
  const {task,job}=reviewTask(state,input.id);
  if(input.jobId&&input.jobId!==job.id)fail('审阅轮次已变化，请刷新后核对最新结果');
  if(task.archivedAt)fail('此任务已移出，请刷新后核对');
  if(state.tasks.some(t=>t.parentId===task.id&&!t.archivedAt&&t.status!=='done')||(task.dependsOn??[]).some(id=>state.tasks.find(t=>t.id===id)?.status!=='done'))fail('子任务或前置任务尚未验收通过');
  if(input.manual===true){
    if(input.jobId!==job.id)fail('请核对当前审阅轮次');
    if(!['failed','interrupted','released','uncertain','completed'].includes(job.status)||job.awaitingUser)fail('本轮仍在执行或等待你的回复，不能人工验收');
    if(input.confirmed!==true)fail('请确认成果已完成且不会再产生本轮执行');
    const reviewNote=note(input.note,true),originalStatus=job.status;
    if(!manualVerified)fail('尚未确认原对话属于本项目且已空闲，不能人工验收');
    if(state.jobs.some(j=>j.taskId===task.id&&j.id!==job.id&&activeStatuses.has(j.status)))fail('同任务仍有在途或未决执行，不能人工验收');
    if(job.status==='uncertain')resolveUncertainTask(state,input);
    task.status='done';task.completedAt=now();event(task,'approved',{jobId:job.id,note:reviewNote,mode:'manual',originalStatus});return {task};
  }
  if(job.status!=='completed'||!job.turnId||job.awaitingUser)fail(job.awaitingUser?'当前任务正在等待你的回复，尚不能通过':'仅已确认本轮对话正常结束的任务可以审阅通过');
  const reviewNote=note(input.note);
  task.status='done';task.completedAt=now();event(task,'approved',{jobId:job.id,note:reviewNote});return {task};
}

export function returnTaskToTodo(state,input,{uncertainVerified=false}={}){
  const {task,job}=reviewTask(state,input.id);
  if(input.jobId&&input.jobId!==job.id)fail('审阅轮次已变化，请刷新后核对最新结果');
  if(task.archivedAt)fail('此任务已移出，请刷新后核对');
  if(job.status==='uncertain'){
    if(!uncertainVerified)fail('请先核对原对话已空闲且不会再产生本轮执行');
    resolveUncertainTask(state,input);
  }
  if(state.jobs.some(j=>j.taskId===task.id&&activeStatuses.has(j.status)))fail('仍有未决执行，请先核对原对话并解除未决状态');
  const reviewNote=note(input.note);
  task.pendingContinuation={jobId:job.id,roundId:roundIdOf(job),threadId:job.threadId};
  task.status='todo';task.reviewNote=reviewNote;task.currentJobId=null;
  delete task.syncReserved;delete task.syncReservationConfirmed;
  event(task,'returned',{jobId:job.id,note:reviewNote});return {task};
}

// Run within transactBoard: returning and queueing must commit together. Continue
// the reviewed conversation and retain this machine's confirmed sync ownership.
export function retryReviewedTask(state,input,catalog,{uncertainVerified=false,desiredModel=null}={}){
  const rid=requestId(input.requestId),feedback=note(input.note);
  const signature=JSON.stringify([input.id,input.jobId,feedback]);
  const existing=state.jobs.find(j=>j.executeRequestId===rid);
  if(existing){
    if(existing.reviewRequestSignature!==signature)fail('反馈请求标识已用于其他任务或内容');
    return {task:taskById(state,input.id),job:existing,duplicate:true};
  }
  const {task,job}=reviewTask(state,input.id);
  if(job.id!==input.jobId)fail('审阅轮次已变化，请刷新后核对最新结果');
  if(task.archivedAt)fail('此任务已移出，请刷新后核对');
  if(task.syncReserved&&!task.syncReservationConfirmed)fail('上次领取结果未确认，请先核对远端');
  if(job.status==='uncertain'){
    if(!uncertainVerified)fail('请先核对原对话已空闲且不会再产生本轮执行');
    resolveUncertainTask(state,{...input,note:feedback});
  }
  const {syncReserved,syncReservationConfirmed}=task;
  returnTaskToTodo(state,{id:task.id,note:feedback});
  if(syncReserved)task.syncReserved=syncReserved;
  if(syncReservationConfirmed)task.syncReservationConfirmed=syncReservationConfirmed;
  const result=executeTask(state,{id:task.id,threadId:job.threadId,requestId:rid},catalog,{routed:true,gate:'completed',desiredModel});
  result.job.reviewRequestSignature=signature;
  result.job.reviewedJobId=job.id;
  return result;
}

export function resolveUncertainTask(state,input,{automatic=false}={}){
  const {task,job}=reviewTask(state,input.id);
  if(job.status!=='uncertain')fail('此任务当前没有未确认的发送');
  if(input.confirmed!==true)fail('请先确认已核对原对话且不会再产生本轮执行');
  const resolutionNote=note(input.note,true);
  job.status='released';job.resolutionNote=resolutionNote;job.finishedAt=now();job.message=automatic?'已自动核对原对话空闲并解除历史占用；成果仍待审阅，未重发':'已人工核对并释放未决记录；本轮未标记成功';
  event(task,'uncertain-resolved',{jobId:job.id,note:resolutionNote,...(automatic?{mode:'automatic'}:{})});
  if(automatic)acknowledgeReleasedPlanNode(state,job);
  syncTaskStates(state);return {task,job};
}

function acknowledgeReleasedPlanNode(state,job){
  for(const plan of state.automation.plans){
    if(plan.id!==job.autoPlanId||plan.projectId!==job.projectId)continue;
    const node=plan.nodes?.find(n=>!n.skipped&&n.jobId===job.id&&n.taskId===job.taskId);
    if(node)node.acknowledged=true;
  }
}

export function resolveLegacyJob(state,input,{automatic=false}={}){
  const job=state.jobs.find(j=>j.id===input.id&&!j.taskId);
  if(!job||job.status!=='uncertain')fail('此旧记录没有未决发送');
  if(input.confirmed!==true)fail('请先确认已核对原对话且不会再产生本轮执行');
  job.resolutionNote=note(input.note,true);job.status='released';job.finishedAt=now();
  job.message=automatic?'已自动核对原对话空闲并解除历史占用；未标记成功，未重发':'已人工核对并释放旧记录；未标记成功，不会自动重发';if(automatic)acknowledgeReleasedPlanNode(state,job);return {job};
}

export function setTaskPriority(state,input){const task=taskById(state,input.id);assertNoHandoff(task);if(task.archivedAt||task.syncReserved)fail('归档或已领取任务不能修改优先级');const priority=priorityValue(input.priority);if(priority!==task.priority){event(task,'priority-changed',{before:{priority:task.priority??2},after:{priority}});task.priority=priority;}return {task};}
