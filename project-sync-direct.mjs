import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {normalize,queuedThreadReason,matchingTurn,sourcePathsOverlap} from './core.mjs';
import {CURRENT_THREAD_DELIVERY,messageText,sameDispatchText} from './dispatch-state.mjs';
import {workflowProject} from './workflow.mjs';
import {sourceContext,sourceBindingRequired} from './source-binding.mjs';
import {publicationTransient,validateProjectCatalog} from './project-transfer.mjs';

export const legacyDirectSyncPrompt=`同步当前原项目，直接在本对话执行并返回结果，不创建同步任务卡或新的执行对话。
沿用本项目已有规范、交接、仓库、上游及本机运行入口。老项目按增量同步处理：复用已确认的配置和已有验证结果，只核对当前目录/仓库/分支及工作区，再fetch确认远端变化；不重复首次初始化、全仓扫描、安装依赖或无变化的完整测试。
远端独有且工作区干净时快进拉取；本机独有提交核对归属和验证后推送，未提交修改仅提交本次获准且验证通过的范围；一致则只核验。分叉、目标不明或修改阻挡拉取时保留现场并报告，不强推、不reset、不自动stash。回执不明只读核对，不重发。
只有新代码、配置变化或实际服务缺项时才按既有流程补验证、部署或安全重启；保留在途任务及原数据。已配置的待办同步用原入口增量合并并校验附件，冲突保留；不复制data、凭据、.codex或对话/执行历史，不解除领取或重发旧任务。修改C盘已有持久文件前按规则备份。
报告同步方向、远端SHA、待办/附件及本机加载结果；另一台未实测标待验收。必要时更新现有短交接。同步是本次独立操作，不作为此前开发任务的完成或验收；完成后停止。`;

