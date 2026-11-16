import {installPanelTransport,panelFetch,responseError} from './read-client.js';
import {initSidebarOpener} from './hub.js';

// Loaded only by the packaged MCP resource, before the shared application.
const mode=document.documentElement.dataset.leixMode;
if(!['global','thread'].includes(mode)||window.parent===window)throw Error('需要原生 LEIX 插件宿主');
export const startSharedApplication=mode==='thread';
const calls=new Map();let serial=0,session,liveUrl,routeState=null,reconnecting,entry;
let receiveEntry;const entryReady=new Promise(resolve=>{receiveEntry=resolve;});
function rpc(method,params,timeout=15000){
  const id='leix:'+ ++serial;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{calls.delete(id);reject(Error('宿主未返回回执，请核对原记录后重试'));},timeout);
    calls.set(id,{resolve,reject,timer});window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*');
  });
}
window.addEventListener('message',event=>{
  if(event.source!==window.parent||!event.data||event.data.jsonrpc!=='2.0')return;
  const message=event.data,call=calls.get(message.id);
  if(message.method==='ui/notifications/tool-result'&&message.params?.structuredContent?.mode===mode&&typeof message.params.structuredContent.ticket==='string'){entry=message.params.structuredContent;receiveEntry();}
  if(call){calls.delete(message.id);clearTimeout(call.timer);if(message.error)call.reject(Error(message.error.message??'宿主调用失败'));else call.resolve(message.result);}
  else if(message.method==='ui/resource-teardown'&&Object.hasOwn(message,'id'))window.parent.postMessage({jsonrpc:'2.0',id:message.id,result:{}},'*');
});
async function tool(name,args,timeout){const result=await rpc('tools/call',{name,arguments:args},timeout);if(result?.isError)throw Error('本机插件调用失败');return result?.structuredContent;}
const banner=document.createElement('section');banner.setAttribute('role','status');banner.className='notice';
banner.innerHTML='<h1>本聊天白板 <small>0.5.1</small></h1><p></p><button type="button">重试</button>';
document.body.prepend(banner);
const status=text=>{banner.hidden=false;banner.querySelector('p').textContent=text;};
const views=[...document.body.children].filter(node=>node!==banner&&node.tagName!=='SCRIPT');for(const node of views)node.hidden=true;
async function requireHost(operation){try{return await operation;}catch(error){status(error.message+'；请从原生入口重新打开。');banner.querySelector('button').onclick=()=>window.location.reload();await new Promise(()=>{});}}
await requireHost(rpc('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'leix-panel',version:'0.5.1'},appCapabilities:{}}));
window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');
if(mode==='thread')await requireHost(Promise.race([entryReady,new Promise((_,reject)=>setTimeout(()=>reject(Error('未收到原生入口凭据')),15000))]));
const viewId=crypto.randomUUID();
let resumeKey,resume,renewEntry=mode==='global';
function restoreSession(){resumeKey='leix-native-view:'+mode+':'+entry.ticket;resume=undefined;try{resume=JSON.parse(sessionStorage.getItem(resumeKey));}catch{}}
if(entry)restoreSession();
const rememberSession=()=>{try{sessionStorage.setItem(resumeKey,JSON.stringify({sessionId:session.sessionId}));}catch{}};
while(!session){
  try{
    status('正在核对本机服务与对话归属…');
    // A cached global app may hold an old tool result. Get a fresh short-lived
    // entry from this fixed MCP service; never retry a business command here.
    if(renewEntry){
      let fresh;try{fresh=await tool('leix_panel_refresh_entry',{});}catch{throw Error('入口验证接口未就绪，请重新加载 LEIX 插件连接，再关闭本页重新打开');}
      if(fresh?.mode!==mode||typeof fresh.ticket!=='string')throw Error('未取得本服务的入口凭据，请从原生入口重新打开');
      entry=fresh;restoreSession();renewEntry=false;
    }
    const opened=await tool(resume?.sessionId?'leix_panel_reopen':'leix_panel_open',resume?.sessionId?{sessionId:resume.sessionId,viewId}:{ticket:entry.ticket,viewId});
    if(!opened?.sessionId)throw Object.assign(Error(opened?.body?.error??'本机服务不可用'),{entryRejected:opened?.body?.entryRejected===true,serviceUnavailable:opened?.body?.serviceUnavailable===true});
    session=opened;liveUrl=new URL(session.href);rememberSession();
  }catch(error){
    status(error.entryRejected?'入口凭据已失效。点击“重新验证入口”取得本服务的新凭据后继续。':error.message+(error.serviceUnavailable?'。请按原项目启动入口运行 127.0.0.1:4319 本机面板后重试。':'。必要时关闭本页，再从原生入口重新打开。'));
    banner.querySelector('button').textContent=error.entryRejected?'重新验证入口':'重试连接';
    await new Promise(resolve=>banner.querySelector('button').onclick=()=>{if(error.entryRejected)renewEntry=true;resolve();});
  }
}
banner.hidden=true;if(startSharedApplication)for(const node of views)node.hidden=false;
let bootstrapStatus=session.bootstrapStatus;delete session.bootstrapStatus;
// Shared code uses this virtual address; the sandbox's real URL is untouched.
const location={get href(){return liveUrl.href;},set href(value){const next=new URL(value,liveUrl);if(next.origin!==liveUrl.origin||next.pathname!=='/')throw Error('不支持的界面地址');liveUrl=next;dispatchEvent(new PopStateEvent('popstate'));},get search(){return liveUrl.search;},get origin(){return liveUrl.origin;},reload(){window.location.reload();}};
const history={get state(){return routeState;},replaceState(state,_,url){routeState=state;if(url)liveUrl=new URL(url,liveUrl);},pushState(state,_,url){this.replaceState(state,_,url);}};
function response(value){
  const headers={'Content-Type':value.type??'application/json',...(value.etag?{ETag:value.etag}:{})};
  const body=value.base64?Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0)):JSON.stringify(value.body??{});
  return new Response(value.status===304?null:body,{status:value.status??503,headers});
}
async function reconnect(){
  if(reconnecting)return reconnecting;
  const operation=(async()=>{
    const next=await tool('leix_panel_reopen',{sessionId:session.sessionId,viewId:crypto.randomUUID()});
    if(!next?.sessionId||next.projectId!==session.projectId||next.threadId!==session.threadId)throw Error(next?.body?.error??'宿主归属已变化，请重新打开侧栏');
    // The triggering status read is retried fresh below. Do not retain an
    // earlier bootstrap for a later, unconditional refresh.
    bootstrapStatus=undefined;delete next.bootstrapStatus;session=next;rememberSession();banner.hidden=true;
  })();
  reconnecting=operation;try{await operation;}finally{if(reconnecting===operation)reconnecting=null;}
}
installPanelTransport({location,history,fetch:async(address,options={})=>{
  const target=new URL(address,liveUrl);if(target.origin!==liveUrl.origin)throw Error('不支持跨站请求');
  if(target.pathname==='/api/state')target.pathname='/api/view/status';
  const method=options.method??'GET';let body=options.body?JSON.parse(options.body):undefined;
  if(method==='GET'&&target.pathname==='/api/view/status'&&bootstrapStatus){
    const first=bootstrapStatus;bootstrapStatus=null;
    if(!new Headers(options.headers).has('If-None-Match'))return response({status:200,body:first});
  }
  if(body&&mode==='thread'&&!Object.hasOwn(body,'projectId'))body={...body,projectId:session.projectId};
  const read=()=>tool(method==='POST'?'leix_panel_command':'leix_panel_read',{sessionId:session.sessionId,path:target.pathname+target.search,...(body?{body}:{}),...(method==='POST'?{requestId:crypto.randomUUID()}:{}),...(options.headers?.['If-None-Match']?{etag:options.headers['If-None-Match']}:{})},method==='POST'?135000:20000);
  let value;try{
    value=await read();
    // A service restart rotates credentials. Only a status read may renew a
    // matching session; a command/unknown receipt is never replayed here.
    if(method==='GET'&&target.pathname==='/api/view/status'&&[403,409,503].includes(value?.status)){await reconnect();value=await read();}
  }catch(error){throw Object.assign(error,{notApplied:false});}
  if(value?.status===409||value?.status===403){status(value.body?.error??'归属尚未确认，写操作已暂停');banner.querySelector('button').textContent='重新打开';banner.querySelector('button').onclick=()=>location.reload();}
  return response(value??{status:503,body:{error:'缺少本机调用回执'}});
}});
// The left app is a launcher, with no guessed source project and no control UI.
// Its authorization session still uses the existing controller scope internally.
if(mode==='global'){
  let current={state:{},projectId:''};
  async function request(path,options){const result=await panelFetch(path,options),value=await result.json();if(!result.ok)throw responseError(value);return value;}
  const api={load:async()=>{current={state:await request('/api/view/status'),projectId:''};},post:(name,body)=>request('/api/'+name,{method:'POST',body:JSON.stringify(body??{})})};
  const opener=initSidebarOpener(api,()=>current,{standalone:true});
  await requireHost(api.load());opener.open();banner.hidden=true;
}
// Thread views remain scoped to their originating project.
if(mode==='thread'){
  const style=document.createElement('style');style.textContent='#controlLink,#workspaceConfigButton,#versionProject{display:none!important}';document.head.append(style);
}
