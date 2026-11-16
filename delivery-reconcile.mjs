import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
const exec=promisify(execFile),digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const evidencePath='docs/ROADMAP.md';
async function git(root,args){return (await exec('git',['--no-optional-locks',...args],{cwd:root,windowsHide:true,timeout:15000,maxBuffer:2*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();}

// Only committed delivery evidence in this application's repository is accepted.
// This records a transfer of completed work, never a synthetic local job/turn.
export async function inspectDelivery(root,commit){
  if(typeof commit!=='string'||! /^[a-f0-9]{40}$/.test(commit))throw Error('请提供完整的已交付提交SHA');
  const remote=await git(root,['remote','get-url','origin']);
  if(!/^(?:https:\/\/github\.com\/|git@github\.com:)lei0620\/codexkz(?:\.git)?\/?$/i.test(remote))throw Error('完成接续仅支持当前已确认的源码仓库');
  const head=await git(root,['rev-parse','HEAD']);
  await git(root,['merge-base','--is-ancestor',commit,head]);
  if(await git(root,['status','--porcelain','--untracked-files=no']))throw Error('工作区尚有未提交修改，请先核对源码后接续');
  const document=await git(root,['show',commit+':'+evidencePath]),current=await git(root,['show',head+':'+evidencePath]);
  const parse=text=>{
    const entries=new Map();
    for(const section of text.split(/(?=^## )/m)){
      const heading=/^## (R\d+)[：:]\s*(.+)$/m.exec(section),status=/^- 状态[：:]\s*done(?:\s|（|\(|$)/m.test(section);
      if(heading&&status&&section.includes('Task ID：'+heading[1]))entries.set(heading[1],{title:heading[2].trim(),sectionHash:digest(section)});
    }
    return entries;
  };
  const delivered=parse(document),latest=parse(current);
  return {commit,head,evidencePath,evidenceHash:digest(document),tasks:Object.fromEntries([...delivered].filter(([code,item])=>latest.get(code)?.title===item.title))};
}

function receipt(task,proof){return task.history?.findLast(e=>e.type==='delivery-reconciled'&&e.commit===proof.commit&&e.evidenceHash===proof.evidenceHash);}
export function deliveryPreview(state,{projectId,ids},proof){
  if(!Array.isArray(ids)||!ids.length||ids.length>20||new Set(ids).size!==ids.length)throw Error('请选择1–20项不同的接续任务');
  const tasks=ids.map(id=>state.tasks.find(t=>t.id===id));
  for(const task of tasks){
    if(!task||task.projectId!==projectId||task.archivedAt)throw Error('接续任务不存在、已归档或不属于本项目');
    if(proof.tasks[task.shortId]?.title!==task.title)throw Error('提交中没有编号和标题均匹配的已完成证据：'+task.title);
    if(task.status==='done'&&receipt(task,proof))continue;
    if(task.status!=='todo'||task.currentJobId||task.syncReserved||task.jobIds?.length||state.jobs.some(j=>j.taskId===task.id))throw Error('仅无本机执行记录且未领取的旧待办可以接续：'+task.title);
    if(task.history?.some(e=>['edited','returned','round-added'].includes(e.type)))throw Error('任务有本机修改或返工记录，请先人工核对：'+task.title);
  }
  const plans=state.automation.plans.filter(p=>p.nodes.some(n=>ids.includes(n.taskId)&&!n.skipped));
  if(plans.some(p=>p.nodes.some(n=>ids.includes(n.taskId)&&n.jobId)))throw Error('接续任务已有执行安排记录，请核对后处理');
  const duplicate=tasks.every(t=>t.status==='done'&&receipt(t,proof));
  return {projectId,ids:[...ids],commit:proof.commit,head:proof.head,duplicate,previewHash:digest({tasks,plans,commit:proof.commit,head:proof.head,evidenceHash:proof.evidenceHash}),tasks:tasks.map(t=>({id:t.id,code:t.shortId,title:t.title,status:t.status})),planIds:plans.filter(p=>['active','paused'].includes(p.status)).map(p=>p.id)};
}

export function reconcileDelivery(state,input,proof){
  const preview=deliveryPreview(state,input,proof);
  if(preview.duplicate)return {...preview,changed:0};
  if(input.confirmed!==true||input.previewHash!==preview.previewHash)throw Error('接续预览已变化，请重新核对；未修改任务');
  const at=new Date().toISOString(),ids=new Set(input.ids);let changed=0;
  for(const task of state.tasks.filter(t=>ids.has(t.id))){
    if(task.status==='done')continue;
    const previous={status:task.status,currentJobId:task.currentJobId??null,pendingDependencies:[...(task.pendingDependencies??[])]};
    task.status='done';task.completedAt=at;task.updatedAt=at;
    task.history??=[];task.history.push({id:randomUUID(),at,type:'delivery-reconciled',commit:proof.commit,evidencePath:proof.evidencePath,evidenceHash:proof.evidenceHash,taskCode:task.shortId,previous,note:'已核对已拉取提交中的完成成果，接续到本机；没有重复执行或创建本机对话轮次。'});changed++;
  }
  // Cancel only the now-redundant unsent nodes in the same atomic transaction.
  for(const plan of state.automation.plans){
    if(!['active','paused'].includes(plan.status))continue;
    for(const node of plan.nodes)if(ids.has(node.taskId)&&!node.jobId&&!node.skipped){node.skipped=true;node.status='cancelled';node.message='已接续跨电脑完成成果，未重复执行';}
    if(plan.nodes.every(n=>n.skipped)){plan.status='completed';plan.reason='已接续完成成果，无需重复执行';}
  }
  return {...preview,changed};
}
