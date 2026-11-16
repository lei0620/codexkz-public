import {randomUUID,createHash} from 'node:crypto';
import {nativeRoute} from './native-policy.mjs';

const reject=(message,status=409)=>{throw Object.assign(Error(message),{status,notApplied:true});};
export function hostThread(meta){
  if(!meta||typeof meta.thread_id!=='string'||meta.thread_id!==meta.threadId||!/^[-a-zA-Z0-9]{1,100}$/.test(meta.thread_id))reject('缺少已核验的宿主对话上下文');
  return meta.thread_id;
}
function publicBody(body,mode){
  if(body&&typeof body==='object'){
    delete body.token;
    if(body.service){body.token='native';body.service={...body.service,desktopContextSupported:mode==='thread',nativeMode:mode};}
  }
  return body;
}
export class LocalPanelAdapter{
  constructor({origin='http://127.0.0.1:4319',fetcher=fetch,now=Date.now}={}){
    const url=new URL(origin);if(url.hostname!=='127.0.0.1'||url.protocol!=='http:'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw Error('适配器仅支持本机回环服务');
    Object.assign(this,{origin:url.origin,fetcher,now});this.sessions=new Map();this.opens=new Map();this.receiptBytes=0;
  }
  async http(path,{method='GET',token,capability,body,etag}={}){
    return this.fetcher(this.origin+path,{method,redirect:'error',signal:AbortSignal.timeout(method==='GET'?15000:120000),headers:{...(token?{'X-Panel-Token':token}:{}),...(capability?{'X-Leix-Native-Session':capability}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...(etag?{'If-None-Match':etag}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  }
  async open({mode,viewId},meta){
    if(!['global','thread'].includes(mode)||!/^[-a-zA-Z0-9]{8,100}$/.test(viewId??''))reject('无效的界面会话');
    const threadId=mode==='thread'?hostThread(meta):'',key=mode+':'+viewId;
    const existing=this.opens.get(key);if(existing){if(existing.threadId!==threadId)reject('宿主对话已切换，请重新打开侧栏');return existing.promise;}
    const operation=(async()=>{
      const status=await this.http('/api/view/status');if(!status.ok)reject('本机面板服务不可用',503);
      const initial=await status.json();if(initial.service?.nativeMcpSupported!==true)reject('本机服务尚未加载插件接口，请按安全更新流程加载',503);
      const response=await this.http('/api/native/session',{method:'POST',token:initial.token,body:{mode,...(threadId?{threadId}:{}),...(initial.service?.nativeBootstrapSupported===true?{bootstrap:true}:{})}}),session=await response.json();
      if(!response.ok)reject(session.error??'本机归属核验失败',response.status);
      if(mode==='thread'&&hostThread(meta)!==threadId)reject('宿主对话已切换，请重新打开侧栏');
      const {bootstrap,...privateSession}=session,bootstrapStatus=bootstrap&&typeof bootstrap==='object'?publicBody(bootstrap,mode):undefined;
      const id=randomUUID();this.sessions.set(id,{...privateSession,token:initial.token,receipts:new Map()});
      if(this.sessions.size>128)this.sessions.delete(this.sessions.keys().next().value);
      const href=new URL('/',this.origin);href.searchParams.set('projectId',session.projectId);href.searchParams.set('panelSession',viewId);href.searchParams.set('view',mode==='global'?'control':'project');if(threadId)href.searchParams.set('threadId',threadId);
      return {sessionId:id,mode,projectId:session.projectId,threadId,href:href.href,expiresAt:session.expiresAt,...(bootstrapStatus?{bootstrapStatus}:{})};
    })();
    this.opens.set(key,{threadId,promise:operation});
    if(this.opens.size>128)this.opens.delete(this.opens.keys().next().value);
    try{return await operation;}catch(error){this.opens.delete(key);throw error;}
  }
  async request(input,meta){
    const session=this.sessions.get(input.sessionId);if(!session||session.expiresAt<=this.now())reject('本机会话已过期，请重新打开调度台');
    if(session.mode==='thread'&&hostThread(meta)!==session.threadId)reject('宿主对话已切换，当前操作未执行');
    nativeRoute(input.method,input.path);
    const readOnly=input.method==='GET'||['/api/attachments/read','/api/capture/image'].includes(input.path);
    if(input.method==='POST'&&!/^[-a-zA-Z0-9]{8,100}$/.test(input.requestId??''))reject('缺少请求防重标识');
    const signature=createHash('sha256').update(JSON.stringify([input.path,input.body])).digest('hex');
    const previous=session.receipts.get(input.requestId);
    if(input.method==='POST'&&previous){if(previous.signature!==signature)reject('相同请求标识对应不同内容');return previous.promise;}
    if(input.method==='POST'&&session.receipts.size>=512)reject('当前会话操作记录已满，请重新打开调度台');
    const operation=(async()=>{
      try{
        const response=await this.http(input.path,{method:input.method,body:input.body,token:session.token,capability:session.capability,etag:input.etag});
        const type=response.headers.get('content-type')??'application/json',etag=response.headers.get('etag');
        if(response.status===304)return {status:304,etag};
        if(type.startsWith('application/json')){
          const body=publicBody(await response.json(),session.mode);
          return {status:response.status,body,etag,type};
        }
        const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>10*1024*1024)reject('附件超过本机插件读取限制',413);
        return {status:response.status,type,base64:bytes.toString('base64')};
      }catch(error){return {status:503,body:{error:'本机服务连接中断；请核对原记录后再操作',notApplied:readOnly,...(!readOnly?{receiptUnknown:true}:{})}};}
    })();
    // Keep unknown/in-flight receipts so a repeated request cannot be replayed.
    if(input.method==='POST'){
      const receipt={signature,promise:operation};session.receipts.set(input.requestId,receipt);
      void operation.then(value=>{
        if(readOnly){if(session.receipts.get(input.requestId)===receipt)session.receipts.delete(input.requestId);return;}
        const size=Buffer.byteLength(JSON.stringify(value));
        if(size>65536||this.receiptBytes+size>8*1024*1024)receipt.promise=Promise.resolve({status:409,body:{error:'原请求已有回执，请读取现有记录后继续',receiptRecorded:true,notApplied:false}});
        else this.receiptBytes+=size;
      });
    }
    return operation;
  }
  async reopen({sessionId,viewId},meta){
    const old=this.sessions.get(sessionId);if(!old)reject('会话已失效，请从原生入口重新打开');
    if(old.mode==='thread'&&hostThread(meta)!==old.threadId)reject('宿主对话已切换，写操作已暂停');
    const next=await this.open({mode:old.mode,viewId},meta);
    const fresh=this.sessions.get(next.sessionId);
    if(next.projectId!==old.projectId||next.threadId!==old.threadId||fresh.path!==old.path){this.sessions.delete(next.sessionId);reject('项目归属或目录已变化，请从原生入口重新打开');}
    return next;
  }
}
