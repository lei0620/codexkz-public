import fs from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {normalize} from './core.mjs';
import {localReceiptPath} from './version-intake.mjs';
import {ensureSection,sectionFor,saveSection} from './task-sections.mjs';
import {describeSection} from './task-classification.mjs';
import {createTask} from './board.mjs';
import {executionFields} from './execution.mjs';
import {writePaths} from './execution-scope.mjs';
const life=24*60*60*1000,key=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(v),hash=v=>createHash('sha256').update(v).digest('hex').slice(0,40);
const taskKey=v=>typeof v==='string'&&/^[A-Za-z0-9\u3400-\u9fff][A-Za-z0-9\u3400-\u9fff_.-]{0,79}$/u.test(v);
export const portablePlanPrompt=[
  '把本项目已确认、未开工的计划整理为待执行卡片，保留版块、优先级、类型、依赖和验收标准。只建卡，不执行开发或发布。',
  '先核对当前目录及 AGENTS。只访问 127.0.0.1：检查已知面板端口、环境变量 PORT（若有）及 4319、4318 的 /api/state，选择 hostId=local 且项目路径规范化后匹配的唯一服务/项目；不输出完整状态或 token。无法唯一确定时报告原因，不猜目标。',
  '用该服务 token 作 X-Panel-Token，以 application/json POST /api/plans/begin（projectId 取现场匹配值）；核对返回 projectId/projectPath 后，按返回约定写指定回执。无服务或接口时报告缺项，自定义端口不明再询问。已有任务复用，不导入已完成项或未确认建议；最后报告新增、复用和差异。'
].join('\n\n');
function findRequest(state,id,project){const r=state.planIntakes?.find(r=>r.id===id&&r.projectId===project.projectId);if(!r||normalize(r.projectPath)!==normalize(project.path))throw Error('整理请求与项目不匹配');if(!Number.isFinite(Date.parse(r.createdAt))||Date.now()-Date.parse(r.createdAt)>life)throw Error('整理请求已过期，请重新领取');if(r.status==='cancelled')throw Error('整理请求已取消');return r;}
export function planIntakeView(state){return (state.planIntakes??[]).filter(r=>Date.now()-Date.parse(r.createdAt)<=life).map(({id,projectId,status,createdAt,result,error})=>({id,projectId,status,createdAt,result,error}));}
export function planCommand(state,project,root,begin=false,id){
  state.planIntakes??=[];state.planIntakes=state.planIntakes.filter(r=>Date.now()-Date.parse(r.createdAt)<=life);
  let r=id?findRequest(state,id,project):state.planIntakes.find(r=>r.projectId===project.projectId&&r.status==='waiting'&&normalize(r.projectPath)===normalize(project.path));
  if(!r){if(state.planIntakes.length>=50)throw Error('整理请求过多');r={id:randomUUID(),projectId:project.projectId,projectPath:project.path,status:'waiting',createdAt:new Date().toISOString()};state.planIntakes.push(r);}
  if(!begin)return {id:r.id,status:r.status,prompt:portablePlanPrompt};
  const target=localReceiptPath(root,r.id,'plan-intake'),sections=(state.taskSections??[]).filter(s=>s.projectId===project.projectId).map(({id,name,description})=>({id,name,description}));
  const existing=state.tasks.filter(t=>t.projectId===project.projectId&&!t.archivedAt).slice(-200).map(t=>({id:t.id,shortId:t.shortId??'',title:t.title,status:t.status,section:sectionFor(state,t)?.name??'',sourceKey:t.planSourceKey??''}));
  const schema={schemaVersion:1,requestId:r.id,projectPath:project.path,source:'docs/ROADMAP.md',sections:[{key:'backend',name:'后端长期改造',description:'填写版块目标、边界与参考文档',keywords:['后端','存储']}],tasks:[{key:'T01',section:'backend',title:'填写任务标题',description:'填写任务目标、范围、不做、验收标准和必要相对文档引用',priority:2,typeName:'新功能',dependsOn:[],execution:{parallel:true,writePaths:[]},existingTaskId:null}]};
  const prompt=[
    '当前项目目录：'+JSON.stringify(project.path)+'。仅整理此项目，先核对目录与规则；不要执行开发、迁移、测试任务、提交推送、部署或创建/发送对话。',
    '依据当前对话已确认的计划或项目真实方案/路线图，整理未开工的独立目标，不将未经确认的建议、已完成内容或原任务的回答、补充、返修重复建卡。按可独立验收的目标拆分，调查、编码、测试等同一目标内步骤写在任务说明中；已有真实模块边界或明确要求拆分时分别建任务并保留依赖。每个版块说明目标与上下文；任务description保留范围、不做、验收和必要资料引用，优先级P0到P3（默认P2），类型沿用已有名称。引用资料不是新增执行授权。',
    '按真实模块组织版块，核对相关源码后为任务填写execution.parallel和execution.writePaths（项目相对文件或目录，包含需修改的测试、公共配置与文档）。可独立执行的任务标parallel=true；必须整体顺序执行的任务标false。范围不确定时填写空数组，不能凭任务标题猜文件。面板会按同模块、路径重叠和依赖自动放行或等待，无执行数量上限。提交、合并与共享部署作为后置顺序任务，不混入并行模块任务。',
    'source优先沿用已有的项目相对来源（如docs/ROADMAP.md）；仅存在于当前对话且未落盘的已确认计划使用固定逻辑来源conversation-plan，不虚构文件或写本机对话ID。任务key沿用已有Task编号（兼容R38、bug-20261015-0001、优化-20261015-0001）；没有编号的独立新目标按项目规则分配稳定编号，不随机编号或每次重编。版块key用英数字短标识；dependsOn准确引用本批任务key。已有任务列表仅含最近200项，不代表全量；同一任务跨来源整理时填existingTaskId，并保持已有标题以便核对，只复用不覆盖。已完成前置可用existingTaskId引用，不重新创建。',
    '已有版块：'+JSON.stringify(sections)+'\n已有任务：'+JSON.stringify(existing),
    '授权仅向面板指定回执写入本次整理结果，不修改state.json。使用UTF-8 JSON，先写临时文件再替换：'+JSON.stringify(target),
    '结构示例（按真实内容替换示例，不照抄；schemaVersion/requestId/projectPath保持）：\n'+JSON.stringify(schema,null,2),
    '最多20个版块、60个任务、总回执不超过256KiB；任务description最多12000字。不得包含凭据或其他电脑的绝对路径。收到有效回执后，面板会原子地创建待执行卡片与依赖，不自动执行；重复来源任务会保留原内容并报告复用/差异。'
  ].join('\n\n');return {id:r.id,status:r.status,projectId:project.projectId,projectPath:project.path,prompt};
}
export function readPlanReceipt(state,id,project,root){
  const r=findRequest(state,id,project);if(r.status==='imported')return null;const target=localReceiptPath(root,id,'plan-intake');
  let info;try{info=fs.lstatSync(target);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(!info.isFile()||info.isSymbolicLink()||info.size>262144)throw Error('任务回执必须为256KiB以内普通JSON');
  let report;try{report=JSON.parse(fs.readFileSync(target,'utf8').replace(/^\uFEFF/,''));}catch{throw Error('任务回执尚未写完或JSON无效');}
  if(!report||report.schemaVersion!==1||report.requestId!==id||typeof report.projectPath!=='string'||normalize(report.projectPath)!==normalize(project.path)||Object.keys(report).some(k=>!['schemaVersion','requestId','projectPath','source','sections','tasks'].includes(k)))throw Error('任务回执与本次项目/请求不匹配');
  return report;
}
export function validatePlan(report){
  if(typeof report.source!=='string'||!report.source.trim()||report.source.length>160||/^[\\/]|[\x00-\x1f:\\]|(?:^|\/)\.\.(?:\/|$)/.test(report.source))throw Error('来源必须为稳定项目相对位置');
  if(!Array.isArray(report.sections)||report.sections.length>20||!Array.isArray(report.tasks)||!report.tasks.length||report.tasks.length>60)throw Error('整理数量超限或无任务');
  const sectionKeys=new Set(),names=new Set(),taskKeys=new Map(),canonicalTaskKeys=new Set();
  for(const s of report.sections){if(!s||Object.keys(s).some(k=>!['key','name','description','keywords'].includes(k))||!key(s.key)||sectionKeys.has(s.key)||typeof s.name!=='string'||!s.name.trim()||s.name.length>80||names.has(s.name.trim().normalize('NFKC').toLowerCase())||typeof s.description!=='string'||s.description.length>4000||!Array.isArray(s.keywords)||s.keywords.length>30||s.keywords.some(k=>typeof k!=='string'||k.length>40))throw Error('版块定义无效或重复');sectionKeys.add(s.key);names.add(s.name.trim().normalize('NFKC').toLowerCase());}
  for(const t of report.tasks){if(!t||Object.keys(t).some(k=>!['key','section','title','description','priority','typeName','dependsOn','execution','existingTaskId'].includes(k))||!taskKey(t.key)||canonicalTaskKeys.has(t.key.normalize('NFKC').toLowerCase())||!sectionKeys.has(t.section)||typeof t.title!=='string'||!t.title.trim()||t.title.length>200||typeof t.description!=='string'||t.description.length>12000||!Number.isInteger(t.priority)||t.priority<0||t.priority>3||typeof t.typeName!=='string'||!t.typeName.trim()||t.typeName.length>30||!Array.isArray(t.dependsOn)||t.dependsOn.length>20||new Set(t.dependsOn).size!==t.dependsOn.length||t.existingTaskId!=null&&typeof t.existingTaskId!=='string')throw Error('任务定义无效或重复');taskKeys.set(t.key,t);canonicalTaskKeys.add(t.key.normalize('NFKC').toLowerCase());}
  for(const t of report.tasks)if(t.execution!==undefined){const e=t.execution;if(!e||Object.keys(e).some(k=>!['parallel','writePaths'].includes(k))||typeof e.parallel!=='boolean'||!Array.isArray(e.writePaths))throw Error('任务执行范围无效');writePaths(e.writePaths);}
  if(/[a-zA-Z]:[\\/]|\b(?:ghp_|sk-)[A-Za-z0-9]{20,}/.test(JSON.stringify({source:report.source,sections:report.sections,tasks:report.tasks})))throw Error('任务内容含本机绝对路径或疑似凭据');
  const done=new Set(),active=new Set(),visit=k=>{if(done.has(k))return;if(active.has(k))throw Error('任务存在循环依赖');const t=taskKeys.get(k);if(!t)throw Error('依赖任务不在本批次中');active.add(k);t.dependsOn.forEach(visit);active.delete(k);done.add(k);};taskKeys.forEach((_,k)=>visit(k));
}
export function importPlan(state,id,project,report){
  const request=findRequest(state,id,project);if(request.status==='imported')return request.result;
  if(report.requestId!==id||normalize(report.projectPath)!==normalize(project.path))throw Error('回执归属不一致');validatePlan(report);
  const differences=[],sections=new Map(report.sections.map(input=>{const s=ensureSection(state,project.projectId,input.name,input.description,input.keywords);
    const generated=s.description===describeSection(s.name,s.keywords);
    if(((!s.description||generated)&&input.description)||(!s.keywords.length&&input.keywords.length))saveSection(state,{id:s.id,revision:s.revision,description:(!s.description||generated)&&input.description?input.description:s.description,keywords:s.keywords.length?s.keywords:input.keywords},project.projectId);
    if(s.description!==input.description)differences.push('版块：'+s.name);return [input.key,s];})),resolved=new Map(),created=[],reused=[];
  for(const row of report.tasks){
    const sourceKey=report.source.trim()+'#'+row.key,canonical=sourceKey.normalize('NFKC').toLowerCase(),section=sections.get(row.section);
    let existing=state.tasks.find(t=>t.projectId===project.projectId&&t.planSourceKey?.normalize('NFKC').toLowerCase()===canonical);
    if(row.existingTaskId){const chosen=state.tasks.find(t=>t.id===row.existingTaskId&&t.projectId===project.projectId&&!t.archivedAt);if(!chosen||chosen.title!==row.title||existing&&existing.id!==chosen.id)throw Error('已有任务引用不匹配');existing=chosen;}
    if(existing){resolved.set(row.key,existing);reused.push(row.key);if(existing.title!==row.title||existing.description!==row.description||existing.priority!==row.priority||existing.attributes?.find(a=>a.groupId==='type')?.name!==row.typeName||existing.sectionId!==section.id)differences.push(row.key);continue;}
    const stableId='plan-'+hash((project.repository??state.workspace.mappings[project.projectId]?.logicalId??project.projectId)+'\0'+canonical);
    if(state.tasks.some(t=>t.id===stableId))throw Error('来源任务归属冲突');
    const task=createTask(state,{projectId:project.projectId,title:row.title,description:row.description,typeName:row.typeName,priority:row.priority,sectionId:section.id,execution:{mode:'match',unit:section.name,parallel:row.execution?.parallel??false,writePaths:row.execution?.writePaths??[],threadId:''},requestId:'import-'+hash(id+'\0'+row.key)},[project]).task;
    task.id=stableId;task.planSourceKey=sourceKey;if(/^[A-Za-z0-9\u3400-\u9fff_-]+$/u.test(row.key))task.shortId=row.key;resolved.set(row.key,task);created.push(row.key);
  }
  for(const key of created){const row=report.tasks.find(t=>t.key===key),task=resolved.get(key);Object.assign(task,executionFields({dependsOn:row.dependsOn.map(k=>resolved.get(k).id)},task,project.projectId,state.tasks));}
  for(const row of report.tasks.filter(t=>reused.includes(t.key))){const task=resolved.get(row.key),wanted=row.dependsOn.map(k=>resolved.get(k).id).sort();if(JSON.stringify(wanted)!==JSON.stringify([...(task.dependsOn??[])].sort()))differences.push(row.key);}
  request.status='imported';request.error='';request.result={created:created.length,reused:reused.length,differences:[...new Set(differences)],taskIds:created.map(k=>resolved.get(k).id)};request.finishedAt=new Date().toISOString();return request.result;
}
export function cancelPlan(state,id,project){const r=findRequest(state,id,project);if(r.status==='imported')throw Error('任务已导入，不能取消回执');r.status='cancelled';}
