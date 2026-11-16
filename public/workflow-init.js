import {panelLocation as location} from './read-client.js';
import {workflowCommand,githubCommand,parseWorkflowReport} from './workflow-prompts.js';
export {githubCommand,workflowCommand};
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=v=>String(v??'').replaceAll('/','\\').replace(/\\+$/,'').toLowerCase();
let api,state={},projectId='',selectedProject='',reviewPath='',reviewTicket=0,reviewBusy=false,reviewResolve=null;
export function workflowReminderNeeded(next,id){
  const project=next.projects?.find(p=>p.projectId===id),check=next.workflowChecks?.[id];
  return !!project&&(!check?.acknowledgedAt||norm(check?.path)!==norm(project.path));
}
export function ensureWorkflowReview(next,id){
  // Keep older services usable while the new frontend is being loaded.
  if(!Object.hasOwn(next,'workflowChecks')||!workflowReminderNeeded(next,id))return Promise.resolve(true);
  if(reviewResolve)return Promise.resolve(false);
  return new Promise(resolve=>{reviewResolve=resolve;void openWorkflowReview(id,true);});
}
function finishReview(value){const resolve=reviewResolve;reviewResolve=null;resolve?.(value);}
export function initWorkflowInitialization(context){
  api=context;initGithubUpgrade();initProjectSync();initWorkflowCommand();
  const dialog=document.createElement('dialog');dialog.id='workflowInitDialog';dialog.setAttribute('aria-labelledby','workflowInitTitle');
  dialog.innerHTML='<div class="dialog-heading"><h2 id="workflowInitTitle">检查开发规范</h2><button id="closeWorkflowInit" type="button" aria-label="关闭规范检查">×</button></div><p id="workflowInitProject" class="hint"></p><p class="hint">检查只反映实际读取范围。补齐任务会整理规范文档，并将代码问题列为待治理事项。</p><p id="workflowInitCheck" class="hint" role="status"></p><div id="workflowEvidence"></div><label for="workflowInitPrompt">检查提示词</label><textarea id="workflowInitPrompt" rows="7" readonly></textarea><p id="workflowInitError" role="alert" class="error"></p><div class="dialog-actions"><button id="copyWorkflowPrompt" type="button">复制提示词</button><button id="ackWorkflowReview" type="button" class="primary">按现有规范继续</button></div><p class="hint">沿用仅记录你的选择，不代表规范或代码已通过验收。</p>';
  document.body.append(dialog);
  document.addEventListener('click',e=>{if(e.target.closest('[data-review-workflow]')&&!reviewBusy&&!reviewResolve)void openWorkflowReview(projectId,false);});
  $('closeWorkflowInit').onclick=()=>{if(!reviewBusy)dialog.close();};
  dialog.addEventListener('cancel',e=>{if(reviewBusy)e.preventDefault();});
  dialog.addEventListener('close',()=>{reviewTicket++;finishReview(false);});
  $('copyWorkflowPrompt').onclick=async()=>{
    try{await navigator.clipboard.writeText($('workflowInitPrompt').value);$('workflowInitCheck').textContent='已复制。请粘贴到本项目聊天消息框中手动执行。';}
    catch{$('workflowInitPrompt').focus();$('workflowInitPrompt').select();$('workflowInitError').textContent='请按 Ctrl+C 复制选中的提示词。';}
  };
  $('ackWorkflowReview').onclick=async()=>{
    if(reviewBusy||!reviewPath)return;reviewBusy=true;$('ackWorkflowReview').disabled=true;$('workflowInitError').textContent='';
    const id=selectedProject,path=reviewPath;
    try{await api.post('workflow/acknowledge',{projectId:id,path,confirmed:true});await api.load();finishReview(true);dialog.close();}
    catch(error){$('workflowInitError').textContent=error.message;}
    finally{reviewBusy=false;$('ackWorkflowReview').disabled=!reviewPath;}
  };
}
async function openWorkflowReview(id,first){
  const ticket=++reviewTicket;selectedProject=id;reviewPath='';const dialog=$('workflowInitDialog'),project=state.projects?.find(p=>p.projectId===id);
  $('workflowInitTitle').textContent=first?'首次执行：检查开发规范':'检查开发规范';
  $('workflowInitProject').textContent=(project?.label??'')+' · '+(project?.path??'');
  $('workflowInitPrompt').value='';$('workflowEvidence').innerHTML='';$('workflowInitCheck').textContent='正在检查规范结构…';$('workflowInitError').textContent='';
  $('copyWorkflowPrompt').disabled=$('ackWorkflowReview').disabled=true;dialog.showModal();
  try{const result=await api.post('workflow/preview',{projectId:id});if(ticket!==reviewTicket||!dialog.open||id!==selectedProject)return;
    reviewPath=result.path;$('workflowInitPrompt').value=result.prompt;$('workflowEvidence').innerHTML=workflowEvidenceHtml(result.check,result.report);
    if(result.check.inspectedPath)$('workflowInitProject').textContent=(project?.label??'')+' · 检查目录：'+result.check.inspectedPath;
    $('workflowInitCheck').textContent=result.check.structure?.status==='needs-review'||result.check.missing.length?'当前检查范围有需要核对的条目；是否补齐请以实际项目为准。':'本次范围找到了规范结构线索；内容和命令仍需按实际项目核对。';
    $('copyWorkflowPrompt').disabled=$('ackWorkflowReview').disabled=false;
  }catch(error){if(ticket===reviewTicket){$('workflowInitCheck').textContent='';$('workflowInitError').textContent=error.message;}}
}
export function renderWorkflowInitialization(next,id){
  if(projectId&&projectId!==id&&$('workflowInitDialog')?.open){finishReview(false);$('workflowInitDialog').close();}
  state=next;projectId=id;renderGithubCommand();renderProjectSync();renderWorkflowCommand();
}


