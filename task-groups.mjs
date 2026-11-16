function fail(message,status=400){
  throw Object.assign(Error(message),{status,notApplied:true});
}

function projectGroups(state,projectId,bucket){
  const groups=state.workspace?.[bucket];
  return groups&&Object.hasOwn(groups,projectId)?groups[projectId]:[];
}
export const projectTaskGroups=(state,projectId)=>projectGroups(state,projectId,'taskGroups');
export const projectReferenceGroups=(state,projectId)=>projectGroups(state,projectId,'projectReferenceGroups');

export function taskGroupName(state,task){
  return projectTaskGroups(state,task?.projectId).find(group=>group.id===task?.boardGroupId)?.name??'默认分组';
}

function requireGroup(groups,id){
  const group=groups.find(row=>row.id===id);
  if(!group)fail('请选择本项目的有效分组',404);
  return group;
}
export const requireTaskGroup=(state,projectId,id)=>requireGroup(projectTaskGroups(state,projectId),id);
export const requireReferenceGroup=(state,projectId,id)=>requireGroup(projectReferenceGroups(state,projectId),id);

export function changeTaskGroup(state,input,projectId){
  return changeGroup(state,input,projectId,'taskGroups',state.tasks.filter(row=>row.projectId===projectId));
}

export function changeReferenceGroup(state,input,projectId,items){
  return changeGroup(state,input,projectId,'projectReferenceGroups',items);
}

function changeGroup(state,input,projectId,bucket,items){
  const groups=projectGroups(state,projectId,bucket),references=bucket==='projectReferenceGroups';
  if(input.action==='move'){
    const task=items.find(row=>row.id===input.id&&!row.archivedAt);
    if(!task)fail(references?'资料不存在或已归档':'任务不存在或已归档',404);
    const {groupId,fromGroupId}=input;
    if(groupId!==null)requireGroup(groups,groupId);
    const current=task.boardGroupId??null;
    if(current!==groupId){
      if(current!==fromGroupId)fail('卡片分组已变化，请刷新后再移动',409);
      if(groupId===null)delete task.boardGroupId;
      else task.boardGroupId=groupId;
      if(references)task.revision++;
    }
    return {taskId:task.id,groupId};
  }

  const {id,action,revision,parentId=null}=input;
  if(typeof id!=='string'||!/^[-a-zA-Z0-9]{8,80}$/.test(id)||!['create','update','remove'].includes(action))fail('分组操作无效');
  const previous=groups.find(group=>group.id===id);
  const store=rows=>{state.workspace[bucket]={...state.workspace[bucket],[projectId]:rows};};
  if(action==='remove'){
    if(!previous)return {id};
    if(previous.revision!==revision)fail('分组已变化，请刷新后再操作',409);
    if(groups.some(group=>group.parentId===id)||items.some(task=>task.boardGroupId===id&&!task.archivedAt)){
      fail(references?'请先移走该分组内的资料和子分组':'请先移走该分组内的任务和子分组');
    }
    for(const task of items)if(task.boardGroupId===id)delete task.boardGroupId;
    store(groups.filter(group=>group.id!==id));
    return {id};
  }

  const name=typeof input.name==='string'?input.name.trim():'';
  if(!name||name.length>80||/[\x00-\x1f]/.test(name))fail('请输入 1 至 80 字符的分组名称');
  if(parentId===null&&name==='默认分组')fail('请为自定义分组使用其他名称');
  if(previous?.name===name&&previous.parentId===parentId)return {group:previous};
  if(action==='create'&&previous)fail('分组已创建，请刷新后编辑',409);
  if(action==='update'&&!previous)fail('分组不存在',404);
  if(previous&&previous.revision!==revision)fail('分组已变化，请刷新后再编辑',409);
  for(let ancestor=parentId;ancestor!==null;){
    if(ancestor===id)fail('上级分组不能是自身或其子分组');
    ancestor=requireGroup(groups,ancestor).parentId;
  }
  const nameKey=value=>value.normalize('NFKC').toLowerCase();
  if(groups.some(group=>group.id!==id&&group.parentId===parentId&&nameKey(group.name)===nameKey(name)))fail('同一层级已有这个分组名称');
  const group={id,projectId,name,parentId,revision:(previous?.revision??0)+1};
  store(previous?groups.map(row=>row.id===id?group:row):[...groups,group]);
  return {group};
}
