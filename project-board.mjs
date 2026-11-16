import {randomUUID} from 'node:crypto';

const initialStatuses=[
  {id:'planned',name:'计划中',collapsed:true},
  {id:'ready',name:'待执行',collapsed:false},
  {id:'beta',name:'测试版',collapsed:false},
  {id:'release',name:'正式版',collapsed:false},
  {id:'non-development',name:'非开发',collapsed:false},
  {id:'paused',name:'暂停中',collapsed:false},
  {id:'permanent',name:'永久版',collapsed:true}
];

function projectBoard(state){
  return state.workspace.projectBoard??{revision:0,defaultStatusId:'ready',statuses:initialStatuses,cards:{}};
}

export function projectBoardView(state,projects){
  const board=projectBoard(state);
  const cards=Object.fromEntries(projects.filter(project=>Object.hasOwn(board.cards,project.projectId)).map(project=>[project.projectId,board.cards[project.projectId]]));
  const occupiedStatusIds=[...new Set(Object.values(board.cards).map(card=>card.statusId))];
  return {...board,cards,occupiedStatusIds};
}

function refuse(message,status=400){
  throw Object.assign(Error(message),{status,notApplied:true});
}

export function changeProjectBoard(state,input,projects){
  if(!input||!state.workspace.controllerProjectId||input.projectId!==state.workspace.controllerProjectId)refuse('请在本机总控管理项目状态看板',403);
  const current=projectBoard(state);
  if(input.revision!==current.revision)refuse('看板已更新，请重新打开编辑后保存',409);
  const next=structuredClone(current);
  const {action,id,statusId,moveTo,level,collapsed}=input;
  const status=next.statuses.find(row=>row.id===id);
  if(action==='save-project'){
    if(!projects.some(project=>project.projectId===id&&project.hostId==='local'&&project.path))refuse('项目不在当前本机目录中',404);
    if(!next.statuses.some(row=>row.id===statusId))refuse('请选择有效的项目状态');
    if(!Number.isInteger(level)||level<1||level>5)refuse('请选择 1 至 5 级的项目等级');
    if(typeof input.description!=='string'||input.description.length>1000)refuse('项目描述最多 1,000 字符');
    next.cards={...next.cards,[id]:{statusId,level,description:input.description.trim()}};
  }else if(action==='remove-status'){
    if(!status)refuse('状态已不存在',404);
    if(next.statuses.length===1)refuse('请至少保留一个项目状态');
    const uses=Object.values(next.cards).filter(card=>card.statusId===id);
    const isDefault=next.defaultStatusId===id;
    if(uses.length||isDefault){
      if(moveTo===id||!next.statuses.some(row=>row.id===moveTo))refuse('请选择项目迁入的状态');
      for(const card of uses)card.statusId=moveTo;
      if(isDefault)next.defaultStatusId=moveTo;
    }
    next.statuses=next.statuses.filter(row=>row.id!==id);
  }else if(action==='create-status'||action==='edit-status'){
    const name=typeof input.name==='string'?input.name.trim():'';
    if(!name||name.length>40)refuse('请填写 1 至 40 字符的状态名称');
    if(typeof collapsed!=='boolean')refuse('请选择状态的默认展开方式');
    if(next.statuses.some(row=>(action==='create-status'||row.id!==id)&&row.name.toLowerCase()===name.toLowerCase()))refuse('已有同名状态');
    if(action==='create-status'){
      next.statuses.push({id:randomUUID(),name,collapsed});
    }else{
      if(!status)refuse('状态已不存在',404);
      Object.assign(status,{name,collapsed});
    }
  }else refuse('项目看板操作无效');
  next.revision++;
  state.workspace.projectBoard=next;
  return projectBoardView(state,projects);
}
