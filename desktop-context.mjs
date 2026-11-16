import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalize} from './core.mjs';
import {WindowsContextReader} from './desktop-context-reader.mjs';

const script=fileURLToPath(new URL('./scripts/read-desktop-context.ps1',import.meta.url));
const unreadableReason='暂时无法读取当前聊天，请切回 Codex 后重试';
const unresolved=(matched=true,reason=unreadableReason,retryable=false)=>({status:'unresolved',matched,reason,...(retryable?{retryableContext:true}:{})});
export function contextPage(value,origin){
  if(typeof value!=='string'||value.length>2000)throw Error('无效的面板上下文地址');
  const url=new URL(value);
  if(url.origin!==origin||url.pathname!=='/'||!/^[-a-zA-Z0-9]{20,80}$/.test(url.searchParams.get('panelSession')??''))throw Error('无效的面板上下文地址');
  return url.href;
}
export function resolveDesktopContext(observation,catalog){
  if(observation?.status==='outside'&&observation.matched===false)return {status:'outside',matched:false};
  if(observation?.status!=='observed'||observation.matched!==true){
    const reason=typeof observation?.reason==='string'?observation.reason.slice(0,200):unreadableReason;
    return unresolved(true,reason,observation?.retryableContext===true&&reason===unreadableReason);
  }
  const local=catalog.projects.filter(p=>p.path&&p.hostId==='local');
  const labels=observation.draftLabels,owners=observation.ownerLabels??[];
  if(!Array.isArray(labels)||labels.some(label=>typeof label!=='string')||!Array.isArray(owners)||owners.some(label=>typeof label!=='string'))return unresolved();
  if(labels.length){
    const projects=local.filter(p=>labels.includes(p.label));
    if(labels.length!==1||projects.length!==1)return unresolved(true,'新对话的项目尚未唯一确认，请先在聊天中选择项目');
    return {status:'confirmed',matched:true,kind:'draft',projectId:projects[0].projectId,threadId:''};
  }
  if(typeof observation.title!=='string'||!observation.title)return unresolved();
  const ownedProjects=owners.length?local.filter(p=>owners.includes(p.label)):[];
  if(owners.length&&(owners.length!==1||ownedProjects.length!==1))return unresolved(true,'当前项目名称不唯一或尚未同步，请核对项目选择');
  // Newly created module chats may have no saved desktop name even while the
  // sidebar shows the requested module name. Only a validated ready route for
  // this exact local thread/project can supply that missing display name.
  const hasTitle=thread=>thread.title===observation.title||
    (!thread.title||thread.title===thread.id)&&(catalog.contextRoutes??[]).some(route=>
      route.status==='ready'&&route.threadId===thread.id&&route.unit===observation.title&&
      normalize(route.path)===normalize(thread.cwd)&&local.some(project=>
        project.projectId===route.projectId&&normalize(project.path)===normalize(route.path)));
  const namedThreads=catalog.threads.filter(t=>hasTitle(t)&&t.kind==='codex'&&t.hostId==='local');
  const threads=namedThreads.filter(t=>!owners.length||normalize(t.cwd)===normalize(ownedProjects[0].path));
  if(owners.length&&!threads.length&&namedThreads.length)return unresolved(true,'当前聊天目录与原生项目不一致');
  // Native ownership can confirm the board before the chat enters the catalog.
  // Same-project names identify a board, but never select an arbitrary thread.
  if(threads.length!==1){
    const candidates=owners.length?ownedProjects:local.filter(p=>threads.length&&threads.every(t=>normalize(t.cwd)===normalize(p.path)));
    if(candidates.length===1&&local.filter(p=>normalize(p.path)===normalize(candidates[0].path)).length===1)return {status:'confirmed',matched:true,kind:'project',projectId:candidates[0].projectId,threadId:''};
    return unresolved(true,threads.length?'当前聊天所属项目尚未唯一确认':'当前聊天尚未识别');
  }
  const projects=local.filter(p=>normalize(p.path)===normalize(threads[0].cwd));
  if(projects.length!==1)return unresolved(true,'当前聊天目录无法唯一关联项目，请核对项目选择');
  return {status:'confirmed',matched:true,kind:'thread',projectId:projects[0].projectId,threadId:threads[0].id};
}
export function contextWriteAllowed(context,pageUrl,{required=false,projectId,threadId}={}){
  if(context.status==='outside'&&context.matched===false)return !required;
  const page=new URL(pageUrl);
  return context.status==='confirmed'&&context.matched===true&&context.pageUrl===pageUrl&&
    ((['draft','project'].includes(context.kind)&&context.threadId==='')||(context.kind==='thread'&&typeof context.threadId==='string'&&/^[-a-zA-Z0-9]{1,100}$/.test(context.threadId)))&&
    context.projectId===page.searchParams.get('projectId')&&context.threadId===(page.searchParams.get('threadId')??'')&&
    (!projectId||projectId===context.projectId)&&(threadId===undefined||threadId===context.threadId);
}
export function readWindowsContext(input,{timeoutMs=5000}={}){
  if(process.platform!=='win32')return Promise.resolve({status:'outside',matched:false});
  return new Promise(resolve=>{
    let done=false,output='';
    const child=spawn('pwsh.exe',['-NoProfile','-NonInteractive','-STA','-File',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(unresolved());},timeoutMs);
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>16384){child.kill();finish(unresolved());}});
    child.stderr.resume();child.stdin.on('error',()=>{});
    child.on('error',()=>finish(unresolved()));
    child.on('close',()=>{try{finish(JSON.parse(output.trim()));}catch{finish(unresolved());}});
    child.stdin.end(JSON.stringify(input));
  });
}
// Requests from visible pages drive detection; no independent desktop monitor.
// Concurrent pages share one fresh visible-window snapshot, never another
// page's identity or a cached completed observation.
export function snapshotObservation(snapshot,pageUrl){
  if(snapshot?.status==='unresolved'&&snapshot.matched===true)return {status:'unresolved',matched:true,...(typeof snapshot.reason==='string'?{reason:snapshot.reason.slice(0,200)}:{}),...(snapshot.retryableContext===true?{retryableContext:true}:{})};
  if(snapshot?.status!=='snapshot'||!Array.isArray(snapshot.observations))return unresolved();
  const matching=snapshot.observations.filter(row=>row?.pageUrl===pageUrl||samePanelSession(row?.pageUrl,pageUrl));
  return matching.length===1?matching[0]:matching.length?unresolved(true,'同一侧栏地址出现在多个窗口，请核对当前窗口'):{status:'outside',matched:false};
}
export function samePanelSession(a,b){try{const left=new URL(a),right=new URL(b),session=left.searchParams.get('panelSession');return !!session&&/^[-a-zA-Z0-9]{20,80}$/.test(session)&&left.origin===right.origin&&left.pathname==='/'&&right.pathname==='/'&&session===right.searchParams.get('panelSession');}catch{return false;}}
export class DesktopContext {
  constructor({origin,getCatalog,read,readSnapshot,reader,lookupThreads,rememberThreads}){this.reader=reader??(!read&&!readSnapshot?new WindowsContextReader():null);Object.assign(this,{origin,getCatalog,read,lookupThreads,rememberThreads,readSnapshot:readSnapshot??(this.reader?(input=>this.reader.read({...input,snapshot:true})):null)});this.tail=Promise.resolve();this.flights=new Map();this.closed=false;this.snapshotFlights=new Map();this.relations=new Map();this.relationSignature='';this.documents=new Map();this.traffic={documentLoads:0,documentReloads:0,contentReads:0};this.counts={matches:0,reuses:0};}
  snapshot(force=false){
    if(this.snapshotFlights.has(force))return this.snapshotFlights.get(force);
    const projectLabels=[...new Set(this.getCatalog().projects.filter(p=>p.hostId==='local').map(p=>p.label))];
    const run=Promise.resolve().then(()=>this.readSnapshot({origin:this.origin,projectLabels,force})).finally(()=>{if(this.snapshotFlights.get(force)===run)this.snapshotFlights.delete(force);});
    this.snapshotFlights.set(force,run);return run;
  }
  resolve(observation,force){
    let catalog=this.getCatalog();
    if(this.lookupThreads&&observation.status==='observed'&&observation.matched===true&&typeof observation.title==='string'&&observation.title&&Array.isArray(observation.draftLabels)&&!observation.draftLabels.length){
      try{
        const rows=this.lookupThreads(observation.title,catalog.projects,observation,catalog.contextRoutes);
        if(!Array.isArray(rows))throw Error('聊天身份读取失败');
        for(const row of rows){const known=catalog.threads.find(t=>t.id===row.id);if(known&&(known.hostId!==row.hostId||known.kind!==row.kind||normalize(known.cwd).replace(/^\\\\\?\\/,'')!==normalize(row.cwd).replace(/^\\\\\?\\/,'')))throw Error('聊天身份冲突');}
        catalog={...catalog,threads:rows};
        const resolved=resolveDesktopContext(observation,catalog);
        this.rememberThreads?.(resolved.kind==='thread'?rows:[],observation.title);
      }catch{this.rememberThreads?.([],observation.title);return {...resolveDesktopContext(observation,{...catalog,threads:[]}),reason:'当前聊天身份尚未唯一核对，请稍后重试'};}
    }
    const signature=JSON.stringify([catalog.projects.map(p=>[p.projectId,p.label,p.path,p.hostId]),catalog.threads.map(t=>[t.id,t.title,t.cwd,t.kind,t.hostId]),catalog.contextRoutes?.map(r=>[r.threadId,r.unit,r.path,r.projectId,r.status])]);
    if(signature!==this.relationSignature){this.relations.clear();this.relationSignature=signature;}
    const key=observation.identityKey&&JSON.stringify([observation.identityKey,observation.title,observation.draftLabels,observation.ownerLabels]);
    if(!force&&observation.status==='observed'&&key&&this.relations.has(key)){this.counts.reuses++;return this.relations.get(key);}
    this.counts.matches++;const result=resolveDesktopContext(observation,catalog);if(result.status==='confirmed'&&key){if(this.relations.size>=64)this.relations.delete(this.relations.keys().next().value);this.relations.set(key,result);}return result;
  }
  inspect(value,{force=false,documentId}={}){
    const pageUrl=contextPage(value,this.origin);
    if(this.closed)return Promise.resolve(unresolved());
    if(typeof documentId==='string'&&/^[a-f0-9-]{36}$/.test(documentId)){const session=new URL(pageUrl).searchParams.get('panelSession'),previous=this.documents.get(session);if(previous!==documentId){this.traffic.documentLoads++;if(previous)this.traffic.documentReloads++;if(this.documents.size>=64&&!this.documents.has(session))this.documents.delete(this.documents.keys().next().value);this.documents.set(session,documentId);}}
    const key=pageUrl+':'+force;if(this.flights.has(key))return this.flights.get(key);
    const describe=observation=>{
      const result=this.resolve(observation,force),hostVersion=observation?.hostVersion;
      const selectedRowId=force&&result.kind==='thread'&&/^[\d.-]{1,160}$/.test(observation.selectedRowId??'')?observation.selectedRowId:'';
      const selection=selectedRowId?{selectedRowId,panelSession:new URL(pageUrl).searchParams.get('panelSession')}:undefined;
      if(!/^\d{1,6}(?:\.\d{1,6}){1,3}$/.test(hostVersion??''))return {...result,pageUrl,...(selection?{selection}:{})};
      return {...result,pageUrl,...(selection?{selection}:{}),hostVersion,ownerObserved:result.status==='confirmed'&&(result.kind==='draft'||observation.ownerLabels?.length===1)};
    };
    const run=this.readSnapshot?this.snapshot(force).then(snapshot=>describe(snapshotObservation(snapshot,pageUrl))).catch(()=>({...unresolved(true,unreadableReason,true),pageUrl})).finally(()=>this.flights.delete(key)):this.tail.catch(()=>{}).then(async()=>{
      if(this.closed)return unresolved();
      const catalog=this.getCatalog(),projectLabels=[...new Set(catalog.projects.filter(p=>p.hostId==='local').map(p=>p.label))];
      const observation=await this.read({pageUrl,projectLabels,force});
      return describe(observation);
    }).catch(()=>({...unresolved(true,unreadableReason,true),pageUrl})).finally(()=>this.flights.delete(key));
    this.flights.set(key,run);if(!this.readSnapshot)this.tail=run;return run;
  }
  noteRead(){this.traffic.contentReads++;}
  async inspectForWrite(value){
    const context=await this.inspect(value,{force:true});
    if(context.status!=='unresolved'||context.retryableContext!==true||this.closed)return context;
    // Only retry a failed observation before the first business mutation.
    // A confirmed mismatch, ambiguous identity or outside window is final.
    await new Promise(resolve=>setTimeout(resolve,150));
    return this.inspect(value,{force:true});
  }
  diagnostics(){return {...this.reader?.diagnostics(),...this.counts,...this.traffic};}
  async close(){this.closed=true;await this.reader?.close();await Promise.allSettled([...this.flights.values(),this.tail,...this.snapshotFlights.values()]);}
}
