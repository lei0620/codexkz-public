const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const priorities=['P0 紧急','P1 高','P2 普通','P3 低'];
const defaults=()=>[{id:'type',name:'任务类型',options:[{id:'feature',name:'新功能'},{id:'bug',name:'Bug'},{id:'improvement',name:'优化'}]}];
export const projectPropertyGroups=(state,id)=>state.propertyGroups?.[id]??defaults();
export function propertyInput(group,selected='',scope='task',typed){
  if(group.id==='type'&&!group.archived){
    const current=group.options.find(o=>o.id===selected),value=typed??current?.name??'';
    return choicePicker({id:scope+'-type-input',label:group.name,value,options:group.options.filter(o=>!o.archived).map(o=>o.name),maxLength:30,placeholder:'输入或选择标签',type:true,descriptionId:scope+'-type-hint'})+`<span class="type-picker-hint" id="${scope}-type-hint" ${scope==='task'&&!current?.archived?'hidden':''}>${current?.archived?'当前标签已停用，可保留或重新选择。':'选择已有标签，或输入新名称；保存时添加，留空不设置。'}</span>`;

  }
  return `<label>${esc(group.name)}${group.archived?'（已删除，保留原值）':''}<select data-${scope}-group="${esc(group.id)}" aria-label="任务属性：${esc(group.name)}"><option value="">未设置</option>${group.options.filter(o=>(!group.archived&&!o.archived)||o.id===selected).map(o=>`<option value="${esc(o.id)}" ${o.id===selected?'selected':''} ${group.archived||o.archived?'disabled':''}>${esc(o.name)}${group.archived||o.archived?'（已删除）':''}</option>`).join('')}</select></label>`;
}
export function readTypeInput(container){const input=container.querySelector('[data-type-name]');return input?{typeName:input.value}:{};}
let api,state={},projectId='',groups=defaults(),filters={sort:'priority',priority:'',attributes:{}},renderKey='';
const attributes=task=>task.attributes??(task.tag&&task.tag!=='none'?[{groupId:'type',groupName:'任务类型',optionId:task.tag,name:({feature:'新功能',bug:'Bug',improvement:'优化'})[task.tag]??task.tag}]:[]);
const preferenceKey=()=>`codex-task-filters:${projectId}`;
function saveFilters(){try{localStorage.setItem(preferenceKey(),JSON.stringify(filters));}catch{api.notice('当前筛选已生效，但浏览器无法保存筛选偏好。',true);}}
export const filterKey=()=>JSON.stringify([filters,groups]);
export const dependencySortEnabled=()=>filters.sort==='priority';
export function filterTasks(tasks){return tasks.filter(t=>(filters.priority===''||(t.priority??2)===Number(filters.priority))&&Object.entries(filters.attributes).every(([groupId,optionId])=>!optionId||(optionId==='@none'?!attributes(t).some(a=>a.groupId===groupId):attributes(t).some(a=>a.groupId===groupId&&a.optionId===optionId))));}
export function sortTasks(a,b){const date=(a.createdAt??'').localeCompare(b.createdAt??'');return (filters.sort==='priority'?(a.priority??2)-(b.priority??2):filters.sort==='priority-reverse'?(b.priority??2)-(a.priority??2):0)||(filters.sort==='oldest'?date:-date)||a.id.localeCompare(b.id);}
export function propertyBadges(task){return attributes(task).map(a=>{const g=groups.find(g=>g.id===a.groupId),o=g?.options.find(o=>o.id===a.optionId),retired=!g||g.archived||!o||o.archived;return `<span class="tag property-badge ${retired?'property-retired':''}" title="${esc(a.groupName)}：${esc(a.name)}${retired?'（已删除，保留历史）':''}">${esc(a.name)}${retired?' · 已删除':''}</span>`;}).join('');}
export function priorityControl(task,disabled=false){const value=task.priority??2;return `<select class="card-priority priority-${value}" aria-label="${esc(task.title)}的优先级" data-priority="${esc(task.id)}" ${disabled||task.syncReserved||state.propertyGroups===undefined?'disabled':''}>${priorities.map((name,i)=>`<option value="${i}" ${i===value?'selected':''}>${name}</option>`).join('')}</select>`;}
function renderFilters(){
  $('taskFilters').innerHTML=`<div class="filter-card-head"><span>筛选条件</span><div class="filter-card-actions"><button type="button" id="manageProperties" aria-label="管理属性" title="管理属性">管理</button><button type="button" id="clearTaskFilters" aria-label="清除筛选" title="清除筛选">清除</button></div></div><div class="filter-grid"><label>排序<select id="taskSort"><option value="priority">高 → 低</option><option value="priority-reverse">低 → 高</option><option value="newest">最新</option><option value="oldest">最早</option></select></label><label>优先级<select id="priorityFilter"><option value="">全部</option>${priorities.map((p,i)=>`<option value="${i}">${p}</option>`).join('')}</select></label>${groups.map(g=>`<label title="${esc(g.name)}">${g.id==='type'?'类型':esc(g.name)}${g.archived?' · 旧':''}<select data-filter-group="${esc(g.id)}" aria-label="筛选${esc(g.name)}"><option value="">全部</option><option value="@none">未设置</option>${g.options.map(o=>`<option value="${esc(o.id)}">${esc(o.name)}${g.archived||o.archived?' · 旧':''}</option>`).join('')}</select></label>`).join('')}</div>`;

  $('taskSort').options[0].textContent='优先级与依赖';
  $('taskSort').value=filters.sort;$('priorityFilter').value=filters.priority;
  document.querySelectorAll('[data-filter-group]').forEach(el=>{el.value=filters.attributes[el.dataset.filterGroup]??'';});
}
function renderManager(){
  $('propertyGroupList').innerHTML=groups.map(g=>{
    const used=state.propertyUsage?.[g.id]??(state.tasks??[]).filter(t=>t.projectId===projectId&&attributes(t).some(a=>a.groupId===g.id)).length;
    return `<section class="property-group ${g.archived?'property-retired':''}"><div class="property-group-heading"><h3>${esc(g.name)}${g.archived?' · 已删除':''}</h3><button type="button" data-property-action="${g.archived?'restore-group':'delete-group'}" data-group="${esc(g.id)}" aria-label="${g.archived?'恢复':'删除'}属性组${esc(g.name)}">${g.archived?'恢复组':'删除组'}</button></div>${used?`<p class="hint">${used} 个任务使用此组</p>`:''}<div class="property-options">${g.options.map(o=>`<div><span>${esc(o.name)}${o.archived?' · 已删除':''}</span><button type="button" data-property-action="${o.archived?'restore-option':'delete-option'}" data-group="${esc(g.id)}" data-option="${esc(o.id)}" aria-label="${o.archived?'恢复':'删除'}${esc(g.name)}中的${esc(o.name)}">${o.archived?'恢复':'删除'}</button></div>`).join('')}</div>${!g.archived?`<form data-add-option="${esc(g.id)}"><label>新增${esc(g.name)}属性<input name="name" maxlength="30" required placeholder="例如：文档、测试、设计"></label><button class="primary" type="submit">添加属性</button></form>`:''}</section>`;
  }).join('');
}
export function updateProperties(next,id){state=next;const changed=id!==projectId;projectId=id;groups=state.propertyGroups?.[id]??defaults();
  if(changed){try{const saved=JSON.parse(localStorage.getItem(preferenceKey()));filters={sort:['priority','priority-reverse','newest','oldest'].includes(saved?.sort)?saved.sort:'priority',priority:['','0','1','2','3'].includes(saved?.priority)?saved.priority:'',attributes:saved?.attributes&&typeof saved.attributes==='object'&&!Array.isArray(saved.attributes)?saved.attributes:{}};}catch{filters={sort:'priority',priority:'',attributes:{}};}}
  const key=JSON.stringify([id,groups,state.propertyGroups!==undefined]);if(key!==renderKey){renderKey=key;renderFilters();if($('propertyManager').open)renderManager();}
}
export function renderPropertyEditor(task,editing=false){
  const selected=task.attributeIds??Object.fromEntries(attributes(task).map(a=>[a.groupId,a.optionId]));
  if(!editing&&task.attributeIds===undefined&&task.attributes===undefined&&task.tag===undefined){const first=groups.find(g=>g.id==='type'&&!g.archived)?.options.find(o=>!o.archived);if(first)selected.type=first.id;}
  const visible=groups.filter(g=>!g.archived||(editing&&selected[g.id])),type=visible.find(g=>g.id==='type'),others=visible.filter(g=>g.id!=='type');
  $('taskProperties').innerHTML=`<div class="task-property-basics"><div><label for="taskPriority">优先级</label><select id="taskPriority">${priorities.map((p,i)=>`<option value="${i}" ${i===(task.priority??2)?'selected':''}>${p}</option>`).join('')}</select></div>${type?`<div>${propertyInput(type,selected[type.id],'task',task.typeName)}</div>`:''}</div>${others.map(g=>propertyInput(g,selected[g.id],'task',task.typeName)).join('')}`;
}
export function readPropertyEditor(){return {priority:Number($('taskPriority').value),...readTypeInput($('taskProperties')),attributeIds:Object.fromEntries([...$('taskProperties').querySelectorAll('[data-task-group]')].map(el=>[el.dataset.taskGroup,el.value]).filter(([,value])=>value))};}
export function initProperties(context){
  api=context;initChoicePickers();const dialog=document.createElement('dialog');dialog.id='propertyManager';dialog.setAttribute('aria-labelledby','propertyManagerTitle');
  dialog.innerHTML='<div class="dialog-heading"><h2 id="propertyManagerTitle">管理任务属性</h2><button type="button" id="closeProperties" aria-label="关闭属性管理">×</button></div><p class="hint">仅当前项目；删除可恢复，历史标记保留。</p><form id="addPropertyGroup"><label for="propertyGroupName">属性组名称</label><input id="propertyGroupName" name="name" maxlength="30" required placeholder="例如：模块、负责人、版本"><button type="submit" class="primary">添加属性组</button></form><p id="propertyError" class="error" role="alert"></p><div id="propertyGroupList"></div>';
  document.body.append(dialog);$('closeProperties').onclick=()=>dialog.close();
  $('taskFilters').addEventListener('change',e=>{const el=e.target;if(el.id==='taskSort')filters.sort=el.value;else if(el.id==='priorityFilter')filters.priority=el.value;else if(el.dataset.filterGroup)filters.attributes[el.dataset.filterGroup]=el.value;saveFilters();api.render();});
  $('taskFilters').addEventListener('click',e=>{if(e.target.closest('#manageProperties')){renderManager();$('propertyError').textContent='';dialog.showModal();}if(e.target.closest('#clearTaskFilters')){filters.priority='';filters.attributes={};saveFilters();renderFilters();api.render();}});
  let changing=false;
  async function change(body,form){if(changing)return;changing=true;$('propertyError').textContent='';dialog.querySelectorAll('button').forEach(b=>b.disabled=true);try{await api.post('properties/change',{projectId,...body});form?.reset();await api.load();renderManager();}catch(error){$('propertyError').textContent=error.message;}finally{changing=false;dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}}
  dialog.addEventListener('submit',e=>{e.preventDefault();const form=e.target;change(form.id==='addPropertyGroup'?{action:'add-group',name:form.elements.name.value}:{action:'add-option',groupId:form.dataset.addOption,name:form.elements.name.value},form);});
  dialog.addEventListener('click',e=>{const b=e.target.closest('[data-property-action]');if(b)change({action:b.dataset.propertyAction,groupId:b.dataset.group,optionId:b.dataset.option});});
  document.addEventListener('change',async e=>{const select=e.target.closest('[data-priority]');if(!select)return;select.disabled=true;try{await api.post('tasks/priority',{id:select.dataset.priority,priority:Number(select.value)});await api.load();api.notice('优先级已更新。');}catch(error){api.notice(error.message,true);await api.load();}finally{if(select.isConnected)select.disabled=false;}});
}


