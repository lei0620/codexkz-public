import {portableWorkflow,validateWorkflow,validateWorkflowRelations,applyWorkflows} from './workflow-sync.mjs';
import {portableStructure,applyStructures} from './task-sections.mjs';
import {validateStructure,validateStructureRelations} from './structure-sync.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {richRecord,richFields,validateRich,applyRichFields} from './rich-sync.mjs';
import {validateProjectIdentities} from './repository-identity.mjs';
import {validateProjectCatalog} from './project-transfer.mjs';
import {boardSyncKey,keepChatDescriptionLocal,maxBoardFile,validateBoard} from './board-sync.mjs';

const fields=['id','logicalId','projectName','title','description','tag','deleted'];
const equal=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const richKeys=['priority','attributes','attachments'];
const clean=record=>Object.fromEntries([...fields,...(record.priority!==undefined?richKeys:[]),...(record.structure?['structure']:[]),...(record.workflow?['workflow']:[])].map(key=>[key,record[key]]));
export function mergeDeletedDependencies(local,remote){
  if(!local?.deleted||!remote?.deleted||!local.structure||!remote.structure)return null;
  const withoutDeps=r=>({...r,structure:{...r.structure,dependsOn:[]}});
  if(!equal(withoutDeps(local),withoutDeps(remote)))return null;
  const dependsOn=[...new Set([...local.structure.dependsOn,...remote.structure.dependsOn])].sort();
  if(dependsOn.length>20||dependsOn.includes(local.id))return null;
  return {...local,structure:{...local.structure,dependsOn}};
}
export function githubRequestError(stderr='',timeout=false){
  const status=Number(/HTTP\s+(\d{3})/i.exec(stderr)?.[1])||0;
  const retryableRead=timeout||[408,429].includes(status)||status>=500||(!status&&/timeout|timed out|connection reset|connection refused|TLS handshake|\bEOF\b|no such host|resolve host|network is unreachable/i.test(stderr));
  const message=status===404?'同步分支或文件不存在':[401,403].includes(status)?'GitHub 登录或仓库权限异常，请检查本机授权':status===409||status===422?'远端同步内容已变化，请重新同步核对':retryableRead?'GitHub 同步读取暂时不可用':'GitHub 同步失败，请检查本机登录、网络或远端冲突';
  return Object.assign(Error(message),{notFound:status===404,retryableRead});
}
export function validateEnvelope(value){
  if(![1,2,3,4].includes(value?.version)||!Array.isArray(value.records)||value.records.length>5000)throw new Error('待办同步格式不受支持');
  const allowed=value.version>=2?[...fields,...richKeys,...(value.version>=3?['structure']:[]),...(value.version>=4?['workflow']:[])]:fields;
  const seen=new Set();
  for(const r of value.records){
    if(!r||Object.keys(r).some(k=>!allowed.includes(k))||typeof r.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(r.id)||['__proto__','constructor','prototype'].includes(r.id)||seen.has(r.id))throw new Error('同步待办包含无效或重复 ID');
    seen.add(r.id);
    for(const key of ['logicalId','projectName','title','description'])if(typeof r[key]!=='string'||r[key].length>(key==='description'?30000:200))throw new Error('同步待办字段超长或缺失');
    if(!r.logicalId.trim()||!r.title.trim()||/[\\/\x00-\x1f]/.test(r.logicalId)||['__proto__','constructor','prototype'].includes(r.logicalId)||!(value.version>=2?['feature','bug','improvement','none','custom']:['feature','bug','improvement']).includes(r.tag)||typeof r.deleted!=='boolean')throw new Error('同步待办字段无效');
    if(value.version>=2)validateRich(r);if(r.structure)validateStructure(r.structure);if(r.workflow)validateWorkflow(r.workflow);
  }
  validateStructureRelations(value.records);validateWorkflowRelations(value.records);
  const envelope={version:value.version,records:value.records.map(clean).sort((a,b)=>a.id.localeCompare(b.id)),...(value.projects!==undefined?{projects:validateProjectIdentities(value.projects)}:{})};
  if(Buffer.byteLength(JSON.stringify(envelope,null,2))>900*1024)throw new Error('待办同步文件超过 900 KiB，请精简任务说明后重试；保留移出记录以避免重复接收');
  return envelope;
}
export function initializeSync(state){state.sync??={base:[],conflicts:[],overrides:{}};state.sync.base??=[];state.sync.conflicts??=[];state.sync.overrides??={};}
export function portableTasks(state){
  const rich=state.sync.config?.schemaVersion>=2;
  const result=new Map(state.sync.base.map(r=>[r.id,rich?richRecord(clean(r)):clean(r)]));
  for(const task of state.tasks){
    if(task.boardSyncReplica)continue;
    const mapping=state.workspace.mappings[task.projectId];if(!mapping||mapping.localOnly)continue;
    const id=task.syncId??task.id,previous=result.get(id),deleted=task.status!=='todo'||!!task.archivedAt||!!task.syncReserved;
    // A completed chat can update its local task description. Retiring the old
    // portable task must not publish that new chat text through its tombstone.
    const description=deleted&&keepChatDescriptionLocal(task)?previous?.description??'':task.description;
    const record={id,logicalId:mapping.logicalId,projectName:previous?.projectName??mapping.logicalName,title:task.title,description,tag:task.tag,deleted};
    if(rich){Object.assign(record,richFields(task));if(!['feature','bug','improvement','none'].includes(record.tag))record.tag='custom';}
    // A removed record only needs its existing portable type, not a newer local custom option.
    if(!rich&&record.deleted&&!['feature','bug','improvement'].includes(record.tag))record.tag=result.get(id)?.tag??'feature';
    const structure=portableStructure(state,task);if(structure){if(!rich)throw Error('版块与依赖需要完整卡片同步');record.structure=structure;}
    const workflow=portableWorkflow(state,task);if(workflow){if(!rich)throw Error('讨论状态与父子关系需要完整卡片同步');record.workflow=workflow;}
    // Never publish jobs, results, bindings, local paths or machine identifiers.
    if(!record.deleted||result.has(id)||task.syncId)result.set(id,mergeDeletedDependencies(result.get(id),record)??record);
  }
  return validateEnvelope({version:[...result.values()].some(r=>r.workflow)?4:[...result.values()].some(r=>r.structure)?3:rich?2:1,records:[...result.values()]}).records;
}
export function mergeTasks(base,local,remote,overrides={}){
  const maps=[base,local,remote].map(rows=>new Map(rows.map(r=>[r.id,clean(r)]))),records=[],conflicts=[],automaticResolutions=[];
  for(const id of new Set(maps.flatMap(m=>[...m.keys()]))){
    const [b,l,r]=maps.map(m=>m.get(id));const choice=overrides[id];let selected;
    if(choice&&equal(choice.expectedRemote,r)&&equal(choice.expectedLocal,l))selected=choice.use==='local'?l:r;
    else if(equal(l,r)||equal(r,b))selected=l;
    else if(equal(l,b))selected=r;
    else if((selected=mergeDeletedDependencies(l,r))){automaticResolutions.push({id,localDependencies:l.structure.dependsOn,remoteDependencies:r.structure.dependsOn,retainedDependencies:selected.structure.dependsOn});}
    else{conflicts.push({id,base:b??null,local:l??null,remote:r??null});continue;}
    if(selected)records.push(selected);
  }
  if(automaticResolutions.length){try{validateStructureRelations(records);validateWorkflowRelations(records);}catch{
    for(const resolution of automaticResolutions){const id=resolution.id,index=records.findIndex(r=>r.id===id);if(index>=0)records.splice(index,1);conflicts.push({id,base:maps[0].get(id)??null,local:maps[1].get(id)??null,remote:maps[2].get(id)??null});}automaticResolutions.length=0;
  }}
  if(!conflicts.length){
    try{validateStructureRelations(records);validateWorkflowRelations(records);}catch(error){
      // Independently valid edits can create a cycle, duplicate source or inconsistent section together.
      // Give the user choices for the divergent rows instead of leaving sync stuck with no conflicts.
      for(const id of new Set(maps.flatMap(m=>[...m.keys()])))if(!equal(maps[1].get(id),maps[2].get(id))){
        conflicts.push({id,base:maps[0].get(id)??null,local:maps[1].get(id)??null,remote:maps[2].get(id)??null,reason:error.message});
      }
      if(!conflicts.length)throw error;
      const ids=new Set(conflicts.map(c=>c.id));for(let i=records.length-1;i>=0;i--)if(ids.has(records[i].id))records.splice(i,1);
      automaticResolutions.length=0;
    }
  }
  return {records:records.sort((a,b)=>a.id.localeCompare(b.id)),conflicts,...(automaticResolutions.length?{automaticResolutions}: {})};
}
export function applyRemote(state,records,projects,files=new Map()){
  for(const r of records){
    const entry=Object.entries(state.workspace.mappings).find(([,m])=>m.logicalId===r.logicalId);
    if(!entry)continue;
    const [projectId,mapping]=entry,project=projects.find(p=>p.projectId===projectId&&p.path===mapping.path);if(!project)continue;
    let task=state.tasks.find(t=>(t.syncId??t.id)===r.id);const existed=!!task;
    if(task){
      if(task.projectId!==projectId)throw new Error('同步任务的本机项目映射冲突');
      if(task.boardSyncReplica){
        if(r.deleted)continue;
        delete task.boardSyncReplica;delete task.boardSyncPrivateDescription;delete task.completedAt;
        task.status='todo';
      }
      if(task.status!=='todo'){if(!r.deleted)throw new Error('已执行任务不能由同步重新变成待执行');continue;}
      if(task.syncReserved&&!r.deleted)throw new Error('已保留执行的任务不能由同步重新开放');
      // A local reservation owns this task even before a job exists. Remote
      // tombstones hide it on other machines, never on its claiming machine.
      if(task.syncReserved&&r.deleted)continue;
      Object.assign(task,{title:r.title,description:r.description,tag:r.priority!==undefined?task.tag:r.tag,syncId:r.id});
      if(r.priority===undefined&&task.attributes)task.attributes=[...task.attributes.filter(a=>a.groupId!=='type'),{groupId:'type',groupName:'任务类型',optionId:r.tag,name:({feature:'新功能',bug:'Bug',improvement:'优化'})[r.tag]}];
      if(r.deleted){
        task.archivedAt??=new Date().toISOString();
        if(!task.syncReserved)for(const plan of state.automation?.plans??[]){
          const nodes=plan.nodes.filter(n=>n.taskId===task.id&&!n.jobId&&!n.skipped);
          if(nodes.length&&['active','paused'].includes(plan.status)){plan.status='paused';plan.reason='任务已被同步移出或领取，请核对其他电脑后再接续';for(const node of nodes){node.status='blocked';node.message=plan.reason;delete node.recovery;}}
        }
      }else delete task.archivedAt;
    }else if(!r.deleted){
      const at=new Date().toISOString();task={id:randomUUID(),syncId:r.id,projectId,project:project.label,path:project.path,title:r.title,description:r.description,tag:r.tag,status:'todo',createdAt:at,updatedAt:at,jobIds:[],currentJobId:null,history:[{id:randomUUID(),at,type:'synced',status:'todo'}]};state.tasks.push(task);
    }
    if(task&&!r.deleted&&r.priority!==undefined)applyRichFields(state,task,r,files,existed);
  }
  const localClaims=new Set(state.tasks.filter(t=>t.syncReserved).map(t=>t.syncId??t.id));
  applyStructures(state,records.filter(r=>!r.deleted||!localClaims.has(r.id)),projects);applyWorkflows(state,records,projects);
  state.sync.base=records.map(clean);state.sync.conflicts=[];state.sync.overrides={};state.sync.lastSync=new Date().toISOString();state.sync.error='';
}
function gh(args,input,maxOutput=8*1024*1024){
  return new Promise((resolve,reject)=>{
    const child=spawn('gh',['api',...args],{windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',error='';
    const timer=setTimeout(()=>{child.kill();reject(githubRequestError('',true));},30000);
    child.stdout.on('data',b=>{output+=b;if(output.length>maxOutput)child.kill();});child.stderr.on('data',b=>{error+=b;});
    child.on('error',()=>{clearTimeout(timer);reject(new Error('无法调用 GitHub CLI，请先配置本机 gh 登录'));});
    child.stdin.on('error',()=>{});
    child.on('close',code=>{clearTimeout(timer);if(code){reject(githubRequestError(error));}else{try{resolve(JSON.parse(output));}catch{reject(new Error('GitHub 返回格式异常'));}}});
    child.stdin.end(input?JSON.stringify(input):undefined);
  });
}
export class GithubTaskStore{
  constructor(config){
    if(!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(config?.repo??'')||!/^panel-tasks(?:-[a-zA-Z0-9_-]+)?$/.test(config?.branch??''))throw new Error('请使用有效仓库和独立 panel-tasks 分支');
    this.repo=config.repo;this.branch=config.branch;this.schemaVersion=config.schemaVersion??1;this.endpoint=`repos/${config.repo}/contents/panel-tasks.json`;
  }
  async verify(){const repo=await gh([`repos/${this.repo}`]);if(!repo.private)throw new Error('待办同步仅允许私有仓库');return repo;}
  async read(){
    await this.verify();
    try{const value=await gh([this.endpoint+'?ref='+encodeURIComponent(this.branch)]);if(value.type!=='file'||value.size>1000*1024||value.encoding!=='base64')throw new Error('远端待办文件过大或无效');const envelope=validateEnvelope(JSON.parse(Buffer.from(value.content,'base64').toString('utf8')));if(envelope.version>this.schemaVersion)throw Error('远端使用新版完整卡片格式，请更新面板并启用完整卡片同步');this.projectIdentities=envelope.projects;return {sha:value.sha,...envelope};}
    catch(e){if(e.notFound)return {sha:null,version:1,records:[]};throw e;}
  }
  async write(records,sha,projects=this.projectIdentities){
    const envelope=validateEnvelope({version:this.schemaVersion,records,...(projects?.length?{projects}:{})});
    for(const r of records)if(/[a-zA-Z]:[\\/]|\b(?:ghp_|sk-)[a-zA-Z0-9]{20,}/.test(r.title+'\n'+r.description+'\n'+(r.attributes??[]).map(a=>a.group+' '+a.name).join('\n')))throw new Error('待办含本机绝对路径或疑似密钥，请先移除后同步');
    const repo=await this.verify();
    if(!sha){
      try{await gh([`repos/${this.repo}/git/ref/heads/${this.branch}`]);}
      catch(e){if(!e.notFound)throw e;const base=await gh([`repos/${this.repo}/git/ref/heads/${repo.default_branch}`]);await gh([`repos/${this.repo}/git/refs`,'--method','POST','--input','-'],{ref:'refs/heads/'+this.branch,sha:base.object.sha});}
    }
    return gh([this.endpoint,'--method','PUT','--input','-'],{message:'同步待执行任务',branch:this.branch,content:Buffer.from(JSON.stringify(envelope,null,2)+'\n').toString('base64'),...(sha?{sha}:{})});
  }
  async ensureBranch(){const repo=await this.verify();try{await gh([`repos/${this.repo}/git/ref/heads/${this.branch}`]);}catch(e){if(!e.notFound)throw e;const base=await gh([`repos/${this.repo}/git/ref/heads/${repo.default_branch}`]);await gh([`repos/${this.repo}/git/refs`,'--method','POST','--input','-'],{ref:'refs/heads/'+this.branch,sha:base.object.sha});}}
  async readProjects(){
    await this.verify();
    try{const file=await gh([`repos/${this.repo}/contents/panel-projects.json?ref=${encodeURIComponent(this.branch)}`]);
      if(file.type!=='file'||file.encoding!=='base64'||file.size>512*1024)throw Error('项目接入清单过大或格式无效');
      return {sha:file.sha,value:validateProjectCatalog(JSON.parse(Buffer.from(file.content,'base64').toString('utf8')))};
    }catch(error){if(error.notFound)return {sha:null,value:{version:1,projects:[]}};throw error;}
  }
  async writeProjects(value,sha){
    const clean=validateProjectCatalog(value);await this.ensureBranch();
    const bytes=Buffer.from(JSON.stringify(clean,null,2)+'\n');if(bytes.length>512*1024)throw Error('项目接入清单过大');
    return gh([`repos/${this.repo}/contents/panel-projects.json`,'--method','PUT','--input','-'],{message:'同步项目接入说明',branch:this.branch,content:bytes.toString('base64'),...(sha?{sha}:{})});
  }
  boardEndpoint(logicalId){return `repos/${this.repo}/contents/panel-board/${boardSyncKey(logicalId)}.json`;}
  async readBoard(logicalId){
    await this.verify();
    const empty={version:1,logicalId,records:[]};
    let item;
    try{item=await gh([this.boardEndpoint(logicalId)+'?ref='+encodeURIComponent(this.branch),'-H','Accept: application/vnd.github.object+json']);}
    catch(error){if(error.notFound)return {sha:null,value:empty};throw error;}
    if(item.type!=='file'||!Number.isInteger(item.size)||item.size<1||item.size>maxBoardFile||!/^[a-f0-9]{40}$/.test(item.sha))throw Error('远端看板文件无效');
    const blob=item.encoding==='base64'?item:await gh([`repos/${this.repo}/git/blobs/${item.sha}`],undefined,Math.ceil(maxBoardFile*1.5));
    if(blob.encoding!=='base64'||typeof blob.content!=='string'||blob.size!==item.size)throw Error('远端看板文件不可读取');
    const bytes=Buffer.from(blob.content,'base64');
    const blobSha=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
    if(bytes.length!==item.size||blobSha!==item.sha)throw Error('远端看板文件校验失败');
    return {sha:item.sha,value:validateBoard(JSON.parse(bytes.toString('utf8')),logicalId)};
  }
  async writeBoard(logicalId,board,sha){
    const bytes=Buffer.from(JSON.stringify(validateBoard(board,logicalId)));
    await this.ensureBranch();
    return gh([this.boardEndpoint(logicalId),'--method','PUT','--input','-'],{message:'同步项目看板和资料',branch:this.branch,content:bytes.toString('base64'),...(sha?{sha}:{})});
  }
  async readAttachment(meta){
    await this.verify();const item=await gh([`repos/${this.repo}/contents/panel-attachments/${meta.sha256}?ref=${encodeURIComponent(this.branch)}`,'-H','Accept: application/vnd.github.object+json']);
    if(item.type!=='file'||item.size!==meta.size)throw Error('远端附件缺失或大小不符');
    const blob=await gh([`repos/${this.repo}/git/blobs/${item.sha}`],undefined,16*1024*1024);
    if(blob.encoding!=='base64'||blob.size!==meta.size)throw Error('远端附件格式不符');
    const bytes=Buffer.from(blob.content.replace(/\s/g,''),'base64');if(bytes.length!==meta.size||createHash('sha256').update(bytes).digest('hex')!==meta.sha256)throw Error('远端附件哈希不符');return bytes;
  }
  async writeAttachment(meta,bytes){
    if(bytes.length!==meta.size||createHash('sha256').update(bytes).digest('hex')!==meta.sha256)throw Error('本机附件校验失败');
    await this.ensureBranch();const endpoint=`repos/${this.repo}/contents/panel-attachments/${meta.sha256}`;
    try{const existing=await gh([endpoint+'?ref='+encodeURIComponent(this.branch),'-H','Accept: application/vnd.github.object+json']);const sha=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');if(existing.sha!==sha||existing.size!==bytes.length)throw Error('远端同名附件内容异常');return;}catch(e){if(!e.notFound)throw e;}
    await gh([endpoint,'--method','PUT','--input','-'],{message:'保存待办附件',branch:this.branch,content:bytes.toString('base64')});
  }
}
