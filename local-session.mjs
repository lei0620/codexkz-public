import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const maxRecordBytes=32*1024*1024;
import {normalize} from './core.mjs';

export const maxThreadReadBytes=64*1024*1024;
export const maxRecentReadBytes=8*1024*1024;
const readBlocked=(code,message)=>Object.assign(new Error(message),{code});
export const isThreadReadBlocked=error=>['THREAD_READ_TOO_LARGE','THREAD_READ_UNVERIFIED','THREAD_LOG_MISSING'].includes(error?.code);
// Apply only around a known read operation, never around reserve/create/send.
export const isTransientThreadRead=error=>!['THREAD_LOG_MISSING','THREAD_READ_TOO_LARGE','EACCES','EPERM'].includes(error?.code)&&![401,403].includes(Number(error?.status??error?.statusCode))&&!/permission|denied|forbidden|unauthori[sz]ed|not authori[sz]ed|授权|拒绝/i.test(error?.message??'')&&(error?.retryableRead===true||['DESKTOP_TIMEOUT','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','ENETUNREACH'].includes(error?.code)||error?.message==='桌面连接已关闭'||error?.code==='THREAD_READ_UNVERIFIED'&&/读取期间变化|末尾尚未完整|尚未完整落盘|当前轮次稳定|对话状态在读取期间变化/.test(error.message));
// Finish only our local parser's bounded chunks. Never retry a desktop RPC,
// arbitrary read failure, or any operation that can submit business work.
export function readSessionPage(reader,thread,options,{continueRead=true}={}){
  // A warm page must stay synchronous: ordinary queue checks used no yield.
  try{return {page:reader.read(thread,options),continued:false};}
  catch(initial){return (async()=>{
    let error=initial;
    for(let attempt=1;attempt<4;attempt++){
      if(!continueRead||error.code!=='THREAD_READ_UNVERIFIED'||error.localReadProgress!==true||error.retryableRead!==true)throw error;
      const bytes=reader.rolloutSize(thread);
      if(!Number.isSafeInteger(bytes)||bytes<0)throw readBlocked('THREAD_READ_UNVERIFIED','无法确认分批读取的日志大小');
      if(bytes>maxThreadReadBytes)throw readBlocked('THREAD_READ_TOO_LARGE','该对话日志超过64 MiB，已停止补读');
      await new Promise(resolve=>setImmediate(resolve));
      try{return {page:reader.read(thread,options),continued:true};}catch(next){error=next;}
    }
    throw error;
  })();}
}
// Every desktop transcript read must pass this gate, including metadata-only
// read_thread requests: the desktop may still load the complete transcript.
export async function readDesktopThread(bridge,args,reader=new LocalSessionReader()){
  let bytes;
  try{bytes=reader.rolloutSize({id:args.threadId});}
  catch(error){throw Object.assign(readBlocked(error.code==='THREAD_LOG_MISSING'?error.code:'THREAD_READ_UNVERIFIED','无法安全核对对话日志，面板已停止读取：'+error.message),error.code==='THREAD_LOG_MISSING'?{threadId:error.threadId,cwd:error.cwd}:{});}
  if(!Number.isSafeInteger(bytes)||bytes<0)throw readBlocked('THREAD_READ_UNVERIFIED','无法确认对话日志大小，面板已停止读取；请核对本机对话索引');
  if(bytes>maxThreadReadBytes)throw Object.assign(readBlocked('THREAD_READ_TOO_LARGE','该对话日志超过64 MiB，面板已跳过自动读取；请在原对话核对，未决任务可确认空闲后解除'),{bytes,limitBytes:maxThreadReadBytes});
  return bridge.call('read_thread',args);
}

export function hydrateSessionTurns(response,local){
  const byId=new Map(local.turns.map(t=>[t.id,t]));
  return {...response,turns:response.turns.map(t=>{const stored=byId.get(t.id),hydrated=!t.items?.length&&stored?.items?.length?{...stored,...t,createdAt:t.createdAt??stored.createdAt,items:stored.items}:t;return stored?.model&&!t.model?{...hydrated,model:stored.model}:hydrated;})};
}

