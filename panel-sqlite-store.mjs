import {openSqliteStore} from './sqlite-store.mjs';
import {StateStore} from './state-store.mjs';
import {stateChanges} from './state-changes.mjs';
import {syncTaskStates} from './board.mjs';
import {storeCommands} from './store-commands.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {isolatedSqliteRoot} from './sqlite-isolation.mjs';

// Bridge existing synchronous domain reducers to serialized asynchronous
// commits. Only changed entity/map DTOs cross the Worker boundary.
export async function openPanelSqliteStore({root,lockLease,timeoutMs}={}){
  root=isolatedSqliteRoot(root);
  const readMarker=file=>{const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>16*1024*1024)throw Error('存储标记无效');return JSON.parse(fs.readFileSync(file,'utf8'));};
  const mode=readMarker(path.join(root,'data','storage-mode.json')),manifest=readMarker(path.join(root,'bundle-manifest.json')),guard=readMarker(path.join(root,'data','state.json'));
  if(mode.version!==1||mode.storageSchema!==1||mode.backend!=='sqlite'||!['prepared','active'].includes(mode.phase)||manifest.version!==1||manifest.kind!=='sqlite-candidate'||mode.migrationId!==manifest.migrationId||mode.sourceFingerprint!==manifest.sourceFingerprint||guard.storageBackend!=='sqlite'||guard.migrationId!==mode.migrationId||guard.schemaVersion!==2147483647)throw Error('SQLite HTTP入口需要R42已核验候选及旧入口保护');
  const client=await openSqliteStore({root,lockLease,deferRecovery:true,timeoutMs});
  try{
    const info=await client.inspect();if(info.migrationId!==mode.migrationId||info.migrationFingerprint!==mode.sourceFingerprint||info.journal!=='delete')throw Error('数据库与候选来源或日志策略不匹配');
    const snapshot=await client.snapshot();let durable=snapshot.value,remoteRevision=snapshot.revision;
    const backend={kind:'sqlite',acceptExternalTask:true,read:()=>structuredClone(durable),async write(value){
      const next=JSON.parse(JSON.stringify(value)),changes=stateChanges(durable,next);
      const result=await client.executeCommand({operation:'applyPanelChanges',expectedRevision:remoteRevision,payload:{changes}});
      durable=next;remoteRevision=result.revision;
    }};
    const store=new StateStore(backend,{normalize:syncTaskStates,commands:storeCommands});
    let tail=Promise.resolve(),queued=0,closing=false,closed;
    const queue=operation=>{
      if(closing)return Promise.reject(Object.assign(Error('存储正在关闭'),{code:'CLOSING'}));
      if(queued>=32)return Promise.reject(Object.assign(Error('存储等待队列已满'),{code:'STORE_BUSY'}));
      queued++;const work=tail.then(operation);tail=work.catch(()=>{});return work.finally(()=>{queued--;});
    };
    return {
      prepare:initialize=>store.prepare(initialize),activate:value=>queue(()=>store.activate(value)),view:()=>store.view(),
      transaction:(meta,reduce)=>queue(()=>store.transaction(meta,reduce)),executeCommand:command=>queue(async()=>{
        if(command.operation!=='setTaskPriority')return store.executeCommand(command);
        if(command.expectedRevision&&command.expectedRevision!==store.inspect().revision)throw Object.assign(Error('数据已变化，请重新读取'),{code:'CONFLICT_REVISION'});
        for(const expected of command.expected??[])if(store.getEntity(expected.entity,expected.id,expected.projectId)?.revision!==expected.revision)throw Object.assign(Error('记录已变化，请重新核对'),{code:'CONFLICT_REVISION'});
        const result=await client.executeCommand({operation:command.operation,payload:structuredClone(command.payload),expectedRevision:remoteRevision});
        durable=store.acceptCommittedTask(result.value.task,result.revision);remoteRevision=result.revision;
        return {value:structuredClone(result.value),revision:store.inspect().revision};
      }),
      getTask:(...args)=>store.getTask(...args),getJob:(...args)=>store.getJob(...args),getEntity:(...args)=>store.getEntity(...args),queryQueue:(...args)=>store.queryQueue(...args),
      inspect:()=>({...store.inspect(),closed:client.status().closed,fault:store.inspect().fault??client.status().fault,sqlite:info.sqlite,queued}),
      // Restart has stopped new work and checked all external operations idle.
      // Flush queued commits first; this private Worker has no background writer.
      backup:backup=>queue(async()=>{await store.flush();return backup(path.join(root,'data','panel.sqlite'));}),
      close(){if(closed)return closed;closing=true;closed=(async()=>{await tail;try{if(!client.status().fault)await store.close();}finally{await client.close();}})();return closed;}
    };
  }catch(error){await client.close();throw error;}
}
