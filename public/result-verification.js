const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labels={changes:'本轮变更',tests:'测试与验证',remaining:'未测与剩余项',code:'代码依据'};
const headings={
  changes:/^(?:本轮)?(?:变更|修改|实现|修复|改动|完成内容)|^changes?\b/i,
  tests:/^(?:测试|验证|检查)(?:结果|情况|范围)?|^(?:tests?|validation|verification)\b/i,
  remaining:/^(?:未测|未验证|未执行|未跑|剩余|待办|待验|风险|限制|阻塞|已知问题)|^(?:remaining|untested|limitations?|risks?)\b/i,
  code:/^(?:代码依据|源码依据|源码|提交|版本依据)|^(?:commit|code references?)\b/i,
};
const markers={
  changes:/修改|实现|修复|新增|调整|改动|更新了|implemented|changed|fixed/i,
  tests:/测试|验证|检查|npm (?:run|test)|node --test|\b(?:passed|failed|verify|check)\b/i,
  remaining:/未测|未验证|未跑|未执行|未覆盖|尚未|待验|剩余|阻塞|风险|限制|失败|untested|not tested|remaining|limitations?/i,
  code:/提交|\bcommit\b|\bsha(?:-?256)?\b|源码|[\w./-]+\.(?:mjs|js|css|html|py|ts|tsx|vue|md)(?::\d+)?/i,
};

// These are bounded excerpts of a report, never machine validation results.
export function reportExcerpts(text){
  const fields={changes:[],tests:[],remaining:[],code:[]};let section='';
  const add=(key,line)=>{if(fields[key].length<2&&!fields[key].includes(line))fields[key].push(line.length>180?line.slice(0,180)+'…':line);};
  for(const raw of String(text??'').slice(0,60000).split(/\r?\n/).slice(0,800)){
    const line=raw.trim().replace(/^#{1,6}\s*/,'').replace(/^[-*+]\s+|^\d+[.、)]\s+/,'').replace(/\*\*/g,'');
    if(!line||/^```/.test(line))continue;
    const title=line.split(/[:：]/,1)[0],key=Object.keys(headings).find(key=>headings[key].test(title));
    const heading=/^\s*#{1,6}\s/.test(raw)||key&&title.length<24&&(/[:：]/.test(line)||/^(?:本轮变更|变更|修改|实现|修复|改动|完成内容|测试|验证|检查|未测|未验证|未执行|未跑|剩余|待办|待验|风险|限制|阻塞|已知问题|未测与剩余项|代码依据|源码依据|源码|提交|版本依据|changes?|tests?|validation|verification|remaining|untested|limitations?|risks?|commit|code references?)$/i.test(line));
    if(heading){
      section=key??'';
      const colon=line.search(/[:：]/);if(key&&colon>=0&&line.slice(colon+1).trim())add(key,line.slice(colon+1).trim());
      continue;
    }
    if(section)add(section,line);
    for(const [key,pattern] of Object.entries(markers))if(pattern.test(line))add(key,line);
  }
  return Object.fromEntries(Object.entries(fields).map(([key,lines])=>[key,lines.join('\n')]));
}

export function resultVerification({task={},job,completion,roundIndex}={}){
  const mismatch=!!(job?.taskId&&task.id&&job.taskId!==task.id);
  const text=mismatch?'':job?.result??completion?.note??'';
  const index=Number.isInteger(job?._roundIndex)&&job._roundIndex>=0?job._roundIndex:roundIndex;
  const round=Number.isInteger(index)&&index>=0?'第 '+(index+1)+' 轮':'轮次编号未提供';
  const approved=!!job?.id&&task.history?.some(event=>event.type==='approved'&&event.jobId===job.id);
  const states={completed:'本轮对话已结束',failed:'本轮执行失败',interrupted:'本轮已中断',uncertain:'本轮状态未确认',released:'本轮已解除未决'};
  const state=mismatch?'轮次归属不匹配':job?states[job.status]??'尚未收齐本轮结果':completion?'跨电脑完成接续登记':'尚无结果记录';
  const fields=reportExcerpts(text);
  const records=[['任务记录',task.id],['轮次记录',mismatch?'归属不匹配，未采用':job?.id],['原对话',mismatch?'':job?.threadId],['对话轮次',mismatch?'':job?.turnId],['本轮审阅',approved?'已记录人工通过':'未提供本轮人工通过记录']];
  if(completion){records.push(['接续登记提交',completion.commit],['接续登记依据',completion.evidencePath]);}
  return {round,state,fields,records,source:mismatch?'未采用不匹配的报告':job?.origin==='archive'?'历史归档报告':completion&&!job?'接续说明报告':'执行者报告'};
}

export function resultVerificationMarkup(input){
  const view=resultVerification(input);
  return `<section class="verification-summary" aria-label="本轮验证摘要"><h4>${escape(view.round)} · 核对摘要</h4><p class="verification-summary-status">${escape(view.state)}</p><p class="verification-summary-source">${escape(view.source)}（摘录） · 尚未独立核验；原文保留在下方。</p><dl class="verification-summary-fields">${Object.entries(labels).map(([key,label])=>`<div><dt>${label}</dt><dd>${escape(view.fields[key]||'未提供明确摘要，请核对原文。')}</dd></div>`).join('')}</dl><details class="verification-summary-records"><summary>轮次与来源记录</summary><p class="hint">仅确认记录关联，不证明代码或测试通过。</p><dl>${view.records.map(([label,value])=>`<div><dt>${label}</dt><dd>${escape(value||'未提供')}</dd></div>`).join('')}</dl></details></section>`;
}
