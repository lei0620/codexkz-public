import {dataTables} from './sqlite-codec.mjs';
import {normalize} from './core.mjs';

export const storageVersion=1;
const nameKey=value=>typeof value==='string'?value.trim().normalize('NFKC').toLowerCase():null;
const scalar=value=>value===undefined?null:typeof value==='boolean'?Number(value):value;
const property=(key,read)=>({key,read:row=>scalar(read(row.context))});
const v=(key,column=key)=>property(column,c=>c.value?.[key]);
const project=property('project_id',c=>c.projectId),id=v('id'),status=v('status');
const task=property('task_id',c=>c.task?.id),job=property('job_id',c=>c.job?.id);
const pathKey=property('path_key',c=>typeof c.value?.path==='string'?normalize(c.value.path):null);
const keyId=property('id',c=>c.value?.id??c.tokens.at(-1));
const schema={};
function table(name,columns,ddl,indexes=[]){schema[name]={columns,ddl,indexes};}
const taskRef='FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id) DEFERRABLE INITIALLY DEFERRED';
table('tasks',[id,project,v('title'),v('description'),status,property('priority',c=>c.value.priority??2),v('sectionId','section_id'),v('parentId','parent_id'),v('currentJobId','current_job_id'),v('shortId','short_id'),v('syncId','sync_id'),property('source_key',c=>nameKey(c.value.planSourceKey)),v('createdAt','created_at'),v('archivedAt','archived_at'),v('createRequestId','create_request_id')],
  `id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,title TEXT,description TEXT,status TEXT NOT NULL CHECK(status IN ('todo','running','review','done')),priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 3),section_id TEXT,parent_id TEXT,current_job_id TEXT,short_id TEXT,sync_id TEXT,source_key TEXT,created_at TEXT,archived_at TEXT,create_request_id TEXT UNIQUE,
   UNIQUE(id,project_id),CHECK(parent_id IS NULL OR parent_id<>id),
   FOREIGN KEY(section_id,project_id) REFERENCES sections(id,project_id) DEFERRABLE INITIALLY DEFERRED,
   FOREIGN KEY(parent_id,project_id) REFERENCES tasks(id,project_id) DEFERRABLE INITIALLY DEFERRED,
   FOREIGN KEY(current_job_id,id,project_id) REFERENCES jobs(id,task_id,project_id) DEFERRABLE INITIALLY DEFERRED`,
  ['CREATE INDEX task_project_status ON tasks(project_id,status,archived_at,priority,legacy_ordinal,id)','CREATE INDEX task_section ON tasks(project_id,section_id,status,legacy_ordinal)','CREATE INDEX task_sync ON tasks(project_id,sync_id)',"CREATE UNIQUE INDEX task_source ON tasks(project_id,source_key) WHERE source_key IS NOT NULL AND source_key<>''"]);
table('sections',[id,project,v('name'),property('name_key',c=>nameKey(c.value.name))],`id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,name TEXT,name_key TEXT NOT NULL,UNIQUE(id,project_id),UNIQUE(project_id,name_key)`,['CREATE INDEX section_order ON sections(project_id,legacy_ordinal)']);
table('jobs',[id,project,v('taskId','task_id'),v('threadId','thread_id'),status,v('origin'),v('operation'),v('turnId','turn_id'),v('correlationToken','correlation_token'),v('executeRequestId','execute_request_id'),v('workflowRequestId','workflow_request_id'),v('createdAt','created_at')],
  `id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,task_id TEXT,thread_id TEXT,status TEXT NOT NULL CHECK(status IN ('queued','sending','submitted','running','completed','failed','interrupted','uncertain','cancelled','released')),origin TEXT,operation TEXT,turn_id TEXT,correlation_token TEXT UNIQUE,execute_request_id TEXT UNIQUE,workflow_request_id TEXT UNIQUE,created_at TEXT,UNIQUE(id,task_id,project_id),UNIQUE(id,project_id),${taskRef}`,
  ['CREATE INDEX job_project_status ON jobs(project_id,status,created_at,id)','CREATE INDEX job_task_order ON jobs(task_id,legacy_ordinal)','CREATE INDEX job_thread_turn ON jobs(thread_id,turn_id)',"CREATE UNIQUE INDEX one_active_task_job ON jobs(task_id) WHERE task_id IS NOT NULL AND COALESCE(origin,'') NOT IN ('observed','archive') AND status IN ('queued','sending','submitted','running','uncertain')"]);
