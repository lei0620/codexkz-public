// Inspection is read-only. Recovery buttons reuse the existing commands;
// neither a successful check nor a refreshed page sends a task automatically.
export function initExecutionRecovery(api){
  const failures=new Map(),inlineBusy=new Set();
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function inlineState(t){
    const s=api.state(),p=s.automation?.plans.find(p=>['active','paused'].includes(p.status)&&p.nodes.some(n=>n.taskId===t.id&&!n.skipped)),n=p?.nodes.find(n=>n.taskId===t.id),j=s.jobs.find(j=>j.id===t.currentJobId);
    if(j||p?.manualAcceptance)failures.delete(t.id);
    if(failures.has(t.id))return {message:failures.get(t.id),actions:['retry','edit','settings']};
    if(j&&['uncertain','failed','interrupted'].includes(j.status))return {message:j.message||j.error,actions:['review',...(j.threadId?['open']:[])],threadId:j.threadId};
    if(t.initialDispatch)return {message:'原提交结果待核对，不会重复发送',actions:['plan']};
    if(n?.recovery){const threadId=j?.threadId??n.threadId??t.execution?.threadId;return {showMessage:false,actions:(n.recovery.requiresInput?[n.recovery.action??'settings']:['retry']),threadId};}
    if(p?.status==='paused'&&p.automaticRecovery?.kind==='result-verification')return {showMessage:false,actions:[]};
    if(p?.status==='paused')return {showMessage:false,actions:['edit']};
    if(j?.status==='queued')return {message:j.message||j.error,actions:j.error?['edit','settings',...(j.threadId?['open']:[])]:[],threadId:j.threadId};
    return null;
  }
  const labels={retry:'立即重试准备',edit:'修改任务',settings:'项目设置',claim:'核对领取',sync:'手动同步',plan:'核对原安排',review:'处理原结果',open:'打开原对话'};
  function cardParts(t){
    const empty={message:'',actions:'',actionKinds:[]};if(!api.state().service?.manualTaskAcceptanceSupported)return empty;const view=inlineState(t);if(!view)return empty;
    return {message:view.showMessage===false?'':`<p class="card-message" role="status" title="${escape(view.message||'原请求已保留')}">${escape(view.message||'原请求已保留')}</p>`,actions:view.actions.map(action=>`<button type="button"${action==='review'?' class="review-action"':''} data-execution-action="${action}" data-id="${escape(t.id)}" ${inlineBusy.has(t.id)?'disabled':''}>${labels[action]??'项目设置'}</button>`).join(''),actionKinds:view.actions};
  }
  function card(t){const parts=cardParts(t);return parts.message+(parts.actions?`<div class="card-actions">${parts.actions}</div>`:'');}
  async function activate(id,kind){
    if(inlineBusy.has(id))return;const project=api.projectId(),instance=api.state().service?.instanceId;inlineBusy.add(id);
    try{const t=await api.ensure(id);if(!t||t.projectId!==project||api.projectId()!==project||api.state().service?.instanceId!==instance)return;const view=inlineState(t);if(!view?.actions.includes(kind))return;
      if(kind==='retry'){failures.delete(id);return await api.execute(id,undefined,true);}
      if(kind==='edit')return api.edit(id);if(kind==='review')return api.review(id);
      if(kind==='settings'){if(!document.body.classList.contains('workspace-settings-open'))document.getElementById('workspaceToggle')?.click();const settings=document.getElementById('settings');if(settings)settings.open=true;return;}
      if(kind==='claim')return existing('data-release-sync',id);
      if(kind==='plan'){const p=api.state().automation.plans.find(p=>p.projectId===project&&['active','paused'].includes(p.status)&&p.nodes.some(n=>n.taskId===id&&!n.skipped));if(p)existing('data-inspect-plan',p.id);return;}
      if(kind==='open'&&view.threadId)await api.post('open',{threadId:view.threadId});
      if(kind==='sync')await api.post('sync/run');
      await api.load();
    }catch(e){failures.set(id,e.message);api.notice(e.message,true);}finally{inlineBusy.delete(id);}
  }
  const dialog=document.createElement('dialog');dialog.id='executionRecovery';dialog.setAttribute('aria-labelledby','executionRecoveryTitle');
  dialog.innerHTML='<div class="dialog-heading"><h2 id="executionRecoveryTitle">检查执行</h2><button type="button" aria-label="关闭执行检查" data-recovery-close>×</button></div><p class="hint" data-recovery-task></p><div data-recovery-status role="status" aria-live="polite"></div><div data-recovery-issues></div><p class="error" role="alert" data-recovery-error></p><div class="dialog-actions"><button type="button" data-recovery-refresh>重新检查</button><button type="button" class="primary" data-recovery-execute hidden>执行当前任务</button></div>';
  document.body.append(dialog);
  const find=s=>dialog.querySelector(s),status=find('[data-recovery-status]'),list=find('[data-recovery-issues]'),error=find('[data-recovery-error]'),refresh=find('[data-recovery-refresh]'),execute=find('[data-recovery-execute]');
  let context=null,sequence=0,busy=false,result=null;
  const same=c=>!!c&&context===c&&api.projectId()===c.projectId&&api.state().service?.instanceId===c.instanceId&&dialog.open;
  const task=()=>api.state().tasks.find(t=>t.id===context?.id&&t.projectId===context?.projectId);
  const reset=()=>{sequence++;context=null;result=null;busy=false;refresh.disabled=false;execute.hidden=true;};
  const close=()=>{reset();dialog.close();};
  dialog.addEventListener('close',()=>{if(!dialog.open)reset();});find('[data-recovery-close]').onclick=close;
  const signature=t=>{const s=api.state(),j=s.jobs.find(j=>j.id===t?.currentJobId);return JSON.stringify([t?.id,t?.status,t?.title,t?.description,t?.priority,t?.attributes,t?.reviewNote,t?.execution,t?.sectionId,t?.dependsOn,t?.parentId,t?.workflowStage,t?.attachments,t?.archivedAt,t?.syncReserved,t?.syncReservationConfirmed,t?.initialDispatch,t?.handoff,t?.currentJobId,t?.jobIds,j?.status,s.defaultModel?.revision]);};
  function update(){
    if(!context)return;
    if(api.projectId()!==context.projectId){close();return;}
    if(api.state().service?.instanceId!==context.instanceId){sequence++;result=null;list.replaceChildren();execute.hidden=true;status.textContent='服务实例已更换，请重新检查。';context={...context,instanceId:api.state().service?.instanceId};busy=false;refresh.disabled=false;}
    else if(context.signature!==signature(task())){sequence++;context={...context,signature:signature(task())};result=null;execute.hidden=true;status.textContent='任务内容或执行状态已变化，请重新检查。';for(const b of list.querySelectorAll('button'))b.disabled=true;busy=false;refresh.disabled=false;}
  }
  async function check(){
    if(busy||!context)return;const c=context,version=++sequence;busy=true;result=null;refresh.disabled=true;execute.hidden=true;list.replaceChildren();error.textContent='';status.textContent='正在检查当前任务、原对话和同步归属…';
    try{
      const state=api.state();if(!state.service?.executionRecoverySupported)throw Error('执行检查需要加载新版后端；原任务与执行记录已保留。');
      const response=await api.fetch('/api/view/execution?'+new URLSearchParams({projectId:c.projectId,id:c.id}),{headers:{'X-Panel-Token':state.token},signal:AbortSignal.timeout(20000)}),value=await response.json();
      if(!same(c)||sequence!==version)return;
      if(c.signature!==signature(task()))throw Error('检查期间任务或执行状态已变化，请重新检查。');
      if(!response.ok)throw Error(value.error||'未能取得执行检查结果，请重新检查。');
      if(value.instanceId!==c.instanceId||value.projectId!==c.projectId||value.taskId!==c.id)throw Error('检查结果归属已变化，请重新检查。');
      result=value;status.textContent=value.canSubmit?(value.allocationRequired?'本项可按原流程提交；目标对话将在分配后重新核对。':'本次检查未发现阻塞，发送前仍会重新核对。'):'以下条件仍需处理；检查不会发送或清除原记录。';
      for(const issue of value.issues){const section=document.createElement('section'),title=document.createElement('h3'),message=document.createElement('p'),actions=document.createElement('div');title.textContent=issue.title;message.className='hint';message.textContent=issue.message;actions.className='dialog-actions';for(const command of issue.actions??[]){if(command.kind==='execute')continue;const button=document.createElement('button');button.type='button';button.textContent=command.label;button.onclick=()=>run(command);actions.append(button);}section.append(title,message,actions);list.append(section);}
      execute.hidden=!value.canSubmit||task()?.status!=='todo';execute.textContent=value.manualPausedPlanId?'手动执行当前项':value.allocationRequired?'分配目标并执行':'执行当前任务';
    }catch(e){if(same(c)&&sequence===version){status.textContent='本次未完成核对，原任务保持不变。';error.textContent=e.message;}}
    finally{if(same(c)&&sequence===version){busy=false;refresh.disabled=false;}}
  }
  // Proxy only navigational, existing UI actions. No synthetic execute event.
  function existing(attribute,value){const button=document.createElement('button');button.hidden=true;button.type='button';button.setAttribute(attribute,value);document.body.append(button);button.click();button.remove();}
  async function run(command){
    if(busy||!same(context))return;const c=context,t=task();if(!t){error.textContent='当前卡片已变化，请关闭后重新打开。';return;}
    if(c.signature!==signature(t)){update();return;}
    if(command.kind==='recheck')return check();
    if(command.kind==='settings'){close();if(!document.body.classList.contains('workspace-settings-open'))document.getElementById('workspaceToggle')?.click();const settings=document.getElementById('settings');if(settings)settings.open=true;return;}
    if(command.kind==='edit'){close();return api.edit(c.id);}
    if(command.kind==='review'){close();return api.review(c.id);}
    if(command.kind==='plan'){const p=api.state().automation.plans.find(p=>p.projectId===c.projectId&&['active','paused'].includes(p.status)&&p.nodes.some(n=>n.taskId===c.id&&!n.skipped));if(!p){error.textContent='原安排已变化，请重新检查。';return;}close();existing('data-inspect-plan',p.id);return;}
    if(command.kind==='claim'&&!confirm('请先核对其他电脑和原对话，确认本轮没有执行。解除后需要重新同步，是否继续？'))return;
    if(command.kind==='restore-claim'&&!confirm('仅恢复本机已确认领取卡片的可见状态，保留领取与原记录；不会发送任务。是否继续？'))return;
    if(!same(c))return;
    busy=true;refresh.disabled=true;error.textContent='';for(const b of list.querySelectorAll('button'))b.disabled=true;
    try{
      if(command.kind==='open')await api.post('open',{threadId:command.threadId});
      else if(command.kind==='refresh')await api.post('refresh');
      else if(command.kind==='sync')await api.post('sync/run');
      else if(command.kind==='claim')await api.post('sync/release',{id:c.id,confirmed:true});
      else if(command.kind==='restore-claim')await api.post('tasks/restore-claimed',{id:c.id,confirmed:true});
      else if(command.kind==='cancel-maintenance')await api.post('service/restart/cancel',{instanceId:c.instanceId});
      else if(command.kind==='cancel-queued'){const j=api.state().jobs.find(j=>j.id===command.jobId);if(j?.id!==t.currentJobId||j?.status!=='queued')throw Error('排队状态已变化，请重新检查。');await api.post('cancel',{id:command.jobId});}
      else throw Error('恢复操作不受支持，请重新检查。');
      if(!same(c))return;await api.load();if(!same(c))return;status.textContent=command.kind==='open'?'已请求打开原对话；完成核对后重新检查。':'操作已完成，请重新检查当前条件。';result=null;execute.hidden=true;list.replaceChildren();
    }catch(e){if(same(c))error.textContent=e.message+'；未自动重试，请核对原记录。';}
    finally{if(same(c)){busy=false;refresh.disabled=false;for(const b of list.querySelectorAll('button'))b.disabled=false;}}
  }
  refresh.onclick=check;
  execute.onclick=()=>{const c=context;if(busy||!same(c)||!result?.canSubmit)return;if(c.signature!==signature(task())){update();return;}const paused=result.manualPausedPlanId;close();void api.execute(c.id,paused);};
  async function open(id){if(busy&&context)return;const t=await api.ensure(id);if(!t||t.projectId!==api.projectId())return;context={id,projectId:api.projectId(),instanceId:api.state().service.instanceId,signature:signature(t)};find('[data-recovery-task]').textContent=t.title;dialog.showModal();void check();}
  return {open,update,card,cardParts,activate,note:(id,message)=>failures.set(id,message),clear:id=>failures.delete(id),key:()=>JSON.stringify([...failures,...inlineBusy]),taskId:()=>dialog.open?context?.id??'':''};
}
