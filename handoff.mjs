import {randomUUID} from 'node:crypto';
import {instructionHash} from './execution.mjs';
import {normalize,queuedThreadReason} from './core.mjs';
import {handoffPending,summaryPrompt,parseHandoff,continuationPrompt,handoffVersion} from './handoff-state.mjs';
import {isTransientThreadRead} from './local-session.mjs';
export class HandoffCoordinator{
  constructor({now=Date.now,...options}){Object.assign(this,options);this.now=now;}
  hasWork(){return this.getState().tasks.some(t=>handoffPending(t)&&['waiting','summarizing','ready'].includes(t.handoff.phase));}
  async block(id,message,handoffId){await this.mutate(s=>{const h=s.tasks.find(t=>t.id===id)?.handoff;if(h&&(!handoffId||h.id===handoffId)&&['waiting','summarizing','ready'].includes(h.phase)){h.phase='blocked';h.error=message;delete h.recovery;}});}
  async deferRead(id,handoffId,phase,error){await this.mutate(s=>{
    const task=s.tasks.find(t=>t.id===id),h=task?.handoff;
    if(h?.id!==handoffId||h.phase!==phase||!['waiting','summarizing','ready'].includes(h.phase)||task.initialDispatch)return;
    if(instructionHash(task)!==h.taskHash||task.currentJobId!==h.sourceJobId){h.phase='blocked';h.error='任务内容或原执行轮次已变化，请核对后取消旧接续';delete h.recovery;return;}
    const attempts=(h.recovery?.attempts??0)+1;
    h.recovery={attempts,nextAttemptAt:this.now()+[5000,15000,30000,60000][Math.min(attempts-1,3)],error:error.message,requiresInput:false};
    h.error='正在自动核对原对话，连接恢复后继续；尚未提交新对话';
  });}
  async checkSource(task,jobId){
    const h=task.handoff,state=this.getState(),source=state.jobs.find(j=>j.id===jobId),project=this.getCatalog().projects.find(p=>p.projectId===task.projectId);
    if(!project||normalize(project.path)!==normalize(task.path)||instructionHash(task)!==h.taskHash||task.currentJobId!==h.sourceJobId)throw Error('项目、任务内容或原执行轮次已变化，请核对后取消旧接续');
    if(!source?.turnId||!['completed','failed','interrupted'].includes(source.status)||source.awaitingUser&&source.operation!=='handoff-summary')return null;
    let response;
    try{response=await this.read(h.sourceThreadId);}catch(error){
      if(isTransientThreadRead(error))throw Object.assign(Error(error.message),{handoffReadRetry:true});
      throw error;
    }
    const reason=queuedThreadReason({...source,operation:'handoff-read',path:task.path,threadId:h.sourceThreadId},response);
    if(reason)return null;
    if(response.turns?.[0]?.id!==source.turnId)throw Error('原对话已有新的轮次，交接依据已过期，请核对后重新接续');
    return {project,source,response};
  }
  async advance(){
    for(const snapshot of this.getState().tasks.filter(t=>handoffPending(t)&&['waiting','summarizing','ready'].includes(t.handoff.phase))){
      if(this.blocked())return;
      const id=snapshot.id,h=snapshot.handoff,phase=h.phase;
      try{
        if(instructionHash(snapshot)!==h.taskHash){await this.block(id,'任务内容已变化，请核对旧交接',h.id);continue;}
        if(h.recovery&&this.now()<h.recovery.nextAttemptAt)continue;
        if(h.phase==='waiting'){
          const checked=await this.checkSource(snapshot,h.basisJobId??h.sourceJobId);if(!checked)continue;
          await this.mutate(s=>{
            const t=s.tasks.find(t=>t.id===id);if(t.handoff.id!==h.id||t.handoff.phase!=='waiting'||t.currentJobId!==h.sourceJobId||instructionHash(t)!==h.taskHash)return;
            const source=s.jobs.find(j=>j.id===(h.basisJobId??h.sourceJobId));if(source.turnId!==checked.source.turnId||!['completed','failed','interrupted'].includes(source.status)||source.awaitingUser&&source.operation!=='handoff-summary')return;
            const job={id:randomUUID(),operation:'handoff-summary',handoffTaskId:id,handoffSourceTurnId:source.turnId,projectId:t.projectId,project:t.project,path:t.path,threadId:h.sourceThreadId,title:checked.response.thread.title,prompt:summaryPrompt(t),status:'queued',createdAt:new Date().toISOString(),allowParallel:false,modelKey:source.modelKey,modelTarget:source.modelTarget,message:'等待原对话整理交接'};
            s.jobs.push(job);t.handoff.summaryJobId=job.id;t.handoff.sourceTurnId=source.turnId;t.handoff.phase='summarizing';t.handoff.error='';delete t.handoff.recovery;
          });
        }else if(h.phase==='summarizing'){
          const summary=this.getState().jobs.find(j=>j.id===h.summaryJobId);if(!summary||['queued','sending','submitted','running','uncertain'].includes(summary.status))continue;
          if(summary.status!=='completed'||!summary.turnId||summary.modelMismatch){await this.block(id,'交接整理没有可靠完成，请查看原对话结果',h.id);continue;}
          const report=parseHandoff(summary.finalResult,h.id);if(!report){await this.block(id,'未收到完整的本轮最终交接，请查看原对话；未创建新对话',h.id);continue;}
          await this.mutate(s=>{const t=s.tasks.find(t=>t.id===id);if(t.handoff.id!==h.id||t.handoff.phase!=='summarizing')return;
            Object.assign(t.handoff,{summary:report,summaryTurnId:summary.turnId,version:handoffVersion(report),phase:report.status==='ready'?'ready':report.status==='complete'?'complete':'blocked',error:report.status==='needs-input'?'交接需要用户输入，请查看原报告':''});
            t.history.push({type:'handoff-prepared',at:new Date().toISOString(),jobId:summary.id,version:t.handoff.version});
          });
        }else{
          const checked=await this.checkSource(snapshot,h.summaryJobId);if(!checked)continue;
          if(this.getState().jobs.some(j=>j.id!==h.summaryJobId&&['sending','submitted','running','uncertain'].includes(j.status)&&normalize(j.path)===normalize(snapshot.path)))continue;
          if(this.activeCount()>=2)continue;
          const prompt=continuationPrompt(snapshot,h.summary);if(prompt.length>29000)throw Error('交接正文过长，请精简后重新接续');
          await this.start({task:snapshot,project:checked.project,prompt,handoffId:h.id,validateSource:async()=>{const t=this.getState().tasks.find(t=>t.id===id);if(!t||t.handoff.id!==h.id||!await this.checkSource(t,h.summaryJobId))throw Error('创建前原对话状态已变化，未提交新对话');}});
          await this.mutate(s=>{const current=s.tasks.find(t=>t.id===id)?.handoff;if(current?.id===h.id&&current.phase==='submitted'){delete current.recovery;current.error='';}});
        }
      }catch(error){if(error.handoffReadRetry)await this.deferRead(id,h.id,phase,error);else await this.block(id,error.message,h.id);}
    }
  }
}
