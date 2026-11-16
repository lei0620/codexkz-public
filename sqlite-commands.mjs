import {storeCommands} from './store-commands.mjs';
import {syncTaskStates,resolveUncertainTask,resolveLegacyJob} from './board.mjs';
import {ingest,correctRecognition,changeTaskChain} from './capture.mjs';
import {archiveSource} from './capture-archive.mjs';
import {configureWorkspace,mapProject} from './workspace.mjs';
import {configureSidecars} from './board-sidecar.mjs';
import {applyRemote} from './task-sync.mjs';
import {saveSection} from './task-sections.mjs';
import {changeProperties} from './properties.mjs';
import {saveVersion} from './versions.mjs';
import {acceptVersionIntake,linkVersionIntake} from './version-intake.mjs';
import {importPlan,cancelPlan} from './plan-intake.mjs';
import {setBinding} from './core.mjs';
import {applyStateChanges} from './state-changes.mjs';
import {initializePanelState} from './panel-state.mjs';

export function initializeSqliteState(original){
  const state=initializePanelState(original);syncTaskStates(state);return state;
}

// External reads/files/Git/network are prepared by the caller. Worker commands
// accept their validated DTOs and only run the existing pure domain reducers.
export const sqliteCommands={
  ...storeCommands,
  applyPanelChanges:(state,{changes})=>{applyStateChanges(state,changes);return {applied:true};},
  configureProject:(state,{input,projects})=>configureWorkspace(state,input,projects),
  mapProject:(state,{input,projects})=>mapProject(state,input,projects),
  setBinding:(state,{input,catalog})=>setBinding(state,input,catalog),
  configureSidecars:(state,{input,catalog,enabled})=>configureSidecars(state,input,catalog,enabled),
  saveSection:(state,{input,projectId})=>saveSection(state,input,projectId),
  changeProperties:(state,{input,projects})=>changeProperties(state,input,projects),
  appendObservation:(state,{projectId,source,projects,options})=>ingest(state,projectId,source,projects,options),
  correctRecognition:(state,{input,projects})=>correctRecognition(state,input,projects),
  changeTaskChain:(state,{input,projects})=>changeTaskChain(state,input,projects),
  archiveSource:(state,{input,source,projects})=>archiveSource(state,input,source,projects),
  applyRemote:(state,{records,projects,files=[]})=>applyRemote(state,records,projects,new Map(files)),
  storeSyncConflict:(state,{conflicts})=>{state.sync.conflicts=conflicts;},
  storeAttachmentMeta:(state,{file})=>{if(!file?.id||!file.projectId||typeof file.sha256!=='string')throw Error('附件元数据无效');state.attachments[file.id]=file;return file;},
  saveVersion:(state,{input,project,snapshot})=>{const result=saveVersion(state,input,project,snapshot);if(input.intakeId)linkVersionIntake(state,input.intakeId,project,result.record);return result;},
  acceptVersionIntake:(state,{id,project,result})=>acceptVersionIntake(state,id,project,result),
  acceptIntake:(state,{id,project,report})=>importPlan(state,id,project,report),
  cancelIntake:(state,{id,project})=>cancelPlan(state,id,project),
  resolveUncertainTask:(state,{input})=>resolveUncertainTask(state,input),
  resolveLegacyJob:(state,{input})=>resolveLegacyJob(state,input)
};