export const directSyncPrompt=legacyDirectSyncPrompt.replace('报告同步方向、远端SHA、待办/附件及本机加载结果','若原面板已经支持 projectBoardSyncSupported，走原 /api/sync/run 入口时附上本机核对过的当前 projectId，一次同步待办及该项目的看板和资料。报告同步方向、远端SHA、待办/看板/资料/附件及本机加载结果');
const reject=(message,cause)=>{throw Object.assign(Error(message),{notApplied:true,...(cause?.code?{code:cause.code}:{}),...(cause?.bytes?{bytes:cause.bytes,limitBytes:cause.limitBytes}: {})});};
export const directSyncText=(project,prompt=directSyncPrompt)=>prompt+sourceContext(project);
const nativeReceiptMarker='\n\n[LEIX 同步回执标识]\n';
const requestIdPattern=/^project-sync-[a-zA-Z0-9-]{1,70}$/;
const validReceiptTurnId=id=>typeof id==='string'&&id.length>0&&id.length<=100;
const composerSyncText=(prompt,id)=>prompt+nativeReceiptMarker+id;
const nativeReceipt=record=>record.nativeReceiptVersion===1&&requestIdPattern.test(record.id)&&[directSyncPrompt,legacyDirectSyncPrompt].some(prompt=>record.dispatchPrompt===composerSyncText(directSyncText(record,prompt),record.id));
export function isDirectSyncText(text){
  if(typeof text!=='string')return false;
  const marker=text.indexOf(nativeReceiptMarker);
  if(marker>=0){if(marker!==text.lastIndexOf(nativeReceiptMarker)||!requestIdPattern.test(text.slice(marker+nativeReceiptMarker.length)))return false;text=text.slice(0,marker);}
  for(const prompt of [directSyncPrompt,legacyDirectSyncPrompt]){
    if(text===prompt)return true;
    const prefix=prompt+'\n\n[本机已确认的源码关联]\n';
    if(!text.startsWith(prefix))continue;
    try{const p=JSON.parse(text.slice(prefix.length).split('\n')[0]);if(Object.keys(p).length!==3||['entryPath','sourcePath','repository'].some(k=>typeof p[k]!=='string'||!p[k]))return false;return text===directSyncText({path:p.entryPath,sourcePath:p.sourcePath,repository:p.repository},prompt);}catch{return false;}
  }
  return false;
}
const hash=value=>createHash('sha256').update(value).digest('hex');
const held=r=>r.occupancyReleased!==true&&['queued','sending','submitted','invoked','uncertain'].includes(r.status);
function syncInputMatches(item,prompt,composer){
  const text=messageText(item);if(sameDispatchText(text,prompt))return true;
  if(!composer||item.type!=='userMessage')return false;
  const value=text.replaceAll('\r\n','\n'),expected=prompt.replaceAll('\r\n','\n');
  // The editor can serialize hard line breaks as Markdown. Match the whole
  // generated request, including its marker, without rewriting arbitrary text.
  if(value.includes('\\\n')&&expected.includes(nativeReceiptMarker)&&isDirectSyncText(expected)){
    const escaped=expected.replaceAll('\n','\\\n');
    if(value===escaped||value===escaped+'\n')return true;
  }
  // The desktop stores its ambient browser block before the actual request.
  // Strip only this complete, leading envelope; never search arbitrary text.
  const prefix='<in-app-browser-context source="ambient-ui-state">\n',start=value.startsWith('\n')?1:0;
  if(!value.startsWith(prefix,start))return false;
  const end=value.indexOf('\n</in-app-browser-context>\n\n## My request:\n',start+prefix.length);
  if(end<0||end-start>8192)return false;
  const header=value.slice(start+prefix.length,end);
  if(header.includes('<in-app-browser-context')||header.includes('</in-app-browser-context>'))return false;
  const body=value.slice(end+'\n</in-app-browser-context>\n\n## My request:\n'.length);
  return body===expected||body===expected+'\n';
}
const syncInputIndices=(turn,prompt,composer=false)=>(turn.items??[]).flatMap((i,index)=>(['userMessage','steeringUserMessage'].includes(i.type)||i.type==='functionCallOutput'&&/^(?:.*__)?send_message_to_thread$/.test(i.name??''))&&syncInputMatches(i,prompt,composer)?[index]:[]);
const syncInputs=(turn,prompt)=>syncInputIndices(turn,prompt,true).length;
const syncResultAfter=(turn,index)=>turn.partial!==true&&(turn.items??[]).slice(index+1).some(i=>i.type==='agentMessage'&&['final','final_answer'].includes(i.phase));
function composerSyncTurn(turns,record){
  if(turns.some(t=>!validReceiptTurnId(t.id))||new Set(turns.map(t=>t.id)).size!==turns.length)return;
  if(nativeReceipt(record)){
    const counts=turns.map(t=>syncInputIndices(t,record.dispatchPrompt,true).length);
    if(counts.some(n=>n>1))return;
    const matches=turns.filter((t,i)=>counts[i]===1);
    return matches.length===1&&(!record.turnId||matches[0].id===record.turnId)&&syncResultAfter(matches[0],syncInputIndices(matches[0],record.dispatchPrompt,true)[0])?matches[0]:undefined;
  }
  if(record.turnId)return turns.find(t=>t.id===record.turnId);
  const index=turns.findIndex(t=>t.id===record.baseline);if(index<0)return;
  const prompt=record.dispatchPrompt??legacyDirectSyncPrompt,fresh=turns.slice(0,index),counts=fresh.map(t=>syncInputIndices(t,prompt,true).length);
  if(counts.some(n=>n>1))return;
  const matches=fresh.filter((t,i)=>counts[i]===1),baseline=turns[index];
  if(Number.isInteger(record.nativeBaselineMatches)&&Number.isInteger(record.nativeBaselineSize)&&record.nativeBaselineSize>=0&&baseline.partial!==true){const indices=syncInputIndices(baseline,prompt,true),count=indices.length;if(count>record.nativeBaselineMatches+1)return;if(count===record.nativeBaselineMatches+1&&indices.at(-1)>=record.nativeBaselineSize)matches.push(baseline);}
  return matches.length===1&&syncResultAfter(matches[0],syncInputIndices(matches[0],prompt,true).at(-1))?matches[0]:undefined;
}
function endedBeforeCurrentComposerTurn(record,before,turn){
  const thread=before.thread,status=thread?.status?.type??thread?.status,head=before.turns?.[0],headStatus=head?.status?.type??head?.status;
  if(thread?.id!==record.threadId||normalize(thread.cwd??'')!==normalize(record.path)||thread.kind!=='codex'||thread.hostId!=='local'||thread.activityUnknown===true)return false;
  if(!['active','running','inProgress'].includes(status)||thread.status?.activeFlags?.length||!['inProgress','running'].includes(headStatus)||!head?.id||head.id===turn?.id)return false;
  if(before.turns.some(t=>(t.status?.type??t.status)==='waitingForApproval'))return false;
  const index=before.turns.indexOf(turn),baseline=before.turns.findIndex(t=>t.id===record.baseline);
  if(index<1||!nativeReceipt(record)&&baseline<index||turn.partial===true)return false;
  // Reprove unique input/baseline/final evidence even for a persisted turn ID.
  return composerSyncTurn(before.turns,{...record,turnId:undefined})===turn;
}
function idleReceiptWindow(before,record){
  if(record.deliveryKind!=='composer'||record.status!=='invoked'||record.turnId||before.source==='local-session-recent')return;
  const thread=before.thread;
  if(thread?.id!==record.threadId||normalize(thread.cwd??'')!==normalize(record.path)||thread.kind!=='codex'||thread.hostId!=='local'||thread.activityUnknown===true||(thread.status?.type??thread.status)!=='idle'||thread.status?.activeFlags?.length)return;
  const turns=before.turns??[],index=turns.findIndex(t=>t.id===record.baseline);
  if(index<1||turns.some(t=>!validReceiptTurnId(t.id))||new Set(turns.map(t=>t.id)).size!==turns.length)return;
  const window=turns.slice(0,index+1),baseline=turns[index],prompt=record.dispatchPrompt??legacyDirectSyncPrompt;
  const checkedTurns=nativeReceipt(record)?turns:window;
  if(checkedTurns.some(t=>t.partial===true||!['completed','failed','interrupted'].includes(t.status?.type??t.status)))return;
  if(!Number.isInteger(record.nativeBaselineMatches)||!Number.isInteger(record.nativeBaselineSize)||record.nativeBaselineSize<0||(baseline.items??[]).length<record.nativeBaselineSize||syncInputs(baseline,prompt)!==record.nativeBaselineMatches)return;
  return {later:window.slice(0,-1),prompt};
}
function idleReceiptRelease(before,record){
  const evidence=idleReceiptWindow(before,record);
  if(!evidence)return;
  const {later,prompt}=evidence;
  if(nativeReceipt(record)){
    if(later.length>10)return;
    return {releaseReason:'idle-after-native-baseline',idleTurnIds:later.map(t=>t.id)};
  }
  if(record.nativeReceiptVersion!==undefined)return;
  const counts=later.map(t=>syncInputIndices(t,prompt,true).length);
  if(counts.some(n=>n>1))return;
  const candidates=later.filter((t,i)=>counts[i]===1);
  if(candidates.length<2||candidates.length>10||candidates.some(t=>!syncResultAfter(t,syncInputIndices(t,prompt,true)[0])))return;
  return {releaseReason:'terminal-candidates-unlinked',candidateTurnIds:candidates.map(t=>t.id)};
}
function validReceiptRelease(record){
  if(record.occupancyReleased!==true||record.status!=='invoked'||record.deliveryKind!=='composer'||record.turnId||!Number.isFinite(Date.parse(record.releasedAt))||record.publication&&record.publishStatus!=='skipped')return false;
  const legacy=record.releaseReason==='terminal-candidates-unlinked'&&record.nativeReceiptVersion===undefined;
  const native=record.releaseReason==='idle-after-native-baseline'&&nativeReceipt(record)&&validReceiptTurnId(record.baseline);
  if(!legacy&&!native)return false;
  const ids=legacy?record.candidateTurnIds:record.idleTurnIds;
  return Array.isArray(ids)&&ids.length>=(legacy?2:1)&&ids.length<=10&&ids.every(id=>validReceiptTurnId(id)&&id!==record.baseline)&&new Set(ids).size===ids.length;
}
const targetReason=(record,before)=>queuedThreadReason({...record,deliveryKind:CURRENT_THREAD_DELIVERY},before);
const queueable=(record,before)=>{
  const thread=before?.thread,status=thread?.status?.type??thread?.status;
  return thread?.id===record.threadId&&normalize(thread.cwd)===normalize(record.path)&&(!thread.kind||thread.kind==='codex')&&(!thread.hostId||thread.hostId==='local')&&['idle','active','running','inProgress','waitingForInput','waitingForApproval'].includes(status);
};
// This local journal is independent of tasks/jobs and never crosses machines.
// Reserve and fsync before the RPC; replay an unknown result without resending.
export class DirectProjectSync{
  constructor({root,read,readReceipt=read,readComposerBaseline=read,send,validate,guard=()=>{},composerSend,validateComposer,guardComposer=()=>{},publication,scopeFor=value=>value,diagnose=()=>{},io=fs,now=Date.now}){
    Object.assign(this,{read,readReceipt,readComposerBaseline,send,validate,guard,composerSend,validateComposer,guardComposer,publication,scopeFor,io,now});this.diagnose=input=>{try{diagnose(input);}catch{}};this.file=path.join(root,'data','project-sync-receipts.jsonl');this.records=new Map();this.active=new Map();this.activeScopes=new Map();this.publishing=new Set();this.fault='';
    try{for(const line of io.readFileSync(this.file,'utf8').split('\n').filter(Boolean)){
      const r=JSON.parse(line);
      if(!requestIdPattern.test(r.id)||!/^[a-f0-9]{64}$/.test(r.signature)||typeof r.projectId!=='string'||typeof r.threadId!=='string'||typeof r.path!=='string'||!['queued','sending','submitted','invoked','uncertain','finished','not-applied'].includes(r.status))throw Error('invalid receipt');
      if(r.nativeReceiptVersion!==undefined&&!nativeReceipt(r))throw Error('invalid native receipt');
      if(r.occupancyReleased!==undefined&&!validReceiptRelease(r))throw Error('invalid released receipt');
      if(r.status==='queued'&&(typeof r.repository!=='string'||!r.repository))throw Error('invalid queued project');
      if(r.status==='sending')r.status='uncertain';this.records.set(r.id,r);
    }}catch(error){if(error.code!=='ENOENT')this.fault='同步发送回执异常，已停止发送，请核对当前对话';}
  }
  save(record){
    this.io.mkdirSync(path.dirname(this.file),{recursive:true});const fd=this.io.openSync(this.file,'a');
    try{this.io.writeFileSync(fd,JSON.stringify(record)+'\n');this.io.fsyncSync(fd);}catch(error){this.fault='同步发送回执写入失败，请核对当前对话';throw error;}finally{this.io.closeSync(fd);}
  }
  jobs(){return [...this.records.values()].filter(held).map(r=>({id:r.id,projectId:r.projectId,path:r.path,threadId:r.threadId,status:r.status==='invoked'?'submitted':['queued','submitted'].includes(r.status)?r.status:'uncertain',allowParallel:false,syncReceipt:true}));}
  hasWork(){return !!this.jobs().length||[...this.records.values()].some(r=>r.publishStatus==='pending');}
  projectBusy(id){return [...this.activeScopes.values()].some(r=>r.projectId===id)||[...this.records.values()].some(r=>r.projectId===id&&(held(r)||r.publishStatus==='pending'));}
  activeJobs(){return [...this.activeScopes.values()].map(({signature,...scope})=>({...scope}));}
  activeReason(target){return this.activeJobs().some(record=>this.conflicts(record,target,target.threadId))?'本项目或共用源码/对话正在提交同步请求，提交完成后自动重查':'';}
  snapshot(){const latest=new Map();for(const r of this.records.values())if(r.publishStatus)latest.set(r.projectId,r);return {pending:this.jobs().length,queued:[...this.records.values()].filter(r=>r.status==='queued').map(r=>({projectId:r.projectId,threadId:r.threadId})),sending:this.active.size>0,fault:this.fault||null,publications:[...latest.values()].slice(-20).map(r=>({projectId:r.projectId,status:r.publishStatus,error:r.publishError??'',commit:r.published?.commit??null}))};}
  conflicts(record,project,threadId){
    if(record.projectId===project.projectId||record.threadId===threadId)return true;
    // Keep frozen dispatch roots as locks alongside verified current mappings.
    // A missing/failed projection cannot prove that a receipt is unrelated.
    let scopes;try{scopes=[record,project].map(value=>[value,this.scopeFor(value)]);}catch(error){reject('同步回执的项目或源码范围尚未确认，尚未发送',error);}
    if(scopes.flat().some(value=>!value||typeof value.path!=='string'||!value.path||value.sourcePath!==undefined&&typeof value.sourcePath!=='string'))reject('同步回执的项目或源码范围尚未确认，尚未发送');
    return scopes[0].some(left=>scopes[1].some(right=>sourcePathsOverlap(left,right)));
  }
  async reconcile({duringSubmit=false,project,threadId,requestId}={}){
    if(this.fault)return;
    const selected=record=>!project||this.conflicts(record,project,threadId);
    const activeConflict=record=>this.activeJobs().some(scope=>(!duringSubmit||scope.id!==requestId)&&this.conflicts(scope,record,record.threadId));
    for(const record of this.records.values())if(held(record)&&record.status!=='queued'&&!this.active.has(record.id)&&selected(record)&&!activeConflict(record))try{
      const before=await this.readReceipt(record.threadId,record);
      const turn=record.deliveryKind==='composer'?composerSyncTurn(before.turns??[],record):matchingTurn(before.turns??[],{threadId:record.threadId,baseline:record.baseline,turnId:record.turnId,dispatchVersion:2,dispatchPrompt:record.dispatchPrompt??legacyDirectSyncPrompt});
      if(!turn){
        const release=idleReceiptRelease(before,record);
        const stillHeld=()=>!activeConflict(record)&&![...this.records.values()].some(other=>other!==record&&held(other)&&this.conflicts(other,record,record.threadId))&&this.records.get(record.id)===record;
        if(release&&stillHeld()){
          if(release.releaseReason==='idle-after-native-baseline'){
            const fresh=await this.readReceipt(record.threadId,record);
            if(JSON.stringify(idleReceiptRelease(fresh,record))!==JSON.stringify(release)||
              composerSyncTurn(fresh.turns??[],record)||!stillHeld())continue;
          }
          const next={...record,...release,occupancyReleased:true,releasedAt:new Date(this.now()).toISOString(),...(record.publication?{publishStatus:'skipped'}:{})};this.save(next);this.records.set(next.id,next);
        }
        continue;
      }
      if(!turn||!['completed','failed','interrupted'].includes(turn.status?.type??turn.status))continue;
      if(queuedThreadReason({threadId:record.threadId,path:record.path},before)&&!(record.deliveryKind==='composer'&&endedBeforeCurrentComposerTurn(record,before,turn)))continue;
      if(this.records.get(record.id)!==record||activeConflict(record))continue;
      const next={...record,status:'finished',turnId:turn.id,...(record.publication?{publishStatus:(turn.status?.type??turn.status)==='completed'?'pending':'skipped'}:{})};this.save(next);this.records.set(next.id,next);
    }catch(error){this.diagnose({phase:'sync-reconcile',projectId:record.projectId,threadId:record.threadId,jobId:record.id,error});/* Unknown results retain the lock. */}
    if(!duringSubmit)for(const record of this.records.values())if(record.status==='queued'&&!this.active.has(record.id)&&selected(record)&&!activeConflict(record)){
      const scope={...record};this.activeScopes.set(record.id,scope);
      const work=Promise.resolve().then(async()=>{
        const project={projectId:record.projectId,path:record.path,hostId:'local',repository:record.repository,...(record.sourcePath?{sourcePath:record.sourcePath}:{})};
        let before=await this.read(record.threadId);
        if(targetReason(record,before)||!before.turns?.[0]?.id)return;
        await this.validate(project,record.threadId);
        before=await this.read(record.threadId);
        if(targetReason(record,before)||!before.turns?.[0]?.id)return;
        await this.dispatch({...record,baseline:before.turns[0].id},project);
      }).catch(error=>{this.diagnose({phase:'sync-queue',projectId:record.projectId,threadId:record.threadId,jobId:record.id,error});}).finally(()=>{this.active.delete(record.id);this.activeScopes.delete(record.id);});
      this.active.set(record.id,work);await work;
    }
    if(!duringSubmit)for(const initial of this.records.values())if(initial.status==='finished'&&initial.publishStatus==='pending'&&selected(initial)&&!activeConflict(initial)&&!this.publishing.has(initial.id)&&this.now()>=(initial.publishRetryAt??0)){
      // Retiring an older receipt must not publish code being changed by a
      // later active turn. Publication keeps its own fresh idle/identity gate.
      this.publishing.add(initial.id);let record=initial;
      try{
        if(initial.deliveryKind==='composer'){
          let before;try{before=await this.read(initial.threadId);}catch{continue;}
          if(queuedThreadReason({threadId:initial.threadId,path:initial.path},before)||this.records.get(initial.id)!==initial||activeConflict(initial))continue;
        }
        if(record.publication?.recoveryVersion===1&&!record.publicationOffer){
          const offer=validateProjectCatalog({version:1,projects:[await this.publication.resolve(record)]}).projects[0];
          record={...record,publicationOffer:offer};this.save(record);this.records.set(record.id,record);
        }
        const published=await this.publication.finish(record);const next={...record,publishStatus:'published',published,publishError:'',publishRetryAt:null};this.save(next);this.records.set(next.id,next);
      }catch(error){
        this.diagnose({phase:'sync-publication',projectId:record.projectId,threadId:record.threadId,jobId:record.id,error});
        const retry=record.publication?.recoveryVersion===1&&!this.fault&&publicationTransient(error),attempts=(record.publishAttempts??0)+1;
        const next={...record,publishStatus:retry?'pending':'failed',publishError:error.message,publishAttempts:attempts,publishRetryAt:retry?this.now()+[6000,15000,30000,60000][Math.min(attempts-1,3)]:null};
        try{this.save(next);this.records.set(next.id,next);}catch{}
      }finally{this.publishing.delete(initial.id);}
    }
  }
  async dispatch(record,project){
    this.guard(project,record.threadId);
    record={...record,status:'sending',...(this.publication?{publication:this.publication.prepare(project)}:{})};
    try{this.save(record);}catch{reject('同步请求无法保存，尚未发送',{code:'STORAGE_FAULT'});}this.records.set(record.id,record);
    let phase='sync-send';try{
      const result=await this.send({threadId:record.threadId,hostId:'local',prompt:record.dispatchPrompt??directSyncText(project,legacyDirectSyncPrompt)});
      if(result?.threadId!==record.threadId)throw Error('unknown send receipt');
      phase='sync-receipt-save';record.status='submitted';this.save(record);return {status:'submitted'};
    }catch(error){this.diagnose({phase,projectId:record.projectId,threadId:record.threadId,jobId:record.id,code:'RECEIPT_UNCONFIRMED',error,notApplied:false});record.status='uncertain';try{this.save(record);}catch{}return {status:'uncertain'};}
  }
  async submitComposer(input,project,{prompt,signature,timing}){
    timing?.mark('validation.begin');
    await this.validateComposer(project,input.threadId);
    timing?.mark('validation.end');timing?.mark('baseline.begin');
    let before;try{before=await this.readComposerBaseline(input.threadId);}catch(error){reject('当前聊天同步基线读取失败，尚未操作输入框：'+error.message,error);}
    timing?.mark('baseline.end');
    const thread=before?.thread;if(thread?.id!==input.threadId||normalize(thread.cwd)!==normalize(project.path)||thread.kind&&thread.kind!=='codex'||thread.hostId&&thread.hostId!=='local'||!before.turns?.[0]?.id)reject('无法确认当前聊天及同步基线，尚未操作输入框');
    this.guardComposer(project,input.threadId);
    const record={id:input.requestId,signature,projectId:project.projectId,path:project.path,threadId:input.threadId,repository:project.repository,deliveryKind:'composer',nativeReceiptVersion:1,dispatchPrompt:prompt,baseline:before.turns[0].id,nativeBaselineMatches:before.turns[0].partial===true?null:syncInputs(before.turns[0],prompt),nativeBaselineSize:before.turns[0].items?.length??0,status:'sending',...(project.sourcePath?{sourcePath:project.sourcePath}:{}),...(this.publication?{publication:this.publication.prepare(project)}:{})};
    try{this.save(record);}catch{reject('同步请求无法保存，尚未操作输入框',{code:'STORAGE_FAULT'});}this.records.set(record.id,record);
    timing?.mark('intent.saved');
    let invoked=false;try{
      timing?.mark('window.begin');
      let result;try{result=await this.composerSend({...input,description:prompt,timing:!!timing},timing);}finally{timing?.mark('window.end');}
      if(result?.status!=='invoked')throw Error('native sync invocation unconfirmed');invoked=true;
      record.status='invoked';this.save(record);return {status:'invoked'};
    }catch(error){
      if(!invoked&&error.notApplied===true){record.status='not-applied';try{this.save(record);}catch{record.status='uncertain';return {status:'uncertain'};}reject(error.message,error);}
      record.status='uncertain';try{this.save(record);}catch{}this.diagnose({phase:'sync-composer',projectId:record.projectId,threadId:record.threadId,jobId:record.id,error,notApplied:false});return {status:'uncertain'};
    }
  }
  submit(input,project,{composer=false,timing}={}){
    timing?.mark('pipeline.begin');
    if(this.fault)reject(this.fault,{code:'STORAGE_FAULT'});
    if(!project)reject('当前项目尚未确认，请刷新后重试');
    try{workflowProject(project);}catch(error){reject(error.message);}
    if(normalize(input.path)!==normalize(project.path))reject('项目目录已变化，请刷新后重试');
    if(!project.repository||project.repositoryReason)reject(project.repositoryReason||sourceBindingRequired);
    if(typeof input.requestId!=='string'||!/^project-sync-[a-zA-Z0-9-]{1,70}$/.test(input.requestId)||typeof input.threadId!=='string'||!/^[-a-zA-Z0-9]{1,100}$/.test(input.threadId))reject('请在当前项目的已有对话中同步');
    const existing=this.records.get(input.requestId);
    const template=!existing||existing.dispatchPrompt?.startsWith(directSyncPrompt)?directSyncPrompt:legacyDirectSyncPrompt;
    const basePrompt=directSyncText(project,template),prompt=composer&&(!existing||existing.nativeReceiptVersion===1)?composerSyncText(basePrompt,input.requestId):basePrompt;
    if(composer&&(!Array.isArray(input.attachmentIds??[])||(input.attachmentIds??[]).some(id=>typeof id!=='string')))reject('同步附件标识无效，尚未操作输入框');
    const signature=hash(JSON.stringify([project.projectId,normalize(project.path),project.repository,input.threadId,prompt,...(composer?[{deliveryKind:'composer',attachmentIds:input.attachmentIds??[]}]:[])])),old=this.records.get(input.requestId);
    if(old){if(old.signature!==signature)reject('同步请求已用于其他项目或对话，或其他提交入口');if(old.status==='not-applied')reject('原同步请求未操作输入框，请重新点击发起');if(old.occupancyReleased===true)reject('原同步占用已回收，具体轮次关联仍未确认；请用新请求同步，不会重发旧消息');return this.active.get(input.requestId)??Promise.resolve({status:old.status,replayed:true});}
    const inFlight=this.activeScopes.get(input.requestId);
    if(inFlight){if(inFlight.signature!==signature)reject('同步请求已用于其他项目或对话');return this.active.get(input.requestId);}
    const scope={id:input.requestId,signature,projectId:project.projectId,path:project.path,threadId:input.threadId,...(project.sourcePath?{sourcePath:project.sourcePath}:{})};
    if(this.activeReason(scope))reject('本项目或共用源码/对话正在发送同步请求，请稍后再操作');
    this.activeScopes.set(input.requestId,scope);
    const work=Promise.resolve().then(async()=>{
      timing?.mark('reconcile.begin');
      await this.reconcile({duringSubmit:true,project,threadId:input.threadId,requestId:input.requestId});
      timing?.mark('reconcile.end');
      if([...this.records.values()].some(record=>held(record)&&this.conflicts(record,project,input.threadId)))reject('本项目或共用源码/对话的上次同步仍在执行或回执待核对，请先查看原对话；不会重复发送');
      if(composer)return this.submitComposer(input,project,{prompt,signature,timing});
      let before;try{before=await this.read(input.threadId);}catch(error){reject('当前对话读取失败，尚未发送：'+error.message,error);}
      const target={threadId:input.threadId,path:project.path},reason=targetReason(target,before);if(reason&&!queueable(target,before))reject(reason);
      if(typeof before.turns?.[0]?.id!=='string'||!before.turns[0].id)reject('当前对话轮次尚未确认，请等待加载后再同步');
      let waiting=!!reason;try{await this.validate(project,input.threadId);}catch(error){if(error.code!=='EXECUTION_WAIT')throw error;waiting=true;}
      if(!waiting){
        try{before=await this.read(input.threadId);}catch(error){reject('当前对话读取失败，尚未发送：'+error.message,error);}
        const latestReason=targetReason(target,before);if(latestReason&&!queueable(target,before))reject(latestReason);
        if(!before.turns?.[0]?.id)reject('当前对话轮次尚未确认，请等待加载后再同步');
        waiting=!!latestReason;
      }
      const record={id:input.requestId,signature,projectId:project.projectId,threadId:input.threadId,path:project.path,repository:project.repository,baseline:before.turns[0].id,status:'queued',dispatchPrompt:prompt,...(project.sourcePath?{sourcePath:project.sourcePath}:{})};
      if(!waiting){try{return await this.dispatch(record,project);}catch(error){if(error.code!=='EXECUTION_WAIT')throw error;}}
      try{this.save(record);}catch{reject('同步请求无法保存，尚未发送',{code:'STORAGE_FAULT'});}this.records.set(record.id,record);return {status:'queued'};
    }).finally(()=>{this.active.delete(input.requestId);this.activeScopes.delete(input.requestId);});
    this.active.set(input.requestId,work);return work;
  }
}
