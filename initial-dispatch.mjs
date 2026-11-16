import {randomUUID} from 'node:crypto';
import {executeTask} from './board.mjs';
import {instructionHash,instructionMatches} from './execution.mjs';
import {normalize} from './core.mjs';
import {maintenanceWaiting} from './maintenance.mjs';
import {adoptHandoffJob} from './handoff-state.mjs';
import {isTransientThreadRead} from './local-session.mjs';

export class InitialDispatcher {
  constructor(options){Object.assign(this,options);}
  async start({task,project,route,target,planId,existingJobId,assertCurrent,handoff}){
    const handoffSourceJobId=handoff?task.handoff?.sourceJobId:null;
    const preflightError=error=>handoff&&(isTransientThreadRead(error)||['SYNC_WAIT','EXECUTION_WAIT','CATALOG_UNVERIFIED'].includes(error.code))?Object.assign(Error(error.message),{handoffReadRetry:true}):error;
    const current=s=>{try{return assertCurrent(s);}catch(error){throw preflightError(error);}};
    const read=async operation=>{try{return await operation();}catch(error){throw preflightError(error);}};
    current();
    // Handoff summaries can outlive the activity snapshot. Refresh before its
    // first freshness gate; failed refreshes must not reserve or create work.
    if(handoff){if(await read(()=>this.refresh({force:true}))===false)return null;current();}
    await read(()=>this.assertCatalog());
    const state=this.getState(),previous=state.jobs.find(j=>j.id===existingJobId),plan=handoff?{id:null,status:'active',maxConcurrent:1,gate:'completed'}:state.automation.plans.find(p=>p.id===(planId??previous?.autoPlanId))??(previous?{id:null,status:'active',maxConcurrent:2,gate:previous.dependencyGate??'completed'}:null),node=handoff?{requestId:'handoff-'+handoff.id}:plan?.nodes?.find(n=>n.taskId===task.id)??(previous?{requestId:previous.executeRequestId}:null);
    if(!plan||plan.status!=='active'||!node||node.skipped)throw Error('首条任务缺少有效执行安排，未创建对话');
    if(await this.reserve(task)===false)return null;
    if(await read(()=>this.refresh({force:true}))===false)return null;current();if(this.blocked())return null;
    const old=existingJobId?this.getState().jobs.find(j=>j.id===existingJobId):null;
    if(existingJobId&&old?.status!=='queued')throw Error('原任务已提交，不能重新创建执行');
    if(handoff)await handoff.validateSource();
    await read(()=>this.verifyProject?.(project));current();await read(()=>this.assertCatalog());if(this.blocked())return null;
    const body=handoff?handoff.buildPrompt(task):this.buildPrompt(task,old,plan),hash=instructionHash(task),startedAt=new Date().toISOString();
    const intent={...(handoff?{handoffId:handoff.id}:{}),phase:'creating',jobId:existingJobId??randomUUID(),taskId:task.id,planId:plan.id,requestId:node.requestId,body,attachments:structuredClone(task.attachments??[]),modelTarget:structuredClone(target),hash,startedAt,existingJobId:existingJobId??null};
    const saved=await this.mutate(s=>{
      current(s);if(this.blocked()||maintenanceWaiting(s))return false;
      const p=s.automation.plans.find(p=>p.id===plan.id),n=p?.nodes.find(n=>n.taskId===task.id),t=s.tasks.find(t=>t.id===task.id);
      if(plan.id&&p?.status!=='active'||n?.skipped||n?.jobId&&!existingJobId||t.initialDispatch)throw Error('任务已有提交意图，未重复创建');
      s.automation.routes[route.key]={...route,initialDispatch:intent,status:'creating',source:'created',startedAt};
      if(handoff){t.handoff.phase='creating';t.handoff.routeKey=route.key;}
      t.status='running';t.initialDispatch={key:route.key,phase:'creating'};if(n){n.status='creating';n.message='正在新建对话并提交首条任务';}return true;
    });if(saved===false)return null;
    let called=false,receipt;
    try{
      const current=this.getState(),p=current.automation.plans.find(p=>p.id===plan.id),t=current.tasks.find(t=>t.id===task.id);
      if(this.blocked()||plan.id&&p?.status!=='active'||!instructionMatches(t,hash)||normalize(this.getCatalog().projects.find(p=>p.projectId===project.projectId)?.path)!==normalize(project.path)||this.currentModel().revision!==target?.revision)throw Object.assign(Error('创建前任务、项目或默认配置已变化，未提交'),{notApplied:true});
      this.assertCatalog();if(handoff){
        await handoff.validateSource();assertCurrent();this.assertCatalog();
      }
      await this.verifyProject?.(project);assertCurrent();this.assertCatalog();
      const latestState=this.getState(),latest=latestState.tasks.find(row=>row.id===task.id),latestPlan=latestState.automation.plans.find(row=>row.id===plan.id)??plan;
      const currentIntent=latestState.automation.routes[route.key]?.initialDispatch;
      if(latest?.initialDispatch?.key!==route.key||latest.initialDispatch.phase!=='creating'||currentIntent?.phase!=='creating'||currentIntent.jobId!==intent.jobId||currentIntent.hash!==hash||currentIntent.body!==body||latest.archivedAt)throw Object.assign(Error('首条任务提交意图已变化，未创建执行'),{notApplied:true});
      if(this.blocked()||plan.id&&latestPlan.status!=='active'||!instructionMatches(latest,hash)||this.currentModel().revision!==target.revision||normalize(this.getCatalog().projects.find(p=>p.projectId===project.projectId)?.path)!==normalize(project.path))throw Object.assign(Error('创建前项目、配置或运行状态已变化，未提交'),{notApplied:true});
      if(!handoff)this.validateAllocation?.(latest,latestPlan,intent.jobId);
      const finalBody=handoff?handoff.buildPrompt(latest):this.buildPrompt(latest,old,latestPlan);
      if(finalBody!==body)throw Object.assign(Error('创建前源码上下文、附件或任务正文已变化，未提交'),{notApplied:true});
      called=true;receipt=await this.create({title:route.title,target:{type:'project',projectId:project.desktopProjectId??project.projectId,environment:{type:'local'}},prompt:body});
      if(!receipt.threadId){await this.unresolved(route.key,'创建回执尚未提供可核对的对话，提交待核对',receipt);return null;}
      await this.adopt(route.key,receipt);
      // Business is already submitted. Metadata failures must never make it queued again.
      try{await this.refresh({force:true,threadId:receipt.threadId});await this.checkModel(route.key);}catch{}
      return {id:receipt.threadId,initialSubmitted:true};
    }catch(error){
      let retryReady=false;
      if(!called||error.notApplied===true){await this.mutate(s=>{const r=s.automation.routes[route.key];if(r?.initialDispatch?.phase!=='creating'||r.initialDispatch.jobId!==intent.jobId||r.initialDispatch.hash!==hash)return;r.initialDispatch.phase='not-applied';r.status='failed';r.error=error.message;const t=s.tasks.find(t=>t.id===task.id);if(handoff){
        retryReady=!called&&(error.handoffReadRetry===true||isTransientThreadRead(error)||['SYNC_WAIT','EXECUTION_WAIT','CATALOG_UNVERIFIED'].includes(error.code))&&t.handoff?.id===handoff.id&&t.handoff.phase==='creating'&&t.currentJobId===handoffSourceJobId&&instructionMatches(t,hash)&&t.initialDispatch?.key===route.key&&r.initialDispatch.handoffId===handoff.id;
        t.handoff.phase=retryReady?'ready':'blocked';t.handoff.error=error.message;t.status='review';
      }else if(!existingJobId)t.status='todo';delete t.initialDispatch;});}
      else await this.unresolved(route.key,'首条任务提交待核对：'+error.message,receipt);
      if(retryReady)throw Object.assign(Error(error.message),{handoffReadRetry:true});
      throw error;
    }
  }
  async unresolved(key,message,receipt){await this.mutate(s=>{const r=s.automation.routes[key];if(!r?.initialDispatch||r.initialDispatch.phase==='adopted')return;r.initialDispatch.phase='uncertain';if(receipt)r.initialDispatch.receipt=receipt;r.status='uncertain';r.error=message;const t=s.tasks.find(t=>t.id===r.initialDispatch.taskId);t.initialDispatch.phase='uncertain';if(r.initialDispatch.handoffId){t.handoff.phase='uncertain';t.handoff.error=message;}const p=s.automation.plans.find(p=>p.id===r.initialDispatch.planId);if(p){p.status='paused';p.reason=message;const n=p.nodes.find(n=>n.taskId===t.id);n.status='uncertain';n.message=message;}});}
  async adopt(key,receipt){return this.mutate(s=>{
    const r=s.automation.routes[key],d=r?.initialDispatch;if(!d)throw Error('提交意图缺失，未登记');if(d.phase==='adopted')return;
    const t=s.tasks.find(t=>t.id===d.taskId),p=s.automation.plans.find(p=>p.id===d.planId),n=p?.nodes.find(n=>n.taskId===t.id);
    if(!t.initialDispatch||t.initialDispatch.key!==key)throw Error('提交归属已变化，保留待核对状态');
    const changed=d.handoffId&&(t.currentJobId!==t.handoff?.sourceJobId||!instructionMatches(t,d.hash)||t.archivedAt);
    if(changed)throw Error('接续期间原任务或当前轮次已变化，保留创建待核对，不覆盖新轮次');
    let job=d.handoffId?adoptHandoffJob(s,t,d,r,receipt.threadId):s.jobs.find(j=>j.id===d.existingJobId);
    if(!job){
      t.status='todo';const thread={id:receipt.threadId,title:r.title,cwd:r.path,kind:'codex',hostId:'local',modelKey:d.modelTarget?.modelKey,modelLabel:d.modelTarget?.modelLabel};
      job=executeTask(s,{id:t.id,threadId:thread.id,requestId:d.requestId},{projects:this.getCatalog().projects,threads:[thread]},{routed:true,planId:p.id,gate:p.gate,allowParallel:p.maxConcurrent!==1&&t.execution?.parallel!==false,workUnit:r.baseKey??r.key,desiredModel:d.modelTarget,initialSubmitted:true,jobId:d.jobId}).job;
    }
    if(!Object.hasOwn(job,'dispatchPrompt'))job.dispatchPrompt=d.body;
    Object.assign(job,{threadId:receipt.threadId,title:r.title,status:'submitted',dispatchVersion:2,deliveryKind:'create',initialDispatchId:d.jobId,modelKey:d.modelTarget?.modelKey,modelLabel:d.modelTarget?.modelLabel,modelProvider:d.modelTarget?.modelProvider,modelRouted:true,routedDispatchPrompt:d.body,correlationToken:null,baseline:null,sentAt:d.startedAt,modelTarget:d.modelTarget,receipt,message:'新对话首条任务已提交，等待回复'});
    if(receipt.turnId)job.turnId=receipt.turnId;
    job.routedPrompt=d.body;delete t.initialDispatch;t.status='running';t.currentJobId=job.id;
    d.phase='adopted';d.receipt=receipt;r.threadId=receipt.threadId;r.status=this.hasModelEvidence(receipt.threadId)?'ready':'model-pending';r.error='';
    if(n){n.jobId=job.id;n.threadId=receipt.threadId;n.status='submitted';n.message=job.message;}
    s.imported=[...new Set([...(s.imported??[]),receipt.threadId])];
  });}
  async checkModel(key){const r=this.getState().automation.routes[key];if(!r?.threadId||!this.hasModelEvidence(r.threadId))return;
    if(this.compatible(r.threadId,r.initialDispatch.modelTarget))await this.mutate(s=>{s.automation.routes[key].status='ready';});
    else await this.mutate(s=>{const route=s.automation.routes[key],job=s.jobs.find(j=>j.id===route.initialDispatch.jobId);route.status='model-mismatch';route.error='首条任务已提交，但实际模型与创建前默认配置不符，后续任务已暂停；不会重发';job.modelMismatch=route.error;const p=s.automation.plans.find(p=>p.id===route.initialDispatch.planId);if(p){p.status='paused';p.reason=route.error;}});
  }
  async confirm(key,threadId){
    const route=this.getState().automation.routes[key];if(!route?.initialDispatch||route.initialDispatch.phase!=='uncertain')throw Error('此任务没有待核对的首条提交');
    const response=await this.read(threadId),thread=response.thread;
    if(thread?.id!==threadId||thread.kind!=='codex'||thread.hostId!=='local'||normalize(thread.cwd)!==normalize(route.path))throw Error('所选对话不属于原任务项目');
    const {matchingTurn}=await import('./core.mjs'),turn=matchingTurn(response.turns??[],{dispatchVersion:2,deliveryKind:'create',dispatchPrompt:route.initialDispatch.body});
    if(!turn)throw Error('所选对话没有唯一对应的完整任务正文，未关联或重发');
    await this.adopt(key,{threadId,turnId:turn.id,manualConfirmed:true});await this.refresh({force:true,threadId});await this.checkModel(key);
  }
}
