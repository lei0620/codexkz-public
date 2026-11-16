const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={waiting:'等待原执行结束并整理交接',summarizing:'正在原对话整理交接',ready:'交接已准备，等待新对话接续',creating:'正在新建接续对话',uncertain:'接续提交待核对，不会重复创建',submitted:'已交给新对话，等待执行结果',complete:'原对话报告任务已完成，无需新建；仍需审阅',blocked:'接续需要处理',cancelled:'接续已取消，原记录保留'};
export function handoffMarkup(task,service,readOnly,threads=[]){
  if(readOnly||!task.currentJobId)return '';
  const h=task.handoff,pending=h&&!['submitted','complete','cancelled'].includes(h.phase),available=service?.taskHandoffSupported===true;
  return '<section class="task-handoff"><h3>对话接续</h3>'+(h?'<p role="status">'+esc(labels[h.phase]??'接续状态待核对')+'</p>':'<p class="hint">保存当前任务交接，在新对话继续剩余工作。</p>')+(h?.error?'<p class="error">'+esc(h.error)+'</p>':'')+
    (h?.summary?'<details><summary>查看交接依据</summary><p>'+esc(h.summary.goal)+'</p><p>代码状态：'+esc(h.summary.git)+'</p><p>下一步：'+esc(h.summary.nextStep)+'</p><ul>'+h.summary.remaining.map(v=>'<li>'+esc(v)+'</li>').join('')+'</ul></details>':'')+
    (h&&['creating','uncertain'].includes(h.phase)?'<p class="hint">创建回执未明确时，可选择实际已创建的对话核对完整正文。核对不会重发。</p><label>已有接续对话<select data-handoff-thread><option value="">请选择</option>'+threads.filter(t=>t.id!==h.sourceThreadId&&t.kind==='codex'&&t.hostId==='local'&&String(t.cwd).replaceAll("\\","/").toLowerCase()===String(task.path).replaceAll("\\","/").toLowerCase()).map(t=>'<option value="'+esc(t.id)+'">'+esc(t.title||t.id)+'</option>').join('')+'</select></label><label>列表没有时，填写已有对话 ID<input data-handoff-thread-id autocomplete="off" maxlength="100"></label><button type="button" data-handoff-confirm>核对创建结果</button>':'')+
    '<div class="handoff-actions">'+(task.status!=='done'&&h?.phase!=='complete'&&!pending?'<button type="button" data-handoff-start '+(!available?'disabled title="需加载新版后端"':'')+'>一键接续到新对话</button>':'')+
    (pending&&!['creating','uncertain'].includes(h.phase)?'<button type="button" data-handoff-cancel>取消接续安排</button>':'')+'</div><p data-handoff-error class="error" role="alert"></p></section>';
}
export function initHandoffUI(api){
  let busy=false;
  document.addEventListener('click',async event=>{
    const start=event.target.closest('[data-handoff-start]'),cancel=event.target.closest('[data-handoff-cancel]'),confirm=event.target.closest('[data-handoff-confirm]');if((!start&&!cancel&&!confirm)||busy)return;
    const task=api.getTask();if(!task)return;const id=task.id,key='task-handoff:'+id+':'+task.currentJobId;busy=true;
    (start??cancel??confirm).disabled=true;
    try{
      if(start){let requestId=localStorage.getItem(key);if(!requestId){requestId='handoff-'+crypto.randomUUID();localStorage.setItem(key,requestId);}await api.post('tasks/handoff',{id,jobId:task.currentJobId,requestId});}
      else if(confirm){const threadId=document.querySelector('[data-handoff-thread-id]')?.value.trim()||document.querySelector('[data-handoff-thread]')?.value;await api.post('tasks/confirm-handoff',{id,threadId});}
      else{await api.post('tasks/cancel-handoff',{id});localStorage.removeItem(key);}
      await api.load();api.render();
    }catch(error){const panel=document.querySelector('[data-handoff-error]');if(api.getTask()?.id===id&&panel)panel.textContent=error.message;else api.notice(error.message,true);}
    finally{busy=false;if((start??cancel??confirm).isConnected)(start??cancel??confirm).disabled=false;}
  });
}
