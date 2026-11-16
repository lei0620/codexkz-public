function validContext(context,current,projects){
  return context?.status==='confirmed'&&context.matched===true&&context.pageUrl===current.href&&
    projects.some(p=>p.projectId===context.projectId&&p.hostId==='local')&&
    ((['draft','project'].includes(context.kind)&&context.threadId==='')||(context.kind==='thread'&&typeof context.threadId==='string'&&/^[-a-zA-Z0-9]{1,100}$/.test(context.threadId)));
}
export function contextTarget(context,current,projects){
  if(!validContext(context,current,projects))return null;
  const next=new URL(current.href);next.searchParams.set('projectId',context.projectId);
  if(context.threadId)next.searchParams.set('threadId',context.threadId);else next.searchParams.delete('threadId');
  return next.href===current.href?null:next;
}
export class ProjectFollower {
  constructor({read,current,projects,apply,block,enabled,canApply=()=>true,intervalMs=2000,retryMs=500,allowPreview=true}){Object.assign(this,{read,current,projects,apply,block,enabled,canApply,intervalMs,retryMs,allowPreview});this.flight=null;this.timer=null;this.stopped=false;this.suspended=false;this.polling=false;this.loop=0;this.matched=false;this.generation=0;this.verified=false;this.allowedHref='';}
  check(){
    if(this.stopped||this.suspended)return Promise.resolve(false);
    if(!this.enabled())return Promise.resolve(true);
    if(this.flight)return this.flight;
    if(!this.verified)this.block(true);
    const current=new URL(this.current()),generation=++this.generation;
    const flight=Promise.resolve().then(()=>this.read(current.href)).then(context=>{
      if(this.stopped||this.suspended||generation!==this.generation||current.href!==this.current())return false;
      this.verified=true;
      if(context.status==='outside'&&context.matched===false){const blocked=this.matched||!this.allowPreview;this.allowedHref=blocked?'':current.href;this.block(blocked,blocked?'当前侧栏所属窗口暂不可见，请切回 Codex 后重试':'');return !blocked;}
      this.matched=true;
      if(!validContext(context,current,this.projects())){this.allowedHref='';this.block(true,context.reason||'当前项目正在自动识别');return false;}
      const target=contextTarget(context,current,this.projects());
      if(context.projectId!==current.searchParams.get('projectId')||context.threadId!==(current.searchParams.get('threadId')??'')){
        this.allowedHref='';this.block(true,this.canApply()?'':'当前保存或上传尚未结束，完成后会自动切换项目');if(target&&this.canApply()){this.stopped=true;if(this.apply(target)===false){this.stopped=false;this.allowedHref=this.current();this.block(false);return true;}}return false;
      }
      this.allowedHref=current.href;this.block(false);return true;
    }).catch(()=>{if(this.stopped||this.suspended||generation!==this.generation)return false;this.allowedHref='';this.verified=true;this.block(true,'当前项目读取超时或暂不可用，正在自动重试');return false;}).finally(()=>{if(this.flight===flight)this.flight=null;});
    this.flight=flight;return flight;
  }
  start(){
    if(this.stopped||this.polling)return;this.suspended=false;this.polling=true;const loop=++this.loop;
    const poll=async()=>{if(this.stopped||this.suspended||loop!==this.loop)return;await this.check();if(!this.stopped&&!this.suspended&&loop===this.loop)this.timer=setTimeout(poll,this.canWrite()?this.intervalMs:this.retryMs);};
    void poll();
  }
  canWrite(){return !this.stopped&&!this.suspended&&this.allowedHref===this.current();}
  pause(){this.allowedHref='';this.verified=false;this.flight=null;this.suspended=true;this.polling=false;this.loop++;this.generation++;clearTimeout(this.timer);}
  resume(){if(!this.stopped){this.suspended=false;this.start();}}
  stop(){this.pause();this.stopped=true;}
}

export function automaticAddress(current){const next=new URL(current);if(next.searchParams.get('follow')==='off')next.searchParams.delete('follow');return next;}

export function viewAddress(current,{view,projectId,projectHref}={}){
  const live=new URL(current),next=automaticAddress(new URL(view==='project'&&projectHref?projectHref:current,current).href);
  if(live.searchParams.has('panelSession'))next.searchParams.set('panelSession',live.searchParams.get('panelSession'));
  if(projectId!==undefined)next.searchParams.set('projectId',projectId);
  next.searchParams.set('view',view);
  if(view==='control')next.searchParams.delete('threadId');
  return next;
}
export function internalView(address,current){try{const next=new URL(address,current),base=new URL(current);return next.origin===base.origin&&next.pathname==='/'&&['project','control','versions','references'].includes(next.searchParams.get('view')??'project');}catch{return false;}}
