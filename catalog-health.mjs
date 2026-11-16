// Runtime-only trust. Panel scope covers the owned queue connection; target
// activity is checked separately. Directory metadata never proves idle.
export function catalogUnverified(reason='完整活动状态未取得，本次未发送'){
  return Object.assign(Error(reason),{code:'CATALOG_UNVERIFIED',operation:'list_threads',status:503,notApplied:true,retryableRead:true});
}
export class CatalogHealth {
  constructor({now=Date.now,maxAgeMs=5000,scope='desktop'}={}){
    this.source=scope==='panel'?'panel-managed':'desktop';
    this.now=now;this.maxAgeMs=maxAgeMs;this.generation=0;this.key=null;this.pending=null;this.failures=0;
    this.details={transport:'connecting',activities:'unverified',recovering:false,requestedAt:null,checkedAt:null,validUntil:null,reason:'',reasonCode:null,retryAt:null,unavailableSources:[],checksStarted:0,checksSucceeded:0,checksFailed:0};
  }
  connected(key){
    if(key!==this.key){const recovering=this.details.recovering||this.details.transport==='disconnected';this.invalidate();this.key=key;this.details.recovering=recovering;}
    this.details.transport='connected';
  }
  invalidate(){this.generation++;this.pending=null;this.details.activities='unverified';this.details.requestedAt=null;this.details.validUntil=null;}
  disconnected(error){this.invalidate();Object.assign(this.details,{transport:'disconnected',recovering:true,reason:error.message,reasonCode:'CONNECTION_UNAVAILABLE',retryAt:this.details.retryAt??this.now()+60000});}
  recoveryDue(){return this.details.recovering&&this.details.transport==='connected'&&!this.pending&&this.now()>=(this.details.retryAt??0);}
  fresh(){return this.details.transport==='connected'&&this.details.activities==='verified'&&this.now()<this.details.validUntil;}
  snapshot(){
    const view={...this.details,unavailableSources:[...this.details.unavailableSources]};
    if(view.activities==='verified'&&!this.fresh())view.activities='unverified';
    for(const key of ['requestedAt','checkedAt','validUntil','retryAt'])if(view[key]!==null)view[key]=new Date(view[key]).toISOString();
    return view;
  }
  reject(reason,code='CATALOG_UNVERIFIED'){
    this.failures++;this.details.checksFailed++;Object.assign(this.details,{activities:'blocked',recovering:true,validUntil:null,reason,reasonCode:code,retryAt:this.now()+[60000,120000,240000,300000][Math.min(this.failures-1,3)]});
  }
  verify(read,apply,{automatic=false,force=true}={}){
    if(this.pending)return this.pending;
    if(!force&&this.fresh())return Promise.resolve(true);
    if(automatic&&this.now()<(this.details.retryAt??0))return Promise.resolve(false);
    const generation=this.generation,requestedAt=this.now();
    this.details.checksStarted++;
    Object.assign(this.details,{activities:'checking',requestedAt,validUntil:null});
    const request=Promise.resolve().then(async()=>{
      try{
        const next=await read();
        if(generation!==this.generation)throw catalogUnverified('桌面连接已变化，旧核验回执未采用');
        const ready=next.catalogSource===this.source&&this.now()-requestedAt<this.maxAgeMs;
        await apply(next,generation);
        if(generation!==this.generation)throw catalogUnverified('桌面连接已变化，旧核验回执未采用');
        if(!ready||this.now()-requestedAt>=this.maxAgeMs){
          this.reject(next.catalogSource===this.source?'执行检查已过期，等待重新检查':next.verificationFailure?.reason||'桌面完整列表暂不可用，未取得可信活动状态',next.verificationFailure?.code);return false;
        }
        this.failures=0;this.details.checksSucceeded++;Object.assign(this.details,{activities:'verified',recovering:false,checkedAt:this.now(),validUntil:requestedAt+this.maxAgeMs,reason:'',reasonCode:null,retryAt:null,unavailableSources:next.unavailableSources??[]});return true;
      }catch(error){if(generation===this.generation)this.reject(error.message,error.code??'CATALOG_UNVERIFIED');throw error;}
      finally{if(this.pending===request)this.pending=null;}
    });this.pending=request;return request;
  }
  assertFresh(){if(!this.fresh())throw catalogUnverified(this.details.reason||'活动状态待核验，本次未发送');}
}
