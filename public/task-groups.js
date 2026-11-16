const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const defaultName='默认分组';
const inProject=(state,id)=>(state.taskGroups??[]).filter(group=>group.projectId===id);

function childrenByParent(groups){
  const children=new Map();
  for(const group of groups){
    const siblings=children.get(group.parentId)??[];
    siblings.push(group);
    children.set(group.parentId,siblings);
  }
  return children;
}

function groupPaths(groups,excluded){
  const children=childrenByParent(groups),paths=[];
  function visit(parentId,parentPath){
    for(const group of children.get(parentId)??[]){
      if(group.id===excluded)continue;
      const path=parentPath?`${parentPath} / ${group.name}`:group.name;
      paths.push({...group,path});
      visit(group.id,path);
    }
  }
  visit(null,'');
  return paths;
}

export function taskGroupPath(state,projectId,id){
  return groupPaths(inProject(state,projectId)).find(group=>group.id===id)?.path??defaultName;
}

export function taskGroupOptions(state,projectId){
  return `<option value="">${defaultName}</option>`+groupPaths(inProject(state,projectId)).map(group=>`<option value="${esc(group.id)}">${esc(group.path)}</option>`).join('');
}

export function matchTaskGroup(state,projectId,description){
  const normalize=value=>value.normalize('NFKC').toLowerCase().trim().replace(/\s*\/\s*/g,'/');
  const text=normalize(description).split(/[，,。；;！!\n]/u)
    .filter(part=>!/(?:^\s*(?:(?:但|并且|并)\s*)?(?:(?:不|不要|无需|不用|不需要|暂不)(?:改|修改|调整|涉及))|保持.{0,60}不变)/u.test(part)).join(' ');
  if(!text)return '';
  const matchesName=value=>{
    const name=normalize(value);
    if(name.length<2)return text===name;
    const pattern=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const start=/^[a-z0-9]/.test(name)?'(?<![a-z0-9_])':'';
    const end=/[a-z0-9]$/.test(name)?'(?![a-z0-9_])':'';
    return new RegExp(start+pattern+end,'u').test(text);
  };
  const groups=groupPaths(inProject(state,projectId));
  const matchedPaths=groups.filter(group=>group.parentId&&matchesName(group.path));
  const paths=matchedPaths.filter(group=>!matchedPaths.some(other=>other.path.startsWith(group.path+' / ')));
  // A full path can resolve a repeated leaf name. Multiple paths remain ambiguous.
  if(paths.length)return paths.length===1?paths[0].id:'';
  const names=groups.filter(group=>matchesName(group.name));
  return names.length===1?names[0].id:'';
}

export function renderBoardGroups(state,projectId,lane,items,renderList,{empty='',canChange=false,label='任务'}={}){
  const groups=inProject(state,projectId),children=childrenByParent(groups),ids=new Set(groups.map(group=>group.id));
  const cards=new Map(),first=new Map(),counts=new Map();
  for(const [index,task] of items.entries()){
    const id=ids.has(task.boardGroupId)?task.boardGroupId:'';
    if(!cards.has(id)){cards.set(id,[]);first.set(id,index);}
    cards.get(id).push(task);
    counts.set(id,cards.get(id).length);
  }
  const totals=state.query?.pages[lane]?.groupCounts;
  if(totals){
    counts.clear();
    for(const [key,count] of Object.entries(totals)){
      const id=ids.has(key)?key:'';
      counts.set(id,(counts.get(id)??0)+count);
    }
  }
  const sort=(a,b)=>Number(b.count>0)-Number(a.count>0)||a.rank-b.rank;
  function collect(group){
    const nested=(children.get(group.id)??[]).map(collect).sort(sort);
    return {...group,nested,count:(counts.get(group.id)??0)+nested.reduce((sum,child)=>sum+child.count,0),rank:Math.min(first.get(group.id)??Infinity,...nested.map(child=>child.rank))};
  }
  const roots=[{id:'',name:defaultName,count:counts.get('')??0,rank:first.get('')??Infinity,nested:[]},...(children.get(null)??[]).map(collect)].sort(sort);
  function render(group){
    const {id,name,count,nested}=group,rows=cards.get(id)??[];
    const create=lane==='todo'?`<button type="button" class="section-create-button" data-group-create-task="${esc(id)}" aria-label="在${esc(name)}新建${label}" title="在此分组新建${label}" ${canChange?'':'disabled'}>＋</button>`:'';
    const content=rows.length?renderList(rows):count&&!nested.some(child=>child.count)?`<p class="hint board-group-more">此分组的${label}在后续页</p>`:!id&&roots.length===1?empty:!count?`<p class="hint board-group-more">${label==="任务"?"此状态暂无任务":"此分组暂无资料"}</p>`:'';
    return `<details class="task-section-group board-task-group" data-section-group="${esc(`${projectId}:${lane}:${id}`)}" data-group-count="${count}" ${count?'open':''}><summary data-group-drop="${esc(id)}" data-group-lane="${lane}"><strong title="${esc(name)}">${esc(name)}</strong><span>${count} 项</span>${create}</summary>${content}${nested.length?`<div class="board-group-children">${nested.map(render).join('')}</div>`:''}</details>`;
  }
  return roots.map(render).join('');
}