// Editable choices share one menu; the input remains the saved form value.
// Keep the toggle empty: its CSS chevron is the only grid item; hidden text still adds a row.
export function choicePicker({id,label,value='',options=[],maxLength=80,placeholder='输入或选择',type=false,descriptionId=''}){
  return `<div class="choice-picker"><label for="${esc(id)}">${esc(label)}</label><div class="choice-combo"><input id="${esc(id)}" data-choice-input ${type?'data-type-name':''} role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${esc(id)}-choices" ${descriptionId?`aria-describedby="${esc(descriptionId)}"`:''} maxlength="${maxLength}" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(value)}"><button type="button" class="choice-toggle" tabindex="-1" aria-label="选择已有${esc(label)}"></button><div class="choice-suggestions" id="${esc(id)}-choices" role="listbox" aria-label="已有${esc(label)}" popover="manual" hidden></div><datalist data-choice-options>${options.map(name=>`<option value="${esc(name)}"></option>`).join('')}</datalist></div></div>`;
}

function close(root){
  const list=root.querySelector('.choice-suggestions'),input=root.querySelector('[data-choice-input]');
  if(list.matches(':popover-open'))list.hidePopover();
  list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');
}
function position(root){
  const input=root.querySelector('[data-choice-input]'),list=root.querySelector('.choice-suggestions'),rect=input.getBoundingClientRect();
  if(!input.getClientRects().length||rect.bottom<0||rect.top>innerHeight){close(root);return;}
  const width=Math.min(Math.max(rect.width,160),innerWidth-16),below=innerHeight-rect.bottom-12,above=rect.top-12,up=below<160&&above>below;
  list.style.width=width+'px';list.style.maxHeight=Math.max(40,Math.min(240,up?above:below))+'px';
  list.style.left=Math.max(8,Math.min(rect.left,innerWidth-width-8))+'px';
  list.style.top=(up?Math.max(8,rect.top-list.getBoundingClientRect().height-6):rect.bottom+6)+'px';
}
function show(root,all=false){
  document.querySelectorAll('.choice-picker').forEach(other=>{if(other!==root)close(other);});
  const input=root.querySelector('[data-choice-input]'),list=root.querySelector('.choice-suggestions'),query=input.value.trim();
  const names=[...root.querySelectorAll('[data-choice-options] option')].map(o=>o.value);
  const choices=[{value:'',text:'未设置'},...names.filter(n=>all||n.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(n=>({value:n,text:n}))];
  if(!all&&query&&!names.some(n=>n.toLocaleLowerCase()===query.toLocaleLowerCase()))choices.unshift({value:query,text:'使用“'+query+'” · 保存时新增'});
  list.innerHTML=choices.map((c,i)=>`<button type="button" tabindex="-1" role="option" aria-label="${esc(c.text)}" id="${list.id}-${i}" aria-selected="${c.value===input.value}" data-choice-value="${esc(c.value)}">${esc(c.text)}</button>`).join('');
  list.dataset.active='-1';list.hidden=false;
  if(!list.matches(':popover-open')&&list.showPopover)list.showPopover();
  input.setAttribute('aria-expanded','true');input.removeAttribute('aria-activedescendant');position(root);
}
let initialized=false;
export function initChoicePickers(){
  if(initialized)return;initialized=true;
  const choose=(root,value)=>{const input=root.querySelector('[data-choice-input]');input.value=value;input.focus();input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));close(root);};
  document.addEventListener('focusin',e=>{if(e.target.matches('[data-choice-input]'))show(e.target.closest('.choice-picker'),true);});
  document.addEventListener('focusout',e=>{const root=e.target.closest('.choice-picker');if(root&&!root.contains(e.relatedTarget))close(root);});
  document.addEventListener('input',e=>{if(e.target.matches('[data-choice-input]'))show(e.target.closest('.choice-picker'));});
  document.addEventListener('pointerdown',e=>{if(e.target.closest('.choice-toggle,[data-choice-value]'))e.preventDefault();});
  document.addEventListener('click',e=>{
    const root=e.target.closest('.choice-picker');document.querySelectorAll('.choice-picker').forEach(other=>{if(other!==root)close(other);});
    const option=e.target.closest('[data-choice-value]');if(option){choose(root,option.dataset.choiceValue);return;}
    if(e.target.closest('.choice-toggle')){const open=!root.querySelector('.choice-suggestions').hidden;root.querySelector('[data-choice-input]').focus();if(open)close(root);else show(root,true);}
  });
  document.addEventListener('keydown',e=>{
    if(!e.target.matches('[data-choice-input]'))return;
    const root=e.target.closest('.choice-picker'),list=root.querySelector('.choice-suggestions');
    if(e.key==='Escape'&&!list.hidden){e.preventDefault();e.stopPropagation();close(root);return;}
    if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)&&(!['Home','End'].includes(e.key)||!list.hidden)){
      e.preventDefault();if(list.hidden)show(root,true);
      const options=[...list.children],active=Number(list.dataset.active),next=e.key==='Home'?0:e.key==='End'?options.length-1:active<0?(e.key==='ArrowDown'?0:options.length-1):(active+(e.key==='ArrowDown'?1:-1)+options.length)%options.length;
      list.dataset.active=String(next);options.forEach((o,i)=>o.classList.toggle('is-active',i===next));e.target.setAttribute('aria-activedescendant',options[next].id);options[next].scrollIntoView({block:'nearest'});
    }else if(e.key==='Enter'&&!list.hidden){e.preventDefault();const index=Number(list.dataset.active);if(index>=0)choose(root,list.children[index].dataset.choiceValue);else close(root);}
  });
  document.addEventListener('close',e=>e.target.querySelectorAll?.('.choice-picker').forEach(close),true);
  const reposition=()=>document.querySelectorAll('.choice-picker:has([aria-expanded=true])').forEach(position);
  document.addEventListener('scroll',reposition,true);window.addEventListener('resize',reposition);
}
