import {choicePicker,dependencySortEnabled} from './properties.js';
// Keep the opt-in execution request in the existing task body so every save,
// queue snapshot, composer fill and synced card carries the same instruction.
const legacyGoalPlanRequest='执行要求：目标和计划\n请根据以上任务内容判断是否需要建立持续目标和制定执行计划。需要时，请创建目标、制定计划并按计划推进，直到完成或遇到确实需要我决定的阻塞；简单任务可直接完成。保留项目现有审批与执行边界。';
const taskModeRequests={
  goal:'执行要求：目标\n请根据以上任务内容判断是否需要建立持续目标。需要时，请创建目标并持续推进，直到完成或遇到确实需要我决定的阻塞；简单任务可直接完成。保留项目现有审批与执行边界。',
  plan:'执行要求：计划\n请根据以上任务内容判断是否需要制定执行计划。需要时，请先制定计划并按计划推进；简单任务可直接完成。保留项目现有审批与执行边界。'
};
export function taskModeContent(description='',mode=''){
  if(!['','goal','plan'].includes(mode))throw Error('目标和计划只能开启其中一个');
  return String(description)+(mode?'\n\n'+taskModeRequests[mode]:'');
}
export function readTaskModeContent(description=''){
  const text=String(description);
  for(const [taskMode,request] of Object.entries(taskModeRequests)){
    const suffix='\n\n'+request;
    if(text.endsWith(suffix))return {description:text.slice(0,-suffix.length),taskMode};
  }
  // The previous combined option cannot represent an exclusive user choice.
  // Keep its body when editing and let the user select either new option.
  const suffix='\n\n'+legacyGoalPlanRequest;
  return {description:text.endsWith(suffix)?text.slice(0,-suffix.length):text,taskMode:''};
}
let state={},projectId='',api,flags={section:true,priority:true,type:true},timer,ticket=0,opened=false,manualGrouping=false,existingTask=false,autoMatchGroup=false;
const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const taskSection=(s,t)=>(s.taskSections??[]).find(v=>v.id===t.sectionId&&v.projectId===t.projectId);
export function cancelTaskSuggestion(){ticket++;clearTimeout(timer);}
export function initTaskOrganization(context){
  api=context;
  $('taskOrganization').innerHTML='<label id="taskGroupField" for="taskBoardGroup" hidden>任务分组<select id="taskBoardGroup"><option value="">默认分组</option></select></label><div id="taskExecutionSection"><div class="task-section-row"><p id="taskSectionResult" role="status"></p><button type="button" id="adjustTaskSection" aria-expanded="false" aria-controls="taskSectionOverride" title="选择已有版块或输入新名称">调整</button><button type="button" id="inferTaskAgain" title="根据任务内容重新自动匹配版块">重匹配</button></div><div id="taskSectionOverride" hidden>'+choicePicker({id:'taskSectionName',label:'指定版块',placeholder:'选择已有版块或输入新名称'})+'</div><p id="taskSectionContext" class="hint"></p><p id="taskInferenceReason" class="hint" role="status"></p></div><button id="editTaskExecutionSection" type="button" hidden>执行版块设置</button>';
  $('taskForm').addEventListener('input',e=>{
    if(!opened)return;
    if(e.target.id==='taskDescription'){
      if(autoMatchGroup){updateMatchedGroup();api.changed();}
      schedule();
    }else if(e.target.id==='taskBoardGroup'){
      autoMatchGroup=false;api.changed();
    }else if(e.target.id==='taskSectionName'){flags.section=false;summary();api.changed();}
    else if(e.target.id==='taskPriority'){flags.priority=false;summary();api.changed();}
    else if(e.target.matches('[data-type-name]')){flags.type=false;summary();api.changed();}
  });
  $('adjustTaskSection').onclick=()=>{const panel=$('taskSectionOverride');panel.hidden=!panel.hidden;$('adjustTaskSection').setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)$('taskSectionName').focus();};
  $('inferTaskAgain').onclick=()=>{flags.section=true;$('taskSectionOverride').hidden=true;$('adjustTaskSection').setAttribute('aria-expanded','false');schedule();api.changed();};
  $('editor').addEventListener('close',()=>{opened=false;cancelTaskSuggestion();});
}
function summary(){
  const name=$('taskSectionName').value.trim(),section=(state.taskSections??[]).find(s=>s.projectId===projectId&&s.name===name);
  const label=name||($('taskDescription').value.trim()?'按任务内容独立分组':'填写内容后自动匹配');
  $('taskSectionResult').textContent=flags.section?(section?'已匹配 · '+label:name?'新建版块 · '+label:'自动匹配'):'指定 · '+(name||'未指定');
  const context=section?.description?section.description.slice(0,160):'';$('taskSectionContext').textContent=context;$('taskSectionContext').title=context;
}
function schedule(){
  clearTimeout(timer);const current=++ticket;timer=setTimeout(async()=>{
    if(!opened||!$('taskDescription').value.trim()||!Object.values(flags).some(Boolean))return;
    try{const suggestion=await api.post('tasks/suggest',{projectId,autoTitle:true,description:$('taskDescription').value});if(current!==ticket||!opened||$('taskForm').getAttribute('aria-busy')==='true')return;
      if(flags.section)$('taskSectionName').value=suggestion.sectionName;
      if(flags.priority)$('taskPriority').value=String(suggestion.priority);
      if(flags.type&&$('task-type-input'))$('task-type-input').value=suggestion.typeName;
      $('taskInferenceReason').textContent=suggestion.reason;$('taskInferenceReason').title=suggestion.reason;summary();api.changed();
    }catch(e){if(current===ticket&&opened){$('taskInferenceReason').textContent=e.message;$('taskInferenceReason').title=e.message;}}
  },400);
}
export function updateTaskOrganization(next,id){
  state=next;projectId=id;
  const options=$('taskOrganization').querySelector('[data-choice-options]');if(options)options.innerHTML=(state.taskSections??[]).filter(s=>s.projectId===id).map(s=>'<option value="'+esc(s.name)+'"></option>').join('');
  if(api.groupOptions){const select=$('taskBoardGroup'),html=api.groupOptions(next,id),value=select.value;if(select.innerHTML!==html){select.innerHTML=html;select.value=value;if(select.selectedIndex<0)select.selectedIndex=0;updateMatchedGroup();}}
}
function updateMatchedGroup(){
  if(opened&&autoMatchGroup&&$('taskForm').getAttribute('aria-busy')!=='true')$('taskBoardGroup').value=api.matchGroup(state,projectId,$('taskDescription').value);
}
export function openTaskOrganization(task,editing,{legacyReceipt=false,matchGroup=false}={}){
  cancelTaskSuggestion();opened=true;flags={...(task.autoProperties??{section:!editing||!task.sectionId,priority:!editing,type:!editing}),...(editing&&task.sectionId?{section:false}:{})};
  manualGrouping=!!api.groupOptions&&!legacyReceipt;existingTask=editing;
  autoMatchGroup=!!api.matchGroup&&manualGrouping&&!editing&&matchGroup&&(task.autoMatchGroup??!task.boardGroupId);
  if(manualGrouping)flags.section=false;
  $('taskGroupField').hidden=!manualGrouping||editing;
  $('taskExecutionSection').hidden=manualGrouping;
  const settings=$('editTaskExecutionSection'),section=taskSection(state,task);
  settings.hidden=!manualGrouping||!editing||!section;
  if(section)settings.dataset.sectionEdit=section.id;
  else delete settings.dataset.sectionEdit;
  if(manualGrouping){const select=$('taskBoardGroup');select.value=task.boardGroupId??'';if(select.selectedIndex<0)select.selectedIndex=0;}
  updateMatchedGroup();
  $('taskSectionOverride').hidden=true;$('adjustTaskSection').setAttribute('aria-expanded','false');
  $('taskSectionName').value=task.sectionName??taskSection(state,task)?.name??'';$('taskAttributes').open=false;$('taskInferenceReason').textContent='';$('taskInferenceReason').title='';summary();schedule();
}
export function organizationValues({draft=false}={}){
  if(manualGrouping)return {...(!existingTask?{boardGroupId:$('taskBoardGroup').value||null,...(draft?{autoMatchGroup}:{})}:{}),autoProperties:{...flags}};
  const name=$('taskSectionName').value.trim(),section=(state.taskSections??[]).find(s=>s.projectId===projectId&&s.name===name);
  return {...(!flags.section&&section?{sectionId:section.id}:{sectionName:name}),autoProperties:{...flags}};
}
// A save receipt survives an execution failure or lost response. Explicit retry
// reuses both the card and request ID; content changes require resolving that run.
export async function submitEditorTask({projectId,id,values,execute,currentThreadId,currentThreadMode,receipt,request,post,onReceipt,readTask,manualAcceptance=false}){
  const signature=currentThreadId?JSON.stringify({values,currentThreadId,...(currentThreadMode?{currentThreadMode}:{})}):JSON.stringify(values);
  if(!id&&receipt?.id&&receipt.attempted&&readTask){
    const previous=await readTask(receipt.id);
    if(previous?.id!==receipt.id||previous.projectId!==projectId)throw Error('无法核对原卡片归属，已保留草稿与执行回执');
    if(previous.status==='done'){
      if(receipt.signature===signature)return {saved:receipt,settled:true,scheduled:false};
      // Retire only a confirmed completed creation, never an unresolved send.
      // Persist retirement before saving so a failed new save cannot reuse its ID.
      receipt=null;onReceipt(null);
    }
  }
  if(receipt?.attempted&&receipt.signature!==signature)throw Error('上次执行状态尚待核对，请先关闭窗口查看原卡片；未另建或重发任务');
  if(receipt?.savePending&&receipt.signature!==signature)throw Error('上次保存回执尚待核对，请先按原内容重试；未重复创建任务');
  let saved=receipt;
  if(!saved?.id||saved.savePending||saved.signature!==signature){
    const taskId=saved?.id||id;
    const previous=saved&&!saved.savePending?saved:taskId?{id:taskId,attempted:false}:null;
    onReceipt({id:taskId,signature,savePending:true,attempted:false});
    let result;
    try{result=taskId?await post('tasks/update',{id:taskId,...values}):await post('tasks/create',{projectId,...values,requestId:request('create',signature)});}
    catch(error){if(error.notApplied===true)onReceipt(previous);throw error;}
    saved={id:result.task.id,signature,attempted:false};onReceipt(saved);
  }
  if(!execute)return {saved,scheduled:false};
  const wasAttempted=saved.attempted===true;
  saved={...saved,attempted:true};onReceipt(saved);
  let result;
  try{const accepted=manualAcceptance&&!currentThreadId?{accept:true,expectedRevision:(await readTask(saved.id)).executionRevision}:{};result=await post(currentThreadId?'tasks/send-current':'tasks/execute',{projectId,id:saved.id,...accepted,...(currentThreadId?{threadId:currentThreadId,...(currentThreadMode?{currentThreadMode}:{})}:{}),requestId:request('execute:'+saved.id,signature)});}
  catch(error){if((error.notSent===true||currentThreadId&&error.notApplied===true)&&!wasAttempted){saved={...saved,attempted:false};onReceipt(saved);}throw error;}
  return {saved,...result};
}