// Read-only fallback for desktop builds that return turn metadata without items.
// Only a previously validated local thread may resolve a session file.
export class LocalSessionReader{
  constructor({directory=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'sessions'),registry=path.join(path.dirname(directory),'state_5.sqlite')}={}){this.directory=directory;this.registry=registry;this.cache=new Map();}
  locate(id){
    if(!/^[a-f0-9-]{36}$/i.test(id)||!fs.existsSync(this.directory))return null;
    const matches=[],walk=(dir,depth)=>{
      for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
        if(entry.isSymbolicLink())continue;
        const file=path.join(dir,entry.name);
        if(entry.isDirectory()&&depth<3&&/^\d{2,4}$/.test(entry.name))walk(file,depth+1);
        else if(entry.isFile()&&entry.name.endsWith('-'+id+'.jsonl'))matches.push(file);
      }
    };walk(this.directory,0);
    if(matches.length>1)throw Error('发现多个同ID本机日志，未猜测来源');
    return matches[0]??null;
  }
  identity(id){
    if(!/^[a-f0-9-]{36}$/i.test(id)||!fs.existsSync(this.registry))return null;
    if(fs.lstatSync(this.registry).isSymbolicLink())throw Error('对话索引不是普通本机文件');
    const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(this.registry,{readOnly:true});
    let row;
    try{
      if(!db.prepare('PRAGMA table_info(threads)').all().some(column=>column.name==='archived'))return null;
      row=db.prepare('SELECT cwd, archived FROM threads WHERE id = ?').get(id);
    }finally{db.close();}
    if(!row?.cwd)return null;
    const cwd=normalize(row.cwd).replace(/^\\\\\?\\/,'');
    const file=this.activeFile({id,cwd});if(!file)return null;
    const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(65536);let length;
    try{length=fs.readSync(fd,buffer,0,buffer.length,0);}finally{fs.closeSync(fd);}
    const first=buffer.subarray(0,length).toString('utf8').split('\n')[0];let meta;
    try{meta=JSON.parse(first);}catch{throw Error('本机日志缺少可核对的归属信息');}
    if(meta.type!=='session_meta'||(meta.payload?.id??meta.payload?.session_id)!==id||normalize(meta.payload?.cwd).replace(/^\\\\\?\\/,'')!==cwd)throw Error('本机日志与对话项目不一致');
    return {id,cwd,archived:row.archived===1,file,registry:this.registry};
  }
  contextTabThread(pageUrl){
    const file=path.join(path.dirname(this.registry),'.codex-global-state.json');
    const stamp=s=>[s.dev,s.ino,s.size,s.mtimeMs].join(':');
    const before=fs.lstatSync(file,{throwIfNoEntry:false});
    if(!before)return '';
    if(!before.isFile()||before.isSymbolicLink()||before.size>8*1024*1024)throw Error('Codex 侧栏记录不可核对');
    const key=stamp(before);
    if(this.contextTabs?.key!==key){
      const fd=fs.openSync(file,'r');
      let value;
      try{
        if(stamp(fs.fstatSync(fd))!==key)throw Error('Codex 侧栏记录正在变化');
        const bytes=Buffer.alloc(before.size);
        for(let offset=0;offset<bytes.length;){
          const read=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);
          if(!read)throw Error('Codex 侧栏记录正在变化');
          offset+=read;
        }
        if(stamp(fs.fstatSync(fd))!==key||stamp(fs.lstatSync(file))!==key)throw Error('Codex 侧栏记录正在变化');
        value=JSON.parse(bytes.toString('utf8'));
      }finally{fs.closeSync(fd);}
      const tabs=new Map();
      for(const [name,layout] of Object.entries(value?.['electron-persisted-atom-state']??{})){
        if(!name.startsWith('thread-tab-routes-v1:')||!Array.isArray(layout?.routes))continue;
        const id=name.slice('thread-tab-routes-v1:'.length);
        for(const route of layout.routes){
          if(route?.kind!=='browser'||typeof route.params?.restoreUrl!=='string')continue;
          let url;try{url=new URL(route.params.restoreUrl);}catch{continue;}
          const session=url.searchParams.get('panelSession');
          if(url.pathname!=='/'||!session)continue;
          const matchKey=url.origin+'\0'+session;
          const exact=/^[a-f0-9-]{36}$/i.test(id)&&route.params.browserConversationId===id&&
            layout.topology?.right?.open===true&&!!route.tabId&&layout.topology.right.activeTabId===route.tabId;
          tabs.set(matchKey,tabs.has(matchKey)||!exact?'':id);
        }
      }
      this.contextTabs={key,tabs};
    }
    const page=new URL(pageUrl);
    return this.contextTabs.tabs.get(page.origin+'\0'+page.searchParams.get('panelSession'))??'';
  }
  contextThreads(title,projects,observation={},routes=[]){
    if(typeof title!=='string'||!title||title.length>200)throw Error('当前聊天名称无法核对');
    const resultFor=(identity,project)=>({id:identity.id,title,cwd:project.path,kind:'codex',hostId:'local',status:'active',activityUnknown:true});
    // The observed page belongs to the unique visible native sidebar. Match its
    // per-tab session to the desktop's own tab owner, never to URL threadId.
    const owners=observation.ownerLabels;
    const routeMatches=routes.filter(route=>['ready','model-pending'].includes(route.status)&&
      (route.title||route.unit)===title&&route.threadId);
    if(routeMatches.length&&observation.pageUrl&&observation.selectedRowId&&Array.isArray(owners)&&owners.length===1){
      const id=this.contextTabThread(observation.pageUrl);
      const routesForThread=routeMatches.filter(route=>route.threadId===id);
      if(routesForThread.length){
        const identity=this.identity(id),matches=projects.filter(p=>p.hostId==='local'&&p.label===owners[0]&&normalize(p.path).replace(/^\\\\\?\\/,'')===identity?.cwd);
        if(!identity||identity.archived||matches.length!==1||!routesForThread.some(route=>route.projectId===matches[0].projectId&&normalize(route.path)===normalize(matches[0].path))||this.contextTabThread(observation.pageUrl)!==id)throw Error('当前侧栏与聊天项目无法唯一核对');
        return [resultFor(identity,matches[0])];
      }
    }
    const index=path.join(path.dirname(this.registry),'session_index.jsonl');
    const stamp=file=>{const s=typeof file==='number'?fs.fstatSync(file):fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())throw Error('聊天身份索引不是普通文件');return [s.dev,s.ino,s.size,s.mtimeMs];};
    const optionalStamp=file=>fs.existsSync(file)?stamp(file):null;
    const before={index:stamp(index),db:stamp(this.registry),wal:optionalStamp(this.registry+'-wal')};
    if(before.index[2]>4*1024*1024)throw Error('聊天命名索引超过核验上限');
    const fd=fs.openSync(index,'r');
    try{
    if(JSON.stringify(stamp(fd))!==JSON.stringify(before.index))throw Error('聊天命名索引正在变化');
    const bytes=Buffer.alloc(before.index[2]);let length=0;
    while(length<bytes.length){const n=fs.readSync(fd,bytes,length,bytes.length-length,length);if(!n)throw Error('聊天命名索引尚未完整读取');length+=n;}
    const names=new Map();
    for(const line of bytes.toString('utf8').split('\n').filter(Boolean)){
      if(Buffer.byteLength(line)>16384)throw Error('聊天命名记录过长');
      const row=JSON.parse(line);
      if(!/^[a-f0-9-]{36}$/i.test(row.id??'')||typeof row.thread_name!=='string'||row.thread_name.length>1000)throw Error('聊天命名记录无法核对');
      names.set(row.id,row.thread_name);if(names.size>10000)throw Error('聊天命名索引超过核验上限');
    }
    const ids=[...names].filter(([,name])=>name===title).map(([id])=>id);
    // A partial activity catalog cannot prove title uniqueness. Check the
    // complete bounded alias index; never discard a duplicate to pick a chat.
    if(ids.length>1)throw Error('当前聊天名称不唯一');
    const result=[];
    if(ids.length){
      const identity=this.identity(ids[0]);if(!identity)throw Error('当前聊天身份无法核对');
      if(!identity.archived){
        const matches=projects.filter(p=>p.hostId==='local'&&normalize(p.path).replace(/^\\\\\?\\/,'')===identity.cwd);
        if(matches.length!==1)throw Error('当前聊天项目不能唯一核对');
        result.push(resultFor(identity,matches[0]));
      }
    }
    const after={index:stamp(index),db:stamp(this.registry),wal:optionalStamp(this.registry+'-wal')};
    if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(stamp(fd))!==JSON.stringify(before.index))throw Error('聊天身份索引正在变化');
    return result;
    }finally{fs.closeSync(fd);}
  }
  activeFile(thread){
    if(!fs.existsSync(this.registry))return null;
    if(fs.lstatSync(this.registry).isSymbolicLink())throw Error('对话索引不是普通本机文件');
    let DatabaseSync;try{({DatabaseSync}=require('node:sqlite'));}catch{throw Error('读取新版对话日志需要 Node 22.13 或更新版本');}
    const db=new DatabaseSync(this.registry,{readOnly:true});
    try{
      const hasArchived=db.prepare('PRAGMA table_info(threads)').all().some(column=>column.name==='archived');
      const row=db.prepare(`SELECT cwd, rollout_path${hasArchived?', archived':''} FROM threads WHERE id = ?`).get(thread.id);if(!row)return null;
      const cwd=normalize(row.cwd).replace(/^\\\\\?\\/,'');
      if(thread.cwd&&cwd!==normalize(thread.cwd))throw Error('对话索引项目归属不一致');
      const file=path.resolve(row.rollout_path.replace(/^\\\\\?\\/,'')),roots=[fs.realpathSync(this.directory)];
      const archive=path.join(path.dirname(this.directory),'archived_sessions');
      // Only indexed archived threads may use Codex's sibling archive directory.
      if(row.archived===1&&fs.existsSync(archive)&&!fs.lstatSync(archive).isSymbolicLink())roots.push(fs.realpathSync(archive));
      const allowed=value=>roots.some(root=>{const relative=path.relative(root,value);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);});
      if(!allowed(file))throw Error('对话日志不在授权日志目录');
      let realFile;try{realFile=fs.realpathSync(file);}catch(error){if(error.code==='ENOENT')throw Object.assign(Error(error.message),{code:'THREAD_LOG_MISSING',threadId:thread.id,cwd});throw error;}
      if(!roots.some(root=>{const relative=path.relative(root,realFile);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);})||fs.lstatSync(file).isSymbolicLink())throw Error('对话日志不在授权日志目录');
      return file;
    }finally{db.close();}
  }
  rolloutSize(thread){
    const files=[...new Set([this.activeFile(thread),this.locate(thread.id)].filter(Boolean))];
    if(!files.length)return null;
    return files.reduce((total,file)=>{const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink())throw Error('本机日志不是普通文件');return total+info.size;},0);
  }
  // 只读本机索引里的对话模型：用于派发前确认模型与阻止跨模型执行。缺失/不可读时不猜测。
  models(ids=[]){
    const unique=[...new Set(ids.filter(id=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id)))];
    if(!unique.length)return {available:true,entries:{},error:''};
    if(!fs.existsSync(this.registry))return {available:false,entries:{},error:'未找到本机对话索引，模型需按标题后缀确认'};
    if(fs.lstatSync(this.registry).isSymbolicLink())return {available:false,entries:{},error:'对话索引不是普通本机文件'};
    let DatabaseSync;try{({DatabaseSync}=require('node:sqlite'));}catch{return {available:false,entries:{},error:'读取对话模型需要 Node 22.13 或更新版本'};}
    let db;try{
      db=new DatabaseSync(this.registry,{readOnly:true});
      const read=db.prepare('SELECT model, model_provider FROM threads WHERE id = ?'),entries={};
      for(const id of unique){const row=read.get(id);if(row?.model)entries[id]={model:String(row.model),provider:String(row.model_provider??'')};}
      return {available:true,entries,error:''};
    }catch(error){return {available:false,entries:{},error:'读取对话模型失败：'+error.message};}
    finally{try{db?.close();}catch{}}
  }
  read(thread,{cursor,limit=10}={}){
    if(thread.kind!=='codex'||thread.hostId!=='local'||!thread.cwd)return null;
    const legacy=this.locate(thread.id),active=this.activeFile(thread),files=[...new Set([legacy,active].filter(Boolean))];if(!files.length)return null;
    const merged=new Map();for(const file of files)for(const turn of this.readFile(thread,file,file===files[0]?thread.id:thread.id+':'+file))merged.set(turn.id,turn);
    const turns=[...merged.values()].reverse(),start=cursor?.startsWith('local:')?turns.findIndex(t=>t.id===cursor.slice(6))+1:0;
    if(cursor&&(!cursor.startsWith('local:')||start===0))throw Error('本机日志游标已失效，请重新读取');
    const rows=turns.slice(start,start+limit),hasMore=start+rows.length<turns.length;
    return {thread,turns:structuredClone(rows),page:{nextCursor:hasMore?'local:'+rows.at(-1).id:null,hasMore},source:'local-session'};
  }
  // Capacity fallback only: never ask the desktop to load a large transcript.
  // Verify the indexed identity, read a fixed tail, and retain exact turn IDs.
  readRecent(thread,{cursor,limit=10,observedActivity}={}){
    const blocked=message=>readBlocked('THREAD_READ_UNVERIFIED',message);
    try{
    if(thread?.kind!=='codex'||thread.hostId!=='local'||!thread.cwd)throw blocked('近期读取缺少已核验的本机对话归属');
    const identity=this.identity(thread.id);
    if(!identity||normalize(identity.cwd)!==normalize(thread.cwd))throw blocked('近期读取的索引与项目归属不一致');
    const file=identity.file,fd=fs.openSync(file,'r');
    let data,offset;
    try{
      const before=fs.fstatSync(fd);if(!before.isFile())throw blocked('近期日志不是普通文件');
      // Bind ownership to this descriptor, not a header from an earlier open.
      const head=Buffer.alloc(65536),length=fs.readSync(fd,head,0,head.length,0);let meta;
      try{meta=JSON.parse(head.subarray(0,length).toString('utf8').split('\n')[0]);}catch{throw blocked('近期日志缺少可核对的归属头');}
      if(meta.type!=='session_meta'||(meta.payload?.id??meta.payload?.session_id)!==thread.id||normalize(meta.payload?.cwd)!==normalize(thread.cwd))throw blocked('近期日志描述符与对话归属不一致');
      offset=Math.max(0,before.size-maxRecentReadBytes);data=Buffer.alloc(before.size-offset);
      let count=0;while(count<data.length){const n=fs.readSync(fd,data,count,Math.min(256*1024,data.length-count),offset+count);if(!n)throw blocked('近期日志读取期间被截断');count+=n;}
      const after=fs.fstatSync(fd),named=fs.lstatSync(file);
      if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||named.isSymbolicLink()||!named.isFile()||named.ino!==before.ino||named.dev!==before.dev||named.size!==before.size||this.activeFile(thread)!==file)throw blocked('近期日志在读取期间变化，请等待当前轮次稳定');
    }finally{fs.closeSync(fd);}
    const cache={meta:{id:thread.id,cwd:identity.cwd},turns:[],current:null,recent:true};
    const openTurns=new Set();
    let start=offset?data.indexOf(10)+1:0,end,danglingInput=false,historyTruncated=offset>0,lastStartedId,unknownLifecycle=false;
    if(offset&&start===0)throw blocked('近期窗口内没有完整记录边界，请核对原对话');
    while((end=data.indexOf(10,start))!==-1){
      const line=data.subarray(start,end);start=end+1;if(!line.length)continue;
      // Parse every complete row within the fixed total budget. Prefixes and
      // compaction labels cannot hide lifecycle fields or malformed records.
      let row;try{row=JSON.parse(line.toString('utf8'));}catch{throw blocked('近期窗口包含损坏的完整记录');}
      const p=row.payload??{},lifecycle=row.type==='event_msg'&&['task_started','task_complete','turn_aborted'].includes(p.type);
      if(row.type==='event_msg'&&/^(?:task_|turn_)/.test(p.type??'')&&!lifecycle)unknownLifecycle=true;
      if(row.type==='turn_context'&&p.turn_id!==undefined&&(typeof p.turn_id!=='string'||!p.turn_id||p.turn_id.length>100))throw blocked('近期上下文缺少准确轮次');
      if(lifecycle){
        if(typeof p.turn_id!=='string'||!p.turn_id||p.turn_id.length>100)throw blocked('近期状态记录缺少准确轮次');
        if(p.type==='task_started'){danglingInput=false;lastStartedId=p.turn_id;openTurns.add(p.turn_id);}else openTurns.delete(p.turn_id);
        if(openTurns.size>300)throw blocked('近期窗口内未结束轮次过多，无法确认空闲');
      }
      if(row.type==='response_item'&&cache.current?.status!=='inProgress'){
        if(p.type==='message'&&p.role==='user'||p.type==='function_call_output'&&p.namespace==='codex_app'&&['send_message_to_thread','create_thread'].includes(p.name))danglingInput=true;
        continue;
      }
      if((row.type==='turn_context'||lifecycle&&p.type!=='task_started')&&typeof p.turn_id==='string'&&!cache.turns.some(t=>t.id===p.turn_id)){
        if(cache.current?.status==='inProgress'&&cache.current.id!==p.turn_id)throw blocked('近期轮次状态互相冲突，请核对原对话');
        const turn={id:p.turn_id,status:'inProgress',createdAt:row.timestamp,items:[],partial:true};cache.turns.push(turn);cache.current=turn;
        if(row.type==='turn_context')openTurns.add(p.turn_id);
      }
      try{this.consume(cache,row,thread);}catch{throw blocked('近期记录结构或归属无法安全核对');}
      while(cache.turns.length>300){cache.turns.shift();historyTruncated=true;}
    }
    if(start<data.length||danglingInput)throw blocked('近期末尾尚未完整落盘或无法确认当前轮次，请稍后重试');
    const turns=cache.turns.reverse();if(!turns.length)throw blocked('近期窗口没有可核对的轮次，请查看原对话');
    const index=cursor?.startsWith('recent:')?turns.findIndex(t=>t.id===cursor.slice(7))+1:0;
    if(cursor&&(!cursor.startsWith('recent:')||!index))throw blocked('近期窗口游标已失效，请重新读取');
    const rows=turns.slice(index,index+Math.max(1,Math.min(300,limit))),hasMore=index+rows.length<turns.length;
    const terminalWindowVerified=!openTurns.size&&!unknownLifecycle&&!cache.lifecycleAmbiguous&&turns[0].id===lastStartedId&&turns[0].startedInWindow===true&&['completed','interrupted','failed'].includes(turns[0].status);
    const observedTurn=turns.find(t=>t.id===observedActivity?.turnId),observedAt=Date.parse(observedActivity?.observedAt),completedAt=Date.parse(observedTurn?.completedAt);
    const observedActivityEnded=!!observedTurn?.startedInWindow&&observedTurn.terminalObserved===true&&!cache.lifecycleAmbiguous&&Number.isFinite(observedAt)&&Number.isFinite(completedAt)&&observedAt<completedAt&&completedAt<=Date.now();
    return {thread:{...thread,...(openTurns.size?{status:'active'}:{})},turns:rows,page:{nextCursor:hasMore?'recent:'+rows.at(-1).id:null,hasMore,historyTruncated},source:'local-session-recent',terminalWindowVerified,observedActivityEnded};
    }catch(error){if(isThreadReadBlocked(error))throw error;throw blocked('近期日志或索引暂不可安全核对，请稍后重试');}
  }
  readFile(thread,file,key){
    let cache=this.cache.get(key);
    const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink())throw Error('本机日志不是普通文件');
    if(!cache||cache.file!==file||cache.ino!==info.ino||info.size<cache.offset){cache={file,ino:info.ino,offset:0,tail:Buffer.alloc(0),turns:[],current:null,meta:null};this.cache.set(key,cache);}
    const fd=fs.openSync(file,'r');
    try{
      const stop=Math.min(info.size,cache.offset+16*1024*1024);
      while(cache.offset<stop){
        const buffer=Buffer.alloc(Math.min(256*1024,stop-cache.offset)),count=fs.readSync(fd,buffer,0,buffer.length,cache.offset);if(!count)break;cache.offset+=count;
        const data=Buffer.concat([cache.tail,buffer.subarray(0,count)]);let start=0,end;
        while((end=data.indexOf(10,start))!==-1){if(end-start>maxRecordBytes)throw Error('本机日志单条记录超过32MB，未猜测内容');const line=data.subarray(start,end).toString('utf8');start=end+1;let row;try{row=JSON.parse(line);}catch{throw Error('本机日志包含损坏的完整记录，未跳过');}this.consume(cache,row,thread);}
        cache.tail=data.subarray(start);if(cache.tail.length>maxRecordBytes)throw Error('本机日志单条记录超过32MB，未猜测内容');
      }
      if(cache.offset<info.size)throw Object.assign(Error('本机日志正在分批读取，请稍后重试'),{code:'THREAD_READ_UNVERIFIED',retryableRead:true,localReadProgress:true});
    }catch(error){if(!error.message.includes('分批读取'))this.cache.delete(key);throw error;}finally{fs.closeSync(fd);}
    if(!cache.meta||cache.meta.id!==thread.id||normalize(cache.meta.cwd)!==normalize(thread.cwd))throw Error('本机日志与对话项目不一致');
    return cache.turns;
  }

  consume(cache,row,thread){
    const p=row.payload??{};
    if(row.type==='session_meta'){
      if((p.id??p.session_id)!==thread.id||normalize(p.cwd??'')!==normalize(thread.cwd))throw Error('本机日志归属核对失败');
      cache.meta={id:p.id??p.session_id,cwd:p.cwd};return;
    }
    if(!cache.meta)throw Error('本机日志缺少归属信息');
    if(row.type==='event_msg'&&p.type==='task_started'){
      if(typeof p.turn_id!=='string')return;
      let turn=cache.turns.find(t=>t.id===p.turn_id);if(!turn){turn={id:p.turn_id,status:'inProgress',createdAt:p.started_at??row.timestamp,items:[]};cache.turns.push(turn);if(cache.turns.length>300&&!cache.recent)cache.turns.shift();}
      if(cache.recent){if(turn.terminalObserved||turn.startedInWindow)cache.lifecycleAmbiguous=true;else turn.startedInWindow=true;}
      if(cache.pendingModel?.id===p.turn_id){turn.model=cache.pendingModel.model;delete cache.pendingModel;}
      cache.current=turn;return;
    }
    if(row.type==='event_msg'&&['task_complete','turn_aborted'].includes(p.type)){
      const turn=cache.turns.find(t=>t.id===p.turn_id)??cache.current;if(!turn)return;
      if(cache.recent&&turn.terminalObserved){if(turn.status!==(p.type==='task_complete'?'completed':'interrupted'))cache.lifecycleAmbiguous=true;return;}
      turn.status=p.type==='task_complete'?'completed':'interrupted';turn.completedAt=p.completed_at??row.timestamp;
      if(cache.recent)turn.terminalObserved=true;
      if(p.last_agent_message&&!turn.items.some(i=>i.phase==='final'))turn.items.push({type:'agentMessage',phase:'final',text:String(p.last_agent_message).slice(0,30000)});return;
    }
    const turn=cache.current;
    if(row.type==='turn_context'&&typeof p.model==='string'&&p.model){
      const target=p.turn_id?cache.turns.find(t=>t.id===p.turn_id):turn?.status==='inProgress'?turn:null;
      if(target)target.model=p.model;
      else if(typeof p.turn_id==='string')cache.pendingModel={id:p.turn_id,model:p.model};
      return;
    }
    if(!turn||row.type!=='response_item')return;
    // Inbound panel deliveries are tool outputs, not user chat messages. Keep
    // their exact correlation marker for result matching without recapturing
    // the task as a new user request. Ordinary tool receipts remain ignored.
    if(p.type==='function_call_output'&&p.namespace==='codex_app'&&['send_message_to_thread','create_thread'].includes(p.name)&&typeof p.output==='string'&&/^\s*<codex_delegation>/.test(p.output)){
      turn.items.push({type:'functionCallOutput',id:p.id,name:p.name,namespace:p.namespace,output:p.output.slice(0,60000),createdAt:row.timestamp});return;
    }
    if(p.type!=='message')return;
    if(p.role==='user'){
      const content=(p.content??[]).filter(c=>['input_text','text','input_image','image'].includes(c.type)).map(c=>/image/.test(c.type)?{type:'image'}:{type:'text',text:String(c.text??'').slice(0,60000)});
      turn.items.push({type:'userMessage',id:p.id??'local-user-'+turn.items.filter(i=>i.type==='userMessage').length,content,createdAt:row.timestamp});
    }else if(p.role==='assistant'&&p.phase==='final')turn.items.push({type:'agentMessage',phase:'final',text:(p.content??[]).filter(c=>c.type==='output_text'||c.type==='text').map(c=>c.text??'').join('\n').slice(0,30000)});
  }
}