const commandTask=(t,prefix)=>t.createRequestId?.startsWith(prefix+'-')&&!t.archivedAt&&t.status!=='done';
export function githubCommandTask(next,id){return commandTaskFor(next,id,'github-upload');}
export function commandTaskFor(next,id,prefix){return [...(next.projectCommands??[]),...(next.tasks??[])].find(t=>t.projectId===id&&commandTask(t,prefix));}
export function githubCommandRunner(context,storage){return projectCommandRunner(context,storage,{prefix:'github-upload',command:githubCommand,unit:'GitHub交付'});}
export function workflowCommandRunner(context,storage){return projectCommandRunner(context,storage,{prefix:'workflow-prepare',command:workflowCommand,unit:'项目规范'});}
// Keep the creation key across failed responses and reloads. Never resend on a timer.
export function projectCommandRunner(context,storage,{prefix,command,unit}){
  const pending=new Set();
  return async(next,id)=>{
    if(pending.has(id))return;pending.add(id);
    try{
      const project=next.projects?.find(p=>p.projectId===id);
      if(!project||project.hostId!=='local'||!project.path)throw Error('请先核对当前本机项目');
      let task=commandTaskFor(next,id,prefix);
      if(task&&task.status!=='todo')return {existing:true,task};
      const key=prefix+':'+id+':'+norm(project.path);
      if(!task){
        let rid=storage.getItem(key);
        const old=(next.tasks??[]).find(t=>t.createRequestId===rid);
        if(!rid||old?.status==='done'||old?.archivedAt){rid=prefix+'-'+crypto.randomUUID();storage.setItem(key,rid);}
        task=(await context.post('tasks/create',{projectId:id,...command,tag:'feature',sectionName:'功能-'+unit,autoProperties:{section:false},execution:{mode:'match',unit,parallel:false,threadId:''},requestId:rid})).task;
      }
      if(task.status!=='todo'||task.archivedAt){if(task.status==='done'||task.archivedAt)storage.setItem(key,'');return {existing:true,task};}
      // This command includes checking project rules in its execution task.
      const result=await context.post('tasks/execute',{id:task.id,requestId:'run-'+task.createRequestId},{workflowInTask:true});
      return {task,result};
    }finally{pending.delete(id);}
  };
}
let commandBusy=false;
function renderGithubCommand(){
  const task=githubCommandTask(state,projectId);
  for(const button of document.querySelectorAll('[data-upgrade-project]')){
    button.disabled=commandBusy||!!task&&task.status!=='todo';
    button.textContent=commandBusy?'正在安排…':task?(task.status==='todo'?'继续执行上传任务':task.status==='review'?'上传任务待审阅':'上传任务已安排'):'上传 GitHub';
  }
}
function initGithubUpgrade(){
  const command=document.createElement('div');command.className='service-settings';
  command.id='githubUpgradeSettings';command.innerHTML='<button type="button" data-upgrade-project>上传 GitHub</button>';
  $('projectTools').append(command);
  const run=githubCommandRunner(api,{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)});
  document.addEventListener('click',async e=>{
    if(!e.target.closest('[data-upgrade-project]')||commandBusy)return;
    const id=projectId;commandBusy=true;renderGithubCommand();
    try{
      if(id!==projectId)throw Error('项目已切换，本次未发布任务');
      const result=await run(state,id);
      api.notice(result?.existing?'已有上传任务，请在看板查看进度或审阅结果。':'上传任务已安排执行，进度和结果可在看板查看。');
    }catch(error){api.notice(error.message+'；不会自动重发，可在看板核对后继续原任务。',true);}
    finally{try{await api.load();}catch{api.notice('状态刷新失败，请刷新看板核对原任务。',true);}commandBusy=false;renderGithubCommand();}
  });
}

