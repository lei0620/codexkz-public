import {SCHEMA_VERSION,migrateState} from './board.mjs';
import {initSections} from './task-sections.mjs';
import {initCapture} from './capture.mjs';
import {initializeAutomation} from './automation.mjs';
import {initializeSidecars} from './board-sidecar.mjs';
import {initializeWorkspace} from './workspace.mjs';
import {initializeSync} from './task-sync.mjs';

// Runtime recovery is shared by both backends. Migration never calls this.
export function initializePanelState(original,{caller}={}){
  let state;
  if(original==null)state={bindings:{},jobs:[],tasks:[],schemaVersion:SCHEMA_VERSION,caller:''};
  else try{state=migrateState(original);}catch(error){error.code=original?.schemaVersion>SCHEMA_VERSION?'UNSUPPORTED_SCHEMA':'CORRUPT';throw error;}
  if(caller!==undefined)state.caller=caller;
  state.attachments??={};initSections(state);state.planIntakes??=[];if(!Array.isArray(state.planIntakes))throw Error('方案整理请求无效');initCapture(state);initializeAutomation(state);
  state.versionRecords??=[];if(!Array.isArray(state.versionRecords))throw Error('版本记录格式无效，已停止加载以保护数据');
  state.versionIntakes??=[];if(!Array.isArray(state.versionIntakes))throw Error('版本请求格式无效，已停止加载以保护数据');
  initializeSidecars(state);initializeWorkspace(state);initializeSync(state);
  for(const job of state.jobs)if(job.origin!=='observed'&&['sending','running','submitted'].includes(job.status)){job.status='uncertain';job.error='服务重启，请核对原对话。系统不会自动重发。';}
  return state;
}
