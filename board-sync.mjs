import {createHash,randomUUID} from 'node:crypto';
import {richFields,validateRich,applyRichFields,hydrateRichAttachments} from './rich-sync.mjs';
import {readAttachment} from './attachments.mjs';
import {projectTaskGroups,projectReferenceGroups} from './task-groups.mjs';
import {listProjectReferences} from './project-references.mjs';

const kinds=['task-group','reference-group','reference-tag','reference','placement','card'];
const stages=new Set(['review','done']);
const identity=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id)&&!['__proto__','prototype','constructor'].includes(id);
const key=row=>`${row.kind}:${row.id}`;
const equal=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const nameKey=value=>value.normalize('NFKC').toLowerCase();
const credential=/\b(?:gh[pousr]_|github_pat_|sk-)[a-zA-Z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const localPath=/(?:^|[^\w])(?:[A-Za-z]:[\\/]|\\\\[^\\\s])/;
const privateText='[本机路径保留在原电脑]';
export const maxBoardFile=48*1024*1024;
export const boardSyncKey=logicalId=>createHash('sha256').update(logicalId).digest('hex');
export const keepChatDescriptionLocal=task=>!!(task.sourceKind==='conversation'||task.sourceIds?.length||task.historyOnly||task.boardSyncPrivateDescription);
const attachmentFields=files=>[...new Map(files.map(({name,size,type,sha256})=>[JSON.stringify([sha256,name]),{name,size,type,sha256}])).values()];
const date=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value));
const text=(value,limit)=>typeof value==='string'&&value.length<=limit&&!value.includes('\0');
const require=(valid,message)=>{if(!valid)throw Error(message);};
const exact=(row,fields)=>row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).length===fields.length&&fields.every(field=>Object.hasOwn(row,field));
const asRows=rows=>[...rows].sort((a,b)=>key(a).localeCompare(key(b)));

function checkText(value,limit){
  require(text(value,limit),'看板同步包含过长或无效的文字');
  require(!credential.test(value)&&!localPath.test(value),'看板同步文字含本机路径或疑似密钥');
}

function shareText(value){
  return String(value??'').split('\n').map(line=>localPath.test(line)?privateText:line).join('\n');
}

function validateGroups(rows,kind){
  const groups=new Map(rows.filter(row=>row.kind===kind).map(row=>[row.id,row]));
  const names=new Set(),resolved=new Set();
  for(const row of groups.values()){
    const name=JSON.stringify([row.parentId,nameKey(row.name)]);
    require(!names.has(name),'同步分组在同一层级重名，请核对两端分组');
    names.add(name);
    const parents=new Set();let current=row;
    while(current&&!resolved.has(current.id)){
      require(!parents.has(current.id),'同步分组存在循环');
      parents.add(current.id);
      if(current.parentId===null)break;
      current=groups.get(current.parentId);
      require(current,'同步分组的上级不存在');
    }
    for(const id of parents)resolved.add(id);
  }
  return groups;
}

function validLink(value){
  if(!value)return true;
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;}
  catch{return false;}
}

export function validateBoard(value,logicalId){
  require(exact(value,['version','logicalId','records'])&&value.version===1&&value.logicalId===logicalId&&Array.isArray(value.records),'项目看板同步格式或项目身份不符');
  const keys=new Set();
  for(const row of value.records){
    require(row&&kinds.includes(row.kind)&&identity(row.id)&&!keys.has(key(row)),'项目看板含无效或重复的记录');
    keys.add(key(row));
    const base=['kind','id'];
    if(row.kind==='task-group'||row.kind==='reference-group'){
      require(exact(row,[...base,'name','parentId'])&&(row.parentId===null||identity(row.parentId))&&row.name?.trim()&&!(row.parentId===null&&row.name==='默认分组'),'项目看板分组无效');
      checkText(row.name,80);
    }else if(row.kind==='reference-tag'){
      require(exact(row,[...base,'name']),'资料标签无效');checkText(row.name,32);
      require(row.name.trim()&&boardSyncKey(row.name.toLowerCase())===row.id,'资料标签标识无效');
    }else if(row.kind==='reference'){
      require(exact(row,[...base,'title','body','url','tags','attachments','groupId','createdAt','updatedAt'])&&Array.isArray(row.tags)&&row.tags.length<=12&&(row.groupId===null||identity(row.groupId))&&date(row.createdAt)&&date(row.updatedAt),'同步资料字段无效');
      checkText(row.title,120);checkText(row.body,12000);checkText(row.url,2048);
      require(validLink(row.url),'同步资料包含无效链接');
      for(const label of row.tags)checkText(label,32);
      validateRich({priority:2,attributes:[],attachments:row.attachments});
    }else if(row.kind==='placement'){
      require(exact(row,[...base,'groupId'])&&identity(row.groupId),'任务分组归属无效');
    }else{
      require(exact(row,[...base,'title','description','status','createdAt','completedAt','priority','attributes','attachments'])&&stages.has(row.status)&&date(row.createdAt)&&(row.completedAt===null||date(row.completedAt)),'同步历史卡片字段无效');
      checkText(row.title,200);if(row.description!==null)checkText(row.description,30000);
      validateRich(row);
      for(const attribute of row.attributes){checkText(attribute.name,30);checkText(attribute.group,30);}
    }
    for(const file of row.attachments??[])checkText(file.name,180);
  }
  const taskGroups=validateGroups(value.records,'task-group'),referenceGroups=validateGroups(value.records,'reference-group');
  for(const row of value.records){
    if(row.kind==='placement')require(taskGroups.has(row.groupId),'任务的同步分组不存在');
    if(row.kind==='reference'&&row.groupId)require(referenceGroups.has(row.groupId),'资料的同步分组不存在');
  }
  const board={version:1,logicalId,records:asRows(value.records)};
  require(Buffer.byteLength(JSON.stringify(board))<=maxBoardFile,'此项目的看板同步文件过大');
  return board;
}

