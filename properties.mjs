import {randomUUID} from 'node:crypto';

export const defaultGroups=()=>[{id:'type',name:'任务类型',options:[{id:'feature',name:'新功能'},{id:'bug',name:'Bug'},{id:'improvement',name:'优化'}]}];
export const propertyGroups=(state,projectId)=>Object.hasOwn(state.propertyGroups??{},projectId)?state.propertyGroups[projectId]:defaultGroups();
const name=value=>{if(typeof value!=='string'||!value.trim()||value.trim().length>30||/[\x00-\x1f]/.test(value))throw Error('名称需为 1–30 个字符');return value.trim();};
export function priorityValue(value=2){if(!Number.isInteger(value)||value<0||value>3)throw Error('请选择 P0、P1、P2 或 P3 优先级');return value;}
export function attributesOf(task){return task?.attributes??(task?.tag&&task.tag!=='none'?[{groupId:'type',groupName:'任务类型',optionId:task.tag,name:({feature:'新功能',bug:'Bug',improvement:'优化'})[task.tag]??task.tag}]:[]);}
export function changeProperties(state,input,projects){
  if(!projects.some(p=>p.projectId===input.projectId))throw Error('项目不存在');
  state.propertyGroups??={};state.propertyGroups[input.projectId]??=defaultGroups();
  const groups=state.propertyGroups[input.projectId],group=groups.find(g=>g.id===input.groupId);
  if(input.action==='add-group'){
    const label=name(input.name);if(groups.some(g=>g.name===label))throw Error('属性组已存在（已停用的组可恢复）');
    if(groups.length>=20)throw Error('每项目最多 20 个属性组（含停用）');
    groups.push({id:randomUUID(),name:label,options:[]});
  }else{
    if(!group)throw Error('属性组不存在');
    if(input.action==='delete-group')group.archived=true;
    else if(input.action==='restore-group')group.archived=false;
    else if(input.action==='add-option'){
      if(group.archived)throw Error('请先恢复属性组');
      const label=name(input.name);if(group.options.some(o=>o.name===label))throw Error('属性已存在（已停用的属性可恢复）');
      if(group.options.length>=40)throw Error('每组最多 40 个属性（含停用）');
      group.options.push({id:randomUUID(),name:label});
    }else{
      const option=group.options.find(o=>o.id===input.optionId);if(!option)throw Error('属性不存在');
      if(input.action==='delete-option')option.archived=true;
      else if(input.action==='restore-option')option.archived=false;
      else throw Error('属性操作无效');
    }
  }
  return {groups};
}
export function taskPropertyFields(state,projectId,input,previous){
  const groups=propertyGroups(state,projectId),old=attributesOf(previous);
  let choices=input.attributeIds;
  if(choices===undefined){
    choices=Object.fromEntries(old.map(a=>[a.groupId,a.optionId]));
    if(input.tag!==undefined){if(input.tag==='none')delete choices.type;else choices.type=input.tag;}
    else if(!previous){const type=groups.find(g=>g.id==='type'&&!g.archived),first=type?.options.find(o=>!o.archived);if(first)choices.type=first.id;}
  }
  if(!choices||typeof choices!=='object'||Array.isArray(choices)||Object.keys(choices).length>20)throw Error('任务属性格式无效');
  choices={...choices};
  // Resolve free text inside the same task transaction: cancelling or failing
  // to save a task must not leave an unused option behind.
  if(input.typeName!==undefined){
    if(typeof input.typeName!=='string')throw Error('任务类型需为文字');
    if(!input.typeName.trim())delete choices.type;
    else{
      const label=name(input.typeName),type=groups.find(g=>g.id==='type');
      if(!type)throw Error('任务类型属性组不存在，请先恢复');
      let option=type.options.find(o=>o.name.toLocaleLowerCase()===label.toLocaleLowerCase());
      const retained=option&&old.some(a=>a.groupId==='type'&&a.optionId===option.id);
      if((type.archived||option?.archived)&&!retained)throw Error('该任务类型已停用，请在管理属性中恢复');
      if(!option){
        if(type.options.length>=40)throw Error('每组最多 40 个属性（含停用）');
        option={id:randomUUID(),name:label};type.options.push(option);
        state.propertyGroups??={};state.propertyGroups[projectId]=groups;
      }
      choices.type=option.id;
    }
  }
  const attributes=[];
  for(const [groupId,optionId] of Object.entries(choices)){
    if(optionId==='')continue;
    const group=groups.find(g=>g.id===groupId),option=group?.options.find(o=>o.id===optionId);
    if(!group||!option)throw Error('属性已变更，请重新打开任务编辑');
    if((group.archived||option.archived)&&!old.some(a=>a.groupId===groupId&&a.optionId===optionId))throw Error('该属性已停用，不能用于新任务');
    attributes.push({groupId,groupName:group.name,optionId,name:option.name});
  }
  attributes.sort((a,b)=>a.groupId.localeCompare(b.groupId));
  return {priority:priorityValue(input.priority??previous?.priority??2),attributes,tag:attributes.find(a=>a.groupId==='type')?.optionId??'none'};
}
export function requiresLocalProperties(task){return (task.priority??2)!==2||attributesOf(task).some(a=>a.groupId!=='type'||!['feature','bug','improvement'].includes(a.optionId))||task.tag==='none';}
