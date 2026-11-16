import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {checkSqliteRuntime,isolatedSqliteRoot} from './sqlite-isolation.mjs';
import {decodeState} from './sqlite-codec.mjs';
import {ownsDataLock} from './data-lock.mjs';
import path from 'node:path';

const fail=(code,message)=>Object.assign(new Error(message),{code});
// Explicit isolated factory only; no environment switch or production fallback.
export async function openSqliteStore({root,initialState,maxPending=32,maxBytes=4*1024*1024,timeoutMs=10000,lockLease,deferRecovery=false}={}){
  checkSqliteRuntime();root=isolatedSqliteRoot(root);
  if(lockLease!==undefined&&!ownsDataLock(lockLease,path.join(root,'data')))throw fail('INVALID_LOCK','无有效的服务目录锁');
  if(!Number.isInteger(maxPending)||maxPending<1||maxPending>64||!Number.isInteger(maxBytes)||maxBytes<1024||maxBytes>32*1024*1024||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw fail('INVALID_ARGUMENT','存储队列或超时参数无效');
  if(Buffer.byteLength(JSON.stringify(initialState??null))>maxBytes)throw fail('LIMIT_EXCEEDED','隔离初始数据超过大小限制');
  // The R39 10,000-round fixture contains ~180,000 normalized layout rows.
  // Keep a bounded Worker heap with room for verified startup reconstruction.
  const worker=new Worker(new URL('./sqlite-worker.mjs',import.meta.url),{workerData:{root,initialState,maxBytes,externalLock:lockLease!==undefined,deferRecovery},resourceLimits:{maxOldGenerationSizeMb:512}});
  const pending=new Map();let closed=false,closing=null,fault=false,exited=false,readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const startup=setTimeout(()=>{readyReject(fail('STORE_TIMEOUT','SQLite启动超时'));void worker.terminate();},30000);
  const rejectAll=error=>{clearTimeout(startup);readyReject(error);for(const request of pending.values()){clearTimeout(request.timer);request.reject(request.mutating?fail('COMMIT_UNKNOWN','存储Worker中断，请核对命令结果，不要重跑发送'):error);}pending.clear();fault=true;};
  worker.on('error',error=>rejectAll(error));
  worker.on('exit',code=>{exited=true;if(!closed)rejectAll(fail('WORKER_EXIT','存储Worker已退出：'+code));});
  worker.on('message',message=>{
    if(message.ready){clearTimeout(startup);message.error?readyReject(fail(message.error.code,message.error.message)):readyResolve(message.value);return;}
    const request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timer);
    if(message.error)request.reject(fail(message.error.code,message.error.message));else request.resolve(message.value);
  });
  try{await ready;}catch(error){await worker.terminate();throw error;}
  function request(type,payload,bypass=false){
    if(exited)return Promise.reject(fail(type==='command'?'COMMIT_UNKNOWN':'WORKER_EXIT','存储Worker已退出'));
    if((closed||closing)&&!bypass)return Promise.reject(fail('CLOSING','SQLite存储正在关闭'));
    if(fault&&type==='command')return Promise.reject(fail('COMMIT_UNKNOWN','此前命令状态未确认，请查询回执或关闭后核对'));
    if(!bypass&&pending.size>=maxPending)return Promise.reject(fail('STORE_BUSY','存储等待队列已满'));
    try{if(Buffer.byteLength(JSON.stringify(payload??null))>maxBytes)return Promise.reject(fail('LIMIT_EXCEEDED','SQLite请求超过大小限制'));}catch{return Promise.reject(fail('INVALID_ARGUMENT','请求必须为可序列化数据'));}
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),mutating=type==='command',timer=setTimeout(()=>{if(mutating)fault=true;reject(fail(mutating?'COMMIT_UNKNOWN':'STORE_TIMEOUT',mutating?'提交结果未确认，请查询原命令回执，不要自动重试':'存储读取超时'));},timeoutMs);
      pending.set(id,{resolve,reject,timer,mutating});
      try{worker.postMessage({id,type,payload});}catch(error){clearTimeout(timer);pending.delete(id);reject(fail('INVALID_ARGUMENT',error.message));}
    });
  }
  const query=(name,args={})=>request('query',{name,args});
  return {
    status:()=>({closed,closing:!!closing,exited,fault:fault?'COMMIT_UNKNOWN':null}),
    executeCommand:command=>{const commandId=command.commandId??randomUUID();return request('command',{...command,commandId}).then(result=>({...result,commandId}),error=>{error.commandId=commandId;throw error;});},
    inspect:()=>query('inspect'),getTask:(id,projectId)=>query('getTask',{id,projectId}),getJob:(id,projectId)=>query('getJob',{id,projectId}),
    getEntity:(table,id,projectId)=>query('getEntity',{table,id,projectId}),listTasks:(projectId,options)=>query('listTasks',{projectId,options}),
    listTaskEvents:(projectId,id,options={})=>query('listTaskEvents',{projectId,id,...options}),listSectionJobs:(projectId,sectionId,options={})=>query('listSectionJobs',{projectId,sectionId,...options}),
    queryQueue:statuses=>query('queryQueue',{statuses}),loadExecutionContext:(projectId,id)=>query('loadExecutionContext',{projectId,id}),queryProjectSummary:projectId=>query('queryProjectSummary',{projectId}),
    commandResult:(id,scope)=>query('commandResult',{id,scope}),snapshotPage:options=>query('snapshotPage',options),
    async snapshot(){let offset=0,revision,limit=100;const layout=[],rows=new Map();do{let page;try{page=await query('snapshotPage',{offset,revision,limit});}catch(error){if(error.code==='LIMIT_EXCEEDED'&&limit>1){limit=Math.max(1,Math.floor(limit/2));continue;}throw error;}revision=page.revision;for(const {payload_json,...node} of page.rows){layout.push(node);if(!rows.has(node.table_name))rows.set(node.table_name,new Map());rows.get(node.table_name).set(node.row_key,{payload_json});}offset=page.next;}while(offset!==null);return {revision,value:decodeState(layout,rows)};},
    // A deadline is an error, not permission to kill an accepted transaction.
    // The queued close still runs after it; only a successful close is disposed.
    close(){if(closing)return closing;if(exited){closed=true;return Promise.resolve({closed:true});}closing=request('close',{},true).then(async result=>{closed=true;await worker.terminate();return result;});return closing;}
  };
}