export function portableBoard(state,project,logicalId){
  const projectId=project.projectId;
  const taskGroups=projectTaskGroups(state,projectId),refs=listProjectReferences(state,projectId,[project]);
  const groups=(ones,kind)=>ones.map(({id,name,parentId})=>({kind,id,name,parentId}));
  const rows=[...groups(taskGroups,'task-group'),...groups(refs.groups,'reference-group')];
  for(const name of refs.tags)rows.push({kind:'reference-tag',id:boardSyncKey(name.toLowerCase()),name});
  for(const row of refs.items)rows.push({kind:'reference',id:row.id,title:shareText(row.title),body:shareText(row.body),url:row.url,tags:row.tags,attachments:attachmentFields(row.attachments),groupId:row.boardGroupId??null,createdAt:row.createdAt,updatedAt:row.updatedAt});
  for(const task of state.tasks){
    if(task.projectId!==projectId||task.archivedAt||task.status==='running')continue;
    const id=task.syncId??task.id;
    if(task.boardGroupId)rows.push({kind:'placement',id,groupId:task.boardGroupId});
    if(!stages.has(task.status))continue;
    const fields=richFields(task);
    rows.push({kind:'card',id,title:shareText(task.title),description:keepChatDescriptionLocal(task)?null:shareText(task.description),status:task.status,createdAt:task.createdAt,completedAt:task.completedAt??null,...fields,attachments:attachmentFields(fields.attachments)});
  }
  return validateBoard({version:1,logicalId,records:rows},logicalId);
}

export function mergeBoards(base,local,remote,choices={}){
  const maps=[base,local,remote].map(board=>new Map((board?.records??[]).map(row=>[key(row),row])));
  const records=[],conflicts=[];
  for(const id of new Set(maps.flatMap(map=>[...map.keys()]))){
    const [ancestor,a,b]=maps.map(map=>map.get(id));
    let chosen;
    const resolution=choices[id];
    if(resolution&&equal(resolution.local,a)&&equal(resolution.remote,b))chosen=resolution.use==='local'?a:b;
    else if(equal(a,b)||equal(b,ancestor))chosen=a;
    else if(equal(a,ancestor))chosen=b;
    else{conflicts.push({id,local:a??null,remote:b??null});continue;}
    if(chosen)records.push(chosen);
  }
  return {conflicts,value:conflicts.length?null:validateBoard({version:1,logicalId:local.logicalId,records},local.logicalId)};
}

function localFiles(state,projectId,row,files){
  return row.attachments.map(meta=>{
    const file=files.get(JSON.stringify([projectId,meta.sha256,meta.name]));
    require(file,'同步附件尚未校验');
    state.attachments[file.id]=file;
    return {...file};
  });
}

function applyGroups(state,projectId,bucket,records,kind,existing){
  const changes=records.filter(row=>row.kind===kind).map(({id,name,parentId})=>{
    const before=existing.find(row=>row.id===id);
    return {id,projectId,name,parentId,revision:before?.name===name&&before.parentId===parentId?before.revision:(before?.revision??0)+1};
  });
  if(changes.length||existing.length)state.workspace[bucket]={...state.workspace[bucket],[projectId]:changes};
}

