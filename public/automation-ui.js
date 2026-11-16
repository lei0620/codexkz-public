import {filterTasks} from './properties.js';
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let api,state={tasks:[],threads:[]},projectId='',selecting=false,selected=new Set(),planIds=[],planRequest='',lastKey='';
const planPending=new Set();let inspectedPlanId='';
const activePlans=()=>state.automation?.plans.filter(p=>p.projectId===projectId&&['active','paused'].includes(p.status))??[];
const owned=id=>activePlans().some(p=>p.nodes.some(n=>n.taskId===id&&!n.jobId&&!n.skipped));
const selectable=t=>t.projectId===projectId&&t.status==='todo'&&!t.archivedAt&&!t.syncReserved&&!['discussion','confirmation'].includes(t.workflowStage)&&!owned(t.id);
export const isSelected=id=>selected.has(id);
export const selectedTaskIds=()=>[...selected];
export const selectionKey=()=>JSON.stringify([selecting,[...selected],state.automation,[...planPending],state.service?.maintenance,state.connectionError]);
export function selectionControl(task){return selecting&&task.status==='todo'?`<input class="task-choice" type="checkbox" data-select-task="${esc(task.id)}" aria-label="选择任务：${esc(task.title)}" ${selected.has(task.id)?'checked':''} ${selectable(task)?'':'disabled'}>`:'';}
const queuedPlan=(task,data)=>(data.automation?.plans??[]).find(p=>p.projectId===task.projectId&&['active','paused'].includes(p.status)&&p.nodes.some(n=>n.taskId===task.id&&!n.jobId&&!n.skipped));
// An accepted plan already owns these tasks, even before it creates their jobs.
// Keep this a display projection: the scheduler still needs persisted todo state.
export function taskLane(task,data=state){return task.status==='todo'&&queuedPlan(task,data)?'running':task.status;}
export function editableTask(task,data=state){
  if(!task||task.archivedAt||task.initialDispatch)return false;
  if((data.jobs??[]).some(j=>j.taskId===task.id&&['sending','submitted','running','uncertain'].includes(j.status)))return false;
  const job=(data.jobs??[]).find(j=>j.taskId===task.id&&j.id===task.currentJobId),queued=job?.status==='queued'&&!job.sentAt&&!job.receipt&&!job.turnId&&!job.correlationToken;
  return (task.status==='todo'||queued)&&(!task.syncReserved||task.syncReservationConfirmed===true);
}
function visiblePlanReason(reason=''){
  if(/ENOENT|附件/.test(reason)&&/attachments|附件/.test(reason))return '附件无法读取，请修改附件，保存后将自动继续';
  return reason.includes('ENOENT')&&/对话日志|rollout-/.test(reason)?'旧执行对话的记录已缺失，继续后自动新建对话':reason;
}
export function scheduledTaskState(task,data=state){
  const plan=queuedPlan(task,data);
  if(!plan)return null;
  const node=plan.nodes.find(n=>n.taskId===task.id),view=planPresentation(plan,data.tasks??[],data.jobs??[]);
  const diagnosticReason=plan.reason||(node.status==='blocked'?node.message:'')||'',reason=visiblePlanReason(diagnosticReason),message=node.message||'已加入执行队列';
  let label='准备执行',waitReason='正在准备执行对话，尚未发送';
  if(node.recovery?.requiresInput){label='需处理';waitReason=visiblePlanReason(node.message);}
  else if(plan.status==='paused'&&plan.automaticRecovery?.kind==='result-verification'){label='自动核对中';waitReason=reason||'正在核对原执行结果，核实后自动继续';}
  else if(plan.status==='paused'){label='已暂停';waitReason=reason||'安排已暂停，尚未发送';}
  else if(data.service?.maintenance?.status==='waiting'){label='等待更新';waitReason='面板等待安全更新，完成后继续安排';}
  else if(/前置/.test(message)){label='等待前置';waitReason=message;}
  else if(/执行空位|顺序执行|活动对话|空闲/.test(message)){label='等待空闲';waitReason=message;}
  else if(node.status==='recovering'){label='自动恢复中';waitReason=message;}
  else if(/新建对话|创建|就绪/.test(message)){label='准备对话';waitReason=message;}
  else if(/核验|核对|读取/.test(message)||['checking','blocked'].includes(data.service?.catalogHealth?.activities)){label=data.activityScope==='panel'?'检查目标对话':'等待核验';waitReason=data.activityScope==='panel'?visiblePlanReason(message):'正在核对桌面对话状态，核对后继续安排';}
  else if(node.message&&node.message!=='等待调度')waitReason=visiblePlanReason(node.message);
  const canManual=plan.status==='paused'&&!plan.automaticRecovery&&data.service?.manualPausedExecutionSupported===true&&task.status==='todo'&&!task.archivedAt&&(!task.syncReserved||task.syncReservationConfirmed)&&!task.initialDispatch&&(!['discussion','confirmation'].includes(task.workflowStage)||data.service?.manualTaskAcceptanceSupported)&&!(data.jobs??[]).some(j=>j.taskId===task.id&&['queued','sending','submitted','running','uncertain'].includes(j.status));
  return {id:plan.id,status:plan.status,label,waitReason,diagnosticReason,remaining:view.remaining,canResume:view.canResume,canManual,message:plan.automaticRecovery?.kind==='result-verification'?waitReason:plan.status==='paused'?'执行已暂停'+(view.canResume?'':' · 需核对')+(reason?'：'+reason:''):message};
}
export function scheduledMessage(task){return scheduledTaskState(task)?.message??'';}
export function executionManagement(task){
  const plan=(task.status==='todo'||task.initialDispatch?queuedPlan(task,state):null)??(state.automation?.plans??[]).find(p=>p.projectId===task.projectId&&['active','paused'].includes(p.status)&&p.nodes.some(n=>n.taskId===task.id&&n.jobId===task.currentJobId));
  return plan?`<button type="button" data-inspect-plan="${esc(plan.id)}" aria-label="管理本任务的执行安排">管理</button>`:'';
}
export function scheduledAction(task,{blocked='',pending=false}={},data=state){
  const plan=scheduledTaskState(task,data);if(!plan)return '';
  if(plan.status!=='paused')return `<button disabled title="${esc(plan.waitReason)}">${esc(plan.label)}</button>`;
  if(plan.canManual){const reason=data.service?.manualTaskAcceptanceSupported?'':blocked||(['waiting','ready'].includes(data.service?.maintenance?.status)?'面板等待安全更新':'');return `<button type="button" class="primary" data-action="execute" data-id="${esc(task.id)}" data-paused-plan-id="${esc(plan.id)}" title="${esc(reason||'仅执行当前任务，其余任务保持暂停')}" ${reason||pending?'disabled':''}>${pending?'提交中…':'手动执行'}</button>`;}
  if(!plan.canResume)return `<button type="button" data-inspect-plan="${esc(plan.id)}">查看原因</button>`;
  const busy=planPending.has(plan.id),resumeBlocked=state.service?.maintenance?.status==='waiting'?'面板等待安全重启':state.connectionError||(!state.caller?'尚未连接Codex':'');
  return `<button type="button" class="primary" data-plan-action="resume" data-id="${esc(plan.id)}" aria-label="继续本组剩余 ${plan.remaining} 项任务" title="${esc(resumeBlocked||'继续原队列中的 '+plan.remaining+' 项任务，不新增执行安排')}" ${busy||resumeBlocked?'disabled':''}>${busy?'提交中…':'继续 '+plan.remaining+' 项'}</button>`;
}
export function taskRouteHint(task){const scheduled=scheduledMessage(task);if(scheduled)return scheduled;if(!task.execution)return '';return (state.defaultModel?.available?'当前默认：'+state.defaultModel.modelLabel+' · ':'')+'模块：'+(task.execution.unit||task.title)+' · '+({match:'自动匹配，未匹配则新建',new:'模块专用对话',fixed:'指定对话'})[task.execution.mode];}
export const dependencyEditorVisible=()=>true;
function bindExecutionDependencies(dependencies,candidates){
  const picker=$('executionDependencies'),add=$('addExecutionDependency'),list=$('executionDependencyList');
  const selected=new Set(dependencies);
  const labels=new Map(candidates.map(t=>[t.id,`${t.shortId??t.id.slice(0,8)} · ${t.title}`]));
  picker.insertAdjacentHTML('beforeend',[...labels].map(([id,label])=>`<option value="${esc(id)}">${esc(label)}</option>`).join(''));
  const updateAdd=()=>{add.disabled=!labels.has(picker.value)||selected.has(picker.value)||selected.size>=20;};
  const render=()=>{
    list.innerHTML=[...selected].map(id=>{
      const label=labels.get(id)??'已关联的任务（当前列表不可用）';
      return `<li data-execution-dependency="${esc(id)}"><span>${esc(label)}</span><button type="button" data-remove-dependency="${esc(id)}" aria-label="移除前置任务：${esc(label)}">移除</button></li>`;
    }).join('');
    list.hidden=!selected.size;
    $('executionDependencyCount').textContent=selected.size?`已选 ${selected.size} 项`:'未设置';
    for(const option of picker.options)option.disabled=selected.has(option.value);
    updateAdd();
  };
  const changed=()=>{render();list.dispatchEvent(new Event('change',{bubbles:true}));};
  picker.onchange=updateAdd;
  add.onclick=()=>{
    if(add.disabled)return;
    selected.add(picker.value);picker.value='';changed();picker.focus();
  };
  list.onclick=event=>{
    const button=event.target.closest('[data-remove-dependency]');
    if(button&&selected.delete(button.dataset.removeDependency)){changed();picker.focus();}
  };
  render();
}
export function executionEditor(task,id){
  const e=task.execution??{mode:'match',unit:'',parallel:true},stored=id?state.tasks.find(t=>t.id===id):null,showDependencies=dependencyEditorVisible(task,stored),project=state.projects?.find(p=>p.projectId===projectId),norm=p=>(p??'').replaceAll('/','\\').replace(/\\+$/,'').toLowerCase();
  const threads=state.threads.filter(t=>t.kind==='codex'&&t.hostId==='local'&&norm(t.cwd)===norm(project?.path)),dependencies=task.dependsOn??[];
  $('taskExecution').innerHTML=`<section class="execution-settings" id="taskExecutionSettings" aria-label="执行安排"><div class="execution-head"><span>执行安排</span><small id="executionSummary"></small></div><div class="execution-body"><select id="executionMode" aria-label="对话方式"><option value="match">自动匹配</option><option value="new">新建模块对话</option><option value="fixed">指定已有对话</option></select><input type="hidden" id="executionUnit" value="${esc(e.unit)}"><label id="fixedThreadLabel" ${e.mode==='fixed'?'':'hidden'}>本项目对话<select id="executionThread"><option value="">请选择…</option>${threads.map(t=>`<option value="${esc(t.id)}" ${e.threadId===t.id?'selected':''}>${esc(t.title)}</option>`).join('')}</select></label><label class="check" title="仅当双方都允许、不同模块与对话且无依赖时并行；否则自动顺序执行"><input id="executionParallel" type="checkbox" ${e.parallel?'checked':''}>允许独立模块并行</label></div></section>${showDependencies?`<details class="execution-settings dependency-settings" id="executionDependenciesBlock" ${dependencies.length?'open':''}><summary><span>前置任务</span><small id="executionDependencyCount"></small></summary><div class="execution-dependency-body"><div class="execution-dependency-picker"><select id="executionDependencies" aria-label="选择前置任务"><option value="">选择前置任务…</option></select><button type="button" id="addExecutionDependency" disabled>添加</button></div><ul id="executionDependencyList" class="execution-dependency-list" hidden></ul></div></details>`:''}`;
  const unit=$('executionUnit');unit.type='text';unit.maxLength=80;unit.placeholder='默认使用所属版块或任务名称';
  const unitLabel=document.createElement('label');unitLabel.textContent='任务模块';unit.before(unitLabel);unitLabel.append(unit);
  const scopeLabel=document.createElement('label');scopeLabel.textContent='允许修改范围（项目相对路径，每行一项）';
  const scopes=document.createElement('textarea');scopes.id='executionWritePaths';scopes.rows=3;scopes.placeholder='例如：src/search 或 public/search.js';scopes.value=(e.writePaths??[]).join('\n');scopeLabel.append(scopes);$('executionParallel').closest('label').after(scopeLabel);
  const hint=document.createElement('p');hint.className='hint';hint.textContent='独立模块且修改范围不重叠时自动并行；同模块、同对话、范围重叠或未知时自动等待。共享配置、公共文档、提交与部署也需纳入范围。';scopeLabel.after(hint);
  const advanced=document.createElement('details');advanced.id='executionAdvanced';advanced.className='execution-controls';
  const advancedSummary=document.createElement('summary');advancedSummary.textContent='高级执行设置';
  const advancedBody=document.createElement('div');advancedBody.className='execution-control-body';
  hint.after(advanced);advanced.append(advancedSummary,advancedBody);
  advancedBody.append(unitLabel,$('executionParallel').closest('label'),scopeLabel,hint);
  const updateSummary=()=>{$('executionSummary').textContent=({match:'自动匹配',new:'新建对话',fixed:'指定对话'})[$('executionMode').value]+($('executionParallel').checked?' · 智能并行':' · 顺序执行');};
  $('executionMode').value=e.mode;$('executionMode').onchange=()=>{$('fixedThreadLabel').hidden=$('executionMode').value!=='fixed';updateSummary();};
  if(showDependencies)bindExecutionDependencies(dependencies,state.tasks.filter(t=>t.projectId===projectId&&t.id!==id&&!t.archivedAt));
  $('executionParallel').onchange=updateSummary;updateSummary();
}
export function executionValues(){return {execution:{mode:$('executionMode').value,unit:$('executionUnit').value.trim(),parallel:$('executionParallel').checked,threadId:$('executionThread').value,writePaths:$('executionWritePaths').value.split(/\r?\n/).map(p=>p.trim()).filter(Boolean)},dependsOn:[...($('executionDependencyList')?.children??[])].map(row=>row.dataset.executionDependency)};}
// Presentation follows actual execution records, not the scheduler's terminal
// counter: released/failed/cancelled must never look like successful completion.
export function planPresentation(plan,tasks=[],jobs=[]){
  const counts={waiting:0,running:0,review:0,approved:0,returned:0,attention:0,notRun:0};
  const rows=plan.nodes.map(node=>{
    const task=tasks.find(t=>t.id===node.taskId),job=jobs.find(j=>j.id===node.jobId&&j.taskId===node.taskId);
    const status=node.skipped?'skipped':node.jobId?(job?.status??'unknown'):(node.status??'pending');
    let kind,label;
    if(status==='completed'&&job){
      const decision=task?.history?.filter(e=>['approved','returned'].includes(e.type)&&e.jobId===job.id).at(-1);
      const approved=decision?.type==='approved'||(!decision&&task?.status==='done'&&task.currentJobId===job.id);
      kind=approved?'approved':decision?.type==='returned'?'returned':'review';label=approved?'已审阅通过':kind==='returned'?'已退回修改，需再次手动执行':'本轮已结束，待你审阅';
    }else if(['sending','submitted','running'].includes(status)){kind='running';label=({sending:'正在提交',submitted:'等待本轮回复',running:'执行中'})[status];}
    else if(['queued','pending','creating','recovering'].includes(status)){kind='waiting';label=plan.status==='paused'?'已暂停，尚未发送':status==='recovering'?'自动恢复同步中':status==='queued'?'排队等待空闲':status==='creating'?'准备执行对话':'等待安排';}
    else if(['cancelled','skipped'].includes(status)){kind='notRun';label=status==='skipped'?'未执行':'已取消排队';}
    else{kind='attention';label=({completed:'执行记录不可用',failed:'执行失败',interrupted:'执行中断',uncertain:'发送未确认，请核对',released:'已解除未决，未确认成功',blocked:'需要处理',unknown:'执行记录不可用'})[status]??'状态待核对';}
    counts[kind]++;
    return {taskId:node.taskId,status,title:job?.taskTitle??task?.title??'任务不可用',kind,label,message:plan.status==='paused'&&kind==='waiting'?'':node.message??'',priority:task?.priority??2};
  });
  const remaining=plan.nodes.filter(n=>!n.skipped&&(!n.jobId||jobs.some(j=>j.id===n.jobId&&j.taskId===n.taskId&&j.status==='queued'))).length;
  const live=['active','paused'].includes(plan.status)||counts.running>0||counts.waiting>0;
  const label=plan.status==='paused'?'已暂停':plan.status==='cancelled'?(counts.running?'已停止安排，等待已提交任务结束':'已停止'):counts.attention?'需核对':counts.running?'执行中':counts.waiting?'等待执行':counts.review?'待你审阅':counts.returned?'有任务已退回修改':counts.approved===rows.length&&rows.length?'已审阅通过':counts.approved?'部分已审阅':'已结束（未执行）';
  return {id:plan.id,title:rows.length===1?'单次执行 · '+rows[0].title:'执行批次 · '+rows.length+' 项任务',createdAt:plan.createdAt,status:plan.status,label,live,remaining,counts,rows,reason:plan.reason??'',gate:plan.gate,maxConcurrent:plan.maxConcurrent,canResume:plan.status==='paused'&&remaining>0&&!rows.some(r=>r.status==='uncertain'||r.status==='unknown'||r.label==='执行记录不可用')};
}
export function livePlanControls(plan,open=false){
  return `<details class="execution-controls" data-plan="${esc(plan.id)}" ${open?'open':''}><summary><span>执行控制 <small>${plan.rows.length} 项</small></span><span class="control-status">${esc(plan.label)}</span><span class="control-toggle">管理</span></summary><div class="execution-control-body">${plan.reason?'<p class="hint">'+esc(plan.reason)+'</p>':''}<div class="compact-actions">${plan.status==='active'&&plan.remaining>0?`<button data-plan-action="pause" data-id="${esc(plan.id)}">暂停后续任务</button>`:''}${plan.canResume?`<button data-plan-action="resume" data-id="${esc(plan.id)}">继续剩余任务</button>`:''}${['active','paused'].includes(plan.status)?`<button data-plan-action="stop" data-id="${esc(plan.id)}">${plan.remaining?'退回待处理':'结束本次安排'}</button>`:''}</div><p class="hint">只影响后续安排，已提交的对话继续执行。任务进度与结果见下方卡片。</p></div></details>`;
}
function planCard(plan,open){
  const labels={waiting:'等待',running:'执行中',review:'待审阅',approved:'已审阅',returned:'已退回',attention:'需核对',notRun:'未执行'};
  const stats=Object.entries(plan.counts).filter(([,count])=>count).map(([key,count])=>`<span class="plan-count plan-${key}">${labels[key]} ${count}</span>`).join('');
  const date=plan.createdAt?new Date(plan.createdAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
  return `<details class="auto-plan" data-plan="${esc(plan.id)}" ${open?'open':''}><summary><span class="plan-title">${esc(plan.title)}</span><span class="plan-label">${esc(plan.label)}</span></summary><div class="plan-counts">${stats}</div><p class="hint">${date?esc(date)+' · ':''}${plan.maxConcurrent===1?'依次安排':'智能并行（按模块与修改范围放行）'} · ${plan.gate==='completed'?'依赖正常结束后放行':'依赖审阅通过后放行'}</p>${plan.live&&plan.reason?`<p class="hint">${esc(plan.reason)}</p>`:''}${[...plan.rows].sort((a,b)=>a.priority-b.priority).map(n=>`<div class="plan-node"><button data-auto-open="${esc(n.taskId)}">${esc(n.title)}</button><small class="plan-${n.kind}">${esc(n.label)}</small>${plan.live&&n.message&&n.message!==n.label?`<small>${esc(n.message)}</small>`:''}</div>`).join('')}<div class="compact-actions">${plan.status==='active'?`<button data-plan-action="pause" data-id="${esc(plan.id)}">暂停后续任务</button>`:''}${plan.canResume?`<button data-plan-action="resume" data-id="${esc(plan.id)}">继续剩余任务</button>`:''}${['active','paused'].includes(plan.status)?`<button data-plan-action="stop" data-id="${esc(plan.id)}">${plan.remaining?'退回待处理':'结束本次安排'}</button>`:''}</div>${plan.live?'<p class="hint">暂停或停止只影响后续发送，已提交的对话继续执行；异常不会自动重试。</p>':''}</details>`;
}
export function updateAutomation(next,id){
  if(id!==projectId){inspectedPlanId='';$('planReasonDialog')?.close();}
  state=next;if(projectId!==id){projectId=id;selected.clear();selecting=false;lastKey='';$('autoPlanDialog').close();$('autoPlans').innerHTML='';$('executionHistory')?.remove();}
  renderPlanReason();
  for(const value of selected){const t=state.tasks.find(t=>t.id===value);if(!t||!selectable(t))selected.delete(value);}
  $('multiSelect').setAttribute('aria-label',selecting?'退出多选':'多选任务');$('multiSelect').setAttribute('title',selecting?'退出多选':'多选任务');$('multiSelect').setAttribute('aria-pressed',String(selecting));$('multiSelect').hidden=$('board').hidden;$('laneNav').closest('.lane-tools').hidden=$('board').hidden;$('selectionBar').hidden=!selecting||$('board').hidden;$('selectedCount').textContent=`已选 ${selected.size} 项`;$('startAutoPlan').disabled=!selected.size||!state.automation;
  const plans=(state.automation?.plans??[]).filter(p=>p.projectId===projectId).map(p=>planPresentation(p,state.tasks,state.jobs??[]));
  const key=JSON.stringify(plans);if(key===lastKey)return;lastKey=key;
  const previousHistory=$('executionHistory');
  const open=new Set([...$('autoPlans').querySelectorAll('details[open]'),...(previousHistory?[previousHistory,...previousHistory.querySelectorAll('details[open]')].filter(d=>d.open):[])].map(d=>d.dataset.plan??d.id));
  const active=document.activeElement,focus=(active?.closest('#autoPlans')||active?.closest('#executionHistory'))?{plan:active.closest('[data-plan]')?.dataset.plan,task:active.dataset.autoOpen,action:active.dataset.planAction,summary:active.matches('summary')}:null;
  const live=plans.filter(p=>p.live),history=plans.filter(p=>!p.live).reverse();previousHistory?.remove();$('autoPlans').hidden=!live.length;
  $('autoPlans').innerHTML=live.map(p=>livePlanControls(p,open.has(p.id))).join('')+(history.length?`<details id="executionHistory" class="execution-history" ${open.has('executionHistory')?'open':''}><summary>执行记录 · ${history.length} 次</summary><p class="hint">任务是否完成以人工审阅为准；未确认、失败和取消单独标示。</p>${history.map(p=>planCard(p,open.has(p.id))).join('')}</details>`:'');
  if($('executionHistory'))$('executionArchive').prepend($('executionHistory'));
  if(focus){
    const container=focus.plan?[...document.querySelectorAll('[data-plan]')].find(el=>el.dataset.plan===focus.plan):$('executionHistory');
    let target=focus.summary?container?.querySelector('summary'):[...(container?.querySelectorAll('button')??[])].find(el=>focus.task?el.dataset.autoOpen===focus.task:el.dataset.planAction===focus.action);
    target??=container?.querySelector('summary');
    for(let parent=target?.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.open&&!parent.querySelector(':scope > summary')?.contains(target))target=parent.querySelector(':scope > summary');
    target?.focus({preventScroll:true});
  }

}
function renderPlanReason(){
  if(!inspectedPlanId)return;const plan=(state.automation?.plans??[]).find(p=>p.id===inspectedPlanId&&p.projectId===projectId);
  if(!plan){$('planReasonDialog').close();inspectedPlanId='';return;}
  const view=planPresentation(plan,state.tasks,state.jobs??[]);
  $('planReasonTitle').textContent=plan.status==='paused'?'暂停原因':'执行安排';
  $('planReasonDialog').querySelector('.dialog-heading button').setAttribute('aria-label',plan.status==='paused'?'关闭暂停原因':'关闭执行安排');
  if(plan.status!=='paused'){$('planReasonContent').innerHTML=livePlanControls(view,true);return;}
  const pending=(state.automation?.routes??[]).filter(r=>r.initialDispatch?.phase==='uncertain'&&plan.nodes.some(n=>n.taskId===r.initialDispatch.taskId)).map(r=>state.tasks.find(t=>t.id===r.initialDispatch.taskId)??{id:r.initialDispatch.taskId});
  const reasonKey=JSON.stringify([plan,view,pending.map(t=>t.id),planPending.has(plan.id)]),content=$('planReasonContent');if(content.dataset.reasonKey===reasonKey)return;content.dataset.reasonKey=reasonKey;
  $('planReasonContent').innerHTML=`<p>${esc(plan.reason||'有执行记录需要核对，尚未恢复队列。')}</p>${view.rows.filter(row=>row.kind==='attention').map(row=>`<p><strong>${esc(row.title)}</strong><br><span class="hint">${esc(row.label)}</span></p><button type="button" data-auto-open="${esc(row.taskId)}">查看任务</button>`).join('')}<p class="hint">核对相关任务后可继续原队列，不会重复发送已提交任务。</p>${view.canResume?`<button type="button" class="primary" data-plan-action="resume" data-id="${esc(plan.id)}" ${planPending.has(plan.id)?'disabled':''}>继续 ${view.remaining} 项</button>`:''}`;
  for(const task of pending){const form=document.createElement('form');form.dataset.confirmInitial=task.id;form.dataset.planId=plan.id;form.innerHTML='<label>核对已创建的原对话<input name="threadId" required placeholder="填入原对话 ID"></label><p class="hint">只关联唯一对应的任务正文，不创建或重发任务。</p><button type="submit">核对并关联</button>';$('planReasonContent').append(form);}
}
export function initAutomation(context){
  document.addEventListener('submit',async event=>{const form=event.target.closest('form[data-confirm-initial]');if(!form)return;event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await api.post('automation/control',{id:form.dataset.planId,taskId:form.dataset.confirmInitial,threadId:new FormData(form).get('threadId'),action:'confirm-initial',confirmed:true});await api.load();renderPlanReason();}catch(error){api.notice(error.message,true);}finally{button.disabled=false;}});
  api=context;const tools=document.createElement('div');tools.className='lane-tools';$('laneNav').before(tools);tools.append($('laneNav'));const selectButton=document.createElement('button');selectButton.type='button';selectButton.id='multiSelect';selectButton.className='heading-icon';selectButton.setAttribute('aria-label','多选任务');selectButton.setAttribute('title','多选任务');selectButton.setAttribute('aria-pressed','false');selectButton.setAttribute('aria-controls','board');selectButton.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M17 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"/><rect x="7" y="7" width="14" height="14" rx="3.5"/><path d="m11 14 2.2 2.2 3.8-4.4"/></svg>';$('filterToggle').before(selectButton);tools.after($('pendingSources'));
  const reasonDialog=document.createElement('dialog');reasonDialog.id='planReasonDialog';reasonDialog.setAttribute('aria-labelledby','planReasonTitle');reasonDialog.innerHTML='<div class="dialog-heading"><h2 id="planReasonTitle">暂停原因</h2><button type="button" aria-label="关闭暂停原因">×</button></div><div id="planReasonContent"></div>';reasonDialog.querySelector('button').onclick=()=>reasonDialog.close();reasonDialog.onclose=()=>{inspectedPlanId='';};document.body.append(reasonDialog);
  const panel=document.createElement('div');panel.id='automationPanel';panel.innerHTML='<div id="selectionBar" class="selection-bar" hidden><span id="selectedCount">已选 0 项</span><button id="selectVisible">全选当前筛选</button><button id="startAutoPlan" class="primary">安排所选任务</button></div><section id="autoPlans" aria-label="执行队列与记录" hidden></section>';$('board').before(panel);
  $('executionArchive').prepend($('autoPlans'));
  const dialog=document.createElement('dialog');dialog.id='autoPlanDialog';dialog.setAttribute('aria-labelledby','autoPlanTitle');dialog.innerHTML='<div class="dialog-heading"><h2 id="autoPlanTitle">批量执行</h2><button type="button" data-close="autoPlanDialog" aria-label="关闭批量执行设置">×</button></div><p id="autoPlanPolicy" class="hint"></p><div id="autoPlanPreview"></div><form id="autoPlanForm"><details id="planAdvanced"><summary>依赖与并行设置</summary><div class="execution-grid"><label>执行节奏<select id="planConcurrency"><option value="1">依次执行</option><option value="0">智能并行（按模块与修改范围放行）</option></select></label><label>前置任务何时算完成<select id="planGate"><option value="reviewed">我审阅通过后</option><option value="completed">本轮正常结束后（不等审阅）</option></select></label></div><p class="hint">按优先级执行所选任务；未匹配到对话的模块会新建专用对话。异常或发送未确认时暂停，结果始终保留人工审阅。只有明确允许并行、修改范围不重叠且无依赖的独立模块会同时执行；范围未知或重叠时自动排队。</p></details><p id="autoPlanError" class="error" role="alert"></p><button class="primary" type="submit">确认并开始</button></form>';document.body.append(dialog);
  $('multiSelect').onclick=()=>{selecting=!selecting;if(selecting)api.selectTodo();else selected.clear();api.render();};
  $('selectVisible').onclick=()=>{const rows=filterTasks(state.tasks.filter(t=>!t._reference&&selectable(t)));if(rows.length&&rows.every(t=>selected.has(t.id)))rows.forEach(t=>selected.delete(t.id));else rows.forEach(t=>selected.add(t.id));api.render();};
  document.addEventListener('change',e=>{const checkbox=e.target.closest('[data-select-task]');if(checkbox){if(checkbox.checked)selected.add(checkbox.dataset.selectTask);else selected.delete(checkbox.dataset.selectTask);api.render();}});
  const updatePolicy=()=>{$('autoPlanPolicy').textContent=`本次仅执行所选的 ${planIds.length} 项任务，不会自动加入新待办。${$('planConcurrency').value==='1'?'依次安排':'独立模块智能并行，无数量上限'}；${$('planGate').value==='reviewed'?'有依赖时等你审阅通过':'有依赖时等待本轮正常结束'}。`;};$('planConcurrency').onchange=$('planGate').onchange=updatePolicy;
  $('startAutoPlan').onclick=()=>{planIds=[...selected];planRequest=crypto.randomUUID();const parallel=state.service?.intelligentDispatchSupported;$('planConcurrency').querySelector('[value="0"]').disabled=!parallel;$('planConcurrency').value=parallel?'0':'1';$('planGate').value='completed';$('planAdvanced').open=false;updatePolicy();$('autoPlanPreview').innerHTML=planIds.map(id=>state.tasks.find(t=>t.id===id)).sort((a,b)=>(a.priority??2)-(b.priority??2)).map(t=>`<p class="auto-plan-preview"><span>P${t.priority??2}</span><strong>${esc(t.title)}</strong><small>${esc(taskRouteHint(t)||('模块：'+t.title+' · 自动匹配，未匹配则新建'))}</small></p>`).join('');$('autoPlanError').textContent='';dialog.showModal();};
  $('autoPlanForm').onsubmit=async e=>{e.preventDefault();const b=e.submitter;if(b.disabled)return;b.disabled=true;try{await api.post('automation/start',{projectId,ids:planIds,requestId:planRequest,maxConcurrent:Number($('planConcurrency').value),gate:$('planGate').value});selected.clear();selecting=false;dialog.close();await api.load();api.notice('已开始安排所选任务；新建待办不会自动加入。');}catch(error){$('autoPlanError').textContent=error.message;}finally{b.disabled=false;}};
  document.addEventListener('click',async e=>{const inspect=e.target.closest('[data-inspect-plan]');if(inspect){inspectedPlanId=inspect.dataset.inspectPlan;renderPlanReason();reasonDialog.showModal();}const open=e.target.closest('[data-auto-open]');if(open)api.showDetail(open.dataset.autoOpen);const button=e.target.closest('[data-plan-action]');if(button&&!button.disabled){const id=button.dataset.id;if(planPending.has(id))return;planPending.add(id);button.disabled=true;api.render();try{await api.post('automation/control',{id,action:button.dataset.planAction});await api.load();}catch(error){api.notice(error.message,true);}finally{planPending.delete(id);button.disabled=false;api.render();}}});
}
