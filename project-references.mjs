import {attachmentFields} from './attachments.mjs';
import {changeReferenceGroup,projectReferenceGroups,requireReferenceGroup} from './task-groups.mjs';

function fail(message,status=400){throw Object.assign(Error(message),{status,notApplied:true});}

function projectBucket(state,projectId,projects){
  if(typeof projectId!=='string'||!projects.some(project=>project.projectId===projectId&&project.hostId==='local'&&project.path)){
    fail('请先选择本机项目',404);
  }
  const references=state.workspace.projectReferences;
  return references&&Object.hasOwn(references,projectId)?references[projectId]:[];
}

const tagKey=value=>value.toLowerCase();

function tagCatalog(state,projectId,rows){
  const catalogs=state.workspace.projectReferenceTags;
  const stored=catalogs&&Object.hasOwn(catalogs,projectId)?catalogs[projectId]:{names:[],revision:0};
  const names=new Map(stored.names.map(name=>[tagKey(name),name]));
  for(const row of rows)if(!row.archivedAt)for(const name of row.tags){
    const key=tagKey(name);
    if(!names.has(key))names.set(key,name);
  }
  return {names,revision:stored.revision,needsPersist:names.size!==stored.names.length};
}

function storeTags(state,projectId,catalog){
  state.workspace.projectReferenceTags={...state.workspace.projectReferenceTags,[projectId]:{names:[...catalog.names.values()],revision:catalog.revision+1}};
}

export function listProjectReferences(state,projectId,projects){
  const rows=projectBucket(state,projectId,projects),catalog=tagCatalog(state,projectId,rows);
  const items=rows.filter(row=>!row.archivedAt).sort((left,right)=>right.updatedAt.localeCompare(left.updatedAt)||left.id.localeCompare(right.id));
  return {items,groups:projectReferenceGroups(state,projectId),tags:[...catalog.names.values()],tagRevision:catalog.revision};
}

export function changeProjectReferenceGroup(state,input,projects){
  const rows=projectBucket(state,input.projectId,projects);
  const result=changeReferenceGroup(state,{...input,action:input.action.slice('group-'.length)},input.projectId,rows);
  return {...listProjectReferences(state,input.projectId,projects),...result};
}

function text(value,max,label){
  if(typeof value!=='string'||value.length>max)fail(`${label}最多 ${max} 字符`);
  return value.trim();
}

function referenceFields(input,state){
  const title=text(input.title,120,'标题'),body=text(input.body,12000,'内容');
  let url=text(input.url??'',2048,'链接');
  if(url){
    let parsed;
    try{parsed=new URL(url);}catch{fail('请输入完整的网页链接');}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)fail('链接需要使用 HTTP 或 HTTPS');
    url=parsed.href;
  }
  if(!Array.isArray(input.tags)||input.tags.length>12)fail('每条参考最多 12 个标签');
  const unique=new Map();
  for(const value of input.tags){const tag=text(value,32,'标签');if(tag)unique.set(tag.toLowerCase(),tag);}
  const attachments=attachmentFields(state,input.projectId,input.attachmentIds);
  if(!title&&!body&&!url&&!attachments.length)fail('先写一点内容、添加链接或上传文件');
  return {title,body,url,tags:[...unique.values()],attachments};
}

