import {randomBytes} from 'node:crypto';
import {normalize} from './core.mjs';

import {nativeRoute} from './plugins/leix-panel-probe/native-policy.mjs';
const threadWrites=new Set(('refresh bind open cancel threads/create threads/rename tasks/create tasks/update tasks/archive tasks/priority tasks/suggest tasks/execute tasks/send-current tasks/approve tasks/return-to-todo tasks/retry-review tasks/review-state tasks/resolve-uncertain tasks/restore-thread tasks/reconcile-delivery tasks/handoff tasks/cancel-handoff tasks/confirm-handoff tasks/restore-claimed automation/start automation/control attachments/upload attachments/read properties/change task-groups/change sections/save sections/route plans/command plans/begin plans/cancel plans/collect versions/command versions/begin versions/command/cancel versions/collect versions/inspect versions/save versions/delete versions/prepare capture/configure capture/scan capture/history capture/sources capture/event capture/task references/change capture/import capture/pending capture/open capture/correct capture/archive-preview capture/archive capture/image workflow/check workflow/preview workflow/acknowledge workflow/initialize projects/sync-current projects/sync-composer projects/sync-task composer/fill composer/send composer/submit service/check-update service/stage-update service/apply-update service/cancel-update service/backup-config service/data-location').split(' '));
function refuse(message='对话归属已变化或会话已过期，请重新打开调度台',status=409){throw Object.assign(Error(message),{status,notApplied:true});}
// Capabilities stay in the stdio adapter. Browser UI never receives the HTTP
// token/capability. Origin-bearing requests cannot establish/use this channel.
export class NativePanelSessions{
  constructor({catalog,state,identifyThread,now=Date.now,ttl=15*60*1000}){Object.assign(this,{catalog,state,identifyThread,now,ttl});this.sessions=new Map();}
  currentThread(catalog,threadId){
    const rows=catalog.threads.filter(t=>t.id===threadId);
    if(rows.length){if(rows.length!==1||rows[0].kind!=='codex'||rows[0].hostId!=='local')refuse('当前对话不在已核验的本机目录中');return rows[0];}
    // Display catalogs can omit indexed chats (including extended Windows cwd
    // values). Check only the exact host id, using index + rollout-header proof.
    // This is ownership metadata, never proof of idle or permission to send.
    let identity;try{identity=this.identifyThread?.(threadId);}catch{refuse('当前聊天的本机归属无法只读核验，请检查本机索引');}
    if(identity?.id!==threadId||identity.archived!==false||typeof identity.cwd!=='string'||!identity.cwd)refuse('当前对话不在已核验的本机目录中');
    return {id:threadId,cwd:identity.cwd,title:'当前聊天',kind:'codex',hostId:'local',status:'notLoaded'};
  }
  target(mode,threadId){
    const catalog=this.catalog(),state=this.state();
    if(catalog.connectionError||!catalog.lastSync)refuse('本机目录暂不可核验，请等待桌面连接恢复');
    if(mode==='global'){
      const project=catalog.projects.find(p=>p.projectId===state.workspace.controllerProjectId&&p.hostId==='local');
      if(!project)refuse('请先在原面板确认本机总控项目');
      return {projectId:project.projectId,threadId:'',path:normalize(project.path)};
    }
    if(mode!=='thread'||typeof threadId!=='string'||!/^[-a-zA-Z0-9]{1,100}$/.test(threadId))refuse('缺少宿主对话上下文');
    const thread=this.currentThread(catalog,threadId);
    const projects=catalog.projects.filter(p=>p.hostId==='local'&&normalize(p.path)===normalize(thread.cwd));
    if(projects.length!==1)refuse('当前对话的项目归属缺失或有歧义');
    return {projectId:projects[0].projectId,threadId,path:normalize(projects[0].path),thread:{...thread,cwd:projects[0].path}};
  }
  open(mode,threadId){
    const {thread,...target}=this.target(mode,threadId),capability=randomBytes(32).toString('hex');
    for(const [key,value] of this.sessions)if(value.expiresAt<=this.now())this.sessions.delete(key);
    if(this.sessions.size>=128)this.sessions.delete(this.sessions.keys().next().value);
    const session={...target,mode,expiresAt:this.now()+this.ttl};this.sessions.set(capability,session);
    return {...session,capability};
  }
  check(capability){
    const session=this.sessions.get(capability);if(!session||session.expiresAt<=this.now()){this.sessions.delete(capability);refuse();}
    const target=this.target(session.mode,session.threadId);
    if(target.projectId!==session.projectId||target.path!==session.path)refuse();
    return {...session,...(target.thread?{thread:target.thread}:{})};
  }
  request(session,method,address,body){
    const current=this.target(session.mode,session.threadId);
    if(current.projectId!==session.projectId||current.path!==session.path)refuse();
    const url=nativeRoute(method,address);
    if(session.mode==='global'){
      if(['/api/tasks/send-current','/api/projects/sync-current','/api/projects/sync-composer','/api/composer/fill','/api/composer/send','/api/composer/submit'].includes(url.pathname))refuse('请从所属对话侧栏操作');
      return;
    }
    if(method==='GET'){
      if(url.pathname==='/api/view/overview')refuse('请从全局入口打开总控',403);
      if(url.searchParams.get('scope')==='control')refuse('对话侧栏只允许所属项目范围',403);
      const projectId=url.searchParams.get('projectId');
      if(projectId&&projectId!==session.projectId)refuse('项目与当前对话不一致');
      return;
    }
    const route=url.pathname.slice(5);
    if(!threadWrites.has(route))refuse('此操作请从全局总控入口进行',403);
    if(route==='refresh'||route==='service/check-update'||route==='service/stage-update'||route==='service/apply-update'||route==='service/cancel-update'||route==='service/backup-config'||route==='service/data-location')return;
    if(!body||body.projectId!==session.projectId)refuse('项目与当前对话不一致');
    const state=this.state(),catalog=this.catalog();
    const threads=current.thread&&!catalog.threads.some(t=>t.id===current.thread.id)?[...catalog.threads,current.thread]:catalog.threads;
    const owners=[...state.tasks,...state.jobs,...state.automation.plans,...state.taskSections,...state.planIntakes,...state.versionIntakes,...state.versionRecords,...Object.values(state.attachments??{}),...Object.values(state.capture?.events??{})];
    const ids=new Set(),threadIds=new Set();
    const collect=(value,key='')=>{if(Array.isArray(value)){for(const v of value)collect(v,key);}else if(value&&typeof value==='object'){for(const [k,v] of Object.entries(value))collect(v,k);}else if(typeof value==='string'){if(/(^id$|Id$|Ids$|^ids$|^dependsOn$)/.test(key))ids.add(value);if(/threadIds?$/i.test(key)&&value)threadIds.add(value);}};
    collect(body);
    for(const row of owners)if(ids.has(row.id)&&(!row.projectId&&!row.path||row.projectId&&row.projectId!==session.projectId||!row.projectId&&normalize(row.path)!==session.path))refuse('操作内容包含其他项目或归属不明的记录');
    for(const thread of threads)if(ids.has(thread.id)&&(thread.hostId!=='local'||normalize(thread.cwd)!==session.path))refuse('目标对话不属于本机当前项目');
    for(const id of threadIds){const matches=threads.filter(t=>t.id===id);if(matches.length!==1||matches[0].kind!=='codex'||matches[0].hostId!=='local'||normalize(matches[0].cwd)!==session.path)refuse('目标对话缺失、归属不明或属于其他项目');}
    if(['tasks/send-current','projects/sync-current','projects/sync-composer','composer/fill','composer/send','composer/submit'].includes(route)&&body.threadId!==session.threadId)refuse('目标与宿主当前对话不一致');
  }
  context(session,pageUrl){return {status:'confirmed',matched:true,kind:session.mode==='thread'?'thread':'project',projectId:session.projectId,threadId:session.threadId,pageUrl};}
}