export function legacyProjectSyncRunner(context,storage){
  const pending=new Set();
  return async(next,id)=>{
    if(pending.has(id))return {busy:true};pending.add(id);
    try{
      const project=next.projects?.find(p=>p.projectId===id);
      if(!project||project.hostId!=='local'||!project.path)throw Error('请先选择当前本机项目');
      const key='project-sync:'+id+':'+norm(project.path);
      let requestId=storage.getItem(key);if(!requestId){requestId='project-sync-'+crypto.randomUUID();storage.setItem(key,requestId);}
      const {task}=await context.post('projects/sync-task',{projectId:id,path:project.path,requestId});
      if(task.status!=='todo'||task.archivedAt||task.syncReserved){storage.removeItem(key);return {existing:true,task};}
      const result=await context.post('tasks/execute',{id:task.id,requestId:'run-'+task.createRequestId},{workflowInTask:true});
      storage.removeItem(key);return {task,result};
    }finally{pending.delete(id);}
  };
}
export function projectSyncRunner(context,storage){
  const pending=new Set();
  return async(next,id,address=location.href)=>{
    const clientClickedAt=Date.now();
    if(pending.has(id))return {busy:true};pending.add(id);
    try{
      const project=next.projects?.find(p=>p.projectId===id),initial=new URL(address);
      const refuse=()=>{throw Object.assign(Error('请在当前项目的已有对话中同步'),{notApplied:true});};
      if(!project||project.hostId!=='local'||!project.path||initial.searchParams.get('projectId')!==id)refuse();
      const url=!initial.searchParams.get('threadId')&&context.prepareProjectSync?new URL(await context.prepareProjectSync(initial.href)):initial;
      const threadId=url.searchParams.get('threadId');
      if(url.searchParams.get('projectId')!==id||!threadId)refuse();
      if(hasQueuedProjectSync(next,id,threadId))throw Object.assign(Error('已有同步请求排队，请在原聊天查看'),{notApplied:true});
      const key='project-sync-composer:'+id+':'+norm(project.path)+':'+threadId;
      let requestId=storage.getItem(key);if(!requestId){requestId='project-sync-native-'+crypto.randomUUID();storage.setItem(key,requestId);}
      let result;
      try{result=await context.post('projects/sync-composer',{projectId:id,path:project.path,threadId,requestId,clientClickedAt});}
      catch(error){if(error.notApplied===true)storage.removeItem(key);throw error;}
      if(['invoked','finished'].includes(result.status))storage.removeItem(key);
      else throw Error('同步请求的正常按钮操作结果未确认，请核对当前聊天；不会自动重发');
      return result;
    }finally{pending.delete(id);}
  };
}
function hasQueuedProjectSync(next,id,threadId){return next.service?.projectSyncSending?.queued?.some(row=>row.projectId===id&&row.threadId===threadId);}
let syncCommandBusy=false;
function renderProjectSync(){
  const project=state.projects?.find(p=>p.projectId===projectId);
  for(const button of document.querySelectorAll('[data-sync-project]')){
    const supported=state.service?.nativeProjectSyncSupported===true&&state.service?.nativeComposerSendSupported===true,current=new URL(location.href),hasThread=current.searchParams.get('projectId')===projectId&&!!current.searchParams.get('threadId');
    const queued=hasQueuedProjectSync(state,projectId,current.searchParams.get('threadId'));
    button.disabled=syncCommandBusy||queued||!project||project.hostId!=='local'||!project.path||!supported;
    button.setAttribute('aria-label',syncCommandBusy?'同步项目：正在处理':queued?'同步项目：已排队':'同步项目');button.setAttribute('aria-busy',String(syncCommandBusy));
    button.title=syncCommandBusy?'正在核对或提交同步请求':!supported?'后端更新完成后可同步项目':queued?'已有同步请求排队，请在原聊天查看':!hasThread?'点击核对旁边的聊天，确认后同步':'在当前聊天的输入框发送同步指令';
  }
}
function initProjectSync(){
  const button=document.createElement('button');button.type='button';button.dataset.syncProject='';button.className='project-sync-shortcut';button.setAttribute('aria-label','同步项目');
  button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path class="sync-arrow-up" d="M7 20V4m-4 4 4-4 4 4"/><path class="sync-arrow-down" d="M17 4v16m-4-4 4 4 4-4"/></svg>';
  document.querySelector('.heading-actions').prepend(button);
  const run=projectSyncRunner(api,{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value),removeItem:key=>localStorage.removeItem(key)});
  document.addEventListener('click',async e=>{
    if(!e.target.closest('[data-sync-project]')||syncCommandBusy)return;
    const id=projectId;syncCommandBusy=true;renderProjectSync();
    try{await run(state,id,location.href);await api.load();}
    catch(error){api.notice(error.message+(error.notApplied===true?'；本次未发送同步请求。':'；同步结果请在原对话查看。'),true);}
    finally{syncCommandBusy=false;renderProjectSync();}
  });renderProjectSync();
}

