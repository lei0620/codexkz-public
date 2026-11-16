import {initTaskGroups,renderBoardGroups,taskGroupOptions} from './task-groups.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tagKey=value=>value.toLowerCase();
const titleOf=row=>row.title||row.body.split('\n').find(Boolean)?.slice(0,72)||row.attachments[0]?.name||row.url;
const dateLabel=new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric'});

export function initProjectReferences({read,post,upload,attachmentList,hydrateImages,run,manageTags,grouped}){
  const section=document.createElement('section');
  section.id='projectReferencesView';section.hidden=true;section.setAttribute('aria-labelledby','referenceHeading');
  section.innerHTML=`<div class="reference-heading"><h2 id="referenceHeading" tabindex="-1">资料</h2><div class="reference-heading-actions"><button type="button" id="manageReferenceTags" ${manageTags?'':'hidden'}>管理标签</button><button type="button" class="primary reference-create-button" id="newProjectReference" aria-label="新建资料" title="新建资料">＋</button></div></div>
    <div class="reference-filters"><input id="referenceSearch" type="search" placeholder="搜索资料" aria-label="搜索资料"></div>
    <p id="referenceStatus" class="hint" role="status"></p><button type="button" id="retryReferences" hidden>重试读取</button>
    <div id="referenceList"></div><button type="button" id="moreReferences" hidden>加载更多</button>`;
  document.getElementById('projectView').append(section);

  const dialog=document.createElement('dialog');
  dialog.id='referenceEditor';dialog.setAttribute('aria-labelledby','referenceEditorTitle');
  dialog.innerHTML=`<form id="referenceForm"><div class="dialog-heading"><h2 id="referenceEditorTitle">新建记录</h2><button type="button" id="closeReferenceEditor" aria-label="关闭记录编辑">×</button></div>
    <div class="reference-fields"><label id="referenceGroupField" ${grouped?'':'hidden'}>分组 <select name="group"></select></label><label>标题 <input name="title" maxlength="120" placeholder="选填"></label>
      <label>内容 <textarea name="body" maxlength="12000" rows="5" placeholder="记下灵感、想法或资料"></textarea></label>
      <label>链接 <input name="url" type="url" maxlength="2048" placeholder="https://"></label>
      <fieldset class="reference-tag-field"><legend>标签</legend><div class="reference-tag-input">
        <input id="referenceTagInput" type="text" maxlength="32" placeholder="搜索或输入新标签" aria-label="搜索或输入新标签">
        <button id="addReferenceEditorTag" type="button">添加</button></div><div id="referenceTagChoices" class="reference-tag-choices" role="group" aria-label="可选标签"></div></fieldset>
      <label>附件 <input name="files" type="file" multiple></label><div id="referenceEditorFiles"></div>
      <p id="referenceError" class="error" role="alert"></p></div>
    <div class="dialog-actions"><button type="button" id="removeProjectReference" hidden>移除记录</button><button class="primary" type="submit">保存记录</button></div></form>`;
  document.body.append(dialog);
  const manager=document.createElement('dialog');
  manager.id='referenceTagManager';manager.setAttribute('aria-labelledby','referenceTagManagerTitle');
  manager.innerHTML=`<div class="dialog-heading"><h2 id="referenceTagManagerTitle">管理标签</h2><button type="button" id="closeReferenceTagManager" aria-label="关闭标签管理">×</button></div>
    <form id="referenceTagForm" class="reference-tag-input"><input name="label" maxlength="32" required aria-label="标签名称" placeholder="新标签名称"><button type="submit" class="primary">新增</button><button type="button" id="cancelReferenceTagRename" hidden>取消</button></form>
    <p id="referenceTagError" class="error" role="alert"></p><div id="referenceManagedTags" class="reference-managed-tags"></div>`;
  document.body.append(manager);
  const get=id=>document.getElementById(id),form=get('referenceForm'),status=get('referenceStatus'),list=get('referenceList');
  const search=get('referenceSearch');
  const tagInput=get('referenceTagInput'),tagChoices=get('referenceTagChoices'),tagForm=get('referenceTagForm'),tagError=get('referenceTagError');
  let projectId='',visible=false,rows=[],groups=[],tagNames=[],tagRevision=0,loadId=0,limit=30,loading=false,loadError='',busy=false,editor=null,renaming='',boardLastSync=null;

  function applyCatalog(result){
    tagNames=result.tags??[...new Map(rows.flatMap(row=>row.tags.map(tag=>[tagKey(tag),tag]))).values()];
    tagRevision=result.tagRevision??0;
    if(Array.isArray(result.groups))groups=result.groups;
  }

  const groupState=()=>({taskGroups:groups,tasks:rows});
  const canChangeGroups=()=>grouped&&visible&&!loading&&!busy&&!loadError;
  const focusCard=(id,selector='summary')=>{
    const card=[...list.querySelectorAll('[data-reference]')].find(el=>el.dataset.reference===id);
    if(card){for(let group=card.closest('.board-task-group');group;group=group.parentElement.closest('.board-task-group'))group.open=true;}
    (card?.querySelector(selector)??get('newProjectReference')).focus({preventScroll:true});
  };
  const groupControls=grouped?initTaskGroups({
    board:list,state:groupState,projectId:()=>projectId,scope:'references',cardSelector:'[data-reference]',canChange:canChangeGroups,
    openTask:group=>openEditor(undefined,group),focusTask:id=>focusCard(id,'[data-move-task]'),
    post:(_route,input)=>run(()=>post('references/change',{...input,action:'group-'+input.action})),
    commit:result=>{rows=result.items;applyCatalog(result);render();},
    notice:message=>{status.textContent=message;}
  }):null;

  function card(row){
    const title=titleOf(row),summary=row.body.trim().split('\n').find(Boolean)??row.url;
    return `<details class="reference-card task-card" data-reference="${escape(row.id)}" data-status="todo">
      <summary><span class="reference-card-main"><span class="reference-card-title">${escape(title)}</span>
      ${summary&&summary!==title?`<span class="reference-card-summary">${escape(summary)}</span>`:''}
      <time class="reference-card-meta" datetime="${escape(row.updatedAt)}">${dateLabel.format(new Date(row.updatedAt))}</time></span></summary>
      <div class="reference-content">${row.body?`<p>${escape(row.body)}</p>`:''}${row.url?`<a href="${escape(row.url)}" target="_blank" rel="noopener noreferrer">${escape(row.url)}</a>`:''}
      ${row.tags.length?`<div class="reference-card-meta">${row.tags.map(tag=>`<span class="reference-tag">${escape(tag)}</span>`).join('')}</div>`:''}
      ${attachmentList(row.attachments)}
      <div class="card-actions"><button type="button" data-reference-action="edit">编辑</button>${groups.length?`<button type="button" class="card-move-group" draggable="true" data-move-task="${escape(row.id)}" aria-label="移动资料分组：${escape(title)}" title="拖到其他分组，或点击选择分组">⇄</button>`:''}</div></div></details>`;
  }

  function render(){
    if(groupControls?.isDragging())return;
    const query=search.value.trim().toLowerCase();
    const matches=rows.filter(row=>!query||[row.title,row.body,row.url,...row.tags,...row.attachments.map(file=>file.name)].some(value=>value.toLowerCase().includes(query)));
    const open=new Set([...list.querySelectorAll('.reference-card[open]')].map(el=>el.dataset.reference));
    const expanded=new Map([...list.querySelectorAll('[data-section-group]')].map(el=>[el.dataset.sectionGroup,{open:el.open,count:Number(el.dataset.groupCount)}]));
    status.textContent=loading?'正在读取资料…':loadError||(query&&!matches.length?'没有符合搜索条件的资料。':'');
    get('newProjectReference').disabled=loading||!!loadError;
    get('manageReferenceTags').disabled=loading||!!loadError;
    get('retryReferences').hidden=!loadError;
    get('moreReferences').hidden=matches.length<=limit;
    const counts=Object.create(null);
    for(const row of matches){const key=row.boardGroupId??'';counts[key]=(counts[key]??0)+1;}
    const view={...groupState(),query:{pages:{todo:{groupCounts:counts}}}};
    const cards=matches.slice(0,limit);
    list.innerHTML=grouped?renderBoardGroups(view,projectId,'todo',cards,list=>list.map(card).join(''),{label:'资料',canChange:!loading&&!loadError})+
      `<button type="button" class="board-add-button" data-add-task-group aria-haspopup="dialog" ${loading||loadError?'disabled':''}>＋ 添加分组</button>`:cards.map(card).join('');
    for(const el of list.querySelectorAll('[data-section-group]')){
      const old=expanded.get(el.dataset.sectionGroup);
      if(old&&(old.count>0)===(Number(el.dataset.groupCount)>0))el.open=old.open;
    }
    for(const el of list.querySelectorAll('.reference-card'))el.open=open.has(el.dataset.reference);
    hydrateImages();
  }

  async function refresh(){
    const owner=projectId,request=++loadId;
    loading=true;loadError='';render();
    try{const result=await read(owner);if(request===loadId){rows=result.items;applyCatalog(result);}}
    catch(error){if(request===loadId)loadError=error.message;}
    finally{if(request===loadId){loading=false;render();}}
  }

  function renderFiles(){
    get('referenceEditorFiles').innerHTML=editor.files.map(file=>`<div class="reference-file"><span>${escape(file.name)}</span><button type="button" data-reference-file="${escape(file.id)}" aria-label="移除附件 ${escape(file.name)}">移除</button></div>`).join('');
  }

  function renderTagChoices(){
    if(!editor)return;
    const query=tagKey(tagInput.value.trim()),options=new Map(tagNames.map(tag=>[tagKey(tag),tag]));
    for(const [key,tag] of editor.newTags)options.set(key,tag);
    for(const [key,tag] of editor.tags)options.set(key,tag);
    const selected=[...editor.tags.keys()];
    const matching=[...options.keys()].filter(key=>!editor.tags.has(key)&&key.includes(query));
    tagChoices.innerHTML=[...selected,...matching].map(key=>`<button type="button" class="reference-tag-choice" data-reference-tag-key="${escape(key)}" aria-label="${escape(options.get(key))}" aria-pressed="${editor.tags.has(key)}">${escape(options.get(key))}</button>`).join('');
    get('addReferenceEditorTag').disabled=!query||editor.tags.has(query)||editor.tags.size>=12;
  }

  function addEditorTag(){
    const name=tagInput.value.trim(),key=tagKey(name);
    if(busy||!editor||!name||editor.tags.has(key)||editor.tags.size>=12)return;
    const existing=tagNames.find(tag=>tagKey(tag)===key);
    if(!existing)editor.newTags.set(key,name);
    editor.tags.set(key,existing??name);
    tagInput.value='';renderTagChoices();tagInput.focus();
  }

  function openEditor(row,group){
    if(busy||dialog.open)return;
    editor={id:row?.id??crypto.randomUUID(),owner:projectId,revision:row?.revision,files:[...(row?.attachments??[])],tags:new Map((row?.tags??[]).map(tag=>[tagKey(tag),tag])),newTags:new Map(),tagRevision};
    form.reset();
    form.elements.group.innerHTML=taskGroupOptions(groupState(),projectId);
    form.elements.group.value=row?.boardGroupId??group??'';
    get('referenceEditorTitle').textContent=row?'编辑记录':'新建记录';
    form.elements.title.value=row?.title??'';form.elements.body.value=row?.body??'';
    form.elements.url.value=row?.url??'';
    get('removeProjectReference').hidden=!row;get('referenceError').textContent='';renderTagChoices();renderFiles();dialog.showModal();form.elements.body.focus();
  }

  function setBusy(value){
    busy=value;
    for(const control of form.elements)control.disabled=value;
    if(!value)renderTagChoices();
  }

  async function change(row,fields){
    const owner=row.owner??projectId;
    const result=await post('references/change',{projectId:owner,id:row.id,revision:row.revision,...fields});
    if(visible&&projectId===owner){
      rows=rows.filter(item=>item.id!==row.id);
      if(!result.reference.archivedAt)rows.push(result.reference);
      rows.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
      applyCatalog(result);
      render();
    }
  }

  function renderManager(){
    const counts=new Map();
    for(const row of rows)for(const tag of row.tags){const key=tagKey(tag);counts.set(key,(counts.get(key)??0)+1);}
    get('referenceManagedTags').innerHTML=tagNames.length?[...tagNames].sort((a,b)=>a.localeCompare(b,'zh-CN')).map(tag=>`<div class="reference-managed-tag">
      <span>${escape(tag)} <small>${counts.get(tagKey(tag))??0} 条</small></span>
      <button type="button" data-tag-rename="${escape(tag)}" aria-label="改名 ${escape(tag)}">改名</button>
      <button type="button" data-tag-delete="${escape(tag)}" aria-label="删除 ${escape(tag)}">删除</button></div>`).join(''):'<p class="hint">还没有标签。</p>';
  }

  function renameMode(tag=''){
    renaming=tag;tagForm.elements.label.value=tag;
    tagForm.querySelector('[type=submit]').textContent=tag?'保存名称':'新增';
    get('cancelReferenceTagRename').hidden=!tag;
  }

  async function changeTag(fields){
    if(busy)return;
    const owner=projectId;busy=true;tagError.textContent='';
    for(const button of manager.querySelectorAll('button'))button.disabled=true;
    try{
      const result=await run(()=>post('references/change',{projectId:owner,tagRevision,...fields}));
      if(owner!==projectId)return;
      rows=result.items;applyCatalog(result);render();renderManager();renameMode();tagForm.elements.label.focus();
    }catch(error){tagError.textContent=error.message;await refresh();renderManager();}
    finally{busy=false;for(const button of manager.querySelectorAll('button'))button.disabled=false;}
  }

  get('newProjectReference').onclick=()=>openEditor();
  get('manageReferenceTags').onclick=()=>{if(!busy){renameMode();tagError.textContent='';renderManager();manager.showModal();tagForm.elements.label.focus();}};
  get('closeReferenceTagManager').onclick=()=>{if(!busy)manager.close();};
  manager.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  get('cancelReferenceTagRename').onclick=()=>{renameMode();tagError.textContent='';tagForm.elements.label.focus();};
  tagForm.onsubmit=event=>{
    event.preventDefault();const name=tagForm.elements.label.value.trim();
    if(name)void changeTag(renaming?{action:'tag-rename',previousName:renaming,name}:{action:'tag-add',name});
  };
  get('referenceManagedTags').onclick=event=>{
    if(busy)return;
    const rename=event.target.closest('[data-tag-rename]'),remove=event.target.closest('[data-tag-delete]');
    if(rename){renameMode(rename.dataset.tagRename);tagError.textContent='';tagForm.elements.label.focus();tagForm.elements.label.select();}
    if(remove&&confirm(`删除标签「${remove.dataset.tagDelete}」？该标签会从项目内相关记录移除。`))void changeTag({action:'tag-delete',previousName:remove.dataset.tagDelete});
  };
  tagInput.oninput=renderTagChoices;
  tagInput.onkeydown=event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();addEditorTag();}};
  get('addReferenceEditorTag').onclick=addEditorTag;
  tagChoices.onclick=event=>{
    const button=event.target.closest('[data-reference-tag-key]');
    if(!button||!editor||busy)return;
    const key=button.dataset.referenceTagKey;
    if(!editor.tags.delete(key)){
      if(editor.tags.size>=12){get('referenceError').textContent='每条参考最多 12 个标签';return;}
      editor.tags.set(key,button.textContent);
    }
    get('referenceError').textContent='';renderTagChoices();
    ([...tagChoices.children].find(item=>item.dataset.referenceTagKey===key)??tagInput).focus();
  };
  get('closeReferenceEditor').onclick=()=>{if(!busy)dialog.close();};
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  dialog.addEventListener('close',()=>{editor=null;});
  get('retryReferences').onclick=()=>void refresh();
  get('moreReferences').onclick=()=>{limit+=30;render();};
  search.oninput=()=>{limit=30;render();};
  list.onclick=event=>{
    const button=event.target.closest('[data-reference-action="edit"]');
    if(!button||busy)return;
    const row=rows.find(item=>item.id===button.closest('[data-reference]').dataset.reference);
    if(row)openEditor(row);
  };
  get('referenceEditorFiles').onclick=event=>{
    const button=event.target.closest('[data-reference-file]');
    if(button&&editor&&!busy){editor.files=editor.files.filter(file=>file.id!==button.dataset.referenceFile);renderFiles();form.elements.files.focus();}
  };
  form.elements.files.onchange=async()=>{
    if(!editor||busy)return;
    const chosen=[...form.elements.files.files];form.elements.files.value='';
    if(!chosen.length)return;
    get('referenceError').textContent='';setBusy(true);
    try{await run(async()=>{
      for(const file of chosen){
        if(editor.files.length>=8)throw Error('每条参考最多 8 个附件');
        if(file.size>10*1024*1024||editor.files.reduce((n,item)=>n+item.size,0)+file.size>40*1024*1024)throw Error('附件超过单文件 10 MB 或总计 40 MB 限制');
        editor.files.push(await upload(file,editor.owner));renderFiles();
      }
    });}catch(error){get('referenceError').textContent=error.message;}finally{setBusy(false);}
  };
  async function save(fields){
    if(busy||!editor)return;
    get('referenceError').textContent='';setBusy(true);
    try{
      const {id}=editor;
      await run(()=>change(editor,fields));
      dialog.close();
      if(fields.action==='save')focusCard(id);
    }
    catch(error){get('referenceError').textContent=error.message;}
    finally{setBusy(false);}
  }
  form.onsubmit=event=>{
    event.preventDefault();if(!editor||busy)return;
    const values=Object.fromEntries(new FormData(form));
    void save({action:'save',title:values.title,body:values.body,url:values.url,tags:[...editor.tags.values()],tagRevision:editor.tagRevision,attachmentIds:editor.files.map(file=>file.id),...(grouped?{boardGroupId:values.group||null}:{})});
  };
  get('removeProjectReference').onclick=()=>{if(!busy&&editor&&confirm('移除这条资料？'))void save({action:'archive'});};

  return {update(id,open,lastSync){
    const changed=!!lastSync&&lastSync!==boardLastSync;
    if(lastSync!==undefined)boardLastSync=lastSync;
    if(projectId===id&&visible===open){if(open&&changed)void refresh();return;}
    if(projectId!==id){rows=[];groups=[];tagNames=[];tagRevision=0;search.value='';limit=30;list.replaceChildren();}
    groupControls?.close();
    if(dialog.open)dialog.close();
    if(manager.open)manager.close();
    projectId=id;visible=open;section.hidden=!open;
    if(open){void refresh();get('referenceHeading').focus({preventScroll:true});}
    else{loadId++;loading=false;}
  }};
}
