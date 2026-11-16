const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const collator=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});

function projectDetails(board,id){
  return (Object.hasOwn(board.cards,id)?board.cards[id]:null)??{statusId:board.defaultStatusId,level:3,description:''};
}

export function groupProjects(board,projects){
  const groups=board.statuses.map(status=>({...status,projects:[]}));
  const byId=new Map(groups.map(group=>[group.id,group]));
  for(const project of projects){
    const details=projectDetails(board,project.projectId);
    (byId.get(details.statusId)??byId.get(board.defaultStatusId)).projects.push({project,details});
  }
  for(const group of groups)group.projects.sort((a,b)=>a.details.level-b.details.level||collator.compare(a.project.label,b.project.label)||collator.compare(a.project.projectId,b.project.projectId));
  return groups;
}

export function initProjectBoard({post,load},root){
  const list=root.querySelector('#projectOverview');
  const add=root.querySelector('#addProjectStatus');
  const dialog=document.createElement('dialog');
  dialog.id='projectBoardEditor';
  dialog.setAttribute('aria-labelledby','projectBoardEditorTitle');
  dialog.innerHTML=`<form><h2 id="projectBoardEditorTitle"></h2><div class="project-board-fields"></div><p class="hint" role="alert" hidden></p><div class="dialog-actions"><button type="button" data-cancel>取消</button><button type="submit" class="primary">保存</button></div></form>`;
  root.append(dialog);
  const form=dialog.querySelector('form'),fields=form.querySelector('.project-board-fields'),submit=form.querySelector('[type=submit]'),error=form.querySelector('[role=alert]');
  const openOverrides=new Map();
  let current,edit,trigger,signature='',saving=false;

  function close(){if(dialog.open)dialog.close();}
  function report(message){error.textContent=message;error.hidden=!message;}
  function options(statuses,selected){return statuses.map(status=>`<option value="${esc(status.id)}" ${status.id===selected?'selected':''}>${esc(status.name)}</option>`).join('');}

  function show(action,id,button){
    const {board,projects,projectId,instanceId,canWrite}=current??{};
    if(!canWrite||saving)return;
    const status=board.statuses.find(row=>row.id===id),project=projects.find(row=>row.projectId===id);
    edit={action,id,revision:board.revision,projectId,instanceId};
    trigger=button;
    report('');
    submit.classList.toggle('primary',action!=='remove-status');
    submit.classList.toggle('danger',action==='remove-status');
    submit.textContent=action==='remove-status'?'删除状态':'保存';
    const title=dialog.querySelector('h2');
    if(action==='save-project'){
      if(!project)return;
      const details=projectDetails(board,id);
      title.textContent='编辑项目 · '+project.label;
      fields.innerHTML=`<label>项目状态<select name="statusId" required>${options(board.statuses,details.statusId)}</select></label><label>项目等级<select name="level" required>${[1,2,3,4,5].map(level=>`<option value="${level}" ${level===details.level?'selected':''}>${level} 级${level===1?'（最高）':''}</option>`).join('')}</select></label><label>项目描述<textarea name="description" rows="4" maxlength="1000">${esc(details.description)}</textarea></label>`;
    }else if(action==='remove-status'){
      if(!status)return;
      title.textContent='删除状态 · '+status.name;
      const needsDestination=board.defaultStatusId===id||board.occupiedStatusIds.includes(id);
      const label=board.defaultStatusId===id?'项目迁入及新的默认状态':'将项目迁入';
      fields.innerHTML=needsDestination?`<label>${label}<select name="moveTo" required><option value="">选择目标状态…</option>${options(board.statuses.filter(row=>row.id!==id))}</select></label>`:'<p>确认删除此状态？</p>';
    }else{
      title.textContent=status?'编辑状态':'新增状态';
      fields.innerHTML=`<label>状态名称<input name="name" required maxlength="40" value="${esc(status?.name)}"></label><label class="check"><input type="checkbox" name="collapsed" ${status?.collapsed?'checked':''}>默认收起</label>`;
    }
    dialog.showModal();
    (fields.querySelector('input, select')??form.querySelector('[data-cancel]')).focus();
  }

  add.onclick=()=>show('create-status',undefined,add);
  list.addEventListener('click',event=>{
    const button=event.target.closest('button[data-project-board-action]');
    if(button)show(button.dataset.projectBoardAction,button.dataset.id,button);
  });
  form.querySelector('[data-cancel]').onclick=close;
  dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
  dialog.addEventListener('close',()=>{
    if(root.hidden)return;
    const replacement=trigger?.dataset.projectBoardAction&&[...list.querySelectorAll('[data-project-board-action]')].find(button=>button.dataset.projectBoardAction===trigger.dataset.projectBoardAction&&button.dataset.id===trigger.dataset.id&&button.getClientRects().length);
    (trigger?.isConnected&&trigger.getClientRects().length?trigger:replacement||add).focus({preventScroll:true});
  });
  form.onsubmit=async event=>{
    event.preventDefault();
    if(saving||!current?.canWrite||!edit)return;
    const {action,id,revision,projectId,instanceId}=edit;
    if(instanceId!==current.instanceId||projectId!==current.projectId||revision!==current.board.revision){report('看板已更新，请重新打开编辑后保存。');return;}
    const values=Object.fromEntries(new FormData(form));
    if(action==='save-project')values.level=Number(values.level);
    if(action==='create-status'||action==='edit-status')values.collapsed=values.collapsed==='on';
    report('');
    saving=true;
    for(const control of form.elements)control.disabled=true;
    try{
      const result=await post('project-board/change',{...values,action,id,revision,projectId});
      if(current?.projectId===projectId&&current.instanceId===instanceId){
        if(action==='save-project')openOverrides.set(values.statusId,true);
        if(action==='edit-status'||action==='remove-status')openOverrides.delete(id);
        render({...current,board:result.projectBoard});
      }
      close();
      await load();
    }catch(reason){report(reason.message);}
    finally{saving=false;for(const control of form.elements)control.disabled=false;}
  };

  function render(model){
    if(model&&current?.instanceId===model.instanceId&&current?.projectId===model.projectId&&current.board.revision>model.board.revision)model={...model,board:current.board};
    current=model;
    add.hidden=!model;
    if(!model){close();signature='';return;}
    const {board,visible,filtering,canWrite,renderCard}=model;
    add.disabled=!canWrite;
    const next=groupProjects(board,visible).filter(group=>!filtering||group.projects.length).map(group=>{
      const cards=group.projects.map(({project,details})=>renderCard(project,details,canWrite)).join('');
      const id=esc(group.id),name=esc(group.name);
      return `<section class="project-status"><details data-project-status="${id}" ${filtering||!group.collapsed?'open':''}><summary><h2>${name}</h2><span class="project-status-count">${group.projects.length} 个项目</span></summary><div class="project-overview">${cards||'<p class="hint project-status-empty">暂无项目</p>'}</div></details>${canWrite?`<div class="project-status-actions"><button type="button" data-project-board-action="edit-status" data-id="${id}" aria-label="编辑状态 ${name}">编辑</button><button type="button" data-project-board-action="remove-status" data-id="${id}" aria-label="删除状态 ${name}" ${board.statuses.length===1?'disabled':''}>删除</button></div>`:''}</section>`;
    }).join('')||'<p class="hint">没有符合筛选条件的项目</p>';
    if(next===signature&&list.classList.contains('project-status-board'))return;
    const focused=list.contains(document.activeElement)?document.activeElement:null;
    signature=next;
    list.className='project-status-board';
    list.hidden=false;
    list.innerHTML=next;
    for(const details of list.querySelectorAll('details[data-project-status]')){
      const id=details.dataset.projectStatus;
      if(!filtering&&openOverrides.has(id))details.open=openOverrides.get(id);
      details.querySelector('summary').addEventListener('click',()=>{if(!filtering)openOverrides.set(id,!details.open);});
    }
    if(focused){
      const status=focused.closest('[data-project-status]')?.dataset.projectStatus;
      const replacement=[...list.querySelectorAll('summary, button, a')].find(element=>{
        if(element.tagName!==focused.tagName||!element.getClientRects().length)return false;
        if(status&&element.tagName==='SUMMARY')return element.closest('details')?.dataset.projectStatus===status;
        return element.outerHTML===focused.outerHTML;
      });
      replacement?.focus({preventScroll:true});
    }
  }
  return {render};
}