let workflowBusy=false;
export function workflowEvidenceHtml(check,report){
  const rows=check.evidence??[],coverage=(check.coverage??[]).map(x=>x.path),r=parseWorkflowReport(report?.text??'');
  const list=values=>'<ul>'+values.map(v=>'<li>'+esc(v)+'</li>').join('')+'</ul>';
  return '<section class="workflow-evidence"><h3>结构检查</h3>'+list(rows.map(r=>r.label+'：'+(r.paths.join('、')||'未发现入口')))+
    (check.conflicts?.length?list(check.conflicts):'')+'<details><summary>本次读取范围（'+coverage.length+' 个文件）</summary>'+list(coverage)+list(check.skipped??[])+'</details></section>'+
    '<section class="workflow-evidence"><h3>内容核对结果</h3><p>'+esc(r?r.content:'尚无可解析的内容报告；结构存在不代表内容正确。')+'</p>'+(r?'<p class="hint">智能体报告 · 基线 '+esc(r.baseline)+' · '+esc(report?.status??'')+'；以原任务证据和审阅为准。</p><details><summary>报告检查范围</summary>'+list(r.coverage)+'</details>':'')+'</section>'+
    '<section class="workflow-evidence"><h3>已完成验证</h3>'+list(r?.validation.length?r.validation.map(v=>v.command+' · '+({passed:'报告通过',failed:'报告失败','not-run':'未运行'}[v.status])+' · '+v.evidence):['尚无验证报告；配置中的命令未由结构检查运行。'])+'</section>'+
    '<section class="workflow-evidence"><h3>待治理事项</h3>'+list(r?(r.governance.length?r.governance:['本次报告未列出治理项，不代表全仓无问题。']):['待执行任务核对代表性实现后报告。'])+'</section>';
}
function renderWorkflowCommand(){
  const task=commandTaskFor(state,projectId,'workflow-prepare');
  for(const button of document.querySelectorAll('[data-initialize-workflow]')){
    button.disabled=workflowBusy||state.service?.workflowTasksSupported!==true||!!task&&task.status!=='todo';
    button.textContent=workflowBusy?'正在安排…':task?(task.status==='todo'?'继续补齐规范':task.status==='review'?'规范任务待审阅':'规范任务已安排'):'补齐规范';
    button.title=state.service?.workflowTasksSupported===true?'':'需加载新版后端后使用';
  }
}
function initWorkflowCommand(){
  const row=document.createElement('div');row.className='service-settings';row.innerHTML='<button type="button" data-initialize-workflow>补齐规范</button>';$('projectTools').append(row);
  const run=workflowCommandRunner(api,{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)});
  document.addEventListener('click',async e=>{
    if(!e.target.closest('[data-initialize-workflow]')||workflowBusy||state.service?.workflowTasksSupported!==true)return;
    const id=projectId;workflowBusy=true;renderWorkflowCommand();
    try{await run(state,id);}catch(error){api.notice(error.message+'；请核对原任务，不会自动重发。',true);}
    finally{try{await api.load();}catch{api.notice('状态刷新失败，请查看原规范任务。',true);}workflowBusy=false;renderWorkflowCommand();}
  });
}