export function changeProjectReference(state,input,projects){
  const rows=projectBucket(state,input.projectId,projects);
  const {id,action,revision}=input;
  if(typeof id!=='string'||!/^[-a-zA-Z0-9]{1,80}$/.test(id)||!['save','read','archive'].includes(action))fail('参考操作无效');
  const previous=rows.find(row=>row.id===id);
  const at=new Date().toISOString();
  if(action==='save'){
    const fields=referenceFields(input,state);
    if(Object.hasOwn(input,'boardGroupId')){
      if(input.boardGroupId!==null)requireReferenceGroup(state,input.projectId,input.boardGroupId);
      if(input.boardGroupId!==null||previous?.boardGroupId)fields.boardGroupId=input.boardGroupId??undefined;
    }
    const catalog=tagCatalog(state,input.projectId,rows);
    const newTags=fields.tags.filter(name=>!catalog.names.has(tagKey(name)));
    // Existing spellings are authoritative when the picker supplies a catalog version.
    if(input.tagRevision!==undefined)fields.tags=fields.tags.map(name=>catalog.names.get(tagKey(name))??name);
    if(previous&&!previous.archivedAt&&Object.keys(fields).every(key=>JSON.stringify(previous[key])===JSON.stringify(fields[key])))return previous;
    if(input.tagRevision!==undefined&&input.tagRevision!==catalog.revision)fail('项目标签已变化，请重新读取标签后再保存',409);
    for(const name of newTags)catalog.names.set(tagKey(name),name);
    if(!previous){
      if(revision!==undefined)fail('参考记录不存在',404);
      if(rows.filter(row=>!row.archivedAt).length>=500)fail('当前项目已保存 500 条参考，请先移除不用的记录');
      const row={id,projectId:input.projectId,...fields,read:false,createdAt:at,updatedAt:at,revision:1};
      state.workspace.projectReferences={...state.workspace.projectReferences,[input.projectId]:[...rows,row]};
      if(newTags.length||catalog.needsPersist)storeTags(state,input.projectId,catalog);
      return row;
    }
    if(previous.archivedAt||previous.revision!==revision)fail('参考记录已变化，请刷新后再保存',409);
    Object.assign(previous,fields,{updatedAt:at,revision:previous.revision+1});
    if(previous.boardGroupId===undefined)delete previous.boardGroupId;
    if(newTags.length||catalog.needsPersist)storeTags(state,input.projectId,catalog);
  }else{
    if(!previous)fail('参考记录不存在',404);
    if(action==='read'&&typeof input.read!=='boolean')fail('阅读状态无效');
    if(action==='archive'&&previous.archivedAt||action==='read'&&!previous.archivedAt&&previous.read===input.read)return previous;
    if(previous.archivedAt||previous.revision!==revision)fail('参考记录已变化，请刷新后重试',409);
    if(action==='read')previous.read=input.read;
    else{
      const catalog=tagCatalog(state,input.projectId,rows);
      if(catalog.needsPersist)storeTags(state,input.projectId,catalog);
      previous.archivedAt=at;
    }
    previous.revision++;
  }
  return previous;
}

export function changeProjectReferenceTag(state,input,projects){
  const {projectId,action,tagRevision}=input;
  if(!['tag-add','tag-rename','tag-delete'].includes(action))fail('标签操作无效');
  const rows=projectBucket(state,projectId,projects),catalog=tagCatalog(state,projectId,rows);
  if(tagRevision!==catalog.revision)fail('项目标签已变化，请重新读取后再操作',409);
  const name=action==='tag-delete'?'':text(input.name,32,'标签');
  if(action!=='tag-delete'&&!name)fail('请输入标签名称');
  const key=tagKey(name);
  if(action==='tag-add'){
    if(catalog.names.has(key))fail('已有同名标签',409);
    catalog.names.set(key,name);
  }else{
    const previousKey=tagKey(text(input.previousName,32,'原标签'));
    if(!catalog.names.has(previousKey))fail('原标签已变化，请重新读取',409);
    if(action==='tag-rename'&&previousKey!==key&&catalog.names.has(key))fail('已有同名标签',409);
    catalog.names.delete(previousKey);
    if(action==='tag-rename')catalog.names.set(key,name);
    for(const row of rows){
      if(!row.tags.some(tag=>tagKey(tag)===previousKey))continue;
      row.tags=action==='tag-rename'?row.tags.map(tag=>tagKey(tag)===previousKey?name:tag):row.tags.filter(tag=>tagKey(tag)!==previousKey);
      row.revision++;
    }
  }
  storeTags(state,projectId,catalog);
  return listProjectReferences(state,projectId,projects);
}
