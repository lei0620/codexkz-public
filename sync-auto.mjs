export class AutoTaskSync{
  constructor({enabled,fingerprint,blocked,run,now=Date.now,debounce=2000,interval=15000}){Object.assign(this,{enabled,fingerprint,blocked,run,now,debounce,interval});this.signature=null;this.due=0;this.running=false;this.failures=0;this.status='disabled';this.error='';}
  snapshot(){return {enabled:!!this.enabled(),status:this.status,error:this.error,nextAttemptAt:this.due?new Date(this.due).toISOString():null};}
  async tick(){
    if(this.running)return;
    if(!this.enabled()){this.status='disabled';this.signature=null;this.due=0;return;}
    let signature;try{signature=this.fingerprint();}catch(e){this.status='blocked';this.error=e.message;return;}
    const now=this.now();
    if(signature!==this.signature){this.signature=signature;this.due=now+this.debounce;this.status='waiting';}
    const reason=this.blocked();if(reason){this.status='blocked';this.error=reason;return;}
    if(this.status==='blocked'){this.status='waiting';this.error='';}
    if(now<this.due)return;
    this.running=true;this.status='syncing';this.error='';
    try{const result=await this.run();this.signature=this.fingerprint();this.failures=0;this.status=result?.pending?'waiting':'idle';this.due=this.now()+(result?.pending?this.debounce:this.interval);}
    catch(e){this.failures++;this.status='retrying';this.error=e.message;this.due=this.now()+Math.min(300000,5000*2**Math.min(this.failures-1,6));}
    finally{this.running=false;}
  }
}
