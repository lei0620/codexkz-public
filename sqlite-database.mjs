import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {tableSpecs,migrateDatabase} from './sqlite-schema.mjs';
import {encodeState,decodeState,validateRelations,fingerprint} from './sqlite-codec.mjs';
import {setTaskPriority} from './board.mjs';

export function sqliteError(error){
  if(error.code!=='ERR_SQLITE_ERROR'&&error.errcode===undefined)return error;
  const code=Number(error.errcode??0)&255;
  return Object.assign(new Error(error.message),{code:code===5||code===6?'STORE_BUSY':code===19?'CONSTRAINT':code===13?'DISK_FULL':code===11||code===26?'CORRUPT':'IO_ERROR'});
}
const common=['row_key','legacy_ordinal','payload_json','revision'];
function immutable(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))immutable(child);}return value;}
const resultEntities={tasks:'tasks',jobs:'jobs',taskSections:'sections',attachments:'attachments',versionRecords:'versions',versionIntakes:'version_intakes',planIntakes:'plan_intakes'};
function resultReference(value,state){
  if(value===undefined)return {kind:'undefined'};
  if(value===null||typeof value!=='object')return {kind:'value',value};
  if(value.id)for(const [field,table] of Object.entries(resultEntities)){
    const rows=state[field],candidate=Array.isArray(rows)?rows.find(row=>row.id===value.id):rows?.[value.id];
    if(candidate&&JSON.stringify(candidate)===JSON.stringify(value))return {kind:'entity',table,id:value.id,projectId:value.projectId};
  }
  return Array.isArray(value)?{kind:'array',items:value.map(item=>resultReference(item,state))}:{kind:'object',entries:Object.entries(value).map(([key,item])=>[key,resultReference(item,state)])};
}

