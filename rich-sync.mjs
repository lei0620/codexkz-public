import {randomUUID,createHash} from 'node:crypto';
import {attributesOf,defaultGroups} from './properties.mjs';
import {readAttachment,saveAttachment,MAX_FILE} from './attachments.mjs';
const legacyNames={feature:'新功能',bug:'Bug',improvement:'优化'};
const text=(v,max)=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/[\x00-\x1f]/.test(v);
export function richRecord(r){return {...r,priority:r.priority??2,attributes:r.attributes??(legacyNames[r.tag]?[{group:'任务类型',type:true,name:legacyNames[r.tag]}]:[]),attachments:r.attachments??[]};}
export function richFields(task){return {priority:task.priority??2,attributes:attributesOf(task).map(a=>({group:a.groupName,type:a.groupId==='type',name:a.name})).sort((a,b)=>a.group<b.group?-1:a.group>b.group?1:0),attachments:(task.attachments??[]).map(({name,size,type,sha256})=>({name,size,type,sha256}))};}
export function validateRich(r){
  if(!Number.isInteger(r.priority)||r.priority<0||r.priority>3||!Array.isArray(r.attributes)||r.attributes.length>20||!Array.isArray(r.attachments)||r.attachments.length>8)throw Error('同步优先级、属性或附件格式无效');
  const groups=new Set();let types=0;
  for(const a of r.attributes){if(!a||Object.keys(a).some(k=>!['group','type','name'].includes(k))||!text(a.group,30)||!text(a.name,30)||typeof a.type!=='boolean'||groups.has(a.group))throw Error('同步属性名称无效或重复');groups.add(a.group);if(a.type)types++;}
  if(types>1||r.attributes.some(a=>a.type!== (a.group==='任务类型'))||(!r.deleted&&r.tag==='custom'&&types!==1))throw Error('任务类型标记无效或重复');
  const files=new Set();let size=0;
  for(const a of r.attachments){
    if(!a||Object.keys(a).some(k=>!['name','size','type','sha256'].includes(k))||!text(a.name,180)||/[\\/<>:"|?*]/.test(a.name)||/[. ]$/.test(a.name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(a.name)||!Number.isInteger(a.size)||a.size<0||a.size>MAX_FILE||!['application/octet-stream','image/png','image/jpeg','image/gif','image/webp'].includes(a.type)||!/^[a-f0-9]{64}$/.test(a.sha256))throw Error('同步附件元数据无效');
    const key=a.sha256+':'+a.name;if(files.has(key))throw Error('同步附件重复');files.add(key);size+=a.size;
  }
  if(size>40*1024*1024)throw Error('同步任务附件总量超过40MB');
}
export function applyRichFields(state,task,r,files=new Map(),allowRetained=false){
  state.propertyGroups??={};const groups=state.propertyGroups[task.projectId]??=defaultGroups();
  const attrs=[],old=allowRetained?attributesOf(task):[];
  for(const a of r.attributes){
    let group=a.type?groups.find(g=>g.id==='type'):groups.find(g=>g.id!=='type'&&g.name===a.group);
    if(!group){if(groups.length>=20)throw Error('接收属性超过项目上限');group={id:a.type?'type':randomUUID(),name:a.group,options:[]};groups.push(group);}
    if(group.archived&&!old.some(v=>v.groupId===group.id&&v.name===a.name))throw Error('接收的属性组已在本机停用，请先核对：'+a.group);
    let option=group.options.find(o=>o.name===a.name);
    if(!option){if(group.options.length>=40)throw Error('接收属性超过组内上限');option={id:randomUUID(),name:a.name};group.options.push(option);}
    if(option.archived&&!old.some(v=>v.groupId===group.id&&v.optionId===option.id))throw Error('接收的属性已在本机停用，请先核对：'+a.name);
    attrs.push({groupId:group.id,groupName:group.name,optionId:option.id,name:option.name});
  }
  task.priority=r.priority;task.attributes=attrs.sort((a,b)=>a.groupId.localeCompare(b.groupId));task.tag=task.attributes.find(a=>a.groupId==='type')?.optionId??'none';
  task.attachments=r.attachments.map(a=>{const file=files.get(JSON.stringify([task.projectId,a.sha256,a.name]));if(!file)throw Error('同步附件尚未完整下载，任务未更新');state.attachments??={};state.attachments[file.id]=file;return {...file};});
}
export async function hydrateRichAttachments(root,state,records,projects,store,persistFile){
  const files=new Map();
  for(const r of records){if(r.deleted||!r.attachments?.length)continue;
    const entry=Object.entries(state.workspace.mappings).find(([,m])=>m.logicalId===r.logicalId);if(!entry)continue;
    const [projectId,m]=entry;if(!projects.some(p=>p.projectId===projectId&&p.path===m.path))continue;
    for(const meta of r.attachments){const key=JSON.stringify([projectId,meta.sha256,meta.name]);if(files.has(key))continue;
      let file=Object.values(state.attachments??{}).find(f=>f.projectId===projectId&&f.sha256===meta.sha256&&f.name===meta.name&&f.size===meta.size);
      if(file){try{readAttachment(root,file);}catch{file=null;}}
      if(!file){const bytes=await store.readAttachment(meta);if(bytes.length!==meta.size||createHash('sha256').update(bytes).digest('hex')!==meta.sha256)throw Error('远端附件校验失败');file=saveAttachment(root,{projectId,name:meta.name,base64:bytes.toString('base64')},projects);await persistFile?.(file);}
      if(file.type!==meta.type)throw Error('远端附件类型与内容不符');
      files.set(key,file);
    }
  }
  return files;
}
