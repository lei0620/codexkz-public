import {createTask,updateTask,setTaskPriority,executeTask,retryReviewedTask,approveTask,returnTaskToTodo} from './board.mjs';
import {startPlan,controlPlan,acceptManualTask} from './automation.mjs';
import {applySuggestions} from './task-sections.mjs';
import {classify} from './capture.mjs';
import {maintenanceWaiting} from './maintenance.mjs';
const requireExecutionOpen=state=>{if(maintenanceWaiting(state)||state.maintenance?.status==='ready')throw Error('面板等待更新，暂不接收新执行');};

// Serializable command payloads; all reducers are synchronous domain code.
// The shared transaction adapter runs these domain reducers. SQLite receives
// serializable entity changes; callbacks and SQL never cross the Worker boundary.
export const storeCommands={
  createTask:(draft,{input,projects})=>createTask(draft,applySuggestions(draft,input,input.projectId,classify({text:(input.title??'')+' '+(input.description??'')},[],null).kind),projects),
  updateTask:(draft,{input})=>updateTask(draft,applySuggestions(draft,input,draft.tasks.find(t=>t.id===input.id)?.projectId,classify({text:(input.title??'')+' '+(input.description??'')},[],null).kind)),
  setTaskPriority:(draft,{input})=>setTaskPriority(draft,input),
  enqueueTask:(draft,{input,catalog,policy})=>{requireExecutionOpen(draft);return executeTask(draft,input,catalog,policy);},
  retryTask:(draft,{input,catalog,policy})=>{requireExecutionOpen(draft);return retryReviewedTask(draft,input,catalog,policy);},
  approveTask:(draft,{input,policy})=>approveTask(draft,input,policy),
  returnTask:(draft,{input,policy})=>returnTaskToTodo(draft,input,policy),
  startPlan:(draft,{input,manualAcceptance=false})=>{if(manualAcceptance)return acceptManualTask(draft,input);requireExecutionOpen(draft);return startPlan(draft,input);},
  controlPlan:(draft,{input})=>{if(input.action==='resume')requireExecutionOpen(draft);return controlPlan(draft,input);},
  recordJob:(draft,{id,patch,allowed})=>{
    const job=draft.jobs.find(j=>j.id===id);
    if(!job||allowed&&!allowed.includes(job.status))return false;
    Object.assign(job,patch);return true;
  },
  reserveTask:(draft,{id,confirmed=false,records})=>{
    if(!confirmed)requireExecutionOpen(draft);
    const task=draft.tasks.find(t=>t.id===id);if(!task)throw Error('待办不存在');
    task.syncReserved=true;
    if(confirmed){task.syncReservationConfirmed=true;draft.sync.base=records;}
  }
};
