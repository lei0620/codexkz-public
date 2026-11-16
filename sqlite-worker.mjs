import {parentPort,workerData} from 'node:worker_threads';
import path from 'node:path';
import {acquireDataLock} from './data-lock.mjs';
import {SqliteDatabase,sqliteError} from './sqlite-database.mjs';
import {fingerprint} from './sqlite-codec.mjs';
import {sqliteCommands,initializeSqliteState} from './sqlite-commands.mjs';
import {syncTaskStates} from './board.mjs';
import {isolatedSqliteRoot,checkSqliteRuntime} from './sqlite-isolation.mjs';

let database,lock,closing=false;
const size=value=>Buffer.byteLength(JSON.stringify(value));
const pack=error=>({code:error.code??'INVALID_ARGUMENT',message:error.message});
try{
  checkSqliteRuntime();const root=isolatedSqliteRoot(workerData.root);
  lock=workerData.externalLock?{release:async()=>{}}:await acquireDataLock(path.join(root,'data'));
  database=new SqliteDatabase(path.join(root,'data','panel.sqlite'));
  if(!workerData.deferRecovery){const initial=initializeSqliteState(structuredClone(database.current??workerData.initialState));if(!database.current||JSON.stringify(initial)!==JSON.stringify(database.current))database.commit(initial,{operation:'open'});}
  parentPort.postMessage({ready:true,value:database.inspect()});
}catch(error){database?.close();await lock?.release();parentPort.postMessage({ready:true,error:pack(error)});parentPort.close();}

if(database&&lock)parentPort.on('message',async message=>{
  const {id,type,payload}=message;
  try{
    if(closing)throw Object.assign(Error('SQLite存储正在关闭'),{code:'CLOSING'});
    if(type==='close'){
      closing=true;database.close();await lock.release();parentPort.postMessage({id,value:{closed:true}});parentPort.close();return;
    }
    if(size(payload)>workerData.maxBytes)throw Object.assign(Error('SQLite命令超过大小限制'),{code:'LIMIT_EXCEEDED'});
    let answer;
    if(type==='query')answer=database.query(payload.name,payload.args);
    else if(type==='command'){
      const command=payload,scope=command.scope??'command',signature=fingerprint(command);
      if(typeof scope!=='string'||scope.length>100||typeof command.commandId!=='string'||command.commandId.length>100)throw Error('命令标识或作用域无效');
      const previous=database.commandResult(scope,command.commandId,signature);
      if(previous)answer=previous;
      else{
        if(command.expectedRevision&&command.expectedRevision!==database.revision)throw Object.assign(Error('存储版本已变化'),{code:'CONFLICT_REVISION'});
        for(const expected of command.expected??[]){const table={tasks:'tasks',jobs:'jobs',taskSections:'sections',attachments:'attachments',versionRecords:'versions'}[expected.entity];if(!table||database.entity(table,expected.id,expected.projectId)?.revision!==expected.revision)throw Object.assign(Error('实体版本已变化'),{code:'CONFLICT_REVISION'});}
        const reduce=Object.hasOwn(sqliteCommands,command.operation)&&sqliteCommands[command.operation];if(typeof reduce!=='function')throw Error('未知SQLite业务命令');
        if(command.operation==='applyPanelChanges'&&!command.expectedRevision)throw Error('面板事务必须指定存储版本');
        if(command.operation==='setTaskPriority'){
          answer=database.setPriority(command.payload.input,{scope,id:command.commandId,signature,maxBytes:workerData.maxBytes});
        }else{
        const draft=structuredClone(database.current??{}),result=reduce(draft,command.payload??{});if(result?.then)throw Error('SQLite事务不允许异步业务回调');
        syncTaskStates(draft);
        if(size({value:result})>workerData.maxBytes)throw Object.assign(Error('命令返回值超过大小限制'),{code:'LIMIT_EXCEEDED'});
        answer=database.commit(draft,{scope,id:command.commandId,signature,operation:command.operation,result});
        }
      }
    }else throw Error('未知存储消息');
    if(size(answer)>workerData.maxBytes)throw Object.assign(Error('查询结果过大，请缩小分页'),{code:'LIMIT_EXCEEDED'});
    parentPort.postMessage({id,value:answer});
  }catch(error){parentPort.postMessage({id,error:pack(sqliteError(error))});}
});
