import {createHash} from 'node:crypto';
import {instructionHash} from './execution.mjs';

const inFlight=new Set(['sending','submitted','running','uncertain']);
export const maintenanceWaiting=state=>state.maintenance?.status==='waiting';
export function maintenanceImpact(state,projects=[]){
  const rows=new Map();
  const row=id=>{if(!rows.has(id))rows.set(id,{projectId:id,name:projects.find(p=>p.projectId===id)?.label??state.workspace?.mappings?.[id]?.logicalName??'未识别项目',running:0,uncertain:0,queued:0,activePlans:0,pausedPlans:0});return rows.get(id);};
  for(const job of state.jobs){if(inFlight.has(job.status)){row(job.projectId).running++;if(job.status==='uncertain')row(job.projectId).uncertain++;}else if(job.status==='queued')row(job.projectId).queued++;}
  for(const plan of state.automation.plans)if(['active','paused'].includes(plan.status))row(plan.projectId)[plan.status==='active'?'activePlans':'pausedPlans']++;
  return [...rows.values()];
}
// One-use local continuation permission, scoped to the exact plan and inputs at
// the safe restart boundary. Nothing here is exported through task sync.
function planFingerprint(state,plan){
  return createHash('sha256').update(JSON.stringify([plan,plan.nodes.map(n=>{
    const task=state.tasks.find(t=>t.id===n.taskId),job=state.jobs.find(j=>j.id===n.jobId);
    return [task?instructionHash(task):null,task?.status,task?.archivedAt??null,job?.status??null];
  })])).digest('hex');
}
export function armMaintenance(state){
  if(state.jobs.some(j=>inFlight.has(j.status)))throw Error('还有在途或未决任务，继续等待，不中断对话');
  state.maintenance={status:'ready',requestedAt:state.maintenance?.requestedAt??new Date().toISOString(),expiresAt:Date.now()+120000,
    plans:state.automation.plans.filter(p=>p.status==='active').map(p=>({id:p.id,fingerprint:planFingerprint(state,p)}))};
}
export function consumeMaintenance(state){
  const receipt=state.maintenance,resume=new Set();
  if(receipt?.status==='ready'&&receipt.expiresAt>Date.now()&&receipt.expiresAt<=Date.now()+120000&&!state.jobs.some(j=>inFlight.has(j.status))){
    for(const saved of receipt.plans??[]){const plan=state.automation.plans.find(p=>p.id===saved.id);if(plan?.status==='active'&&saved.fingerprint===planFingerprint(state,plan))resume.add(plan.id);}
  }
  // Persisted by createPanel before any scheduler is started; stale, interrupted
  // or failed maintenance never grants a later boot continuation permission.
  delete state.maintenance;
  return resume;
}
