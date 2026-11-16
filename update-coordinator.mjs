import path from 'node:path';
import {acquireDataLock} from './data-lock.mjs';
import {safeLocalPath} from './maintenance-policy.mjs';
import {verifyBackupMatchesSource} from './installed-migration.mjs';
import {listReleaseTransactions,advanceReleaseTransaction} from './release-journal.mjs';
import {activatePreparedRelease,rollbackProgramRelease,inspectActiveVersion} from './release-activation.mjs';

function pending(dataRoot,lease,id){const found=listReleaseTransactions({root:dataRoot,lease}).filter(row=>row.id===id);if(found.length!==1)throw Error('升级记录不存在');return found[0];}

// Invoked only after the old child exits cleanly; never stop a live child here.
export async function applyOfflineUpdate({installRoot,dataRoot,id,powershellPath}){
  dataRoot=safeLocalPath(dataRoot,{directory:true});const lease=await acquireDataLock(path.join(dataRoot,'data'));
  try{
    const tx=pending(dataRoot,lease,id);if(tx.phase!=='backed-up')throw Error('升级未完成安全备份');
    const result=await activatePreparedRelease({installRoot,dataRoot,lease,id,powershellPath});
    const directory=path.join(installRoot,'versions',result.slot);
    return {...result,program:path.join(directory,'program'),node:path.join(directory,'runtime','node','node.exe'),powershell:path.join(directory,'runtime','powershell','pwsh.exe')};
  }finally{await lease.release();}
}

// A failed, exited child may be rolled back only if the latest data still
// matches the verified snapshot. Unknown or already-confirmed outcomes stop.
export async function recoverFailedUpdate({installRoot,dataRoot,id,reason}){
  dataRoot=safeLocalPath(dataRoot,{directory:true});const lease=await acquireDataLock(path.join(dataRoot,'data'));
  try{
    const tx=pending(dataRoot,lease,id);
    if(tx.phase==='backed-up'){
      const backup=tx.records.find(row=>row.phase==='backed-up').data.backupPath;
      verifyBackupMatchesSource({source:dataRoot,backup,lease});advanceReleaseTransaction({root:dataRoot,lease,id,phase:'cancelled'});
    }else if(['switching','started','rollback-required'].includes(tx.phase))rollbackProgramRelease({installRoot,dataRoot,lease,id,reason});
    else throw Error('升级结果不明确，未自动回退或启动旧程序');
    const active=inspectActiveVersion(installRoot),runtime=path.dirname(active.program);
    return {program:active.program,node:path.join(runtime,'runtime','node','node.exe'),powershell:path.join(runtime,'runtime','powershell','pwsh.exe'),version:active.version,dataRestored:false};
  }finally{await lease.release();}
}
