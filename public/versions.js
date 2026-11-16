import {panelLocation as location} from './read-client.js';
import {createVersionAssistant} from './version-assistant.js';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let api,state={},projectId='',key='',editing=null,busy=false,removing=false,previewRequest=0,assistant,capturePromise=null,captureEpoch=0;
const date=value=>new Date(value).toLocaleString('zh-CN',{hour12:false});
const fields=['name','summary','ref','validation','backupPath','rollbackNotes'];
export function initVersions(context){
  api=context;
  const section=document.createElement('section');section.id='versionsView';section.hidden=true;
  section.innerHTML=`<div class="version-heading"><h1 id="versionsTitle">版本回顾</h1><button id="newVersion" class="primary">记录版本</button></div><label class="version-project-label">项目<select id="versionProject"></select></label><div class="version-toolbar"><input id="versionSearch" type="search" aria-label="搜索版本" placeholder="搜索版本名、说明或提交"><button id="inspectVersionGit">读取 Git</button></div><p id="versionMessage" class="hint" role="status"></p><div id="versionGitInfo"></div><div id="versionList"></div>`;
  const footer=document.querySelector('main footer');if(footer)footer.before(section);else document.querySelector('main').append(section);
  const editor=document.createElement('dialog');editor.id='versionEditor';editor.setAttribute('aria-labelledby','versionEditorTitle');
  editor.innerHTML=`<form id="versionForm"><div class="dialog-heading"><h2 id="versionEditorTitle">记录版本</h2><button type="button" id="closeVersionEditor" aria-label="关闭版本记录">×</button></div><label>版本名称<input name="name" required maxlength="80" placeholder="例如：任务编辑更简洁"></label><label>更新与修复<textarea name="summary" rows="4" maxlength="4000" placeholder="简述本次更新了什么、修复了什么"></textarea></label><p id="versionCaptureHint" class="hint"></p><details id="versionRecoverySettings"><summary>Git 与恢复设置</summary><label>Git 标签 / 提交 / 分支<input name="ref" maxlength="120" placeholder="关联提交以便后续回滚；留空仅记录说明"></label><button type="button" id="useVersionHead">读取当前提交</button><label>验证记录<textarea name="validation" rows="2" maxlength="2000" placeholder="验证结论和已知问题"></textarea></label><label>备份位置<input name="backupPath" maxlength="1000" placeholder="已有备份的位置；没有则写未创建"></label><label>回滚注意事项<textarea name="rollbackNotes" rows="2" maxlength="4000" placeholder="必要的数据兼容或恢复说明"></textarea></label><p class="hint">记录提交便于定位源码；保存不执行回滚，也不创建备份。</p></details><p id="versionEditorError" class="error" role="alert"></p><div class="dialog-actions"><button type="button" id="cancelVersionEditor">取消</button><button class="primary" id="saveVersion">保存记录</button></div></form>`;
  const preview=document.createElement('dialog');preview.id='versionPreview';preview.setAttribute('aria-labelledby','versionPreviewTitle');
  preview.innerHTML=`<div class="dialog-heading"><h2 id="versionPreviewTitle">回滚准备</h2><button id="closeVersionPreview" aria-label="关闭回滚准备">×</button></div><div id="versionPreviewBody"></div><label>可复制的回滚说明<textarea id="versionGuide" rows="8" readonly></textarea></label><button id="copyVersionGuide" class="primary">复制回滚说明</button><p class="hint" id="versionCopyStatus" role="status"></p>`;
  document.body.append(editor,preview);
  assistant=createVersionAssistant({form:$('versionForm'),dialog:editor,post:(route,body)=>api.post(route,body),readFields:()=>Object.fromEntries(fields.map(f=>[f,$('versionForm').elements[f].value])),onBegin:()=>{captureEpoch++;capturePromise=null;$('versionCaptureHint').textContent='将使用 Codex 整理的提交信息。';},fillFields:(values,snapshot)=>{captureEpoch++;capturePromise=null;for(const f of fields)$('versionForm').elements[f].value=values[f];$('versionCaptureHint').textContent=snapshot?gitHint(snapshot):'未固定 Git 提交；当前为说明记录。';$('versionEditorError').textContent='';}});
  for(const event of ['input','change'])$('versionForm').elements.ref.addEventListener(event,()=>{captureEpoch++;capturePromise=null;$('versionCaptureHint').textContent=$('versionForm').elements.ref.value?'使用手动填写的 Git 引用。':'未关联 Git 提交，保存为说明记录。';});
  $('versionProject').onchange=()=>{location.href='/?projectId='+encodeURIComponent($('versionProject').value)+'&view=versions';};
  $('versionSearch').oninput=()=>{if(api.reader)void api.load();else renderList();};
  $('newVersion').onclick=()=>openEditor();
  const closeEditor=()=>{if(!busy)editor.close();};$('closeVersionEditor').onclick=$('cancelVersionEditor').onclick=closeEditor;
  editor.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  $('closeVersionPreview').onclick=()=>{previewRequest++;preview.close();};
  $('useVersionHead').onclick=async()=>{
    if(busy||editing)return;captureEpoch++;capturePromise=null;const owner=projectId,requestId=$('versionForm').dataset.requestId,current=()=>owner===projectId&&requestId===$('versionForm').dataset.requestId;setBusy(true);$('versionEditorError').textContent='';
    try{const r=await api.post('versions/inspect',{projectId:owner});if(current()){$('versionForm').elements.ref.value=r.commit;$('versionCaptureHint').textContent=gitHint(r);}}
    catch(e){if(current())$('versionEditorError').textContent=e.message;}finally{if(current())setBusy(false);}
  };
  $('versionForm').onsubmit=async e=>{
    e.preventDefault();if(busy)return;setBusy(true);$('versionEditorError').textContent='';
    const form=e.currentTarget,owner=projectId,requestId=form.dataset.requestId;
    try{await capturePromise;if(owner!==projectId||requestId!==form.dataset.requestId||!editor.open)return;const data=Object.fromEntries(fields.map(f=>[f,form.elements[f].value]));await api.post('versions/save',{projectId:owner,...data,...(editing?{id:editing.id,revision:editing.revision}:{}),...(assistant.sourceId()?{intakeId:assistant.sourceId()}:{}),requestId});editor.close();$('versionGitInfo').querySelector('details')?.removeAttribute('open');await api.load();api.notice('版本记录已保存。');}
    catch(error){$('versionEditorError').textContent=error.message;}finally{setBusy(false);}
  };
  $('inspectVersionGit').onclick=async()=>{
    const button=$('inspectVersionGit'),capturedProject=projectId;button.disabled=true;$('versionMessage').textContent='正在读取本机 Git…';
    try{const r=await api.post('versions/inspect',{projectId:capturedProject});if(capturedProject!==projectId)return;$('versionMessage').textContent=gitHint(r);$('versionGitInfo').innerHTML=r.tags.length||r.history.length?`<details class="version-git" open><summary>${r.history.length?'Git 近期提交':'Git 标签'}</summary>${r.tags.length?`<p class="hint">${r.tags.map(esc).join('、')}</p>`:''}${r.history.map(h=>`<button class="git-commit-option" data-version-ref="${esc(h.commit)}"><span>${esc(h.subject)}</span><code>${h.commit.slice(0,8)}</code></button>`).join('')}</details>`:'';}
    catch(e){$('versionMessage').textContent=e.message;}finally{button.disabled=false;}
  };
  section.addEventListener('click',e=>{
    const more=e.target.closest('[data-more-versions]');if(more){more.disabled=true;void api.reader.list('versions',{projectId,limit:20,search:$('versionSearch').value},true).then(()=>api.load()).catch(error=>api.notice(error.message,true)).finally(()=>{more.disabled=false;});return;}
    const ref=e.target.closest('[data-version-ref]');if(ref){openEditor(null,ref.dataset.versionRef);return;}
    const remove=e.target.closest('[data-version-delete]');if(remove){void removeRecord(remove);return;}
    if(removing)return;
    const edit=e.target.closest('[data-version-edit]');if(edit){openEditor(state.versionRecords.find(v=>v.id===edit.dataset.versionEdit&&v.projectId===projectId));return;}
    const prepare=e.target.closest('[data-version-prepare]');if(prepare)void openPreview(prepare.dataset.versionPrepare);
  });
  $('copyVersionGuide').onclick=async()=>{try{await navigator.clipboard.writeText($('versionGuide').value);$('versionCopyStatus').textContent='已复制，可交给当前项目的执行任务核对。';}catch{$('versionGuide').focus();$('versionGuide').select();$('versionCopyStatus').textContent='请按 Ctrl+C 复制已选中的说明。';}};
}
async function removeRecord(button){
  if(removing||busy)return;const owner=projectId,record=state.versionRecords.find(v=>v.id===button.dataset.versionDelete&&v.projectId===owner&&!v.deletedAt);if(!record)return;
  if(!confirm('删除版本记录“'+record.name+'”？\n仅从版本列表移除，历史仍保留；不会删除代码、Git 提交或备份。'))return;
  removing=true;button.disabled=true;
  try{await api.post('versions/delete',{projectId:owner,id:record.id,revision:record.revision});if(owner===projectId)await api.load();}
  catch(error){api.notice(error.message,true);}finally{removing=false;button.disabled=false;}
}
function setBusy(value){busy=value;$('versionForm').querySelectorAll('input,textarea,button').forEach(el=>el.disabled=value);$('versionForm').elements.ref.readOnly=!!editing;$('useVersionHead').disabled=value||!!editing;}
function gitHint(r){return `${r.branch} · ${r.commit.slice(0,8)} · ${r.dirty?'有 '+r.changes+' 项未提交修改，提交号不包含这些修改':'工作区干净'}。`;}
function openEditor(record=null,ref=''){
  if(!projectId||busy)return;editing=record??null;const form=$('versionForm');form.reset();form.dataset.requestId=crypto.randomUUID();
  for(const f of fields)form.elements[f].value=record?.[f]??'';
  if(!record)form.elements.ref.value=ref;
  $('versionRecoverySettings').open=false;$('versionEditorTitle').textContent=record?'编辑版本记录':'记录版本';$('versionCaptureHint').textContent=record?.commit?'已关联提交 '+record.commit.slice(0,8)+'；编辑说明不会改变此提交。':'可展开“Git 与恢复设置”关联提交，便于后续回滚。';$('versionEditorError').textContent='';setBusy(false);$('versionEditor').showModal();assistant.open(projectId,editing,state.versionIntakes);if(editing)form.elements.name.focus();else $('versionForm').querySelector('[data-copy]').focus();
  captureEpoch++;capturePromise=null;
  if(!record&&!ref&&!(state.versionIntakes??[]).some(r=>r.projectId===projectId&&['waiting','ready'].includes(r.status))){
    const owner=projectId,requestId=form.dataset.requestId,epoch=captureEpoch,current=()=>$('versionEditor').open&&owner===projectId&&requestId===form.dataset.requestId&&!editing&&epoch===captureEpoch;
    $('versionCaptureHint').textContent='正在读取当前提交，供后续回滚定位…';
    const pending=api.post('versions/inspect',{projectId:owner}).then(r=>{if(current()&&!form.elements.ref.value){form.elements.ref.value=r.commit;$('versionCaptureHint').textContent=gitHint(r);}}).catch(()=>{if(current())$('versionCaptureHint').textContent='当前未关联 Git 提交，保存为说明记录；可展开恢复设置手动关联。';}).finally(()=>{if(capturePromise===pending)capturePromise=null;});capturePromise=pending;
  }
}
async function openPreview(id){
  const record=state.versionRecords.find(v=>v.id===id&&v.projectId===projectId);if(!record)return;
  const ticket=++previewRequest;$('versionPreviewTitle').textContent='回滚准备 · '+record.name;$('versionPreviewBody').textContent='正在核对版本…';$('versionGuide').value='';$('versionCopyStatus').textContent='';$('copyVersionGuide').disabled=true;$('versionPreview').showModal();
  try{const r=await api.post('versions/prepare',{projectId,id});if(ticket!==previewRequest)return;const difference=r.gitAvailable?(r.fileCount?`<details open><summary>当前提交 → 目标提交 · ${r.fileCount} 个文件</summary>${r.stat?`<pre>${esc(r.stat)}</pre>`:''}${r.truncated?'<p class="hint">仅显示前100个文件。</p>':''}${r.files.length?`<pre>${esc(r.files.join('\n'))}</pre>`:''}</details>`:'<p class="hint">两个提交的源码内容相同</p>'):'';$('versionPreviewBody').innerHTML=`<p class="hint">${esc(r.message)}</p>${r.gitAvailable?`<div class="version-compare"><span>当前 <code>${r.current.commit.slice(0,8)}</code></span><span>目标 <code>${r.target.slice(0,8)}</code></span></div>${r.current.dirty?`<p class="version-warning">当前有 ${r.current.changes} 项未提交修改，执行前必须先保存或备份。</p>`:''}${difference}`:''}`;$('versionGuide').value=r.guide;$('copyVersionGuide').disabled=false;}
  catch(e){if(ticket===previewRequest)$('versionPreviewBody').textContent=e.message;}
}
function renderList(){
  const query=$('versionSearch').value.trim().toLocaleLowerCase(),records=(state.versionRecords??[]).filter(v=>!v.deletedAt&&v.projectId===projectId&&(!query||[v.name,v.summary,v.ref,v.commit].some(x=>x?.toLocaleLowerCase().includes(query)))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  $('versionList').innerHTML=records.map(v=>{
    const details=[['验证记录',v.validation],['备份记录（未独立核验）',v.backupPath],['回滚注意',v.rollbackNotes]].filter(([,value])=>value?.trim());
    const summary=v.summary?.trim()??'',longSummary=summary.length>180||summary.split('\n').length>5,preview=summary.slice(0,180).split('\n').slice(0,5).join('\n');
    return `<article class="version-card"><div class="version-card-head"><h2 title="${esc(v.name)}">${esc(v.name)}</h2><time>${esc(date(v.createdAt))}</time></div>${summary?`<p class="version-summary">${esc(longSummary?preview+'…':summary)}</p>${longSummary?`<details class="version-full-summary"><summary>完整更新说明</summary><p class="version-summary">${esc(summary)}</p></details>`:''}`:''}<div class="version-badges"><span>${v.commit?'提交 '+v.commit.slice(0,8):'未关联提交'}</span></div>${details.length||v.dirtyAtCapture?`<details><summary>验证与恢复</summary>${v.dirtyAtCapture?'<p class="version-warning">记录时含未提交修改，恢复时需结合备份。</p>':''}<dl>${details.map(([label,value])=>`<dt>${label}</dt><dd>${esc(value)}</dd>`).join('')}</dl></details>`:''}<div class="version-actions"><button data-version-edit="${esc(v.id)}">编辑</button><button data-version-delete="${esc(v.id)}" ${state.service?.versionDeleteSupported?'':'disabled title="更新本机面板后可删除记录"'}>删除</button><button class="primary" data-version-prepare="${esc(v.id)}">准备回滚</button></div></article>`;
  }).join('');
  $('versionList').hidden=!records.length&&!state.query?.versions?.cursor;
  if(state.query?.versions?.cursor){const button=document.createElement("button");button.type="button";button.dataset.moreVersions="true";button.textContent="加载更多版本";$("versionList").append(button);}
}
export function updateVersions(next,id,active){
  state=next;const changed=id!==projectId;projectId=id;$('versionsView').hidden=!active;
  const project=state.projects.find(p=>p.projectId===id);$('versionsTitle').textContent=(project?.label??'项目')+' · 版本';
  const select=$('versionProject'),options=state.projects.filter(p=>p.hostId==='local'&&p.path).map(p=>`<option value="${esc(p.projectId)}">${esc(p.label)}</option>`).join('');if(select.innerHTML!==options)select.innerHTML=options;select.value=id;
  $('newVersion').disabled=!project||!Array.isArray(state.versionRecords);$('inspectVersionGit').disabled=!project||!Array.isArray(state.versionRecords);
  if(changed){busy=false;capturePromise=null;$('versionSearch').value='';$('versionMessage').textContent='';$('versionGitInfo').innerHTML='';$('versionEditor').close();$('versionPreview').close();previewRequest++;}
  const nextKey=JSON.stringify([id,state.versionRecords,state.query?.versions?.cursor]);if(nextKey!==key){key=nextKey;renderList();}
}
