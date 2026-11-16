import {archiveDestination,archiveSource} from './capture-archive.mjs';
import {isDirectSyncText} from './project-sync-direct.mjs';
import {presentSource,sourceTaskTitle,cleanSourcePrefix} from './source-display.mjs';
import {suggestTask} from './task-sections.mjs';
import {moduleKey} from './execution.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {normalize,summarize,readJobTurn} from './core.mjs';
import {createTask} from './board.mjs';
import {propertyGroups} from './properties.mjs';
import {openContinuation,roundIdOf,awaitsReply,goalContextText} from './public/rounds.js';

const now=()=>new Date().toISOString();
const hash=text=>createHash('sha256').update(text).digest('hex');
export function initCapture(state){state.capture??={projects:{},events:{},contexts:{},sequence:0};const c=state.capture;if(!c||typeof c!=='object'||['projects','events','contexts'].some(key=>!c[key]||typeof c[key]!=='object'||Array.isArray(c[key]))||!Number.isSafeInteger(c.sequence)||c.sequence<0)throw Error('对话识别数据格式异常，已停止加载以保留原数据');}
const kindLabels={feature:'新功能',bug:'Bug',improvement:'优化',analysis:'分析评审'};
const eventLog=(task,type,extra={})=>{task.updatedAt=now();task.history.push({id:randomUUID(),at:now(),type,status:task.status,...extra});};
function requestText(raw){
  raw=goalContextText(raw,{extractObjective:false});
  if(/^\s*<send_user_message_question_reply>/.test(raw))return '';
  if(raw.includes('## My request:'))raw=raw.split('## My request:').at(-1);
  else if(/^\s*(?:# AGENTS\.md|<environment_context>|<recommended_plugins>)/.test(raw))return '';
  return raw.replace(/<(in-app-browser-context|environment_context|recommended_plugins)[\s\S]*?<\/\1>/g,'').trim();
}
export function messages(thread,turns){
  const result=[];
  for(const turn of turns)for(const [index,item] of (turn.items??[]).filter(i=>i.type==='userMessage').entries()){
    if(item.type!=='userMessage')continue;
    if(typeof turn.id!=='string'||!turn.id)continue;
    const content=Array.isArray(item.content)?item.content:[],raw=typeof item.text==='string'?item.text:typeof item.content==='string'?item.content:content.filter(c=>c.type==='text'||c.type==='input_text').map(c=>c.text??'').join('\n');
    const text=requestText(raw);if(!text||isDirectSyncText(text)||/panel-run-|panel-module-ready|这是用户新建的项目专用执行对话/.test(text))continue;
    const id=hash([thread.id,turn.id,item.id??index].join('\0'));
    const stamp=item.createdAt??turn.createdAt??turn.startedAt,date=stamp===undefined?null:new Date(typeof stamp==='number'&&stamp<1e12?stamp*1000:stamp);
    const finalResult=(turn.items??[]).filter(i=>i.type==='agentMessage'&&['final','final_answer'].includes(i.phase)).map(i=>i.text??'').join('\n\n').slice(0,30000);
    result.push({id,threadId:thread.id,threadTitle:thread.title??'',turnId:turn.id,itemId:item.id??String(index),text:text.slice(0,30000),truncated:text.length>30000,hasAttachments:content.some(c=>/image|file/i.test(c.type)),at:date&&Number.isFinite(date.getTime())?date.toISOString():null,turnStatus:turn.status?.type??turn.status,result:summarize(turn).slice(0,30000),finalResult});
  }
  return result;
}
const commonWords=new Set(['新增','增加','添加','实现','开发','优化','改善','调整','功能','任务','模块','方案','讨论','分析','确认','实施','执行','整体','当前','需要','支持','进行','之后','然后','用户','建议','先讨论','流程','步骤','完成','验收']);
const words=text=>new Set([...new Intl.Segmenter('zh',{granularity:'word'}).segment(text.toLowerCase())].filter(s=>s.isWordLike&&s.segment.length>1&&!commonWords.has(s.segment)).map(s=>s.segment));
function similarity(a,b){const x=words(a),y=words(b);return [...x].filter(v=>y.has(v)).length/Math.max(1,Math.min(x.size,y.size));}
export function classify(source,tasks,contextId,context={}){
  const text=cleanSourcePrefix(source.text);
  const continuation=/^(?:你|请|那就|直接|赶紧|帮我)?(?:继续(?:执行|处理|修改|做)?|接着(?:执行|处理|修改|做)|执行|实施|做下去)(?:吧|啊|呀|哦|呢|就行|下去|起来)*[，,。！!\s]*(?:(?:别|不要)(?:停|停止|停下|断开|中断)(?:啊|呀|了|吧)*[。！!\s]*)?$/.test(text);
  if(continuation){
    const target=tasks.find(t=>t.id===contextId&&!t.archivedAt);
    return {kind:target?.recognitionType??'improvement',relation:target?(target.jobIds?.length?'observe':target.workflowStage==='discussion'||target.workflowStage==='confirmation'?'approve-plan':'supplement'):'new',targetId:target?.id??null,phase:'ready',candidate:!target||source.truncated||source.hasAttachments,confidence:target?'high':'low',reason:target?'同对话明确要求继续处理，沿用原卡片记录轮次':'继续指令缺少可靠的原任务关联，请确认'};
  }
  if(!source.truncated&&/^(可以执行|按.{0,12}方案执行|开始实施|就按.{0,12}方案|同意.{0,8}方案)/.test(text)&&!/[?？]|是否|能否|吗|先讨论|不要|暂不|不改代码/.test(text)){
    const refs=tasks.filter(t=>!t.archivedAt&&((t.shortId&&new RegExp('(?:^|[^A-Z0-9])'+t.shortId+'(?:$|[^0-9])','i').test(text))||(t.title.length>=5&&text.includes(t.title))));
    const target=refs.length===1?refs[0]:refs.length>1?null:tasks.find(t=>t.id===contextId&&!t.archivedAt);
    if(target&&['review','done'].includes(target.status))return {kind:target.recognitionType??'improvement',relation:'observe',targetId:target.id,phase:'ready',confidence:'high',reason:'明确继续原任务，追加执行轮次'};
    if(target?.status==='todo'&&['discussion','confirmation'].includes(target.workflowStage))return {kind:target.recognitionType??'feature',relation:'approve-plan',targetId:target.id,phase:'ready',confidence:'high',reason:'用户明确同意执行所关联任务的讨论方案'};
  }
  const discussion=/先.{0,8}(讨论|分析|评审|方案)|先别|暂不.{0,4}(执行|开发)|不.{0,2}(改代码|执行)|先看.{0,6}方案/.test(text);
  const signal=text.replace(/(?:bug|新功能|优化)(?:[、,，/\s]+(?:bug|新功能|优化))+/gi,'');
  const bug=/报错|崩溃|故障|失效|无法.{0,8}(上传|打开|保存|下载|执行)|不能.{0,8}(上传|打开|保存)|修复|异常|不生效/i.test(text)||(/\bbug\b/i.test(text)&&!/分类|标签|属性组|bug.{0,12}(新功能|优化)/i.test(text));
  const improvement=/优化|改善|调整|移到|移至|移动到|移动至|太复杂|还是.{0,8}不对|排版|版式|对齐|去掉|精简|改一下|改成|修改|太繁琐|易用|不拥挤|更清晰/.test(signal);
  const feature=/新增|增加|添加|实现|开发|功能|支持|建立/.test(text);
  const analysis=/分析|审查|审视|评审|方案|讨论|调查/.test(text);
  const kind=bug?'bug':improvement?'improvement':feature?'feature':'analysis';
  const independent=/另一个(?:问题|功能|任务)|独立(?:的)?(?:功能|任务)|新建.{0,4}(?:卡片|任务)|另建|作为子任务|拆成子任务/.test(text);
  const candidates=tasks.filter(t=>!t.archivedAt),explicit=candidates.filter(t=>new RegExp('(?:^|[^A-Z0-9])'+(t.shortId??t.id.slice(0,8))+'(?:$|[^A-Z0-9])','i').test(text)||(t.title.length>=5&&text.includes(t.title)));
  const contextTask=!independent?tasks.find(t=>t.id===contextId&&!t.archivedAt):null;
  if(context.anchored&&context.awaiting&&contextTask&&!discussion&&!source.truncated&&!source.hasAttachments&&contextTask.jobIds?.length&&(contextTask.status==='review'||contextTask.status==='todo'&&contextTask.pendingContinuation)&&!(explicit.length===1&&explicit[0].id!==contextTask.id))return {kind:contextTask.recognitionType??kind,relation:'observe',targetId:contextTask.id,phase:'ready',confidence:'high',reason:'当前任务在等待回复，本条回答继续当前轮次'};
  if(/^(好的?|收到|谢谢|明白|可以|已添加|已创建)[。！!\s]*$/.test(text))return {ignore:true};
  if(!bug&&!improvement&&!feature&&!analysis&&/[?？]|吗[。！!\s]*$/.test(text))return {ignore:true,reason:'咨询消息，不作为开发任务'};
  if(!bug&&!improvement&&!feature&&!analysis&&!/执行|实施|完成|修改|补充|改成|再把|上个|刚才/.test(text))return {candidate:true,kind:'analysis',relation:'new',phase:'confirmation',confidence:'low',reason:'未识别到足够明确的工作指令，需确认是否建卡'};
  if(!source.truncated&&!independent&&explicit.length===1&&['todo','running','review','done'].includes(explicit[0].status)&&/执行|实施|完成|实现|修复|修改/.test(text)&&!discussion&&!/[?？]|是否|不要|暂不|吗[。！!\s]*$/.test(text)&&['inProgress','running','completed','failed','interrupted'].includes(source.turnStatus))return {kind,relation:'observe',targetId:explicit[0].id,phase:'ready',confidence:'high',reason:'明确引用已有任务，记录原对话执行，不重复建卡'};
  const followup=/刚才|上轮|上个|这个(?:任务|问题)|这项|还是|仍然|依然|继续.{0,6}(任务|修改|处理|调整|执行)|接着.{0,6}(修改|处理|调整)|再把|再加|再.{0,3}(调整|修改)|补充|改成|之前/.test(text);
  let target=independent?null:explicit.length===1?explicit[0]:followup?candidates.find(t=>t.id===contextId):null;
  const ranked=candidates.map(t=>({t,score:similarity(text,t.title+' '+(t.description??'').slice(0,500))})).filter(r=>r.score>=.45).sort((a,b)=>b.score-a.score);
  let ambiguous=explicit.length>1;
  if(!independent&&!target&&ranked.length){target=ranked[0].t;ambiguous=true;}
  const relation=target?(target.jobIds?.length||['review','done'].includes(target.status)?'observe':'supplement'):'new';
  const uncertain=source.truncated||(source.hasAttachments&&!(text.length>=24&&/修复|修改|调整|实现|对齐|去掉|增加|新增|开发/.test(text)))||ambiguous||/可不可以|是否|能否|能不能|可以.*吗|[?？]\s*$|不要.{0,4}(新增|添加|实现|开发|修改|优化)|不需要.{0,4}(增加|新增|开发|实现)/.test(text)||(followup&&!target&&!independent)||(target&&relation==='supplement'&&target.status!=='todo');
  return {kind,relation,targetId:target?.id??null,candidate:!!uncertain,phase:discussion||(!feature&&!bug&&!improvement)?'discussion':'ready',confidence:uncertain?'low':'high',reason:source.truncated?'消息过长，需查看原文后确认':source.hasAttachments&&uncertain?'消息带有图片或文件，需打开原对话核对内容':ambiguous?'找到可能相关任务，未自动合并':target?`依据${explicit.length===1?'明确任务引用':'同对话的明确补充语句'}关联 ${target.shortId??target.title}`:`识别为${kindLabels[kind]}${discussion?'，用户要求先讨论':''}${uncertain?'；含提问、否定或不明确指代，需人工确认':''}`};
}
const titleOf=sourceTaskTitle;
function taskInput(state,projectId,kind,title,description){
  const type=propertyGroups(state,projectId).find(g=>g.id==='type'&&!g.archived),option=type?.options.find(o=>o.id===kind&&!o.archived);
  const suggestion=suggestTask(state,projectId,{title,description},kind);
  return {projectId,title,description,...(suggestion.sectionId?{sectionId:suggestion.sectionId}:{}),priority:suggestion.priority,typeName:suggestion.typeName,execution:{mode:'match',unit:suggestion.sectionName||title.replace(/[\x00-\x1f]/g,' ').slice(0,80),parallel:false,threadId:''},attributeIds:option?{type:option.id}:{},requestId:randomUUID()};
}
function linkedTask(state,id,projectId){const task=state.tasks.find(t=>t.id===id&&t.projectId===projectId&&!t.archivedAt);if(!task)throw Error('关联任务不存在或不属于本项目');return task;}
function checkCycle(state,task,parentId,dependsOn){
  const edges=t=>[t.id===task.id?parentId:t.parentId,...(t.id===task.id?dependsOn:t.dependsOn??[])].filter(Boolean),visited=new Set(),active=new Set();
  const walk=id=>{if(active.has(id))throw Error('任务关系形成循环，请调整父任务或依赖');if(visited.has(id))return;active.add(id);const t=state.tasks.find(t=>t.id===id);if(t)for(const next of edges(t))walk(next);active.delete(id);visited.add(id);};
  walk(task.id);
}
function observe(state,task,event){
  const s=event.source;if(event.suggestion.phase!=='ready'||!['inProgress','running','completed','failed','interrupted'].includes(s.turnStatus))return;
  const duplicate=state.jobs.find(j=>j.taskId===task.id&&j.threadId===s.threadId&&j.turnId===s.turnId);if(duplicate)return;
  if((task.syncReserved&&!(task.syncReservationConfirmed&&['review','done'].includes(task.status)))||state.jobs.some(j=>j.taskId===task.id&&['queued','sending','submitted','running','uncertain'].includes(j.status)))throw Error('已有任务仍在执行或已领取，请核对后关联，未覆盖');
  const previous=state.jobs.find(j=>j.id===task.currentJobId),reopening=['review','done'].includes(task.status);
  if(reopening&&event.suggestion.confidence!=='confirmed'){
    const stamp=Date.parse(s.at),boundary=Date.parse(task.completedAt??previous?.createdAt);
    if(!Number.isFinite(stamp)||!Number.isFinite(boundary)||stamp<boundary)throw Error('无法确认这是原卡片之后的新轮次，请核对来源时间后关联');
  }
  const priorStatus=task.status,priorCompletedAt=task.completedAt,priorDelivery=task.delivery?structuredClone(task.delivery):null;
  const status=s.turnStatus==='completed'?'completed':['failed','interrupted'].includes(s.turnStatus)?s.turnStatus:'running';
  const job={id:randomUUID(),origin:'observed',taskId:task.id,projectId:task.projectId,path:task.path,project:task.project,title:s.threadTitle,threadId:s.threadId,turnId:s.turnId,prompt:s.text,result:status==='running'?'':s.finalResult??s.result??'',status,createdAt:s.at??now(),message:'观察到原对话的用户轮次；不是面板发送回执'};
  const continuation=openContinuation(state,task);
  job.roundId=continuation?roundIdOf(continuation):job.id;job.inputKind='answer';
  if(continuation)job.continuedFromJobId=continuation.id;
  job.finalResult=job.result;job.awaitingUser=status==='completed'&&awaitsReply(job.finalResult);
  state.jobs.push(job);task.jobIds.push(job.id);
  const unit=state.taskSections?.find(v=>v.id===task.sectionId)?.name??task.execution?.unit;
  if(unit){
    state.automation??={plans:[],routes:{}};
    const key=moduleKey(task),routes=state.automation.routes;
    if(!routes[key]&&!Object.values(routes).some(r=>r.threadId===s.threadId&&r.key!==key)){
      routes[key]={key,projectId:task.projectId,path:task.path,sectionId:task.sectionId??null,unit,threadId:s.threadId,status:'ready',source:'observed'};
    }
  }
  task.currentJobId=job.id;task.status=status==='running'?'running':'review';task.workflowStage='ready';delete task.completedAt;delete task.historyOnly;delete task.pendingContinuation;
  if(reopening){task.delivery={codeVerified:false,enabled:false};eventLog(task,continuation?'round-continued':'round-added',{jobId:job.id,sourceId:event.id,previousStatus:priorStatus,previousCompletedAt:priorCompletedAt,previousDelivery:priorDelivery});}
  eventLog(task,'observed',{jobId:job.id,threadId:s.threadId});
}
export function applyRecognition(state,event,projects,choice=event.suggestion){
  if(event.status!=='candidate'&&event.status!=='pending')throw Error('此消息已经处理，不能重复创建');
  const projectId=event.projectId,target=choice.targetId?linkedTask(state,choice.targetId,projectId):null;
  if(!Object.hasOwn(kindLabels,choice.kind)||!['new','supplement','revise','repair','child','depends','approve-plan','observe'].includes(choice.relation))throw Error('请选择有效的类型和关联方式');
  if(choice.relation!=='new'&&!target)throw Error('请选择关联任务');
  let task;
  if(choice.relation==='observe'){
    task=target;const before=task.jobIds.length;observe(state,task,{...event,suggestion:choice});if(task.jobIds.length===before)eventLog(task,'round-note',{sourceId:event.id,note:event.source.text});
  }else if(choice.relation==='approve-plan'){
    if(target.status!=='todo'||target.syncReserved)throw Error('任务已经执行或已领取，不能重复确认');task=target;event.undo={kind:'plan',beforeStage:task.workflowStage};task.workflowStage='ready';eventLog(task,'plan-confirmed',{sourceId:event.id});observe(state,task,{...event,suggestion:choice});
  }else if(choice.relation==='supplement'||choice.relation==='revise'){
    if(target.status!=='todo'||target.syncReserved)throw Error('任务已执行或已领取，请创建关联子任务保留本轮边界');
    task=target;const before=task.description;
    const next=choice.relation==='revise'?event.source.text:before+'\n\n补充需求：\n'+event.source.text;if(next.length>30000)throw Error('合并后的任务说明超过 30,000 字符，请拆成子任务');
    if(['inProgress','running','completed','failed','interrupted'].includes(event.source.turnStatus)&&choice.phase==='ready')observe(state,task,{...event,suggestion:choice});
    task.description=next;event.undo={taskId:task.id,before,after:next};eventLog(task,'requirement-added',{sourceId:event.id,before:{description:before},after:{description:next}});
  }else{
    task=createTask(state,taskInput(state,projectId,choice.kind,choice.title?.trim()||titleOf(event.source.text),event.source.text),projects).task;
    task.shortId='T'+String(++state.capture.sequence).padStart(4,'0');task.workflowStage=choice.phase==='discussion'?'discussion':'ready';task.delivery={codeVerified:false,enabled:false};task.recognitionType=choice.kind;task.sourceKind='conversation';task.summary=kindLabels[choice.kind]+' · '+(task.workflowStage==='discussion'?'先讨论方案，确认后实施':'原始需求与对话来源已记录');
    if(choice.relation==='repair'||choice.relation==='child')task.parentId=target.id;
    if(choice.relation==='depends')task.dependsOn=[target.id];
    task.relation=choice.relation;event.createdTaskId=task.id;
    observe(state,task,{...event,suggestion:choice});
  }
  task.sourceIds??=[];if(!task.sourceIds.includes(event.id))task.sourceIds.push(event.id);
  event.status='linked';event.taskId=task.id;event.suggestion={...choice};event.processedAt=now();state.capture.contexts[event.source.threadId]=task.id;
  return task;
}
// Panel prompts are deliberately excluded from messages(). Use their verified
// execution records as context, so a direct reply can still continue that card.
function sourceContext(state,projectId,source){
  const tasks=new Map(state.tasks.filter(t=>t.projectId===projectId).map(t=>[t.id,t])),stamp=Date.parse(source.at);
  const asks=awaitsReply;
  const records=state.jobs.filter(j=>{const task=tasks.get(j.taskId);return j.projectId===projectId&&j.threadId===source.threadId&&j.origin!=='archive'&&task?.jobIds?.includes(j.id)&&normalize(task.path)===normalize(j.path);});
  const jobs=records.filter(j=>j.turnId);
  const exact=jobs.filter(j=>j.turnId===source.turnId),exactIds=[...new Set(exact.map(j=>j.taskId))];
  if(exact.length)return {taskId:exactIds.length===1?exactIds[0]:null,anchored:exactIds.length===1,awaiting:exactIds.length===1&&(exact[0].awaitingUser??asks(exact[0].finalResult??exact[0].result))};
  const anchors=jobs.map(j=>({taskId:j.taskId,at:Date.parse(j.sentAt??j.createdAt),awaiting:j.awaitingUser??asks(j.finalResult??j.result)}));
  // An unassociated send is a barrier, never permission to reuse an older card.
  for(const job of records)if(!job.turnId&&['sending','submitted','running','uncertain'].includes(job.status))anchors.push({taskId:null,at:Date.parse(job.sentAt??job.createdAt),awaiting:false});
  for(const event of Object.values(state.capture.events))if(event.projectId===projectId&&event.status==='linked'&&event.source.threadId===source.threadId)anchors.push({taskId:event.taskId,at:Date.parse(event.source.at),awaiting:asks(event.source.finalResult??event.source.result)});
  const prior=anchors.filter(a=>Number.isFinite(a.at)&&a.at<=stamp).sort((a,b)=>b.at-a.at);
  if(prior.length){const ids=new Set(prior.filter(a=>a.at===prior[0].at).map(a=>a.taskId));return {taskId:ids.size===1?prior[0].taskId:null,anchored:ids.size===1&&prior[0].taskId!=null,awaiting:ids.size===1&&prior[0].taskId!=null?!!prior[0].awaiting:false};}
  // A chronological gap must not fall back to a newer card in this module.
  if(Number.isFinite(stamp)&&anchors.some(a=>Number.isFinite(a.at)))return {taskId:null,anchored:false,awaiting:false};
  return {taskId:state.capture.contexts[source.threadId]??null,anchored:false,awaiting:false};
}
export function ingest(state,projectId,source,projects,{forceCandidate=false}={}){
  initCapture(state);if(state.capture.events[source.id])return state.capture.events[source.id];
  state.capture.projects[projectId]??={enabled:false,threads:{},error:''};
  if(Object.keys(state.capture.events).length>=5000)throw Error('识别记录达到 5000 条，已停止新增，请先整理记录');
  const context=sourceContext(state,projectId,source),suggestion=classify(source,state.tasks.filter(t=>t.projectId===projectId),context.taskId,context);
  if(!state.workspace?.mappings?.[projectId]){forceCandidate=true;suggestion.reason='当前项目尚未绑定逻辑身份，请核对项目归属后确认';}
  const event={id:source.id,projectId,source,suggestion,status:suggestion.ignore?'ignored':'candidate',at:now()};state.capture.events[event.id]=event;
  if(!suggestion.ignore&&!suggestion.candidate&&!forceCandidate){try{applyRecognition(state,event,projects);}catch(error){event.status='candidate';event.suggestion={...suggestion,candidate:true,reason:error.message};}}
  return event;
}
export function correctRecognition(state,input,projects){
  initCapture(state);const event=state.capture.events[input.id];if(!event)throw Error('识别记录不存在');
  if(input.action==='dismiss'){if(event.status!=='candidate')throw Error('只能忽略待确认消息');event.status='dismissed';return {event};}
  if(input.action==='confirm')return {task:applyRecognition(state,event,projects,{...event.suggestion,...input.choice,candidate:false,confidence:'confirmed',reason:'用户确认或修正识别结果'})};
  if(input.action==='undo'){
    if(event.status!=='linked')throw Error('此识别没有可撤销的关联');
    const task=state.tasks.find(t=>t.id===event.taskId);
    if(event.createdTaskId){if(task.sourceIds?.length>1||state.tasks.some(t=>t.parentId===task.id||t.dependsOn?.includes(task.id)))throw Error('已有后续关联，请先调整任务关系');if(state.jobs.some(j=>j.taskId===task.id&&j.origin!=='observed'))throw Error('任务已有面板执行，不能撤销建卡');task.archivedAt=now();task.captureCancelled=true;}
    else{if(event.undo?.kind==='plan'){if(task.status!=='todo'||task.jobIds.length)throw Error('已有执行，不能撤销方案确认');task.workflowStage=event.undo.beforeStage;}else{if(!event.undo||task.description!==event.undo.after||task.status!=='todo')throw Error('已有后续修改或执行，不能自动撤销；请编辑任务核对');task.description=event.undo.before;}task.sourceIds=task.sourceIds.filter(id=>id!==event.id);}
    eventLog(task,'recognition-undone',{sourceId:event.id});event.status='undone';return {event};
  }
  throw Error('识别操作无效');
}
export function changeTaskChain(state,input,projects){
  const task=state.tasks.find(t=>t.id===input.id&&!t.archivedAt);if(!task)throw Error('任务不存在');
  const check=id=>linkedTask(state,id,task.projectId);
  if(input.action==='links'){
    const parentId=input.parentId||null,dependsOn=input.dependsOn??[];if(!Array.isArray(dependsOn)||dependsOn.length>20||new Set(dependsOn).size!==dependsOn.length)throw Error('依赖列表无效');
    if(task.pendingParentId&&!parentId)throw Error('父任务尚未在本机接续，请先接收或明确选择父任务');if(parentId)check(parentId);for(const id of dependsOn)check(id);checkCycle(state,task,parentId,dependsOn);
    eventLog(task,'links-changed',{before:{parentId:task.parentId,dependsOn:task.dependsOn},after:{parentId,dependsOn}});task.parentId=parentId;delete task.pendingParentId;task.dependsOn=dependsOn;
    if(input.kind){if(!Object.hasOwn(kindLabels,input.kind))throw Error('任务类型无效');task.recognitionType=input.kind;const inputFields=taskInput(state,task.projectId,input.kind,'','');const option=propertyGroups(state,task.projectId).find(g=>g.id==='type')?.options.find(o=>o.id===inputFields.attributeIds.type);task.attributes=[...(task.attributes??[]).filter(a=>a.groupId!=='type'),...(option?[{groupId:'type',groupName:'任务类型',optionId:option.id,name:option.name}]:[])];task.tag=option?.id??'none';}
  }else if(input.action==='plan-ready'){
    if(task.status!=='todo')throw Error('仅未执行任务可以确认方案');task.workflowStage='ready';eventLog(task,'plan-confirmed');
  }else if(input.action==='delivery'){
    if(typeof input.codeVerified!=='boolean'||typeof input.enabled!=='boolean')throw Error('请明确核对交付状态');task.delivery={codeVerified:input.codeVerified,enabled:input.enabled};eventLog(task,'delivery-confirmed',{...task.delivery});
  }else if(input.action==='complete-parent'){
    const children=state.tasks.filter(t=>t.parentId===task.id&&!t.archivedAt);if(task.status!=='todo'||task.jobIds.length||!children.length||children.some(t=>t.status!=='done'))throw Error('仅无独立执行且子任务全部验收的主任务可以确认完成');if((task.dependsOn??[]).some(id=>state.tasks.find(t=>t.id===id)?.status!=='done'))throw Error('请先完成前置任务');task.status='done';task.completedAt=now();eventLog(task,'parent-approved',{childIds:children.map(t=>t.id)});
  }else if(input.action==='split'){
    const titles=input.titles;if(!Array.isArray(titles)||!titles.length||titles.length>10||titles.some(t=>typeof t!=='string'||!t.trim()||t.length>200))throw Error('每次拆分 1–10 项，每个标题最多 200 字符');
    if(input.requestId){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId))throw Error('拆分请求标识无效');const signature=JSON.stringify(titles);task.chainRequests??={};if(task.chainRequests[input.requestId]){if(task.chainRequests[input.requestId]!==signature)throw Error('拆分请求已用于不同内容');return {task,duplicate:true};}task.chainRequests[input.requestId]=signature;}
    for(const title of titles){const input=taskInput(state,task.projectId,task.recognitionType??(kindLabels[task.tag]?task.tag:'feature'),title.trim(),'父任务：'+task.title+'\n本子任务范围：'+title.trim()+'\n\n原需求：\n'+task.description);input.priority=task.priority??2;input.attachmentIds=(task.attachments??[]).map(f=>f.id);const child=createTask(state,input,projects).task;child.parentId=task.id;child.workflowStage=task.workflowStage??'ready';child.shortId='T'+String(++state.capture.sequence).padStart(4,'0');eventLog(task,'task-split',{childId:child.id,title});}
  }else if(input.action==='merge'){
    const target=check(input.targetId);if(target.id===task.id||task.status!=='todo'||target.status!=='todo'||task.syncReserved||target.syncReserved||task.jobIds.length||target.jobIds.length)throw Error('仅两个未执行、未领取的不同任务可以合并');
    if(state.tasks.some(t=>[task.id,target.id].includes(t.parentId)||t.dependsOn?.some(id=>[task.id,target.id].includes(id)))||task.parentId||target.parentId||task.dependsOn?.length||target.dependsOn?.length)throw Error('任务已有关系，请先调整父子或依赖关系再合并');
    const next=target.description+'\n\n合并任务：'+task.title+'\n'+task.description;if(next.length>30000)throw Error('合并说明过长，请改用父子任务');
    eventLog(target,'task-merged',{sourceTaskId:task.id,before:{description:target.description},after:{description:next}});target.description=next;target.sourceIds=[...new Set([...(target.sourceIds??[]),...(task.sourceIds??[])])];task.mergedInto=target.id;task.archivedAt=now();eventLog(task,'merged-into',{targetId:target.id});
  }else throw Error('任务链操作无效');
  return {task};
}
export function chainExecutionReason(state,task){
  if(['discussion','confirmation'].includes(task.workflowStage))return '请先确认方案，再手动执行';
  for(const id of task.dependsOn??[]){const dependency=state.tasks.find(t=>t.id===id);if(!dependency||dependency.status!=='done')return '前置任务尚未审阅通过，请先完成依赖';}
  return '';
}
export function captureSnapshot(state){
  const projects=Object.fromEntries(Object.entries(state.capture.projects).map(([id,c])=>[id,{enabled:c.enabled,enabledAt:c.enabledAt,lastScan:c.lastScan,error:Object.values(c.errors??{}).join('；')||c.error||'',monitoredCount:Object.keys(c.threads??{}).length,pending:Object.values(state.capture.events).filter(e=>e.projectId===id&&e.status==='candidate').length}]));
  const events=Object.values(state.capture.events).filter(e=>e.status==='candidate').slice(-200).map(e=>{const view=presentSource(e);return {...view,source:{...view.source,text:e.source.text.slice(0,400),result:undefined,presentation:{...view.source.presentation,text:view.source.presentation.text.slice(0,1000)}}};});
  return {projects,events,totalPending:Object.values(state.capture.events).filter(e=>e.status==='candidate').length,mode:'manual-history'};
}

