import {checkRelease} from './release-check.mjs';
import {compareReleaseVersions,selectReleaseAsset,verifyReleaseManifest} from './release-manifest.mjs';

const DAY=24*60*60*1000;
// Persistence is injected by the installed-mode owner; an attempt is committed
// before networking, so a crash cannot turn startup into an unbounded poll.
export class ReleaseScheduler{
  constructor({read,write,publicKey,version,platform,arch,now=Date.now,check=checkRelease}){
    Object.assign(this,{read,write,publicKey,version,platform,arch,now,check});this.pending=null;
  }
  view(saved){
    if(!saved?.envelope)return {available:false};
    const manifest=verifyReleaseManifest(saved.envelope,this.publicKey),asset=selectReleaseAsset(manifest,this);
    return {available:!!asset,version:manifest.version,notes:manifest.notes};
  }
  checkNow({manual=false}={}){
    if(this.pending)return this.pending;
    this.pending=this.#run(manual).finally(()=>{this.pending=null;});return this.pending;
  }
  async #run(manual){
    const saved=await this.read();
    if(saved!==null&&(!saved||saved.version!==1||!Number.isSafeInteger(saved.lastAttempt)||saved.lastAttempt<0))throw Error('更新检查记录异常，未进行网络请求');
    const record=saved??{version:1,lastAttempt:0,envelope:null},current=this.now();
    if(!Number.isSafeInteger(current)||current<=0)throw Error('本机时间异常，未进行网络请求');
    const previous=this.view(record);
    if(!manual&&record.lastAttempt&&current-record.lastAttempt<DAY)return {status:'cached',...previous};
    const attempted={...record,lastAttempt:Math.max(current,record.lastAttempt)};await this.write(attempted);
    try{
      const result=await this.check({publicKey:this.publicKey,version:this.version,platform:this.platform,arch:this.arch});
      if(!result?.envelope)throw Error('更新检查未返回签名清单');
      const next={...attempted,envelope:result.envelope};const view=this.view(next);
      if(previous.version&&view.version&&compareReleaseVersions(view.version,previous.version)<0)throw Error('发行清单版本倒退');
      if(previous.version===view.version&&record.envelope?.payload!==result.envelope.payload)throw Error('相同版本的发行内容发生变化');
      await this.write(next);return {status:'checked',...view};
    }catch{return {status:'error',...previous};}
  }
}
