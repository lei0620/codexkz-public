import {createHash} from 'node:crypto';
import {normalize} from './core.mjs';
import {writePaths} from './execution-scope.mjs';
export const unitName=task=>(task.execution?.unit||task.title).trim().normalize('NFKC').toLowerCase();
export const legacyModuleKey=task=>createHash('sha256').update(task.projectId+'\0'+normalize(task.path)+'\0'+unitName(task)).digest('hex');
export const moduleKey=task=>task.sectionId?createHash('sha256').update(task.projectId+'\0'+normalize(task.path)+'\0section:'+task.sectionId).digest('hex'):legacyModuleKey(task);
export function executionFields(input,previous,projectId,tasks){
  const result={};
  if(input.execution!==undefined){
    const e=input.execution;if(!e||!['match','new','fixed'].includes(e.mode)||typeof e.parallel!=='boolean')throw Error('请选择有效执行方式和并行关系');
    const unit=typeof e.unit==='string'?e.unit.trim():'';if(unit.length>80||/[\x00-\x1f]/.test(unit))throw Error('模块名称最多 80 字符');
    if(e.mode==='fixed'&&(typeof e.threadId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(e.threadId)))throw Error('请选择本项目的执行对话');
    result.execution={mode:e.mode,unit,parallel:e.parallel,threadId:e.mode==='fixed'?e.threadId:'',writePaths:writePaths(e.writePaths??previous?.execution?.writePaths)};
  }else if(previous?.execution)result.execution=previous.execution;
  if(input.dependsOn!==undefined){
    const ids=input.dependsOn;if(!Array.isArray(ids)||ids.length>20||new Set(ids).size!==ids.length||ids.some(id=>!tasks.some(t=>t.id===id&&t.projectId===projectId&&!t.archivedAt)||id===previous?.id))throw Error('前置任务必须是本项目的其他有效任务');
    const seen=new Set(),walk=id=>{if(id===previous?.id)throw Error('依赖关系形成循环');if(seen.has(id))return;seen.add(id);const t=tasks.find(t=>t.id===id);for(const next of [t?.parentId,...(t?.dependsOn??[])].filter(Boolean))walk(next);};for(const id of ids)walk(id);
    result.dependsOn=[...ids];
  }
  return result;
}
export function instructionHash(task){if(!task)return '';return createHash('sha256').update(JSON.stringify({title:task.title,description:task.description,path:normalize(task.path),tag:task.tag,attributes:task.attributes,attachments:task.attachments,execution:task.execution,sectionId:task.sectionId,sectionRevision:task.sectionRevision,pendingDependencies:task.pendingDependencies,...(task.pendingParentId?{pendingParentId:task.pendingParentId}:{}),dependsOn:task.dependsOn??[],parentId:task.parentId,workflowStage:task.workflowStage,reviewNote:task.reviewNote})).digest('hex');}
export function instructionMatches(task,expected){
  if(!task)return false;
  if(instructionHash(task)===expected)return true;
  // Sync may add an empty local dependency list to an unchanged queued card.
  return Array.isArray(task.pendingDependencies)&&task.pendingDependencies.length===0&&instructionHash({...task,pendingDependencies:undefined})===expected;
}