export class ConversationCapture{
  constructor({getState,getCatalog,mutate,read}){Object.assign(this,{getState,getCatalog,mutate,read});}
  threads(project){return this.getCatalog().threads.filter(t=>t.kind==='codex'&&t.hostId==='local'&&normalize(t.cwd)===normalize(project.path));}
  project(id){const p=this.getCatalog().projects.find(p=>p.projectId===id);if(!p)throw Error('项目不存在');return p;}
  validate(response,thread,project){if(response.thread?.id!==thread.id||response.thread.kind!=='codex'||response.thread.hostId!=='local'||normalize(response.thread.cwd)!==normalize(project.path))throw Error('对话归属核对失败，未读取为本项目任务');}
  configure({projectId,enabled}){
    this.project(projectId);if(typeof enabled!=='boolean')throw Error('请指定是否启用');
    return {enabled:false};
  }
  async archiveSourceRecord(input){
    const event=this.getState().capture.events[input.id],project=this.project(input.projectId);
    if(!event||event.projectId!==project.projectId)throw Error('来源不存在或不属于本项目');
    const thread={id:event.source.threadId};
    const found=await readJobTurn(async(id,cursor)=>{const response=await this.read(id,cursor);this.validate(response,thread,project);return response;},{threadId:thread.id,turnId:event.source.turnId});
    if(!found.turn)throw Error('尚未找到原轮次，请打开原对话核对');
    const rows=messages(thread,[found.turn]),same=rows.filter(s=>s.text===event.source.text);
    const source=rows.find(s=>s.id===event.source.id)??(same.length===1?same[0]:null);
    if(!source||source.text!==event.source.text)throw Error('原消息已变化，请刷新核对后归档');
    return {...event.source,...source,id:event.source.id,itemId:event.source.itemId,threadTitle:event.source.threadTitle};
  }
  async archivePreview(input){
    const source=await this.archiveSourceRecord(input),event=this.getState().capture.events[input.id];
    return {...archiveDestination(this.getState(),event,source),canArchive:['completed','failed','interrupted'].includes(source.turnStatus),source};
  }
  async archive(input){
    const event=this.getState().capture.events[input.id];
    if(event?.projectId===input.projectId&&event.status==='archived')return {duplicate:true,archive:event.archive};
    if(input.handled!==true)throw Error('请确认这条历史需求已经处理');
    const source=await this.archiveSourceRecord(input);
    return await this.mutate(state=>archiveSource(state,input,source,this.getCatalog().projects));
  }
  async history(projectId,threadId,cursor){const project=this.project(projectId),thread=this.threads(project).find(t=>t.id===threadId);if(!thread)throw Error('请选择当前项目的可用对话');const response=await this.read(threadId,cursor);this.validate(response,thread,project);return {messages:messages(thread,response.turns??[]),nextCursor:response.page?.nextCursor??null};}
  async import(input){
    if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>30)throw Error('请选择 1–30 条历史消息');
    const page=await this.history(input.projectId,input.threadId,input.cursor);const selected=page.messages.filter(m=>input.ids.includes(m.id));if(selected.length!==input.ids.length)throw Error('历史页面已变化，请重新读取后选择');
    return await this.mutate(state=>({events:selected.reverse().map(source=>ingest(state,input.projectId,source,this.getCatalog().projects,{forceCandidate:true}))}));
  }
}