export function applyBoard(state,project,board,files){
  const {projectId,path,label}=project;
  const records=board.records;
  applyGroups(state,projectId,'taskGroups',records,'task-group',projectTaskGroups(state,projectId));
  applyGroups(state,projectId,'projectReferenceGroups',records,'reference-group',projectReferenceGroups(state,projectId));
  const byKind=kind=>new Map(records.filter(row=>row.kind===kind).map(row=>[row.id,row]));
  const placements=byKind('placement'),history=byKind('card');
  const groupIds=byKind('task-group');
  const projectTasks=state.tasks.filter(row=>row.projectId===projectId);
  for(const task of state.tasks)if(task.projectId!==projectId)require(!history.has(task.syncId??task.id)&&!placements.has(task.syncId??task.id),'同步卡片标识与其他本机项目冲突');
  for(const task of projectTasks){
    const id=task.syncId??task.id;
    const row=history.get(id);
    if(task.status!=='running'){
      if(!task.archivedAt&&placements.has(id))task.boardGroupId=placements.get(id).groupId;
      else delete task.boardGroupId;
    }else if(task.boardGroupId&&!groupIds.has(task.boardGroupId))delete task.boardGroupId;
    if(!row&&task.boardSyncReplica){task.archivedAt??=new Date().toISOString();continue;}
    if(!row)continue;
    history.delete(id);
    const canReplicate=task.boardSyncReplica||(task.archivedAt&&task.status==='todo'&&!task.currentJobId&&!task.jobIds.length&&!task.syncReserved);
    if(!canReplicate)continue;
    applyCard(state,task,row,placements.get(id),files);
  }
  for(const row of history.values()){
    const task={id:randomUUID(),syncId:row.id,projectId,project:label,path,history:[],jobIds:[],currentJobId:null,lastJobStatus:null};
    applyCard(state,task,row,placements.get(row.id),files);state.tasks.push(task);
  }
  const refs=byKind('reference'),previous=state.workspace.projectReferences?.[projectId]??[];
  const local=previous.map(row=>{
    const remote=refs.get(row.id);
    if(!remote)return row.archivedAt?row:{...row,archivedAt:new Date().toISOString(),revision:row.revision+1};
    refs.delete(row.id);
    return applyReference(state,projectId,remote,files,row);
  });
  for(const row of refs.values())local.push(applyReference(state,projectId,row,files));
  if(local.length)state.workspace.projectReferences={...state.workspace.projectReferences,[projectId]:local};
  const tags=records.filter(row=>row.kind==='reference-tag').map(row=>row.name);
  const catalog=state.workspace.projectReferenceTags?.[projectId];
  if(!equal(catalog?.names??[],tags))state.workspace.projectReferenceTags={...state.workspace.projectReferenceTags,[projectId]:{names:tags,revision:(catalog?.revision??0)+1}};
}

function applyCard(state,task,row,placement,files){
  task.boardSyncReplica=true;
  task.title=row.title;task.description=row.description??'';task.boardSyncPrivateDescription=row.description===null;
  task.status=row.status;task.createdAt=row.createdAt;task.updatedAt=row.completedAt??row.createdAt;
  if(row.completedAt)task.completedAt=row.completedAt;else delete task.completedAt;
  if(placement)task.boardGroupId=placement.groupId;else delete task.boardGroupId;
  delete task.archivedAt;
  applyRichFields(state,task,row,files,true);
}

function applyReference(state,projectId,row,files,before){
  const next={id:row.id,projectId,title:before&&shareText(before.title)===row.title?before.title:row.title,body:before&&shareText(before.body)===row.body?before.body:row.body,url:row.url,tags:row.tags,attachments:localFiles(state,projectId,row,files),createdAt:row.createdAt,updatedAt:row.updatedAt,read:before?.read??false};
  if(row.groupId)next.boardGroupId=row.groupId;
  const changed=Object.keys(next).some(field=>!equal(next[field],before?.[field]))||!!before?.archivedAt||!!before?.boardGroupId&&!row.groupId;
  return {...next,revision:(before?.revision??0)+Number(changed)};
}

export async function boardFiles(root,state,project,board,remote,store,persistFile){
  const rows=board.records.filter(row=>row.attachments?.length).map(row=>({...row,logicalId:board.logicalId}));
  const files=await hydrateRichAttachments(root,state,rows,[project],store,persistFile);
  const uploaded=new Set(remote.records.flatMap(row=>(row.attachments??[]).map(file=>file.sha256)));
  for(const file of files.values())if(!uploaded.has(file.sha256)){
    await store.writeAttachment(file,readAttachment(root,file));uploaded.add(file.sha256);
  }
  return files;
}
