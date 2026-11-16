// Shared by the local service and the browser; no persistence or desktop writes.
export const continueTaskPrompt='继续处理当前任务，完成后给出结果；需要我回答时请明确提问。';
export const roundIdOf=job=>job?.roundId??job?.id;
export function groupRounds(jobs){
  const groups=new Map();
  for(const job of [...jobs].sort((a,b)=>String(a.createdAt??'').localeCompare(b.createdAt??''))){
    const key=job.taskId+'\0'+roundIdOf(job);let group=groups.get(key);
    if(!group){group={roundId:roundIdOf(job),createdAt:job.createdAt,steps:[]};groups.set(key,group);}
    group.steps.push(job);group.job=job;
  }
  return [...groups.values()];
}
export function openContinuation(state,task){
  if(task.status==='done')return null;
  const id=task.currentJobId??task.pendingContinuation?.jobId;
  const job=state.jobs.find(j=>j.id===id&&j.taskId===task.id&&j.projectId===task.projectId);
  if(!job||task.history?.some(e=>e.type==='approved'&&e.jobId===job.id))return null;
  return job;
}
export function awaitsReply(text){
  // Only the latest final reply is passed here, never previous progress messages.
  return /[?？]|请(?:你)?(?:确认|选择|回复|回答)|需要(?:你|您)(?:确认|选择|回复|回答)|是否|要不要|吗[。！!\s]*$/.test(String(text??''));
}
export function executionSuggestion(text){
  const value=String(text??'').trim();
  const plan=value.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/)?.[1];
  const lines=value.split('\n');let collected=[];
  if(plan)collected=[plan];
  else{
    let taking=false;
    for(const line of lines){
      if(/^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:执行建议|处理建议|建议|下一步(?:可执行动作)?|可复制(?:指令|提示词)|执行方案)(?:\*\*)?\s*[：:]?/.test(line)){taking=true;collected.push(line);continue;}
      if(taking&&/^\s*#{1,6}\s+/.test(line))break;
      if(taking)collected.push(line);
    }
  }
  const note=collected.join('\n').trim();return {note:note.length<=10000?note:'',tooLong:note.length>10000};
}

// These are desktop-generated reminders, not new user requests. For old cards,
// show the original objective; at ingestion, omit the reminder altogether.
// Fenced, quoted and indented examples remain literal user content.
export function goalContextText(value,{extractObjective=true}={}){
  const lines=String(value??'').match(/[^\n]*\n|[^\n]+$/g)??[],output=[];
  let fence=null;
  for(let i=0;i<lines.length;i++){
    const line=lines[i],marker=/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
    if(fence){output.push(line);if(marker&&marker[1][0]===fence.char&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;continue;}
    if(marker){fence={char:marker[1][0],length:marker[1].length};output.push(line);continue;}
    const opening=/^ {0,3}<codex_internal_context\b([^>]*)>[ \t]*(?:\r?\n)?$/.exec(line);
    if(!opening||!/(?:^|\s)source\s*=\s*(["'])goal\1(?:\s|$)/.test(opening[1])){output.push(line);continue;}
    let end=i+1,innerFence=null;
    for(;end<lines.length;end++){
      const marker=/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(lines[end]);
      if(innerFence){if(marker&&marker[1][0]===innerFence.char&&marker[1].length>=innerFence.length&&!marker[2].trim())innerFence=null;continue;}
      if(marker){innerFence={char:marker[1][0],length:marker[1].length};continue;}
      if(/^ {0,3}<\/codex_internal_context>[ \t]*(?:\r?\n)?$/.test(lines[end]))break;
    }
    const body=lines.slice(i+1,end).join('');
    if(extractObjective){const objective=/<objective>[ \t]*(?:\r?\n)?([\s\S]*)<\/objective>/.exec(body)?.[1];if(objective?.trim())output.push(objective.trim()+(lines[end]?.endsWith('\n')?'\n':''));}
    i=end;
  }
  return output.join('');
}
