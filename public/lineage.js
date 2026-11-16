import {panelFetch as fetch} from './read-client.js';
import {dependencyCompleted} from './task-organization.js';
import {goalContextText} from './rounds.js';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={feature:'新功能',bug:'Bug',improvement:'优化',analysis:'分析评审'};
let api,state={},projectId='',view='board',filterOpen=false,key='',selectedEvent=null,historyPage=null,historyCursor=null,historyNext=null,pendingOffset=0;
const own=()=>state.tasks.filter(t=>t.projectId===projectId&&!t.archivedAt);
const label=t=>`${t.shortId??t.id.slice(0,8)} · ${t.title}`;
const stage=t=>t.historyOnly?'历史归档':t.status==='done'?'已验收':t.status==='review'?'待审阅':t.status==='running'?'执行中':t.workflowStage==='discussion'?'方案讨论':t.workflowStage==='confirmation'?'待确认':'待执行';
const options=(tasks,value='')=>'<option value="">无</option>'+tasks.map(t=>`<option value="${esc(t.id)}" ${value===t.id?'selected':''}>${esc(label(t))}</option>`).join('');
const lineageDrafts=new Map(),lineagePending=new Set();
const formKey=form=>['chainForm','deliveryForm','splitTask','mergeTask'].map(key=>form.dataset[key]?key+':'+form.dataset[key]:'').find(Boolean);
function rememberForm(form,focused){const key=formKey(form);if(key)lineageDrafts.set(key,{values:[...new FormData(form)],requestId:form.dataset.requestId,focused});}
export function restoreLineageDrafts(root){for(const form of root.querySelectorAll('form')){const key=formKey(form),draft=lineageDrafts.get(key);if(!draft)continue;for(const el of form.elements){if(!el.name)continue;const values=draft.values.filter(([name])=>name===el.name).map(([,value])=>value);if(el.type==='checkbox')el.checked=values.includes(el.value);else if(el.multiple)for(const option of el.options)option.selected=values.includes(option.value);else el.value=values[0]??'';}if(draft.requestId)form.dataset.requestId=draft.requestId;for(let parent=form.closest('details');parent;parent=parent.parentElement?.closest('details'))parent.open=true;const button=form.querySelector('button[type=submit]');if(button)button.disabled=lineagePending.has(key);if(draft.focused)form.elements.namedItem(draft.focused)?.focus({preventScroll:true});}}
export function chainBlock(t,review=false){if(t.pendingParentId)return '父任务待本机接续';if(t.pendingDependencies?.length)return '前置任务待本机接续';if(review&&state.tasks.some(x=>x.parentId===t.id&&!x.archivedAt&&x.status!=='done'))return '先完成子任务验收';if(['discussion','confirmation'].includes(t.workflowStage))return '先确认方案，再执行';if(!review&&(t.execution||t.sectionId||t.dependsOn?.length))return '';if((t.dependsOn??[]).some(id=>{const parent=state.tasks.find(x=>x.id===id&&x.projectId===t.projectId);return review?parent?.status!=='done':!dependencyCompleted(parent,state);}))return review?'等待前置任务审阅通过':'前置任务本轮尚未确认正常结束';return '';}
export function chainHint(t){return t.shortId||t.workflowStage||t.parentId?`<div class="chain-card-hint"><span>${esc(t.shortId??'关联任务')}</span>${t.workflowStage==='discussion'?'<span>方案讨论</span>':''}${t.parentId?'<span>子任务</span>':''}${t.sourceKind==='conversation'?'<span title="依据原对话记录，不是面板发送回执">来自对话</span>':''}</div>`:'';}
function treeMarkup(tasks){
  const ids=new Set(tasks.map(t=>t.id)),byParent=new Map();for(const t of tasks){const p=ids.has(t.parentId)?t.parentId:'';if(!byParent.has(p))byParent.set(p,[]);byParent.get(p).push(t);}
  const node=(t,depth,seen)=>{if(seen.has(t.id))return '';const next=new Set([...seen,t.id]),children=byParent.get(t.id)??[];
    return `<div class="chain-node chain-depth-${Math.min(depth,3)}"><div class="chain-node-main"><button class="chain-task-title" data-chain-open="${esc(t.id)}"><span class="hint">${esc(t.shortId??t.id.slice(0,8))}</span><strong>${esc(t.title)}</strong></button><span class="chain-stage" data-status="${esc(t.status)}">${stage(t)}</span></div><div class="chain-node-meta"><span>${esc(labels[t.recognitionType]??labels[t.tag]??'任务')} · P${t.priority??2}</span>${t.delivery?.enabled?'<span>已启用</span>':t.delivery?.codeVerified?'<span>代码已验证 · 未确认启用</span>':''}${t.dependsOn?.length?`<span>依赖 ${t.dependsOn.length} 项</span>`:''}</div>${children.length?`<details data-chain-group="${esc(t.id)}"><summary>${children.filter(c=>c.status==='done').length}/${children.length} 个子任务已验收</summary><div class="chain-children">${children.sort((a,b)=>(a.priority??2)-(b.priority??2)).map(c=>node(c,depth+1,next)).join('')}</div></details>`:''}</div>`;
  };
  return (byParent.get('')??[]).sort((a,b)=>(a.priority??2)-(b.priority??2)).map(t=>node(t,0,new Set())).join('')||'<div class="empty">暂无任务链。在任务详情里可拆分子任务和设置依赖。</div>';
}
const imageRequests=new Map();let imageService="";
function clearSourceImages(){for(const pending of imageRequests.values())pending.then(r=>{if(r.url)URL.revokeObjectURL(r.url);});imageRequests.clear();}
window.addEventListener('pagehide',clearSourceImages);
export function readableSourceText(text){return goalContextText(text).replace(/^(?:\s|&#x0*20;|&#0*32;|&nbsp;)+/i,'').replace(/<image\b[^>]*(?:>|$)|<\/image>/gi,'').trim();}
export function readableSourceTask(task){
  if(task.sourceKind!=='conversation')return task;
  let title=task.title;
  if(/^(?:\s|&#x0*20;?|&#0*32;?|&nbsp;?)+$/i.test(title??'')){
    const clean=readableSourceText(task.description).replace(/\s+/g,' ').replace(/^(?:请|我(?:现在)?需要你?|我想要|帮我|现在)/,'');
    const parts=clean.split(/[，。；;\n]/).map(s=>s.trim()).filter(Boolean);
    title=(parts.find(s=>/^(优化|增加|新增|添加|实现|开发|修复|改善|调整|审查|审视|分析)/.test(s))??parts[0]??'待确认需求').slice(0,48);
  }
  return {...task,title:readableSourceText(title),description:goalContextText(task.description)};
}
export async function showTaskSourceImages(root,task){
  if(!root||!task.sourceIds?.length)return;
  const owner=projectId;
  try{const response=await api.post('capture/sources',{id:task.id,projectId:owner});if(!root.isConnected||owner!==projectId)return;root.innerHTML=response.events.filter(event=>sourceView(event).images.length).map(sourceImages).join('');void hydrateSourceImages(root);}catch{if(root.isConnected)root.textContent='对话附件暂未加载，请稍后刷新。';}
}
function sourceView(event){
  const source=event.source,presentation=source.presentation;
  const tags=[...source.text.matchAll(/<image\b[^>]*(?:>|$)/gi)];
  return presentation??{text:readableSourceText(source.text),images:tags.map((_,index)=>({index,name:'截图 '+(index+1)})),hasAttachments:source.hasAttachments||tags.length>0};
}
function sourceTitle(event){
  const text=sourceView(event).text.replace(/\s+/g,' ').trim(),target=state.tasks?.find(t=>t.id===event.suggestion.targetId);
  if(target)return '继续：'+target.title;
  if(/移动.{0,4}示意位置/.test(text))return '调整截图所示位置';
  const parts=text.split(/[，。；;]/).map(t=>t.trim()).filter(Boolean);
  return (parts.find(t=>/待执行|侧栏|移动|调整|优化|修改|修复|布局|自动计划/.test(t))??parts[0]??'查看截图中的需求').replace(/^(我发现|我想要|请|帮我)/,'').replace(/(?:就)?(?:够了|可以了)吧[？?。]*$/,'').slice(0,60);
}
function sourceImages(event){const view=sourceView(event);return view.images.length?'<div class="source-images">'+view.images.map(image=>`<figure class="source-image" data-source-image="${esc(event.id)}" data-image-index="${image.index}"><button type="button" data-source-zoom disabled aria-label="放大需求截图 ${image.index+1}"><img alt="需求截图 ${image.index+1}" hidden></button><figcaption role="status">正在读取截图 ${image.index+1}…</figcaption></figure>`).join('')+'</div>':view.hasAttachments?'<p class="hint">原消息含附件，请在原对话中查看。</p>':'';}
async function hydrateSourceImages(root){
  const owner=projectId,token=state.token;
  for(const figure of root.querySelectorAll('[data-source-image]')){
    if(figure.dataset.loading)continue;figure.dataset.loading='true';
    const id=figure.dataset.sourceImage,index=Number(figure.dataset.imageIndex),key=owner+':'+id+':'+index;
    if(!imageRequests.has(key)){
      if(imageRequests.size>=32){const first=imageRequests.keys().next().value;imageRequests.get(first).then(r=>{if(r.url)URL.revokeObjectURL(r.url);});imageRequests.delete(first);}
      imageRequests.set(key,(async()=>{try{const r=await fetch('/api/capture/image',{method:'POST',headers:{'Content-Type':'application/json','X-Panel-Token':token},body:JSON.stringify({projectId:owner,id,index})});if(!r.ok){const problem=await r.json().catch(()=>({}));throw Error(/截图|附件|来源/.test(problem.error??'')?problem.error:'图片预览需加载新版接口，请在本轮结束后重启面板。');}if(!r.headers.get('content-type')?.startsWith('image/'))throw Error('截图格式不可用，请打开原对话查看。');return {url:URL.createObjectURL(await r.blob())};}catch(e){return {error:e.message};}})());
    }
    const image=await imageRequests.get(key);if(!figure.isConnected||owner!==projectId)continue;
    const img=figure.querySelector('img'),button=figure.querySelector('button'),caption=figure.querySelector('figcaption');
    if(image.url){img.onload=()=>{img.hidden=false;button.disabled=false;caption.textContent='截图 '+(index+1)+' · 点击放大';};img.onerror=()=>{caption.textContent='截图无法显示，请打开原对话查看。';};img.src=image.url;}
    else{button.hidden=true;caption.textContent=image.error;}
  }
}
function sourceSummary(event){const view=sourceView(event),title=sourceTitle(event),date=event.source.at?new Date(event.source.at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';return `<article class="capture-preview" data-source-card="${esc(event.id)}"><h4><button type="button" class="source-card-title" data-review-source="${esc(event.id)}" aria-label="查看记录：${esc(title)}">${esc(title)}</button></h4><div class="source-meta">${esc(event.source.threadTitle||'原对话')}${date?' · '+esc(date):''}</div>${view.text!==title?'<p>'+esc(view.text.slice(0,240))+'</p>':''}${sourceImages(event)}<div class="source-actions"><button type="button" class="primary" data-archive-source="${esc(event.id)}" hidden disabled>归档</button><button type="button" data-dismiss-source="${esc(event.id)}">忽略</button><button type="button" data-open-source="${esc(event.id)}">原对话 ↗</button></div></article>`;}

const sourceArchiveChecks=new Map(),archiveCheckQueue=[];
let archiveCheckFlights=0;
const archiveObserver=new IntersectionObserver(entries=>{
  for(const entry of entries)if(entry.isIntersecting){archiveObserver.unobserve(entry.target);archiveCheckQueue.push({card:entry.target,owner:entry.target.dataset.sourceOwner});}
  void checkVisibleArchives();
});
function hydrateSourceArchives(root){
  for(const card of root.querySelectorAll('[data-source-card]')){
    if(card.dataset.sourceOwner)continue;
    card.dataset.sourceOwner=projectId;archiveObserver.observe(card);
  }
}
function renderSourceCards(root,events,empty=''){
  root.querySelectorAll('[data-source-card]').forEach(card=>archiveObserver.unobserve(card));
  root.innerHTML=events.map(sourceSummary).join('')||empty;
  void hydrateSourceImages(root);hydrateSourceArchives(root);updateSourceBatchControls();
}
async function checkVisibleArchives(){
  while(archiveCheckFlights<2&&archiveCheckQueue.length){
    const {card,owner}=archiveCheckQueue.shift();
    if(!card.isConnected||owner!==projectId)continue;
    const id=card.dataset.sourceCard,cacheKey=owner+':'+id;
    let cached=sourceArchiveChecks.get(cacheKey);
    if(!cached||cached.expires<Date.now()){
      if(sourceArchiveChecks.size>=128)sourceArchiveChecks.delete(sourceArchiveChecks.keys().next().value);
      cached={expires:Date.now()+30000,result:api.post('capture/archive-preview',{id,projectId:owner}).then(result=>!!result.canArchive,()=>false)};
      sourceArchiveChecks.set(cacheKey,cached);
    }
    archiveCheckFlights++;
    void cached.result.then(canArchive=>{
      if(!card.isConnected||owner!==projectId)return;
      const button=card.querySelector('[data-archive-source]');button.hidden=!canArchive;button.disabled=!!sourceBatch||sourceChanges.has(cacheKey);
    }).finally(()=>{archiveCheckFlights--;void checkVisibleArchives();});
  }
}

const sourceChanges=new Set();
let sourceBatch=null;
function updateSourceBatchControls(){
  const busy=!!sourceBatch,disabled=busy||sourceChanges.size>0;
  for(const id of ['dismissPendingSources','archivePendingSources'])if($(id))$(id).disabled=disabled;
  for(const card of document.querySelectorAll('[data-source-card]')){
    const pending=busy||sourceChanges.has(projectId+':'+card.dataset.sourceCard);
    card.querySelectorAll('.source-actions button,[data-review-source]').forEach(button=>button.disabled=pending);
  }
  if(sourceBatch&&sourceBatch.owner===projectId){
    const status=$('pendingBatchStatus');status.hidden=false;
    status.textContent=sourceBatch.total===null?'正在读取全部待整理记录…':`正在${sourceBatch.kind==='archive'?'归档':'忽略'} ${sourceBatch.done} / ${sourceBatch.total}，已处理 ${sourceBatch.success} 条`;
  }
}
const postSourceChange=(id,kind,owner)=>api.post(kind==='archive'?'capture/archive':'capture/correct',kind==='archive'?{id,projectId:owner,handled:true}:{id,projectId:owner,action:'dismiss'});
async function batchSources(kind){
  if(sourceBatch||sourceChanges.size)return;
  const owner=projectId,instance=imageService,batch={owner,kind,total:null,done:0,success:0,skipped:0,failed:0};
  sourceBatch=batch;$('pendingSources').open=true;updateSourceBatchControls();
  let problem='',stopped=false;
  const current=()=>owner===projectId&&instance===imageService;
  try{
    // Read the complete snapshot before removing anything, so offsets cannot skip rows.
    const ids=new Set();
    for(let offset=0;;offset+=50){
      const page=await api.post('capture/pending',{projectId:owner,offset});
      if(!current()){stopped=true;break;}
      for(const event of page.events)ids.add(event.id);
      if(page.events.length<50)break;
    }
    batch.total=ids.size;updateSourceBatchControls();
    for(const id of stopped?[]:ids){
      if(!current()){stopped=true;break;}
      let canArchive=false;
      try{canArchive=!!(await api.post('capture/archive-preview',{id,projectId:owner})).canArchive;}
      catch(error){
        // A missing/changed original message is a known unarchivable record.
        // Connection, permission and other unknown failures cannot authorize bulk dismissal.
        if(!/尚未找到原轮次|原消息已变化|\bENOENT:\s*no such file or directory/i.test(error.message)){
          batch.failed++;batch.done++;problem ||= error.message;
          if(error.notApplied)throw error;
          updateSourceBatchControls();continue;
        }
      }
      if(!current()){stopped=true;break;}
      if(canArchive!==(kind==='archive'))batch.skipped++;
      else{
        const changeKey=owner+':'+id;sourceChanges.add(changeKey);
        try{await postSourceChange(id,kind,owner);batch.success++;sourceArchiveChecks.delete(changeKey);}
        catch(error){batch.failed++;problem ||= error.message;if(error.notApplied)throw error;}
        finally{sourceChanges.delete(changeKey);}
      }
      batch.done++;updateSourceBatchControls();
    }
  }catch(error){problem=error.message;stopped=true;}
  finally{
    try{await api.load();if(current()&&$('pendingDialog').open)await loadPending();}
    catch(error){problem ||= error.message;}
    sourceBatch=null;updateSourceBatchControls();
    if(current()){
      const status=$('pendingBatchStatus');status.hidden=false;
      status.textContent=`${stopped?'已停止；':''}已${kind==='archive'?'归档':'忽略'} ${batch.success} 条，跳过 ${batch.skipped} 条${batch.failed?'，未确认 '+batch.failed+' 条':''}${problem?'；部分记录未能处理，请稍后重试或查看故障日志。':''}`;
    }
  }
}
async function changeSource(button,kind){
  const id=kind==='archive'?button.dataset.archiveSource:button.dataset.dismissSource,owner=projectId,key=owner+':'+id;
  if(sourceBatch||button.disabled||sourceChanges.has(key))return;
  sourceChanges.add(key);
  const controls=[...document.querySelectorAll('[data-source-card]')].filter(card=>card.dataset.sourceCard===id).flatMap(card=>[...card.querySelectorAll('.source-actions button')]);
  controls.forEach(control=>control.disabled=true);
  try{
    await postSourceChange(id,kind,owner);
    await api.load();
    if(owner===projectId&&$('pendingDialog').open)await loadPending();
  }catch(error){
    if(kind==='archive'){
      sourceArchiveChecks.delete(key);
      controls.filter(control=>control.dataset.archiveSource).forEach(control=>control.hidden=true);
    }
    api.notice(error.message,true);
  }
  finally{sourceChanges.delete(key);controls.forEach(control=>control.disabled=false);updateSourceBatchControls();}
}

export function resetTaskView(){view='board';}
export function updateLineage(next,id,referencesOpen=false){
  state=next;if(next.service?.instanceId!==imageService){imageService=next.service?.instanceId;clearSourceImages();sourceArchiveChecks.clear();key='';}const changed=id!==projectId;projectId=id;if(changed){clearSourceImages();archiveObserver.disconnect();$('pendingBatchStatus').hidden=true;view='board';key='';}
  const tasks=own(),events=(state.capture?.events??[]).filter(e=>e.projectId===id),pending=state.capture?.projects?.[id]?.pending??events.length;
  $('board').hidden=view==='chain';$('taskFilters').hidden=view==='chain';$('compactTaskFilters').hidden=view==='chain'||!filterOpen;$('filterToggle').hidden=false;$('filterToggle').disabled=view==='chain';$('filterToggle').setAttribute('aria-expanded',String(view!=='chain'&&filterOpen));const selectedCount=[...$('taskFilters').querySelectorAll('select')].filter(el=>el.id!=='taskSort'&&el.value).length;const filterLabel=view==='chain'?'切回看板进行筛选':selectedCount?'排序筛选，'+selectedCount+'项条件':'排序筛选';$('filterToggle').setAttribute('aria-label',filterLabel);$('filterToggle').title=filterLabel;$('filterToggle').dataset.count=selectedCount?String(selectedCount):'';$('laneNav').hidden=view==='chain';$('taskChain').hidden=view!=='chain';
  $('chainViewButton').setAttribute('aria-pressed',String(!referencesOpen&&view==='chain'));
  $('projectView').classList.toggle('project-references-open',referencesOpen);
  if(referencesOpen)$('board').hidden=true;
  api.references?.update(id,referencesOpen&&!$('projectView').hidden,next.sync?.boardLastSync);
  $('openHistoryImport').disabled=!state.capture;
  $('pendingSources').hidden=!pending;$('pendingSourceCount').textContent=String(pending);
  const nextKey=JSON.stringify([id,tasks,events]);if(key!==nextKey){key=nextKey;const open=new Set([...$('taskChain').querySelectorAll('details[open]')].map(d=>d.dataset.chainGroup));$('taskChain').innerHTML=treeMarkup(tasks);$('taskChain').querySelectorAll('details').forEach(d=>{d.open=open.has(d.dataset.chainGroup);});renderSourceCards($('candidatePreviews'),events.slice(-3).reverse());}
  updateSourceBatchControls();
}
export function renderChainDetails(t){
  const children=own().filter(x=>x.parentId===t.id),tasks=own().filter(x=>x.id!==t.id),dependencyNames=(t.dependsOn??[]).map(id=>state.tasks.find(x=>x.id===id)?.title??'任务不可用');
  return `<section class="task-lifecycle">${children.length&&t.status==='todo'&&!t.jobIds.length?`<button data-parent-complete="${esc(t.id)}" ${children.some(c=>c.status!=='done')?'disabled':''}>验收主任务</button><p class="hint">子任务全部验收后，再确认主任务完成。</p>`:''}<p class="workflow-steps" aria-label="开发流程">需求 → 方案 → 确认 → 实施 → 验收</p><div class="lifecycle-stage"><span><small>当前阶段</small><strong>${stage(t)}</strong></span><span class="${t.delivery?.codeVerified?'is-confirmed':''}"><small>代码验证</small><strong>${t.delivery?.codeVerified?'已验证':'待确认'}</strong></span><span class="${t.delivery?.enabled?'is-confirmed':''}"><small>功能启用</small><strong>${t.delivery?.enabled?'已启用':'待确认'}</strong></span></div>${t.workflowStage==='discussion'||t.workflowStage==='confirmation'?`<button class="primary" data-plan-ready="${esc(t.id)}">确认方案，列为待执行</button>`:''}${dependencyNames.length?`<p class="hint">前置任务：${esc(dependencyNames.join('、'))}</p>`:''}</section>
  <details class="task-background"><summary>任务链与需求来源${t.sourceIds?.length?' · '+t.sourceIds.length:''}</summary><button data-load-sources="${esc(t.id)}">查看原始需求与补充记录</button><div id="taskSources-${esc(t.id)}"></div>
  <form data-chain-form="${esc(t.id)}" class="chain-form"><label>任务类型<select name="kind"><option value="">沿用当前属性</option>${Object.entries(labels).map(([id,name])=>`<option value="${id}" ${(t.recognitionType??t.tag)===id?'selected':''}>${name}</option>`).join('')}</select></label><label>父任务<select name="parentId">${options(tasks,t.parentId)}</select></label><label>前置依赖（可多选）<select name="dependsOn" multiple size="3">${tasks.map(x=>`<option value="${esc(x.id)}" ${t.dependsOn?.includes(x.id)?'selected':''}>${esc(label(x))}</option>`).join('')}</select></label><button type="submit">保存类型与关系</button></form>
  <form data-delivery-form="${esc(t.id)}"><label class="check"><input type="checkbox" name="codeVerified" ${t.delivery?.codeVerified?'checked':''}>已核对代码验证通过</label><label class="check"><input type="checkbox" name="enabled" ${t.delivery?.enabled?'checked':''}>已核对功能实际启用</label><button type="submit">记录交付状态</button></form>
  <details><summary>拆分或合并任务</summary><form data-split-task="${esc(t.id)}"><label>子任务标题，每行一项<textarea name="titles" rows="3" required placeholder="例如：现状审查&#10;实施已确认的优化"></textarea></label><button type="submit">拆成子任务</button></form><form data-merge-task="${esc(t.id)}"><label>并入另一个未执行任务<select name="targetId" required>${options(tasks.filter(x=>x.status==='todo'&&!x.jobIds?.length))}</select></label><p class="hint">合并保留原任务与需求历史，不删除记录。</p><button type="submit">合并任务</button></form></details></details>`;
}
async function action(fn){try{await fn();await api.load();}catch(error){api.notice(error.message,true);}}
async function openRecognition(id){
  const response=await api.post('capture/event',{id,projectId});selectedEvent=response.event;
  $('recognitionRequest').textContent=sourceView(selectedEvent).text;$('recognitionImages').innerHTML=sourceImages(selectedEvent);void hydrateSourceImages($('recognitionImages'));
  $('recognitionError').textContent='';$('archiveDestination').textContent='正在核对原对话与归档位置…';$('archiveSourceButton').disabled=true;$('recognitionDialog').showModal();
  $('recognitionResultState').textContent='正在读取原轮次…';$('recognitionResult').textContent='';
  try{const preview=await api.post('capture/archive-preview',{id,projectId});if(selectedEvent.id!==id||!$('recognitionDialog').open)return;
    const source=preview.source??{},finished=['completed','failed','interrupted'].includes(source.turnStatus);
    $('recognitionResultState').textContent=source.turnStatus==='completed'?'原对话已结束，请核对处理结果':source.turnStatus==='failed'?'原轮次执行失败':source.turnStatus==='interrupted'?'原轮次已中断':'原对话仍在处理中';
    $('recognitionResult').textContent=source.result?.trim()|| (finished?'该轮次未记录处理结果，可点击“定位到聊天”核对。':'尚未收到处理结果，结束后重新打开此记录查看。');
    $('archiveDestination').textContent=(preview.sectionName||'默认分组')+' · '+preview.title;
    $('archiveSourceButton').disabled=!preview.canArchive;
    $('recognitionReason').textContent=preview.canArchive?'只保存原对话和处理结果，不会重新执行，也不会生成新的待执行任务。':'原对话仍在进行，结束后可以归档；需要继续处理时直接在对话中说明。';
  }catch(error){if(selectedEvent.id!==id||!$('recognitionDialog').open)return;$('recognitionError').textContent=error.message;$('recognitionResultState').textContent='处理结果暂未读取';$('recognitionResult').textContent='请稍后重新打开，或定位到聊天核对原对话。';}
}

async function loadPending(){const result=await api.post('capture/pending',{projectId,offset:pendingOffset});if(!result.events.length&&pendingOffset>0){pendingOffset=Math.max(0,pendingOffset-50);return loadPending();}renderSourceCards($('pendingList'),result.events,'<p class="hint">没有待确认消息。</p>');$('pendingPrevious').disabled=pendingOffset===0;$('pendingNext').disabled=result.events.length<50;$('pendingDialog').showModal();}
async function loadHistory(cursor){const threadId=$('historyThread').value;if(!threadId)throw Error('请选择本项目对话');const page=await api.post('capture/history',{projectId,threadId,cursor});historyPage=page;historyCursor=cursor;historyNext=page.nextCursor;$('historyMessages').innerHTML=page.messages.map(m=>`<label class="history-choice"><input type="checkbox" value="${esc(m.id)}"><span>${esc(m.text.slice(0,350))}<small>${esc(m.at??'时间不可用')} · ${esc(m.turnId)}</small></span></label>`).join('')||'<p class="hint">本页没有用户需求消息。</p>';$('historyOlder').disabled=!historyNext;}
export function initLineage(context){
  api=context;const filterWrap=document.createElement('section');filterWrap.id='compactTaskFilters';filterWrap.hidden=true;filterWrap.setAttribute('aria-label','排序筛选');$('taskFilters').before(filterWrap);filterWrap.append($('taskFilters'));$('lineageTools').innerHTML=`<div class="workflow-toolbar"><nav class="task-view-switch" aria-label="任务视图"><button id="chainViewButton" aria-pressed="false">任务链</button></nav><button id="filterToggle" class="heading-icon" aria-label="排序筛选" title="排序筛选" aria-controls="compactTaskFilters" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="10" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></svg></button><button id="captureSettingsButton" aria-controls="captureSetup" aria-expanded="false">历史导入</button></div><details id="captureSetup" class="capture-setup"><summary>历史导入</summary><p class="hint">手动选择需要整理的历史消息。</p><div class="compact-actions"><button id="openHistoryImport">选择历史消息</button></div></details><details id="pendingSources"><summary><span class="pending-source-label">待整理记录 <span id="pendingSourceCount">0</span></span><span class="pending-bulk-actions"><button type="button" id="dismissPendingSources" title="忽略当前项目全部不可归档的待整理记录">一键忽略</button><button type="button" id="archivePendingSources" title="归档当前项目全部可归档的待整理记录">一键归档</button></span></summary><p id="pendingBatchStatus" class="hint pending-bulk-status" role="status" hidden></p><div id="candidatePreviews"></div><button id="viewPending">查看全部待归档记录</button></details>`;
  $('settings').querySelector('.settings-body').append($('captureSettingsButton'),$('captureSetup'));
  document.querySelector('#projectView .heading-main').append(document.querySelector('.task-view-switch'));document.querySelector('#projectView .heading-actions').prepend($('filterToggle'));$('lineageTools').querySelector('.workflow-toolbar').remove();
  $('filterToggle').onclick=()=>{filterOpen=!filterOpen;api.render();};
  const tree=document.createElement('section');tree.id='taskChain';tree.setAttribute('aria-label','项目任务链');tree.hidden=true;$('board').before(tree);
  const host=document.createElement('div');host.innerHTML=`<dialog id="recognitionDialog" aria-labelledby="recognitionHeading"><div class="dialog-heading"><h2 id="recognitionHeading">归档已处理的问题</h2><button type="button" data-close="recognitionDialog" aria-label="关闭归档窗口">×</button></div><p id="recognitionRequest" class="source-request"></p><div id="recognitionImages"></div><button type="button" id="locateSourceChat">定位到聊天 ↗</button><section class="recognition-result" aria-live="polite"><h3>本次处理结果</h3><p id="recognitionResultState" class="hint"></p><pre id="recognitionResult"></pre></section><form id="recognitionForm"><section class="archive-destination"><h3>归档位置</h3><p id="archiveDestination"></p></section><p id="recognitionReason" class="hint"></p><p id="recognitionError" class="error" role="alert"></p><div class="compact-actions"><button type="button" id="dismissRecognition">忽略此消息</button><button type="submit" id="archiveSourceButton" class="primary">已处理，归档记录</button></div></form></dialog>
  <dialog id="historyDialog" aria-labelledby="historyHeading"><div class="dialog-heading"><h2 id="historyHeading">选择历史需求</h2><button data-close="historyDialog" aria-label="关闭历史导入">×</button></div><p class="hint">只导入勾选的用户消息，先进入待确认，不自动执行。</p><label>来源对话<select id="historyThread"></select></label><div class="compact-actions"><button id="loadHistory">读取最新历史</button><button id="historyOlder" disabled>读取更早一页</button></div><div id="historyMessages"></div><button id="importSelected" class="primary">导入所选消息</button></dialog>
  <dialog id="pendingDialog" aria-labelledby="pendingHeading"><div class="dialog-heading"><h2 id="pendingHeading">待整理记录</h2><button data-close="pendingDialog" aria-label="关闭待确认列表">×</button></div><div id="pendingList"></div><div class="compact-actions"><button id="pendingPrevious">上一页</button><button id="pendingNext">下一页</button></div></dialog>`;document.body.append(host);const imageDialog=document.createElement('dialog');imageDialog.id='sourceImageDialog';imageDialog.setAttribute('aria-label','需求截图大图');imageDialog.innerHTML='<button type="button" data-close="sourceImageDialog" aria-label="关闭截图">×</button><img alt="需求截图大图">';document.body.append(imageDialog);
  $('chainViewButton').onclick=async()=>{
    const address=location.href;
    try{await api.ensureChoices?.();if(location.href===address&&!$('board').hidden){view='chain';api.render();}}
    catch(error){api.notice(error.message,true);}
  };
  $('captureSettingsButton').onclick=()=>{$('captureSetup').open=!$('captureSetup').open;$('captureSettingsButton').setAttribute('aria-expanded',String($('captureSetup').open));};
  $('viewPending').onclick=()=>action(async()=>{pendingOffset=0;await loadPending();});$('pendingPrevious').onclick=()=>action(async()=>{pendingOffset=Math.max(0,pendingOffset-50);await loadPending();});$('pendingNext').onclick=()=>action(async()=>{pendingOffset+=50;await loadPending();});
  for(const [id,kind] of [['dismissPendingSources','dismiss'],['archivePendingSources','archive']])$(id).onclick=e=>{e.preventDefault();e.stopPropagation();void batchSources(kind);};
  $('openHistoryImport').onclick=()=>{const p=state.projects.find(p=>p.projectId===projectId),norm=s=>(s??'').replaceAll('/','\\').replace(/\\+$/,'').toLowerCase();$('historyThread').innerHTML='<option value="">选择本项目对话</option>'+state.threads.filter(t=>t.kind==='codex'&&t.hostId==='local'&&norm(t.cwd)===norm(p?.path)).map(t=>`<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('');$('historyMessages').innerHTML='';historyPage=null;historyCursor=historyNext=null;$('historyOlder').disabled=true;$('historyDialog').showModal();};
  $('historyThread').onchange=()=>{historyPage=null;historyCursor=historyNext=null;$('historyMessages').innerHTML='';$('historyOlder').disabled=true;};
  $('loadHistory').onclick=()=>action(()=>loadHistory(null));$('historyOlder').onclick=()=>action(()=>loadHistory(historyNext));
  $('importSelected').onclick=()=>action(async()=>{const ids=[...$('historyMessages').querySelectorAll('input:checked')].map(i=>i.value);if(!historyPage||!ids.length)throw Error('请先勾选要导入的消息');await api.post('capture/import',{projectId,threadId:$('historyThread').value,cursor:historyCursor,ids});$('historyDialog').close();api.notice('已导入待确认，尚未执行。');});
  $('locateSourceChat').onclick=async e=>{if(!selectedEvent||e.currentTarget.disabled)return;const button=e.currentTarget;button.disabled=true;try{await api.post('capture/open',{id:selectedEvent.id,projectId});$('recognitionDialog').close();}catch(error){$('recognitionError').textContent=error.message;}finally{button.disabled=false;}};
  $('recognitionForm').onsubmit=async e=>{e.preventDefault();if(sourceBatch||e.submitter.disabled)return;e.submitter.disabled=true;try{await api.post('capture/archive',{id:selectedEvent.id,projectId,handled:true});$('recognitionDialog').close();$('pendingDialog').close();await api.load();api.notice('已归档到版块历史，没有重新执行。');}catch(error){$('recognitionError').textContent=error.message;}finally{e.submitter.disabled=false;}};
  $('dismissRecognition').onclick=()=>!sourceBatch&&action(async()=>{await api.post('capture/correct',{id:selectedEvent.id,action:'dismiss'});$('recognitionDialog').close();$('pendingDialog').close();});
  document.addEventListener('click',e=>{
    const open=e.target.closest('[data-chain-open]');if(open)api.showDetail(open.dataset.chainOpen);
    const zoom=e.target.closest('[data-source-zoom]');if(zoom&&!zoom.disabled){$('sourceImageDialog').querySelector('img').src=zoom.querySelector('img').src;$('sourceImageDialog').showModal();}
    const archive=e.target.closest('[data-archive-source]');if(archive)void changeSource(archive,'archive');
    const dismiss=e.target.closest('[data-dismiss-source]');if(dismiss)void changeSource(dismiss,'dismiss');
    const review=e.target.closest('[data-review-source]'),card=e.target.closest('[data-source-card]');
    if(!sourceBatch&&(review||card&&!e.target.closest('button,a,input,select,textarea,summary')))action(()=>openRecognition(review?.dataset.reviewSource??card.dataset.sourceCard));
    const parent=e.target.closest('[data-parent-complete]');if(parent)action(()=>api.post('capture/task',{id:parent.dataset.parentComplete,action:'complete-parent'}));
    const plan=e.target.closest('[data-plan-ready]');if(plan)action(()=>api.post('capture/task',{id:plan.dataset.planReady,action:'plan-ready'}));
    const source=e.target.closest('[data-open-source]');if(source)action(()=>api.post('capture/open',{id:source.dataset.openSource,projectId}));
    const undo=e.target.closest('[data-undo-source]');if(undo)action(()=>api.post('capture/correct',{id:undo.dataset.undoSource,action:'undo'}));
    const load=e.target.closest('[data-load-sources]');if(load)action(async()=>{const response=await api.post('capture/sources',{id:load.dataset.loadSources,projectId});const target=$('taskSources-'+load.dataset.loadSources);if(target)target.innerHTML=response.events.map(event=>`<details class="source-record"><summary>${esc(event.source.threadTitle||'原对话')} · ${esc(event.status==='undone'?'已撤销':'需求来源')}</summary><p class="hint">${esc(event.source.at??event.at)} · 轮次 ${esc(event.source.turnId)}</p><p class="source-request">${esc(sourceView(event).text)}</p>${sourceImages(event)}<details><summary>查看完整原文</summary><pre>${esc(event.source.text)}</pre></details>${event.source.result?`<h4>该轮对话回复（不代表开发已验证）</h4><pre>${esc(event.source.result)}</pre>`:''}<p class="hint">${esc(event.suggestion.reason??'')}</p><div class="compact-actions"><button data-open-source="${esc(event.id)}">打开来源对话</button>${event.status==='linked'?`<button data-undo-source="${esc(event.id)}">撤销此识别</button>`:''}</div></details>`).join('')||'<p class="hint">此任务为手动创建，没有自动识别来源；编辑记录仍在操作历史中保留。</p>';if(target)void hydrateSourceImages(target);});
  });
  document.addEventListener('input',e=>{const form=e.target.closest('[data-chain-form],[data-delivery-form],[data-split-task],[data-merge-task]');if(form){if(form.dataset.splitTask)delete form.dataset.requestId;rememberForm(form,e.target.name);}});
  document.addEventListener('submit',e=>{
    const f=e.target;if(!f.matches('[data-chain-form],[data-delivery-form],[data-split-task],[data-merge-task]'))return;e.preventDefault();const data=new FormData(f);
    const body=f.dataset.chainForm?{id:f.dataset.chainForm,action:'links',parentId:data.get('parentId'),dependsOn:data.getAll('dependsOn'),kind:data.get('kind')}:f.dataset.deliveryForm?{id:f.dataset.deliveryForm,action:'delivery',codeVerified:data.has('codeVerified'),enabled:data.has('enabled')}:f.dataset.splitTask?{id:f.dataset.splitTask,action:'split',requestId:f.dataset.requestId??=crypto.randomUUID(),titles:String(data.get('titles')).split('\n').map(s=>s.trim()).filter(Boolean)}:{id:f.dataset.mergeTask,action:'merge',targetId:data.get('targetId')};
    const button=e.submitter,key=formKey(f);if(button.disabled||lineagePending.has(key))return;button.disabled=true;lineagePending.add(key);rememberForm(f);action(async()=>{try{await api.post('capture/task',body);lineageDrafts.delete(key);api.notice('任务链已更新。');}finally{lineagePending.delete(key);button.disabled=false;}});
  });
}
