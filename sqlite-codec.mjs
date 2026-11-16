import {createHash} from 'node:crypto';
import {fieldRoutes} from './storage-layout.mjs';

export const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rules=fieldRoutes.map(([pattern,table])=>({tokens:pattern.replaceAll('[]','.@').split('.'),table}));
export const dataTables=[...new Set([...rules.map(r=>r.table),'legacy_root_extensions','legacy_container_extensions'])];
const matches=(tokens,rule)=>tokens.every((token,i)=>rule[i]==='*'||rule[i]==='@'&&typeof token==='number'||rule[i]===token);

// Cut every R39 routed entity, relation, event and snapshot into its own row.
// A parent payload contains only its other fields; layout preserves optional
// containers, key order and exact array order without a whole-state blob.
export function encodeState(state,{copy=true,taskIndex}={}){
  if(copy)state=JSON.parse(JSON.stringify(state));
  const rows=new Map(dataTables.map(table=>[table,new Map()])),layout=[];
  function visit(value,tokens,parent=null,key=null,ordinal=0,stableParent=[]){
    const exact=rules.find(r=>r.tokens.length===tokens.length&&matches(tokens,r.tokens));
    const table=exact?.table??(tokens.length===1&&!rules.some(r=>matches(tokens,r.tokens))?'legacy_root_extensions':'legacy_container_extensions');
    const identity=typeof tokens.at(-1)==='number'&&table!=='task_events'?(value?.id??value?.projectId??value?.repository??(typeof value==='string'?value:null)):null;
    const stable=tokens.length?[...stableParent,identity===null?tokens.at(-1):'@'+identity]:[],rowKey=JSON.stringify(stable);
    const kind=Array.isArray(value)?'array':value!==null&&typeof value==='object'?'object':'scalar';
    let payload=value;
    const children=[];
    if(kind!=='scalar'){
      const entries=Object.entries(value),remaining=[];
      for(const [i,[field,child]] of entries.entries()){
        const childKey=kind==='array'?Number(field):field,next=[...tokens,childKey];
        if(tokens.length===0||rules.some(r=>r.tokens.length>=next.length&&matches(next,r.tokens))){children.push([child,next,field,i]);}
        else remaining.push([field,child]);
      }
      // All routed arrays are ordered relations; preserve empty/missing/null.
      payload=Object.fromEntries(remaining);
    }
    const task=tokens[0]==='tasks'&&typeof tokens[1]==='number'?state.tasks[tokens[1]]:null;
    const job=tokens[0]==='jobs'&&typeof tokens[1]==='number'?state.jobs[tokens[1]]:null;
    const event=tokens[0]==='capture'&&tokens[1]==='events'?state.capture.events[tokens[2]]:null;
    const plan=tokens[0]==='automation'&&tokens[1]==='plans'&&typeof tokens[2]==='number'?state.automation.plans[tokens[2]]:null;
    const projectId=value?.projectId??task?.projectId??job?.projectId??event?.projectId??plan?.projectId??(tokens[0]==='propertyGroups'?tokens[1]:null)??(tokens[0]==='capture'&&tokens[1]==='projects'?tokens[2]:null)??(['bindings','workflowChecks'].includes(tokens[0])?tokens[1]:null)??(tokens[0]==='workspace'&&tokens[1]==='mappings'?tokens[2]:null);
    // SQL projections need parent identities, not retained full snapshots.
    const identityOf=owner=>owner?{id:owner.id}:null;
    const groupId=tokens[0]==='propertyGroups'?state.propertyGroups[tokens[1]]?.[tokens[2]]?.id:null;
    const context={task:identityOf(task),job:identityOf(job),event:identityOf(event),plan:identityOf(plan),projectId,tokens,groupId,value};
    const row={row_key:rowKey,legacy_ordinal:ordinal,payload_json:JSON.stringify(payload),revision:fingerprint(value),context};
    if(rows.get(table).has(rowKey))throw Object.assign(Error('重复实体或关系标识：'+table),{code:'CONSTRAINT'});
    rows.get(table).set(rowKey,row);
    layout.push({row_key:rowKey,parent_key:parent,field_key:key,legacy_ordinal:ordinal,table_name:table,kind,keys_json:kind==='scalar'?null:JSON.stringify(Object.keys(value))});
    for(const [child,next,field,i] of children)visit(child,next,rowKey,field,i,stable);
  }
  if(taskIndex===undefined)visit(state,[]);
  else visit(state.tasks[taskIndex],['tasks',taskIndex],JSON.stringify(['tasks']),String(taskIndex),taskIndex,['tasks']);
  return {rows,layout};
}

export function decodeState(layout,rows){
  const children=new Map();for(const row of layout){const list=children.get(row.parent_key)??[];list.push(row);children.set(row.parent_key,list);}
  function read(node){
    const record=rows.get(node.table_name)?.get(node.row_key);if(!record)throw Error('SQLite布局缺少实体行');
    const payload=JSON.parse(record.payload_json);
    if(node.kind==='scalar')return payload;
    const values=new Map(Object.entries(payload));
    for(const child of children.get(node.row_key)??[])values.set(child.field_key,read(child));
    const keys=JSON.parse(node.keys_json);
    return node.kind==='array'?keys.map(key=>values.get(key)):Object.fromEntries(keys.map(key=>[key,values.get(key)]));
  }
  const root=layout.find(row=>row.parent_key===null);return root?read(root):null;
}

export function validateRelations(state,previous,{queuedEdits=new Set()}={}){
  const frozen=rules.filter(r=>r.table==='job_snapshots'&&r.tokens.length===3).map(r=>r.tokens[2]);
  const jobs=new Map((state.jobs??[]).map(j=>[j.id,j]));
  for(const old of previous?.jobs??[]){
    const next=jobs.get(old.id);
    if(!next)throw Object.assign(Error('执行历史不能通过普通事务删除'),{code:'CONSTRAINT'});
    for(const field of frozen){
      if(queuedEdits.has(old.id)&&['prompt','basePrompt','taskTitle','taskCode','taskTag','taskPriority','taskAttributes','attachments','contextSnapshot','sectionSnapshot','dispatchPrompt'].includes(field))continue;
      if(field==='dispatchPrompt'&&!Object.hasOwn(old,field)&&old.status==='queued'&&(next.status==='sending'||next.status==='submitted'&&next.dispatchVersion===2&&next.deliveryKind==='create'&&next.initialDispatchId===next.id))continue;
      if(Object.hasOwn(old,field)!==Object.hasOwn(next,field)||JSON.stringify(old[field])!==JSON.stringify(next[field]))throw Object.assign(Error('执行快照不可改写：'+field),{code:'CONSTRAINT'});
    }
  }
  const tasks=new Map((state.tasks??[]).map(t=>[t.id,t]));
  const seen=new Set(),active=new Set();
  function visit(id){
    if(active.has(id))throw Object.assign(Error('任务依赖或父子关系形成循环'),{code:'CONSTRAINT'});
    if(seen.has(id))return;seen.add(id);active.add(id);
    const task=tasks.get(id);for(const next of [task?.parentId,...(task?.dependsOn??[])].filter(Boolean))visit(next);active.delete(id);
  }
  for(const id of tasks.keys())visit(id);
}
