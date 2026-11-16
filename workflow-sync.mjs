const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
export function hasPortableWorkflow(t){return !!(t.workflowStage||t.parentId||t.pendingParentId||t.sourceIds?.length);}
export function validateWorkflow(value){
  if(!value||Object.keys(value).some(k=>!['stage','parentId'].includes(k))||!['ready','discussion','confirmation'].includes(value.stage)||(value.parentId!==null&&!validId(value.parentId)))throw Error('同步讨论状态或父任务格式无效');
}
export function portableWorkflow(state,task){
  if(!hasPortableWorkflow(task))return undefined;
  let parentId=task.pendingParentId??null;
  if(task.parentId){
    if(parentId)throw Error('父任务同时处于已接续和待接续状态');
    const parent=state.tasks.find(t=>t.id===task.parentId&&t.projectId===task.projectId);
    if(!parent)throw Error('父任务缺失，不能静默丢失同步关系');
    parentId=parent.syncId??parent.id;
  }
  const value={stage:task.workflowStage??'ready',parentId};validateWorkflow(value);return value;
}
export function applyWorkflows(state,records,projects){
  for(const r of records){
    if(!r.workflow||r.deleted)continue;
    const task=state.tasks.find(t=>(t.syncId??t.id)===r.id);
    if(!task||task.status!=='todo'||task.syncReserved||!projects.some(p=>p.projectId===task.projectId))continue;
    task.workflowStage=r.workflow.stage;
    const parent=state.tasks.find(t=>t.projectId===task.projectId&&(t.syncId??t.id)===r.workflow.parentId);
    task.parentId=parent?.id??null;
    if(r.workflow.parentId&&!parent)task.pendingParentId=r.workflow.parentId;else delete task.pendingParentId;
    // Conversation source IDs, jobs, approval and local routing remain on their original machine.
  }
}
export function validateWorkflowRelations(records){
  const byId=new Map(records.map(r=>[r.id,r])),done=new Set(),visiting=new Set();
  function visit(r){
    if(done.has(r.id))return;if(visiting.has(r.id))throw Error('同步父子与依赖关系存在循环');visiting.add(r.id);
    for(const id of [r.workflow?.parentId,...(r.structure?.dependsOn??[])].filter(Boolean)){
      const target=byId.get(id);if(!target)continue;
      if(target.logicalId!==r.logicalId)throw Error('同步父任务或依赖不属于同一项目');visit(target);
    }
    visiting.delete(r.id);done.add(r.id);
  }
  for(const r of records)visit(r);
}