export async function submitDirectMessage({projectId,threadId,description,attachmentIds,receipt,request,post,onReceipt,route='composer/send'}){
  const values={projectId,threadId,description,attachmentIds},signature=JSON.stringify({...values,...(route!=='composer/send'?{route}:{})});
  if(route==='composer/submit'&&receipt&&receipt.signature!==signature)throw Error('上次发送结果尚未确认，请先核对原对话，再发送改过的内容。');
  const requestId=receipt?.signature===signature?receipt.requestId:request('message',signature);
  onReceipt({signature,requestId});
  let result;
  try{result=await post(route,{...values,requestId});}
  catch(error){if(error.notApplied===true)onReceipt(null);throw error;}
  if(route==='composer/submit'&&result.status==='not-submitted'){
    onReceipt(null);
    throw Error('这次没有发送。'+(result.message||'请检查聊天输入框，可继续执行卡片。'));
  }
  if(result.status!=='submitted'&&!(route==='composer/submit'&&result.status==='invoked'))throw Error('消息发送回执待核对，请查看原对话；不会自动重发');
  onReceipt(null);return result;
}
export async function nativeReceiptNotSubmitted({receipt,projectId,threadId,post}){
  if(!receipt||!threadId)return false;
  try{
    const {route,projectId:owner,threadId:target,description,attachmentIds}=JSON.parse(receipt.signature);
    if(route!=='composer/submit'||owner!==projectId||target!==threadId||!Array.isArray(attachmentIds))return false;
    // An older server ignores receiptOnly, so omit its mandatory submission requestId.
    const result=await post(route,{projectId,threadId,description,attachmentIds,receiptRequestId:receipt.requestId,receiptOnly:true});
    return result.status==='not-submitted';
  }catch{return false;}
}
// Preserve the incoming priority/date order among tasks whose predecessors are placed.
// Walk the project graph before filtering so hidden intermediate dependencies still count.
export function dependencyOrder(items,allTasks){
  if(items.length<2)return [...items];
  const project=items[0].projectId,byId=new Map(allTasks.filter(t=>t.projectId===project&&!t.archivedAt).map(t=>[t.id,t])),visible=new Set(items.map(t=>t.id));
  const prerequisites=new Map(items.map(t=>{
    const seen=new Set(),required=new Set(),pending=[...(t.dependsOn??[])];
    while(pending.length){const id=pending.pop();if(seen.has(id))continue;seen.add(id);const parent=byId.get(id);if(!parent)continue;if(visible.has(id))required.add(id);pending.push(...(parent.dependsOn??[]));}
    return [t.id,required];
  }));
  const remaining=[...items],placed=new Set(),ordered=[];
  while(remaining.length){
    const index=remaining.findIndex(t=>[...prerequisites.get(t.id)].every(id=>placed.has(id)));
    // Invalid historical cycles must never hide cards or hang rendering.
    if(index<0){ordered.push(...remaining);break;}
    const [next]=remaining.splice(index,1);ordered.push(next);placed.add(next.id);
  }
  return ordered;
}
export function dependencyCompleted(task,state){
  if(task?.status==='done')return true;
  if(!task||task.status!=='review'||task.archivedAt)return false;
  const job=state.jobs?.find(j=>j.id===task.currentJobId);
  return job?job.taskId===task.id&&job.status==='completed'&&!!job.turnId:task.dependencyCompleted===true;
}
function dependencySummary(task,byId,state){
  const parents=[...new Set(task.dependsOn??[])].map(id=>byId.get(id)).concat((task.pendingDependencies??[]).map(()=>undefined));
  if(!parents.length)return '';
  const plan=state.automation?.plans?.find(p=>['active','paused'].includes(p.status)&&p.nodes.some(n=>n.taskId===task.id&&!n.skipped));
  const gate=plan?.gate??state.jobs?.find(j=>j.id===task.currentJobId&&j.status==='queued')?.dependencyGate??'completed';
  const missing=parents.filter(t=>!t),waiting=parents.filter(t=>!t||(gate==='reviewed'?t.status!=='done':!dependencyCompleted(t,state)));
  const reviewOnly=gate==='reviewed'&&waiting.length&&waiting.every(t=>t?.status==='review'&&!t.archivedAt),unconfirmed=waiting.length&&waiting.every(t=>t?.status==='review');
  const summary=missing.length?`前置待接续 · ${missing.length} 项`:reviewOnly?`此安排等待审阅 · ${waiting.length} 项`:unconfirmed?`前置结束状态待核对 · ${waiting.length} 项`:waiting.length===1?`等待：${waiting[0].title}`:waiting.length?`等待 ${waiting.length} 项前置`:parents.some(t=>t?.status==='review')?`前置本轮已结束 · 可继续执行`:`前置已完成 · ${parents.length}/${parents.length}`;
  const link=(t,direction)=>!t?'<li class="task-dependency missing">前置任务待接续</li>':`<li><button type="button" class="task-dependency" data-dependency-target="${esc(t.id)}" aria-label="查看${direction}任务：${esc(t.title)}"><span>${esc(t.shortId?t.shortId+' · ':'')}${esc(t.title)}</span><span class="dependency-status">${esc(t.status==='done'?'已完成':t.archivedAt?'已归档 · 未完成':({todo:'待执行',running:'执行中',review:'待审阅'})[t.status]??'状态待核对')}</span></button></li>`;
  return `<details class="task-dependencies" data-dependency-task="${esc(task.id)}"><summary title="${esc(summary)}"><span class="dependency-summary-text">${esc(summary)}</span><span class="dependency-disclosure" aria-hidden="true"><span class="dependency-expand">展开</span><span class="dependency-collapse">收起</span></span></summary><div class="dependency-content"><p class="dependency-heading">需要先完成</p><ul>${parents.map(t=>link(t,'前置')).join('')}</ul></div></details>`;
}
export function renderTaskGroups(s,items,lane,render,renderGroups){
  const byId=new Map((s.tasks??items).filter(t=>t.projectId===items[0]?.projectId).map(t=>[t.id,t]));
  const renderList=tasks=>{
    const ordered=lane!=='done'&&dependencySortEnabled()?dependencyOrder(tasks,s.tasks??items):tasks;
    return ordered.map(t=>render(t,lane==='done'?'':dependencySummary(t,byId,s))).join('');
  };
  if(renderGroups)return renderGroups(renderList);
  if(lane==='running')return renderList(items);
  const groups=new Map();for(const t of items){const id=t.sectionId??'';if(!groups.has(id))groups.set(id,[]);groups.get(id).push(t);}
  return [...groups].map(([id,tasks])=>{const section=taskSection(s,tasks[0]),name=section?.name??'未分版块';return `<details class="task-section-group" data-section-group="${esc(lane+':'+id)}" ${lane==='done'?'':'open'}><summary><strong>${esc(name)}</strong><span>${tasks.length} 项</span>${section&&lane==='todo'?`<button type="button" class="section-create-button" data-section-create="${esc(id)}" aria-label="在${esc(name)}新建任务" title="在此版块新建任务">＋</button>`:''}${section?`<button class="section-context-button" data-section-edit="${esc(id)}" aria-label="编辑${esc(name)}版块说明">版块说明</button>`:''}</summary>${renderList(tasks)}</details>`;}).join('');
}

export function recentCompletedTasks(items){
  const completed=t=>{const value=t.completedAt??t.history?.filter(h=>['approved','parent-approved'].includes(h.type)).at(-1)?.at??t.updatedAt??t.createdAt;return Date.parse(value)||0;};
  return items.filter(t=>t.status==='done'&&!t.archivedAt).sort((a,b)=>completed(b)-completed(a)||a.id.localeCompare(b.id)).slice(0,10);
}
export function renderRecentCompleted(items,render){
  const recent=recentCompletedTasks(items);if(!recent.length)return '';
  return '<details class="task-section-group recent-completed" data-section-group="done:recent"><summary><strong>最近已完成</strong><span>'+recent.length+' 项</span></summary>'+recent.map(t=>render(t)).join('')+'</details>';
}