export class SqliteDatabase{
  db; current; encoded; revision; #statements=new Map(); #jsonCache=new WeakMap();
  constructor(file,{readOnly=false}={}){
    try{
      this.db=new DatabaseSync(file,{readOnly,timeout:250,defensive:true,allowExtension:false,enableForeignKeyConstraints:true});
      if(readOnly){
        const version=this.db.prepare('PRAGMA user_version').get().user_version;
        if(version!==1||this.db.prepare('PRAGMA application_id').get().application_id!==1128551256)throw Object.assign(Error('SQLite版本或项目标识不匹配，未修改文件'),{code:version>1?'UNSUPPORTED_SCHEMA':'CORRUPT'});
        this.db.exec('PRAGMA query_only=ON;PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;BEGIN');
      }else{
        migrateDatabase(this.db);
        this.db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;');
      }
      const layout=this.db.prepare('SELECT * FROM state_layout ORDER BY legacy_ordinal').all(),rows=new Map();
      for(const name of Object.keys(tableSpecs))rows.set(name,new Map(this.db.prepare(`SELECT row_key,legacy_ordinal,payload_json,revision FROM ${name}`).all().map(row=>[row.row_key,row])));
      this.current=immutable(decodeState(layout,rows));
      rows.clear();layout.length=0;
      if(!this.current&&this.db.prepare("SELECT value FROM store_metadata WHERE key='initialized'").get())throw Object.assign(Error('SQLite已初始化但缺少根布局'),{code:'CORRUPT'});
      this.encoded=this.current?encodeState(this.current,{copy:false}):{rows:new Map(Object.keys(tableSpecs).map(name=>[name,new Map()])),layout:[]};
      this.revision=this.db.prepare("SELECT value FROM store_metadata WHERE key='revision'").get()?.value??randomUUID();
      if(this.current)this.priorityFingerprints(this.current);
      if(readOnly)this.db.exec('COMMIT');
    }catch(error){this.db?.close();throw sqliteError(error);}
  }
  statement(sql){let statement=this.#statements.get(sql);if(!statement){statement=this.db.prepare(sql);this.#statements.set(sql,statement);}return statement;}
  cachedJSON(value){
    if(!value||typeof value!=='object')return JSON.stringify(value);
    let text=this.#jsonCache.get(value);if(text===undefined){text=JSON.stringify(value);this.#jsonCache.set(value,text);}return text;
  }
  priorityFingerprints(state){
    const root=createHash('sha256'),tasks=createHash('sha256');root.update('{');tasks.update('[');
    for(const [index,key] of Object.keys(state).entries()){
      root.update((index?',':'')+JSON.stringify(key)+':');
      if(key==='tasks'&&Array.isArray(state.tasks)){
        root.update('[');for(const [i,task] of state.tasks.entries()){const text=(i?',':'')+this.cachedJSON(task);root.update(text);tasks.update(text);}root.update(']');
      }else root.update(this.cachedJSON(state[key]));
    }
    root.update('}');tasks.update(']');return {root:root.digest('hex'),tasks:tasks.digest('hex')};
  }
  inspect(){return {backend:'sqlite',node:process.version,sqlite:this.db.prepare('SELECT sqlite_version() AS version').get().version,storageSchema:this.db.prepare('PRAGMA user_version').get().user_version,journal:this.db.prepare('PRAGMA journal_mode').get().journal_mode,synchronous:this.db.prepare('PRAGMA synchronous').get().synchronous,foreignKeys:this.db.prepare('PRAGMA foreign_keys').get().foreign_keys,busyTimeout:this.db.prepare('PRAGMA busy_timeout').get().timeout,revision:this.revision,tables:Object.keys(tableSpecs).length,migrationId:this.db.prepare("SELECT value FROM store_metadata WHERE key='migration_id'").get()?.value??null,migrationFingerprint:this.db.prepare("SELECT value FROM store_metadata WHERE key='migration_source_fingerprint'").get()?.value??null};}
  commandResult(scope,id,signature){
    const row=this.statement('SELECT * FROM request_ledger WHERE scope=? AND request_id=?').get(scope,id);
    if(row&&signature!==undefined&&row.signature!==signature)throw Object.assign(Error('命令标识已用于其他内容'),{code:'IDEMPOTENCY_CONFLICT'});
    if(!row)return null;
    const resolve=ref=>ref.kind==='undefined'?undefined:ref.kind==='value'?ref.value:ref.kind==='entity'?this.entity(ref.table,ref.id,ref.projectId)?.value??null:ref.kind==='array'?ref.items.map(resolve):Object.fromEntries(ref.entries.map(([key,value])=>[key,resolve(value)]));
    return {value:resolve(JSON.parse(row.result_ref_json)),revision:row.revision};
  }
  // The typed priority operation cannot change jobs, dependencies or identity.
  // Keep the normal reducer and SQL constraints, but encode only its task tree.
  setPriority(input,{scope,id,signature,maxBytes=Infinity}={}){
    const index=this.current.tasks.findIndex(t=>t.id===input.id);if(index<0)throw Error('看板任务不存在');
    const tasks=[...this.current.tasks];tasks[index]=structuredClone(tasks[index]);const next={...this.current,tasks};
    const result=setTaskPriority(next,input);if(Buffer.byteLength(JSON.stringify({value:result}))>maxBytes)throw Object.assign(Error('命令返回值超过大小限制'),{code:'LIMIT_EXCEEDED'});
    const before=encodeState(this.current,{copy:false,taskIndex:index}),after=encodeState(next,{copy:false,taskIndex:index});
    const fingerprints=this.priorityFingerprints(next);
    const ancestors=['[]','["tasks"]'].map(key=>{const node=this.encoded.layout.find(row=>row.row_key===key),old=this.encoded.rows.get(node.table_name).get(key),value=key==='[]'?next:tasks;return {table:node.table_name,key,row:{...old,revision:key==='[]'?fingerprints.root:fingerprints.tasks,context:{...old.context,value}}};});
    const first=this.encoded.layout.findIndex(row=>row.row_key===before.layout[0].row_key);
    if(first<0)throw Error('任务编码缓存缺失');
    const layout=this.encoded.layout.slice(0,first).concat(after.layout,this.encoded.layout.slice(first+before.layout.length));
    immutable(next);
    const revision=randomUUID(),answer={value:structuredClone(result),revision};
    try{
      this.db.exec('BEGIN IMMEDIATE');
      if(id){const previous=this.commandResult(scope,id,signature);if(previous){this.db.exec('ROLLBACK');return previous;}}
      this.applyEncoding(before,after);
      for(const ancestor of ancestors)this.statement(`UPDATE ${ancestor.table} SET revision=? WHERE row_key=?`).run(ancestor.row.revision,ancestor.key);
      this.statement("UPDATE store_metadata SET value=? WHERE key='revision'").run(revision);
      if(id)this.statement('INSERT INTO request_ledger(scope,request_id,signature,operation,result_ref_json,revision) VALUES(?,?,?,?,?,?)').run(scope,id,signature,'setTaskPriority',JSON.stringify(resultReference(result,next)),revision);
      this.db.exec('COMMIT');
    }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw sqliteError(error);}
    for(const [table,rows] of before.rows)for(const key of rows.keys())this.encoded.rows.get(table).delete(key);
    for(const [table,rows] of after.rows)for(const [key,row] of rows)this.encoded.rows.get(table).set(key,row);
    this.encoded.layout=layout;
    for(const ancestor of ancestors)this.encoded.rows.get(ancestor.table).set(ancestor.key,ancestor.row);
    this.current=immutable(next);this.revision=revision;return answer;
  }
  applyEncoding(previous,encoded){
      for(const [name,spec] of Object.entries(tableSpecs)){
        const before=previous.rows.get(name),after=encoded.rows.get(name);
        for(const key of before.keys())if(!after.has(key))this.statement(`DELETE FROM ${name} WHERE row_key=?`).run(key);
        const columns=[...common,...spec.columns.map(c=>c.key)],sql=`INSERT INTO ${name}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')}) ON CONFLICT(row_key) DO UPDATE SET ${columns.slice(1).map(c=>`${c}=excluded.${c}`).join(',')}`;
        for(const [key,row] of after){
          const old=before.get(key);if(old?.revision===row.revision&&old.legacy_ordinal===row.legacy_ordinal)continue;
          this.statement(sql).run(...common.map(c=>row[c]),...spec.columns.map(c=>c.read(row)));
        }
      }
      // Layout is small metadata, never a payload containing the state.
      const beforeLayout=new Map(previous.layout.map(row=>[row.row_key,row])),afterLayout=new Map(encoded.layout.map(row=>[row.row_key,row]));
      for(const key of beforeLayout.keys())if(!afterLayout.has(key))this.statement('DELETE FROM state_layout WHERE row_key=?').run(key);
      const layoutColumns=['row_key','parent_key','field_key','legacy_ordinal','table_name','kind','keys_json'];
      const layoutSql=`INSERT INTO state_layout(${layoutColumns.join(',')}) VALUES(?,?,?,?,?,?,?) ON CONFLICT(row_key) DO UPDATE SET ${layoutColumns.slice(1).map(c=>`${c}=excluded.${c}`).join(',')}`;
      for(const row of encoded.layout)if(JSON.stringify(row)!==JSON.stringify(beforeLayout.get(row.row_key)))this.statement(layoutSql).run(...layoutColumns.map(c=>row[c]));
  }
  commit(next,{scope='command',id,signature,operation,result,metadata={},ledger=[]}={}){
    this.#jsonCache=new WeakMap();
    next=JSON.parse(JSON.stringify(next));
    const queuedEdits=new Set(['updateTask','applyPanelChanges'].includes(operation)?(this.current?.jobs??[]).filter(old=>{
      const before=this.current.tasks.find(t=>t.id===old.taskId),after=next.tasks.find(t=>t.id===old.taskId),edit=after?.history?.at(-1);
      return old.status==='queued'&&!old.sentAt&&!old.receipt&&!old.turnId&&!old.correlationToken&&next.jobs.some(j=>j.id===old.id&&j.status==='queued')&&!before?.initialDispatch&&after?.currentJobId===old.id&&edit?.type==='edited'&&!before.history.some(e=>e.id===edit.id);
    }).map(j=>j.id):[]);
    validateRelations(next,this.current,{queuedEdits});const encoded=encodeState(next,{copy:false}),revision=randomUUID(),answer={value:structuredClone(result),revision};
    const resultJson=JSON.stringify(resultReference(result,next)); // References, not copies of growing entity histories.
    try{
      this.db.exec('BEGIN IMMEDIATE');
      if(id){const prior=this.commandResult(scope,id,signature);if(prior){this.db.exec('ROLLBACK');return prior;}}
      // Only a validated task edit with a new edit event may replace unsent snapshots.
      // The exclusive transaction blocks other writers; all guards are restored
      // before commit, and rollback also restores them on any failure.
      const snapshotGuards=queuedEdits.size?this.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('job_snapshots_frozen_update','job_snapshots_frozen_delete','job_attachment_snapshots_frozen_update','job_attachment_snapshots_frozen_delete')").all():[];
      for(const guard of snapshotGuards)this.db.exec('DROP TRIGGER '+guard.name);
      this.applyEncoding(this.encoded,encoded);
      for(const guard of snapshotGuards)this.db.exec(guard.sql);
      this.statement("INSERT INTO store_metadata(key,value) VALUES('revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(revision);
      this.statement("INSERT INTO store_metadata(key,value) VALUES('initialized','1') ON CONFLICT(key) DO NOTHING").run();
      for(const [key,value] of Object.entries(metadata)){
        if(!key.startsWith('migration_')||typeof value!=='string')throw Error('迁移元数据无效');
        this.statement('INSERT INTO store_metadata(key,value) VALUES(?,?)').run(key,value);
      }
      if(id)this.statement('INSERT INTO request_ledger(scope,request_id,signature,operation,result_ref_json,revision) VALUES(?,?,?,?,?,?)').run(scope,id,signature,operation,resultJson,revision);
      for(const row of ledger)this.statement('INSERT INTO request_ledger(scope,request_id,signature,operation,result_ref_json,revision) VALUES(?,?,?,?,?,?)').run(row.scope,row.request_id,row.signature,row.operation,row.result_ref_json,row.revision);
      this.db.exec('COMMIT');
      this.current=immutable(next);this.encoded=encoded;this.revision=revision;this.priorityFingerprints(this.current);return answer;
    }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw sqliteError(error);}
  }
  entity(table,id,projectId){
    if(!['tasks','jobs','sections','attachments','versions','version_intakes','plan_intakes'].includes(table))throw Error('不支持的实体类型');
    const row=this.statement(`SELECT row_key,project_id FROM ${table} WHERE id=?`).get(id);if(!row)return null;
    if(projectId!==undefined&&row.project_id!==projectId)throw Object.assign(Error('记录不属于本项目'),{code:'PROJECT_MISMATCH'});
    const value=this.encoded.rows.get(table).get(row.row_key).context.value;return {value:structuredClone(value),revision:fingerprint(value)};
  }
  taskList(projectId,{status,includeArchived=true,limit=100,cursor}={}){
    if(typeof projectId!=='string'||!projectId||!Number.isInteger(limit)||limit<1||limit>200)throw Error('项目或分页上限无效');
    const filter=JSON.stringify({projectId,status:status??null,includeArchived});let after=-1;
    if(cursor){const decoded=JSON.parse(Buffer.from(cursor,'base64url').toString());if(decoded.revision!==this.revision||decoded.filter!==filter||!Number.isInteger(decoded.after))throw Object.assign(Error('分页游标已失效或不属于此查询'),{code:'CONFLICT_REVISION'});after=decoded.after;}
    const values=[projectId,after],where=['project_id=?','legacy_ordinal>?'];if(status){where.push('status=?');values.push(status);}if(!includeArchived)where.push('archived_at IS NULL');
    const rows=this.statement(`SELECT row_key,legacy_ordinal FROM tasks WHERE ${where.join(' AND ')} ORDER BY legacy_ordinal LIMIT ?`).all(...values,limit+1);
    const more=rows.length>limit,selected=rows.slice(0,limit);
    return {revision:this.revision,items:selected.map(row=>structuredClone(this.encoded.rows.get('tasks').get(row.row_key).context.value)),cursor:more?Buffer.from(JSON.stringify({revision:this.revision,filter,after:selected.at(-1).legacy_ordinal})).toString('base64url'):null};
  }
  query(name,payload={}){
    if(name==='inspect')return this.inspect();
    if(name==='getTask')return this.entity('tasks',payload.id,payload.projectId);
    if(name==='getJob')return this.entity('jobs',payload.id,payload.projectId);
    if(name==='getEntity')return this.entity({taskSections:'sections',versionRecords:'versions',versionIntakes:'version_intakes',planIntakes:'plan_intakes'}[payload.table]??payload.table,payload.id,payload.projectId);
    if(name==='listTasks')return this.taskList(payload.projectId,payload.options);
    if(name==='queryProjectSummary'){
      const rows=this.statement('SELECT status,count(*) AS n FROM tasks WHERE project_id=? AND archived_at IS NULL GROUP BY status').all(payload.projectId);
      return {revision:this.revision,counts:Object.fromEntries(['todo','running','review','done'].map(s=>[s,rows.find(r=>r.status===s)?.n??0]))};
    }
    if(name==='listTaskEvents'){
      if(!this.entity('tasks',payload.id,payload.projectId))return null;
      const limit=payload.limit??100,after=payload.after??-1;if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(after)||after< -1)throw Error('事件分页参数无效');
      const rows=this.statement('SELECT payload_json,legacy_ordinal FROM task_events WHERE task_id=? AND project_id=? AND legacy_ordinal>? ORDER BY legacy_ordinal LIMIT ?').all(payload.id,payload.projectId,after,limit+1),selected=rows.slice(0,limit);
      return {revision:this.revision,items:selected.map(r=>JSON.parse(r.payload_json)),after:rows.length>limit?selected.at(-1).legacy_ordinal:null};
    }
    if(name==='queryQueue'){
      const statuses=payload.statuses??['queued','sending','submitted','running','uncertain'];if(!Array.isArray(statuses)||statuses.length>10||statuses.some(s=>typeof s!=='string'))throw Error('队列状态无效');
      const rows=this.statement(`SELECT row_key FROM jobs WHERE status IN (${statuses.map(()=>'?').join(',')}) ORDER BY legacy_ordinal LIMIT 201`).all(...statuses);
      if(rows.length>200)throw Object.assign(Error('活动队列超过读取上限'),{code:'LIMIT_EXCEEDED'});
      return {revision:this.revision,items:rows.map(r=>structuredClone(this.encoded.rows.get('jobs').get(r.row_key).context.value))};
    }
    if(name==='listSectionJobs'){
      const rows=this.statement('SELECT j.row_key FROM jobs j JOIN tasks t ON t.id=j.task_id AND t.project_id=j.project_id WHERE t.project_id=? AND t.section_id=? AND j.legacy_ordinal>? ORDER BY j.legacy_ordinal LIMIT 101').all(payload.projectId,payload.sectionId,payload.after??-1),selected=rows.slice(0,100);
      return {revision:this.revision,items:selected.map(r=>structuredClone(this.encoded.rows.get('jobs').get(r.row_key).context.value)),after:rows.length>100?this.encoded.rows.get('jobs').get(selected.at(-1).row_key).legacy_ordinal:null};
    }
    if(name==='loadExecutionContext'){
      const task=this.entity('tasks',payload.id,payload.projectId);if(!task)return null;
      const ids=[task.value.id,...(task.value.dependsOn??[])];if(ids.length>21)throw Error('依赖数超限');
      const dependencies=ids.map(id=>this.entity('tasks',id,payload.projectId)?.value).filter(Boolean),currentJobs=dependencies.map(t=>t.currentJobId).filter(Boolean);
      const rows=this.statement(`SELECT row_key FROM jobs WHERE project_id=? AND (status IN ('queued','sending','submitted','running','uncertain') OR id IN (${currentJobs.map(()=>'?').join(',')})) ORDER BY legacy_ordinal LIMIT 201`).all(payload.projectId,...currentJobs);
      if(rows.length>200)throw Object.assign(Error('执行上下文超过读取上限'),{code:'LIMIT_EXCEEDED'});
      return {revision:this.revision,task,dependencies,jobs:rows.map(row=>structuredClone(this.encoded.rows.get('jobs').get(row.row_key).context.value)),binding:this.current.bindings?.[payload.projectId],mapping:structuredClone(this.current.workspace?.mappings?.[payload.projectId]),section:task.value.sectionId?this.entity('sections',task.value.sectionId,payload.projectId)?.value:undefined};
    }
    if(name==='snapshotPage'){
      const offset=payload.offset??0,limit=payload.limit??100;if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200)throw Error('快照分页无效');
      if(payload.revision&&payload.revision!==this.revision)throw Object.assign(Error('快照期间数据已变化'),{code:'CONFLICT_REVISION'});
      const rows=this.encoded.layout.slice(offset,offset+limit).map(node=>({...node,payload_json:this.encoded.rows.get(node.table_name).get(node.row_key).payload_json}));
      return {revision:this.revision,rows,next:offset+limit<this.encoded.layout.length?offset+limit:null};
    }
    if(name==='commandResult')return this.commandResult(payload.scope??'command',payload.id);
    throw Error('未知SQLite查询');
  }
  close(){this.#statements.clear();if(this.db.isOpen)this.db.close();this.current=null;this.encoded=null;this.#jsonCache=new WeakMap();}
}
