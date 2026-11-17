import {createHash,randomUUID} from 'node:crypto';

const clone=value=>structuredClone(value);
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const item of Object.values(value))freeze(item);}return value;}
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure=(code,message)=>Object.assign(new Error(message),{code});
// Only these observational clocks may be coalesced. Intent, cursors, receipt,
// review, result, sync reservations and all unknown fields remain durable.
function businessText(state){
  const jobs=state.jobs?.map(({lastSeenAt,...job})=>job);
  const projects=state.capture?.projects&&Object.fromEntries(Object.entries(state.capture.projects).map(([id,{lastScan,...config}])=>[id,config]));
  return JSON.stringify({...state,...(jobs?{jobs}:{}),...(projects?{capture:{...state.capture,projects}}:{})});
}

export class StateStore{
  #backend; #normalize; #commands; #current; #durable=''; #business=''; #revision=randomUUID(); #closed=false; #busy=false;
  #writes=0; #skipped=0; #coalesced=0; #fault=null;
  #externalClean=false;
  constructor(backend,{normalize=()=>{},commands={}}={}){this.#backend=backend;this.#normalize=normalize;this.#commands=commands;}
  prepare(initialize){
    const raw=this.#backend.read();
    this.#durable=raw===null?'':JSON.stringify(raw);
    return initialize(raw);
  }
  activate(value,{requireUnchanged=false}={}){
    this.#normalize(value);
    if(requireUnchanged&&JSON.stringify(value)!==this.#durable)throw failure('UPGRADE_DATA_CHANGE','新版本启动需要修改运行数据，未通过可回退升级检查');
    const committed=this.#commit(value,true);return committed?.then?committed.then(()=>this.view()):this.view();
  }
  view(){return this.#current;}
  acceptCommittedTask(task,revision){
    if(this.#backend.kind!=='sqlite'||!this.#backend.acceptExternalTask)throw failure('INVALID_ARGUMENT','此存储不接受外部提交缓存');
    this.#assertOpen();if(this.#busy)throw failure('STORE_BUSY','提交期间不能替换缓存');
    const index=this.#current.tasks.findIndex(t=>t.id===task.id&&t.projectId===task.projectId);if(index<0)throw failure('PROJECT_MISMATCH','已提交任务不属于本机缓存');
    const tasks=[...this.#current.tasks];tasks[index]=freeze(clone(task));this.#current=freeze({...this.#current,tasks});
    this.#revision=revision;this.#writes++;this.#durable='';this.#business='';this.#externalClean=true;
    return this.#current;
  }
  inspect(){return {backend:this.#backend.kind??'json',revision:this.#revision,writes:this.#writes,skipped:this.#skipped,coalesced:this.#coalesced,closed:this.#closed,fault:this.#fault?.code??null};}
  #assertOpen(){if(this.#closed)throw failure('CLOSING','存储已关闭');if(this.#fault)throw this.#fault;}
  #commit(draft,force=false){
    const published=freeze(clone(draft)),text=JSON.stringify(published),business=businessText(published);
    const publish=written=>{
      this.#externalClean=false;
      if(written){this.#durable=text;this.#writes++;}
      else if(this.#current&&text!==JSON.stringify(this.#current))this.#coalesced++;else this.#skipped++;
      if(!this.#current||text!==JSON.stringify(this.#current)){this.#current=published;this.#revision=randomUUID();}
      this.#business=business;
    };
    const failed=error=>{if(error.code==='COMMIT_UNKNOWN')this.#fault=error;throw error;};
    if(text!==this.#durable&&(force||business!==this.#business)){
      try{const written=this.#backend.write(draft);if(written?.then)return written.then(()=>publish(true),failed);publish(true);}catch(error){failed(error);}
    }else publish(false);
  }
  transaction({operation,expectedRevision,expected=[]}={},reduce){
    this.#assertOpen();
    if(!operation||typeof reduce!=='function')throw failure('INVALID_ARGUMENT','存储命令缺少操作名称');
    if(this.#busy)throw failure('STORE_BUSY','不能嵌套存储事务');
    if(expectedRevision&&expectedRevision!==this.#revision)throw failure('CONFLICT_REVISION','数据已变化，请重新读取');
    for(const item of expected){const current=this.getEntity(item.entity,item.id,item.projectId);if(current?.revision!==item.revision)throw failure('CONFLICT_REVISION','记录已变化，请重新核对');}
    this.#busy=true;let pending=false;
    try{
      const draft=clone(this.#current),value=reduce(draft);
      if(value&&typeof value.then==='function'){value.catch(()=>{});throw failure('INVALID_ARGUMENT','事务内不能等待外部操作');}
      // Prepare return DTO before I/O too: serialization failure cannot turn a
      // successful commit into an error response.
      this.#normalize(draft);const result=clone(value),committed=this.#commit(draft);
      const response=()=>({value:result,revision:this.#revision});
      if(committed?.then){pending=true;return committed.then(response).finally(()=>{this.#busy=false;});}
      return response();
    }finally{if(!pending)this.#busy=false;}
  }
  executeCommand(command){
    const reduce=Object.hasOwn(this.#commands,command.operation)&&this.#commands[command.operation];if(typeof reduce!=='function')throw failure('INVALID_ARGUMENT','未知存储命令');
    const payload=clone(command.payload);
    return this.transaction(command,draft=>reduce(draft,payload));
  }
  getEntity(entity,id,projectId){
    const rows=this.#current[entity];
    if(!['tasks','jobs','taskSections','attachments','versionRecords','versionIntakes','planIntakes'].includes(entity))throw failure('INVALID_ARGUMENT','不支持的实体类型');
    const value=Array.isArray(rows)?rows.find(row=>row.id===id):rows?.[id];
    if(!value)return null;
    if(projectId!==undefined&&value.projectId!==projectId)throw failure('PROJECT_MISMATCH','记录不属于本项目');
    return {value:clone(value),revision:digest(value)};
  }
  getTask(id,projectId){return this.getEntity('tasks',id,projectId);}
  getJob(id,projectId){return this.getEntity('jobs',id,projectId);}
  listTasks(projectId,{status,includeArchived=true}={}){
    if(!projectId)throw failure('INVALID_ARGUMENT','请指定项目');
    return {revision:this.#revision,items:clone(this.#current.tasks.filter(t=>t.projectId===projectId&&(!status||t.status===status)&&(includeArchived||!t.archivedAt)))};
  }
  listTaskEvents(projectId,id){const task=this.getTask(id,projectId);return task?{revision:task.revision,items:task.value.history??[]}:null;}
  listSectionJobs(projectId,sectionId){
    const ids=new Set(this.listTasks(projectId).items.filter(t=>t.sectionId===sectionId).map(t=>t.id));
    return {revision:this.#revision,items:clone(this.#current.jobs.filter(j=>j.projectId===projectId&&ids.has(j.taskId)))};
  }
  queryQueue(statuses=['queued','sending','submitted','running','uncertain']){return {revision:this.#revision,items:clone(this.#current.jobs.filter(j=>statuses.includes(j.status)))};}
  loadExecutionContext(projectId,id){
    const task=this.getTask(id,projectId);if(!task)return null;
    const ids=new Set([id,...(task.value.dependsOn??[])]);
    return {revision:this.#revision,task,dependencies:clone(this.#current.tasks.filter(t=>t.projectId===projectId&&ids.has(t.id))),jobs:clone(this.#current.jobs.filter(j=>j.projectId===projectId&&(ids.has(j.taskId)||['queued','sending','submitted','running','uncertain'].includes(j.status)))),binding:this.#current.bindings[projectId],mapping:clone(this.#current.workspace?.mappings[projectId]),section:clone(this.#current.taskSections?.find(s=>s.id===task.value.sectionId&&s.projectId===projectId))};
  }
  queryProjectSummary(projectId){const tasks=this.listTasks(projectId).items;return {revision:this.#revision,counts:Object.fromEntries(['todo','running','review','done'].map(status=>[status,tasks.filter(t=>t.status===status&&!t.archivedAt).length]))};}
  backup(backup){const flushed=this.flush();return flushed?.then?flushed.then(()=>this.#backend.backup(backup)):this.#backend.backup(backup);}
  flush(){this.#assertOpen();if(this.#externalClean)return;return this.#commit(this.#current,true);}
  close(){if(this.#closed)return;const flushed=this.#current&&!this.#fault?this.flush():undefined;if(flushed?.then)return flushed.then(()=>{this.#closed=true;});this.#closed=true;}
}