table('task_dependencies',[task,project,property('dependency_id',c=>c.value)],`task_id TEXT NOT NULL,project_id TEXT NOT NULL,dependency_id TEXT NOT NULL,CHECK(task_id<>dependency_id),UNIQUE(task_id,dependency_id),${taskRef},FOREIGN KEY(dependency_id,project_id) REFERENCES tasks(id,project_id) DEFERRABLE INITIALLY DEFERRED`,['CREATE INDEX dependency_reverse ON task_dependencies(dependency_id,task_id)']);
table('pending_dependencies',[task,project,property('remote_id',c=>c.value)],`task_id TEXT NOT NULL,project_id TEXT NOT NULL,remote_id TEXT NOT NULL,UNIQUE(task_id,remote_id),${taskRef}`);
table('task_job_order',[task,project,property('job_id',c=>c.value)],`task_id TEXT NOT NULL,project_id TEXT NOT NULL,job_id TEXT NOT NULL,UNIQUE(task_id,legacy_ordinal),${taskRef},FOREIGN KEY(job_id,task_id,project_id) REFERENCES jobs(id,task_id,project_id) DEFERRABLE INITIALLY DEFERRED`);
table('task_sources',[task,project,property('source_id',c=>c.value)],`task_id TEXT NOT NULL,project_id TEXT NOT NULL,source_id TEXT NOT NULL,UNIQUE(task_id,source_id),${taskRef},FOREIGN KEY(source_id,project_id) REFERENCES recognition_events(id,project_id) DEFERRABLE INITIALLY DEFERRED`,['CREATE INDEX source_tasks ON task_sources(source_id,task_id)']);
table('task_events',[task,project,v('id','event_id'),v('jobId','job_id'),v('at'),v('type')],`task_id TEXT NOT NULL,project_id TEXT NOT NULL,event_id TEXT,job_id TEXT,at TEXT,type TEXT,UNIQUE(task_id,legacy_ordinal),${taskRef}`,['CREATE INDEX event_job ON task_events(job_id,legacy_ordinal)']);
table('task_execution_policy',[task,project,v('mode'),v('threadId','thread_id')],`task_id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,mode TEXT CHECK(mode IN ('match','new','fixed')),thread_id TEXT,${taskRef}`);
for(const name of ['task_attribute_values','task_attachment_snapshots'])table(name,[task,project],`task_id TEXT NOT NULL,project_id TEXT NOT NULL,UNIQUE(task_id,legacy_ordinal),${taskRef}`);
for(const name of ['job_snapshots','job_results','job_attachment_snapshots'])table(name,[job,project,property('field_key',c=>String(c.tokens.at(-1)))],`job_id TEXT NOT NULL,project_id TEXT NOT NULL,field_key TEXT NOT NULL,FOREIGN KEY(job_id,project_id) REFERENCES jobs(id,project_id) DEFERRABLE INITIALLY DEFERRED`,[`CREATE INDEX ${name}_owner ON ${name}(job_id,legacy_ordinal)`]);
table('attachments',[keyId,project,v('sha256'),v('name'),v('size')],`id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,sha256 TEXT,name TEXT,size INTEGER CHECK(size>=0)`,['CREATE INDEX attachment_hash ON attachments(project_id,sha256)']);
table('project_mappings',[project,v('logicalId','logical_id'),v('repository'),pathKey],`project_id TEXT NOT NULL UNIQUE,logical_id TEXT UNIQUE,repository TEXT UNIQUE,path_key TEXT`,['CREATE INDEX mapping_path ON project_mappings(path_key)']);
table('repository_identities',[v('repository'),v('logicalId','logical_id')],`repository TEXT NOT NULL UNIQUE,logical_id TEXT NOT NULL UNIQUE`);
table('thread_bindings',[project,property('thread_id',c=>c.value)],`project_id TEXT NOT NULL UNIQUE,thread_id TEXT NOT NULL`);
table('imported_threads',[property('thread_id',c=>c.value)],`thread_id TEXT NOT NULL UNIQUE`);
table('workflow_acknowledgements',[project,pathKey],`project_id TEXT NOT NULL UNIQUE,path_key TEXT`);
table('local_projects',[property('id',c=>c.value.projectId??c.value.id),pathKey],`id TEXT NOT NULL UNIQUE,path_key TEXT`);
table('property_groups',[id,project,property('name_key',c=>nameKey(c.value.name))],`id TEXT NOT NULL,project_id TEXT NOT NULL,name_key TEXT,UNIQUE(project_id,id),UNIQUE(project_id,name_key)`);
table('property_options',[id,project,property('group_id',c=>c.groupId),property('name_key',c=>nameKey(c.value.name))],`id TEXT NOT NULL,project_id TEXT NOT NULL,group_id TEXT NOT NULL,name_key TEXT,UNIQUE(project_id,group_id,id),UNIQUE(project_id,group_id,name_key),FOREIGN KEY(project_id,group_id) REFERENCES property_groups(project_id,id) DEFERRABLE INITIALLY DEFERRED`);
table('recognition_events',[keyId,project,status,v('taskId','task_id'),v('at')],`id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,status TEXT,task_id TEXT,at TEXT,UNIQUE(id,project_id),${taskRef}`,['CREATE INDEX recognition_project ON recognition_events(project_id,status,at,id)']);
table('source_messages',[keyId,project,v('threadId','thread_id'),v('turnId','turn_id'),v('itemId','item_id'),v('text')],`id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,thread_id TEXT,turn_id TEXT,item_id TEXT,text TEXT`,['CREATE INDEX source_turn ON source_messages(thread_id,turn_id,item_id)']);
table('archive_decisions',[project,property('event_id',c=>c.event.id)],`project_id TEXT,event_id TEXT`);
table('capture_config',[project,pathKey,v('enabled')],`project_id TEXT NOT NULL UNIQUE,path_key TEXT,enabled INTEGER CHECK(enabled IN (0,1))`);
table('capture_cursors',[project,property('thread_id',c=>c.tokens.at(-1))],`project_id TEXT NOT NULL,thread_id TEXT NOT NULL,UNIQUE(project_id,thread_id)`);
table('execution_plans',[id,project,status,v('requestId','request_id'),v('gate'),v('maxConcurrent','max_concurrent')],`id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,status TEXT CHECK(status IN ('active','paused','completed','cancelled')),request_id TEXT UNIQUE,gate TEXT CHECK(gate IN ('reviewed','completed')),max_concurrent INTEGER CHECK(max_concurrent IN (1,2))`,['CREATE INDEX plan_project ON execution_plans(project_id,status)']);
table('execution_nodes',[project,property('plan_id',c=>c.plan.id),v('taskId','task_id'),v('jobId','job_id'),status],`project_id TEXT NOT NULL,plan_id TEXT NOT NULL,task_id TEXT NOT NULL,job_id TEXT,status TEXT,UNIQUE(plan_id,legacy_ordinal),FOREIGN KEY(plan_id) REFERENCES execution_plans(id) DEFERRABLE INITIALLY DEFERRED,${taskRef},FOREIGN KEY(job_id,task_id,project_id) REFERENCES jobs(id,task_id,project_id) DEFERRABLE INITIALLY DEFERRED`);
table('module_routes',[project,v('sectionId','section_id'),v('threadId','thread_id'),status,pathKey],`project_id TEXT NOT NULL,section_id TEXT,thread_id TEXT,status TEXT,path_key TEXT`,["CREATE UNIQUE INDEX route_owner ON module_routes(project_id,thread_id) WHERE status='ready' AND thread_id IS NOT NULL"]);
for(const name of ['plan_intakes','version_intakes','thread_requests','versions'])table(name,[keyId,project,status,v('createdAt','created_at'),v('requestId','request_id'),...(name==='versions'?[v('commit','commit_hash')]:[])],`id TEXT NOT NULL UNIQUE,project_id TEXT,status TEXT,created_at TEXT,request_id TEXT${name==='versions'?',commit_hash TEXT,UNIQUE(project_id,request_id)':' UNIQUE'}`,[`CREATE INDEX ${name}_project ON ${name}(project_id,status,created_at,id)`]);
for(const name of ['sync_records','sync_conflicts','sync_overrides'])table(name,[keyId,...(name==='sync_records'?[v('logicalId','logical_id'),v('deleted')]:[])],`id TEXT NOT NULL UNIQUE${name==='sync_records'?',logical_id TEXT,deleted INTEGER CHECK(deleted IN (0,1))':''}`,name==='sync_records'?['CREATE INDEX sync_logical ON sync_records(logical_id,deleted,id)']:[]);
table('sidebar_attachments',[project,v('threadId','thread_id'),status],`project_id TEXT,thread_id TEXT,status TEXT`,['CREATE INDEX sidebar_target ON sidebar_attachments(project_id,thread_id,status)']);
table('maintenance_resume_tokens',[property('plan_id',c=>c.value.id)],`plan_id TEXT NOT NULL UNIQUE,FOREIGN KEY(plan_id) REFERENCES execution_plans(id) DEFERRABLE INITIALLY DEFERRED`);
export const tableSpecs=Object.fromEntries(dataTables.map(name=>[name,schema[name]??{columns:[],ddl:'',indexes:[]}]));

