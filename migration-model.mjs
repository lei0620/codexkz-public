import {createHash} from 'node:crypto';
import {migrateState} from './board.mjs';
import {validateRelations} from './sqlite-codec.mjs';
export {parseSource} from './json-safe.mjs';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const logicalHash=value=>sha256(JSON.stringify(canonical(value)));
export const migrationError=(code,message,diagnostics=[])=>Object.assign(new Error(message),{code,diagnostics});

export function diagnoseState(original){
  const errors=[],add=(code,path,message)=>errors.push({code,path,message});
  if(!original||typeof original!=='object'||Array.isArray(original))return {errors:[{code:'INVALID_ROOT',path:'$',message:'状态根必须为对象'}]};
  const version=original.schemaVersion??1;
  if(!Number.isInteger(version)||version<1||version>3)return {errors:[{code:'UNSUPPORTED_SCHEMA',path:'schemaVersion',message:'仅支持JSON schema 1、2、3'}]};
  let state;try{state=migrateState(structuredClone(original));}catch(error){return {errors:[{code:'INCOMPLETE_STATE',path:'$',message:error.message}]};}
  const array=(value,label,optional=true)=>{if(value==null&&optional)return [];if(!Array.isArray(value)){add('INVALID_CONTAINER',label,'应为数组');return [];}return value;};
  const map=(value,label)=>{if(value==null)return {};if(typeof value!=='object'||Array.isArray(value)){add('INVALID_CONTAINER',label,'应为对象');return {};}return value;};
  const keyed=(rows,label)=>{const result=new Map();for(const [i,row] of rows.entries()){if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.id!=='string'||!row.id){add('INVALID_ID',`${label}[${i}]`,'缺少实体ID');continue;}if(result.has(row.id))add('DUPLICATE_ID',`${label}[${i}].id`,row.id);result.set(row.id,row);}return result;};
  const tasks=array(state.tasks,'tasks',false),jobs=array(state.jobs,'jobs',false),sections=array(state.taskSections,'taskSections');
  const taskMap=keyed(tasks,'tasks'),jobMap=keyed(jobs,'jobs'),sectionMap=keyed(sections,'taskSections');
  const capture=map(state.capture,'capture'),sources=map(capture.events,'capture.events');
  map(capture.projects,'capture.projects');map(capture.contexts,'capture.contexts');
  for(const [id,event] of Object.entries(sources))if(!event||event.id!==id||!event.projectId||!event.source?.threadId||!event.source?.turnId)add('INCOMPLETE_SOURCE','capture.events.'+id,'来源标识/项目/原轮次缺失或不匹配');
  const relation=(owner,target,label,kind)=>{if(!target)add('ORPHAN_REFERENCE',label,kind+'不存在');else if(owner.projectId!==target.projectId)add('CROSS_PROJECT_REFERENCE',label,kind+'不属于同一项目');};
  for(const task of tasks){
    if(!task||typeof task!=='object')continue;const label='tasks.'+task.id;
    if(!task.projectId||typeof task.projectId!=='string'||typeof task.title!=='string'||!task.title)add('INCOMPLETE_TASK',label,'任务缺少项目或标题');
    if(!['todo','running','review','done'].includes(task.status))add('INVALID_STATUS',label+'.status','任务状态无效');
    array(task.history,label+'.history',false);const order=array(task.jobIds,label+'.jobIds',false);
    if(new Set(order).size!==order.length)add('DUPLICATE_REFERENCE',label+'.jobIds','轮次关联重复');
    for(const id of order){const job=jobMap.get(id);relation(task,job,label+'.jobIds','执行记录');if(job&&job.taskId!==task.id)add('WRONG_JOB_OWNER',label+'.jobIds',String(id));}
    if(task.currentJobId){const job=jobMap.get(task.currentJobId);relation(task,job,label+'.currentJobId','当前执行');if(job?.taskId!==task.id||!order.includes(task.currentJobId))add('WRONG_JOB_OWNER',label+'.currentJobId','当前轮次未正确关联任务');}
    if(task.sectionId)relation(task,sectionMap.get(task.sectionId),label+'.sectionId','版块');
    if(task.parentId)relation(task,taskMap.get(task.parentId),label+'.parentId','父任务');
    const dependencies=array(task.dependsOn,label+'.dependsOn');if(new Set(dependencies).size!==dependencies.length)add('DUPLICATE_REFERENCE',label+'.dependsOn','依赖重复');
    for(const id of dependencies)relation(task,taskMap.get(id),label+'.dependsOn','前置任务');
    if(task.pendingParentId!==undefined&&(typeof task.pendingParentId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(task.pendingParentId)||task.parentId))add('INVALID_REFERENCE',label+'.pendingParentId','待接续父任务格式无效');
    const pending=array(task.pendingDependencies,label+'.pendingDependencies');if(pending.some(id=>typeof id!=='string'))add('INVALID_REFERENCE',label+'.pendingDependencies','待接续ID必须为字符串');
    for(const id of array(task.sourceIds,label+'.sourceIds'))relation(task,sources[id],label+'.sourceIds','来源');
  }
  const statuses=['queued','sending','submitted','running','uncertain','completed','failed','interrupted','cancelled','released'];
  for(const job of jobs){if(!job||typeof job!=='object')continue;const label='jobs.'+job.id;
    if(typeof job.projectId!=='string'||!job.projectId||typeof job.threadId!=='string'||!job.threadId)add('INCOMPLETE_JOB',label,'执行记录缺少项目/对话，不能猜测绑定');
    if(!statuses.includes(job.status))add('INVALID_STATUS',label+'.status','执行状态无效');
    if(job.taskId){const task=taskMap.get(job.taskId);relation(job,task,label+'.taskId','所属任务');if(task&&!task.jobIds?.includes(job.id))add('ORPHAN_JOB',label,'任务未包含此执行记录');}
  }
  for(const [id,event] of Object.entries(sources)){if(!event)continue;for(const key of ['taskId','createdTaskId'])if(event[key])relation(event,taskMap.get(event[key]),`capture.events.${id}.${key}`,'关联任务');}
  const automation=map(state.automation,'automation'),plans=array(automation.plans,'automation.plans');keyed(plans,'automation.plans');
  for(const plan of plans){if(!plan)continue;for(const node of array(plan.nodes,'automation.plans.'+plan.id+'.nodes',false)){if(!node||typeof node!=='object'){add('INVALID_NODE','plans.'+plan.id+'.nodes','计划节点无效');continue;}relation(plan,taskMap.get(node.taskId),'plans.'+plan.id+'.nodes','计划任务');if(node.jobId){const job=jobMap.get(node.jobId);relation(plan,job,'plans.'+plan.id+'.nodes','计划轮次');if(job?.taskId!==node.taskId)add('WRONG_JOB_OWNER','plans.'+plan.id+'.nodes','计划轮次与任务不符');}}}
  for(const field of ['versionRecords','versionIntakes','planIntakes'])keyed(array(state[field],field),field);
  for(const field of ['bindings','attachments','propertyGroups','threadRequests','workflowChecks'])map(state[field],field);
  map(map(state.workspace,'workspace').mappings,'workspace.mappings');map(automation.routes,'automation.routes');map(map(state.boards,'boards').attachments,'boards.attachments');
  const sync=map(state.sync,'sync');for(const key of ['base','conflicts','projectIdentities'])array(sync[key],'sync.'+key);map(sync.overrides,'sync.overrides');
  if(!errors.length)try{validateRelations(state);}catch(error){add('INVALID_RELATION','$',error.message);}
  return {state,errors,sourceSchema:version,normalizations:[...(version!==3?['schemaVersion→3']:[]),...(original.tasks===undefined?['缺失tasks→[]']:[])]};
}

export function migrationCounts(state){
  const tasks=state.tasks??[],jobs=state.jobs??[];
  return {tasks:tasks.length,jobs:jobs.length,legacyJobs:jobs.filter(j=>!j.taskId).length,sections:state.taskSections?.length??0,history:tasks.reduce((n,t)=>n+(t.history?.length??0),0),sources:Object.keys(state.capture?.events??{}).length,attachments:Object.keys(state.attachments??{}).length,versions:state.versionRecords?.length??0,versionRequests:state.versionIntakes?.length??0,planRequests:state.planIntakes?.length??0,plans:state.automation?.plans?.length??0,pendingDependencies:tasks.reduce((n,t)=>n+(t.pendingDependencies?.length??0),0),planSources:tasks.filter(t=>t.planSourceKey).length,syncIds:tasks.filter(t=>t.syncId).length,removed:tasks.filter(t=>t.archivedAt).length,bindings:Object.keys(state.bindings??{}).length,conflicts:state.sync?.conflicts?.length??0,tombstones:state.sync?.base?.filter(r=>r.deleted).length??0};
}
