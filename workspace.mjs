import {randomUUID} from 'node:crypto';
import {normalize} from './core.mjs';

export function initializeWorkspace(state){
  state.workspace??={version:1,deviceId:randomUUID(),deviceLabel:'',controllerProjectId:'',mappings:{}};
  const w=state.workspace;
  if(w.version!==1||!w.mappings||typeof w.mappings!=='object'||Array.isArray(w.mappings))throw new Error('项目身份配置格式无效，已保留原数据');
  state.localProjects??=[];
}
const label=(value,max=80)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new Error('请填写有效名称');return value.trim();};
export function configureWorkspace(state,input,projects){
  const controller=projects.find(p=>p.projectId===input.controllerProjectId&&p.path&&p.hostId==='local');
  if(!controller)throw new Error('请选择本机总控项目');
  state.workspace.deviceLabel=label(input.deviceLabel,60);state.workspace.controllerProjectId=controller.projectId;
}
export function mapProject(state,input,projects){
  if(Object.hasOwn(input,'sourcePath')||Object.hasOwn(input,'sourceRepository'))throw Error('源码目录关联请使用独立的核验入口');
  const project=projects.find(p=>p.projectId===input.projectId&&p.path&&p.hostId==='local');
  if(!project||input.confirmed!==true)throw new Error('请核对本机项目名和目录后确认绑定');
  const logicalId=label(input.logicalId),logicalName=label(input.logicalName??input.logicalId);
  if(/[\\/\x00-\x1f]/.test(logicalId)||['__proto__','constructor','prototype'].includes(logicalId))throw new Error('逻辑标识不能包含路径或保留名称');
  if(Object.entries(state.workspace.mappings).some(([id,m])=>id!==input.projectId&&m.logicalId===logicalId))throw new Error('此电脑已有该逻辑项目的绑定，请先核对原映射');
  if(project.repository&&Object.entries(state.workspace.mappings).some(([id,m])=>id!==input.projectId&&(m.repository===project.repository||m.sourceRepository===project.repository)))throw Error('此电脑已有该源码仓库的绑定，请选择已绑定的副本');
  const shared=project.sourcePath?null:state.sync?.projectIdentities?.find(v=>v.repository===project.repository);
  if(shared&&shared.logicalId!==logicalId)throw Error('此源码仓库已有共享逻辑标识，不能直接改成另一个项目');
  const previous=state.workspace.mappings[project.projectId];
  if(previous&&previous.logicalId!==logicalId&&state.tasks.some(t=>t.projectId===project.projectId&&t.syncId))throw new Error('此项目已有同步待办，不能直接更换逻辑身份');
  if(previous&&previous.logicalId!==logicalId&&(state.jobs??[]).some(j=>j.projectId===project.projectId&&['queued','sending','submitted','running','uncertain'].includes(j.status)))throw new Error('此项目仍有未结束执行，请先取消未发送任务或完成核对，再更换逻辑身份');
  const tags=Array.isArray(input.tags)?input.tags.map(t=>label(t,40)):[];
  if(tags.length>12)throw new Error('自定义标签最多 12 个');
  state.workspace.mappings[project.projectId]={...(previous?.sourcePath?previous:{}),logicalId,logicalName,path:project.path,tags:[...new Set(tags)],...(!previous?.sourcePath&&project.repository?{repository:project.repository}:{})};
  return state.workspace.mappings[project.projectId];
}
export function workspaceReason(state,project){
  const w=state.workspace;
  if(!w?.deviceLabel||!w.controllerProjectId)return '请先设置电脑标签和总控项目';
  const mapping=w.mappings[project?.projectId];
  if(!mapping||normalize(mapping.path)!==normalize(project?.path))return project?.repositoryReason||'请先核对并绑定当前项目的逻辑名称和本机目录';
  if(mapping.sourcePath){if(normalize(mapping.sourcePath)!==normalize(project?.sourcePath)||mapping.sourceRepository!==project?.repository||project.repositoryReason)return project?.repositoryReason||'已关联源码目录暂不可确认，请核对原关联';return '';}
  if(mapping.localOnly&&project?.repositoryStatus!=='local'&&!project?.repository)return project?.repositoryReason||'本地项目身份暂不可确认';
  if(mapping.repository&&mapping.repository!==project?.repository)return '源码仓库已变化或暂不可读取，请核对项目身份';
  if(mapping.automatic&&project?.repositoryReason)return project.repositoryReason;
  return '';
}
export function workspaceView(state,projects){
  const {projectReferences,projectReferenceTags,projectReferenceGroups,taskGroups,projectBoard,...w}=state.workspace;
  return {...w,projects:projects.map(p=>({projectId:p.projectId,label:p.label,path:p.path,repository:p.repository??null,repositoryReason:p.repositoryReason??'',mapping:w.mappings[p.projectId]??null,reason:workspaceReason(state,p)}))};
}