export function migrateDatabase(db){
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if(version>storageVersion)throw Object.assign(Error('SQLite存储版本高于当前程序'),{code:'UNSUPPORTED_SCHEMA'});
  if(version===storageVersion){if(db.prepare('PRAGMA application_id').get().application_id!==1128551256)throw Object.assign(Error('SQLite文件不是本项目存储'),{code:'CORRUPT'});return;}
  if(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n)throw Object.assign(Error('拒绝初始化未知SQLite数据库'),{code:'CORRUPT'});
  db.exec('BEGIN IMMEDIATE');
  try{
    db.exec(`CREATE TABLE store_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
      CREATE TABLE state_layout(row_key TEXT PRIMARY KEY,parent_key TEXT,field_key TEXT,legacy_ordinal INTEGER NOT NULL,table_name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('object','array','scalar')),keys_json TEXT) STRICT;
      CREATE INDEX layout_parent ON state_layout(parent_key,legacy_ordinal);
      CREATE TABLE request_ledger(scope TEXT NOT NULL,request_id TEXT NOT NULL,signature TEXT NOT NULL,operation TEXT NOT NULL,result_ref_json TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(scope,request_id)) STRICT;`);
    for(const [name,spec] of Object.entries(tableSpecs)){
      db.exec(`CREATE TABLE ${name}(row_key TEXT PRIMARY KEY,legacy_ordinal INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),revision TEXT NOT NULL${spec.ddl?','+spec.ddl:''}) STRICT;`);
      for(const sql of spec.indexes)db.exec(sql);
    }
    for(const name of ['job_snapshots','job_attachment_snapshots']){
      db.exec(`CREATE TRIGGER ${name}_frozen_update BEFORE UPDATE OF payload_json,revision ON ${name} WHEN OLD.payload_json<>NEW.payload_json OR OLD.revision<>NEW.revision BEGIN SELECT RAISE(ABORT,'immutable execution snapshot'); END;
        CREATE TRIGGER ${name}_frozen_delete BEFORE DELETE ON ${name} BEGIN SELECT RAISE(ABORT,'immutable execution snapshot'); END;`);
    }
    db.exec(`CREATE TRIGGER job_identity_frozen BEFORE UPDATE OF task_id,project_id,thread_id,execute_request_id,workflow_request_id ON jobs
      WHEN OLD.task_id IS NOT NEW.task_id OR OLD.project_id IS NOT NEW.project_id OR (OLD.thread_id IS NOT NEW.thread_id AND NOT (OLD.status='queued' AND (NEW.status='queued' OR (NEW.status='submitted' AND json_extract(NEW.payload_json,'$.dispatchVersion')=2 AND json_extract(NEW.payload_json,'$.deliveryKind')='create' AND json_extract(NEW.payload_json,'$.initialDispatchId')=json_extract(NEW.payload_json,'$.id'))) AND json_extract(OLD.payload_json,'$.sentAt') IS NULL AND OLD.correlation_token IS NULL AND json_extract(OLD.payload_json,'$.receipt') IS NULL AND json_extract(NEW.payload_json,'$.modelRouted')=1 AND json_extract(NEW.payload_json,'$.modelTarget.modelKey') IS NOT NULL)) OR OLD.execute_request_id IS NOT NEW.execute_request_id OR OLD.workflow_request_id IS NOT NEW.workflow_request_id
      BEGIN SELECT RAISE(ABORT,'immutable execution identity'); END;
      CREATE TRIGGER fixed_version_commit BEFORE UPDATE OF commit_hash ON versions WHEN OLD.commit_hash IS NOT NULL AND OLD.commit_hash IS NOT NEW.commit_hash BEGIN SELECT RAISE(ABORT,'immutable version commit'); END;
      PRAGMA application_id=1128551256;PRAGMA user_version=1;`);
    const insert=db.prepare('INSERT INTO store_metadata(key,value) VALUES(?,?)');
    for(const [key,value] of Object.entries({storage_schema_version:'1',legacy_json_schema:'3',normalizer_version:'1'}))insert.run(key,value);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
