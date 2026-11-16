import {randomUUID} from 'node:crypto';
import {createTask} from './board.mjs';
import {taskGroupName} from './task-groups.mjs';
import {sourceContent} from './source-display.mjs';
const regexText=text=>String(text).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

export function archiveDestination(state,event,source){
  const text=sourceContent(source).text;
  const tasks=state.tasks.filter(t=>t.projectId===event.projectId&&!t.archivedAt);
  const exact=tasks.filter(t=>t.sourceIds?.includes(event.id)||state.jobs.some(j=>j.taskId===t.id&&j.threadId===source.threadId&&j.turnId===source.turnId)||(!!text&&sourceContent({text:t.description}).text===text)||(t.shortId&&new RegExp('(?:^|[^A-Z0-9])'+regexText(t.shortId)+'(?:$|[^0-9])','i').test(text))||(t.title.length>=6&&text.includes(t.title)));
  const target=exact.length===1?exact[0]:null;
  const title=/任务说明与附件/.test(text)?'简化任务详情展示':/移动.{0,4}示意位置/.test(text)?'调整截图所示位置':(text.split(/[，。；\n]/).find(t=>/调整|优化|修改|修复|显示|归档/.test(t))||text.split(/[，。；\n]/)[0]||'已处理的对话记录').replace(/^(我发现|请|帮我)/,'').slice(0,100);
  const kind=event.suggestion.kind??'improvement';
  return {title:target?.title??title,taskId:target?.id??null,sectionName:taskGroupName(state,target),kind,text};
}

export function archiveSource(state,input,source,projects){
  const event=state.capture.events[input.id];
  if(!event||event.projectId!==input.projectId)throw Error('来源不存在或不属于本项目');
  if(event.status==='archived')return {duplicate:true,task:state.tasks.find(t=>t.id===event.taskId),archive:event.archive};
  if(input.handled!==true)throw Error('请确认这条历史需求已经处理');
  if(event.status!=='candidate')throw Error('这条来源已处理，请刷新查看');
  if(source.text!==event.source.text||source.turnId!==event.source.turnId||source.threadId!==event.source.threadId)throw Error('来源已变化，请刷新核对');
  if(!['completed','failed','interrupted'].includes(source.turnStatus))throw Error('原对话仍在进行，结束后才能归档');
  const destination=archiveDestination(state,event,source),at=new Date().toISOString();
  let task=destination.taskId?state.tasks.find(t=>t.id===destination.taskId):null;
  if(!task){
    task=createTask(state,{projectId:event.projectId,title:destination.title,description:destination.text,typeName:({feature:'新功能',bug:'Bug',improvement:'优化',analysis:'分析评审'})[destination.kind]??'优化',requestId:randomUUID()},projects).task;
    task.status='done';task.historyOnly=true;task.completedAt=at;task.sourceKind='conversation';task.delivery={codeVerified:false,enabled:false};
  }
  if(!task.sectionId&&(task.syncReserved||state.jobs.some(j=>j.taskId===task.id&&['queued','sending','submitted','running','uncertain'].includes(j.status))))throw Error('此任务仍在执行或已领取，请在结束后归档');
  // These are terminal history records, never queued attempts. Existing task
  // status/currentJobId/reservations are deliberately preserved.
  let job=state.jobs.find(j=>j.taskId===task.id&&j.threadId===source.threadId&&j.turnId===source.turnId);
  if(!job){job={id:randomUUID(),taskId:task.id,projectId:event.projectId,path:task.path,threadId:source.threadId,title:source.threadTitle,turnId:source.turnId,origin:'archive',status:'completed',sourceStatus:source.turnStatus,prompt:destination.text,result:source.result??'',createdAt:source.at??at,finishedAt:at,message:'已处理的历史归档，没有发送执行指令'};state.jobs.push(job);task.jobIds.push(job.id);if(task.historyOnly)task.currentJobId=job.id;}
  task.sourceIds??=[];if(!task.sourceIds.includes(event.id))task.sourceIds.push(event.id);
  task.history.push({id:randomUUID(),type:'source-archived',at,status:task.status,sourceId:event.id,jobId:job.id,note:'用户确认已处理，仅归档历史记录'});
  event.source={...source};event.status='archived';event.taskId=task.id;event.processedAt=at;
  event.archive={at,taskId:task.id,jobId:job.id,sectionId:task.sectionId??null,handled:true};
  return {task,archive:event.archive};
}