export function initTaskGroups({board,state,projectId,post,commit,notice,openTask,focusTask,canChange,scope='tasks',cardSelector='[data-task]'}){
  const dialog=document.createElement('dialog');
  const field=id=>scope==='tasks'?id:id+'-references';
  dialog.id=field('taskGroupDialog');
  dialog.classList.add('board-group-dialog');
  dialog.setAttribute('aria-labelledby',field('taskGroupTitle'));
  dialog.innerHTML=`<form><div class="dialog-heading"><h2 id="taskGroupTitle"></h2><button type="button" data-close="taskGroupDialog" aria-label="关闭分组窗口">×</button></div>
    <div class="task-group-dialog-body" aria-label="分组表单">
      <label id="taskGroupExisting">分组<select id="taskGroupChoice"></select></label>
      <label id="taskGroupNameField">名称<input id="taskGroupName" maxlength="80" required placeholder="例如：界面、数据、交付"></label>
      <label id="taskGroupParentField">上级分组<select id="taskGroupParent"></select></label>
      <p class="hint" id="taskGroupHelp"></p><p class="error" id="taskGroupError" role="alert"></p>
    </div>
    <div class="dialog-actions"><button type="button" id="removeTaskGroup" hidden>移除空分组</button><button type="submit" class="primary" id="saveTaskGroup"></button></div></form>`;
  for(const element of dialog.querySelectorAll('[id]'))element.id=field(element.id);
  dialog.querySelector('[data-close]').dataset.close=dialog.id;
  document.body.append(dialog);
  const get=id=>document.getElementById(field(id)),form=dialog.querySelector('form'),choice=get('taskGroupChoice'),name=get('taskGroupName'),parent=get('taskGroupParent'),remove=get('removeTaskGroup'),save=get('saveTaskGroup'),error=get('taskGroupError');
  remove.classList.add('remove-board-group');
  const option=(value,label)=>`<option value="${esc(value)}">${esc(label)}</option>`;
  let dialogState=null,busy=false,drag=null,dropTarget=null;

  function editFields(){
    const group=dialogState.groups.find(row=>row.id===choice.value);
    const editing=!!group;
    dialogState.group=group;
    name.value=group?.name??'';
    parent.innerHTML=option('','项目根级')+groupPaths(dialogState.groups,group?.id).map(row=>option(row.id,row.path)).join('');
    parent.value=group?.parentId??'';
    save.textContent=editing?'保存分组':'创建分组';
    remove.hidden=!editing;
    error.textContent='';
  }

  function open(task,trigger){
    if(!canChange()||dialog.open)return;
    const owner=projectId(),groups=inProject(state(),owner);
    dialogState={owner,groups,task,trigger,id:crypto.randomUUID()};
    get('taskGroupTitle').textContent=task?'移动到分组':'添加分组';
    get('taskGroupNameField').hidden=!!task;
    get('taskGroupParentField').hidden=!!task;
    name.required=!task;
    error.textContent='';
    if(task){
      choice.innerHTML=taskGroupOptions(state(),owner);
      choice.value=task.boardGroupId??'';
      get('taskGroupHelp').textContent=task.title;
      save.textContent='移动';
      remove.hidden=true;
    }else{
      choice.innerHTML=option('','新建分组')+groupPaths(groups).map(row=>option(row.id,row.path)).join('');
      get('taskGroupHelp').textContent='选择上级分组可创建子分组。';
      editFields();
    }
    get('taskGroupExisting').hidden=!task&&!groups.length;
    dialog.showModal();
    (task?choice:name).focus();
  }

  function lock(value){
    busy=value;
    form.setAttribute('aria-busy',String(value));
    for(const control of form.elements)control.disabled=value;
  }

  async function change(input){
    const result=await post('task-groups/change',input);
    if(projectId()===input.projectId)await commit(result,input.projectId);
    return result;
  }

  const moveInput=(task,target)=>({action:'move',projectId:task.projectId,id:task.id,fromGroupId:task.boardGroupId??null,groupId:target});
  async function submit(removeGroup=false){
    if(busy||!dialogState)return;
    const {task,owner,group,id}=dialogState;
    if(!canChange()||owner!==projectId())return;
    const input=task?moveInput(task,choice.value||null):{action:removeGroup?'remove':group?'update':'create',projectId:owner,id:group?.id??id,revision:group?.revision,name:name.value,parentId:parent.value||null};
    lock(true);
    error.textContent='';
    try{
      await change(input);
      dialog.close();
      if(task)focusTask(task.id);
    }catch(failure){error.textContent=failure.message;}
    finally{lock(false);}
  }

  choice.onchange=()=>{if(!dialogState?.task)editFields();};
  form.onsubmit=event=>{event.preventDefault();void submit();};
  remove.onclick=()=>submit(true);
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  dialog.addEventListener('close',()=>{
    const {owner,trigger}=dialogState??{};
    dialogState=null;
    const focusTarget=trigger?.isConnected?trigger:owner===projectId()&&trigger?.hasAttribute('data-add-task-group')?board.querySelector('[data-add-task-group]'):null;
    focusTarget?.focus({preventScroll:true});
  });

  function highlight(target){
    if(dropTarget===target)return;
    dropTarget?.classList.remove('group-drop-active');
    dropTarget=target;
    dropTarget?.classList.add('group-drop-active');
  }
  function endDrag(){
    highlight(null);
    drag?.element.classList.remove('group-dragging');
    drag=null;
  }
  board.addEventListener('click',event=>{
    const addGroup=event.target.closest('[data-add-task-group]');
    if(addGroup){open(null,addGroup);return;}
    const move=event.target.closest('[data-move-task]'),create=event.target.closest('[data-group-create-task]');
    if(move){
      event.preventDefault();
      const task=state().tasks.find(row=>row.projectId===projectId()&&row.id===move.dataset.moveTask);
      if(task)open(task,move);
    }
    if(create){event.preventDefault();if(canChange())void openTask(create.dataset.groupCreateTask);}
  });
  board.addEventListener('dragstart',event=>{
    const handle=event.target.closest('[data-move-task][draggable="true"]'),card=handle?.closest(cardSelector);
    if(!handle||!card)return;
    if(busy||!canChange()||!event.dataTransfer){event.preventDefault();return;}
    const task=state().tasks.find(row=>row.projectId===projectId()&&row.id===handle.dataset.moveTask);
    if(!task)return;
    drag={task,lane:card.dataset.status,element:card};
    card.classList.add('group-dragging');
    event.dataTransfer.effectAllowed='move';
    event.dataTransfer.setData('application/x-leix-task',task.id);
    event.dataTransfer.setDragImage(card,Math.min(card.clientWidth/2,100),20);
  });
  function destination(event){
    const container=event.target.closest('.board-task-group');
    const target=container?.querySelector(':scope > [data-group-drop]');
    return drag?.task.projectId===projectId()&&canChange()&&target&&target.dataset.groupLane===drag.lane&&(target.dataset.groupDrop||null)!==(drag.task.boardGroupId??null)?target:null;
  }
  board.addEventListener('dragover',event=>{
    const target=destination(event);
    highlight(target);
    if(target){event.preventDefault();event.dataTransfer.dropEffect='move';}
  });
  board.addEventListener('dragleave',event=>{if(!board.contains(event.relatedTarget))highlight(null);});
  board.addEventListener('drop',async event=>{
    const target=destination(event);
    if(!target)return;
    event.preventDefault();
    const {task}=drag;
    endDrag();
    busy=true;
    try{await change(moveInput(task,target.dataset.groupDrop||null));focusTask(task.id);}
    catch(failure){notice(failure.message,true);}
    finally{busy=false;}
  });
  document.addEventListener('dragend',endDrag);

  return {isDragging:()=>!!drag,close:()=>{if(dialog.open)dialog.close();endDrag();}};
}
