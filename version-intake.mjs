import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {normalize} from './core.mjs';
import {versionValues,inspectVersionGit} from './versions.mjs';

const lifetime=24*60*60*1000,fields=['name','summary','ref','validation','backupPath','rollbackNotes'];
export const portableVersionPrompt=[
  '请为当前 Codex 项目整理有依据的版本记录，并自动回填到这台电脑的项目面板。此指令可跨电脑重复使用，所有路径、项目ID、请求ID和连接令牌均须在执行电脑现场取得。',
  '1. 先核对本对话的原项目目录及当前工作目录，读取适用AGENTS与必要项目说明。以已确认的当前项目目录为目标，保留已有修改；不要使用其他电脑的路径，也不要根据同名目录猜测项目。',
  '2. 通过HTTP只读检查本机面板：若PORT环境变量是有效端口可优先检查，再检查 http://127.0.0.1:4319/api/state 与 http://127.0.0.1:4318/api/state。仅访问127.0.0.1。候选响应须有service.instanceId与projects数组；从projects中选择hostId为local、path规范化后与当前项目目录完全一致的项目。Windows路径比较忽略大小写并统一分隔符。',
  '3. 没有匹配服务时说明需要先在本机启动/更新项目面板；如使用其他端口，请用户提供本机地址。多个不同服务均匹配时先核对目标，不随机选用。不要扫描其他项目文件、复制另一电脑的运行数据或修改全局环境。',
  '4. 使用选定响应中的token作为X-Panel-Token请求头，向同一服务POST /api/versions/begin，Content-Type为application/json，请求体仅包含刚取得的projectId。不要把token输出到日志、文档或回执。若接口不存在，停止并说明需要更新这台电脑的面板，不沿用旧电脑的回执路径。',
  '5. 核对接口返回的projectId、projectPath与当前项目一致，然后执行它返回的prompt。这份本机指令会现场给出正确的回执位置和请求标识；只在这些已核对的路径内工作，不扩大到其他项目。',
  '6. 根据实际项目变化、Git提交及可核实的验证/备份证据填写版本信息，未验证或未创建的内容如实注明。未经另行授权，不创建提交、标签、版本备份，不推送、部署、回滚或发送其他对话。按本机指令完成结果回执后，简述结果；用户打开版本表单即可自动填入，检查后保存。'
].join('\n\n');
export function localReceiptPath(root,id,folder='version-intake'){
  if(!/^[a-f0-9-]{36}$/.test(id))throw Error('版本请求标识无效');
  if(!['version-intake','plan-intake'].includes(folder))throw Error('回执类型无效');
  const directory=path.resolve(root,'data',folder);
  fs.mkdirSync(directory,{recursive:true});
  if(normalize(fs.realpathSync(directory))!==normalize(directory))throw Error('版本结果目录不能重定向到其他位置');
  return path.join(directory,id+'.json');
}
const receiptPath=(root,id)=>localReceiptPath(root,id);
function requestFor(state,id,project){
  const request=state.versionIntakes?.find(r=>r.id===id);
  if(!request||request.projectId!==project.projectId||normalize(request.projectPath)!==normalize(project.path))throw Error('版本请求不属于当前项目或项目目录已变化');
  if(!Number.isFinite(Date.parse(request.createdAt))||Date.now()-Date.parse(request.createdAt)>lifetime)throw Error('版本指令已超过24小时，请重新生成');
  if(request.status==='cancelled')throw Error('版本请求已取消，请使用新指令');
  return request;
}
export function versionIntakeView(state){return (state.versionIntakes??[]).filter(r=>['waiting','ready'].includes(r.status)&&Date.now()-Date.parse(r.createdAt)<=lifetime).map(({id,projectId,status,createdAt})=>({id,projectId,status,createdAt}));}
export function createVersionIntake(state,project,root,id){
  state.versionIntakes??=[];
  let request;
  if(id)request=requestFor(state,id,project);
  else{
    state.versionIntakes=state.versionIntakes.filter(r=>Date.now()-Date.parse(r.createdAt)<=lifetime);
    request=state.versionIntakes.filter(r=>r.status==='waiting'&&r.projectId===project.projectId&&normalize(r.projectPath)===normalize(project.path)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
    if(!request){
      if(state.versionIntakes.length>=50)throw Error('版本请求过多，请先完成或等待旧请求过期');
      request={id:randomUUID(),projectId:project.projectId,projectPath:project.path,createdAt:new Date().toISOString(),status:'waiting'};
      state.versionIntakes.push(request);
    }
  }
  if(request.status==='saved')throw Error('此结果已保存，请生成新版本指令');
  const target=receiptPath(root,request.id),previous=(state.versionRecords??[]).filter(v=>v.projectId===project.projectId&&!v.deletedAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  const envelope={schemaVersion:1,requestId:request.id,projectPath:project.path,name:'',summary:'',ref:'',validation:'',backupPath:'',rollbackNotes:''};
  const prompt=[
    '请为当前项目整理一次有依据的版本记录，并把结果回填到本机项目面板。',
    '目标项目目录：'+JSON.stringify(project.path)+'。先核对当前工作目录；不一致时停止并说明，不切换到其他项目猜测执行。',
    '读取适用AGENTS、当前交接/项目说明及必要Git状态、最近提交。保留已有修改。'+(previous?.commit?'上次记录的固定提交为 '+previous.commit+'，可据此核对本版变化。':''),
    '根据真实变化生成简洁版本名称、变化摘要、验证记录、备份位置及回滚注意。优先复用可核实的验证证据；确有必要时仅运行项目已有、不会部署或操作真实业务数据的检查。失败/未执行必须写明，不能把代码完成写成验证通过。',
    '面向日常回顾：版本名称只写本次主题；summary优先用2至5条简短的“更新/修复”说明，合计尽量不超过300字。提交SHA放在ref，测试与限制放在validation，备份和恢复细节放在对应字段，不将任务流水、绝对路径和长篇证据堆进summary；未提交改动的必要边界仍须简短注明。验证和回滚说明也只写必要结论，不复制完整日志。',
    '先用 git rev-parse --show-toplevel 核对项目目录是否为仓库根目录；仅根目录项目的ref填写 git rev-parse HEAD 得到的完整提交SHA，非Git或仅为仓库子目录时留空并说明。存在未提交修改时必须在摘要和回滚注意中说明该提交不包含这些修改。',
    '只记录已存在并已核对的备份位置，没有备份写“未创建”；不要为了填表创建提交、标签、备份、推送、部署或回滚。不要填写凭据。',
    '完成后，授权仅将本次结果写入下面指定的面板回执文件（本任务必要的项目外输出）。不要直接编辑面板state.json，不发送其他对话。',
    '回执文件：'+JSON.stringify(target),
    '使用UTF-8 JSON，完整填写以下结构中的六个版本字段，其余字段保持原样；不要包裹Markdown代码围栏。先写同目录临时文件，完成后替换目标文件，避免面板读取到半份JSON。',
    JSON.stringify(envelope,null,2),
    '写入后验证JSON可解析，并在对话中简述版本、验证结果和回执已写入。面板会自动识别填入，用户检查后保存。'
  ].join('\n\n');
  return {id:request.id,prompt,status:request.status};
}
export function versionCommand(state,project,root,id){return {...createVersionIntake(state,project,root,id),prompt:portableVersionPrompt};}
export function beginVersionIntake(state,project,root){return {...createVersionIntake(state,project,root),projectId:project.projectId,projectPath:project.path};}
export function cancelVersionIntake(state,id,project){const request=requestFor(state,id,project);if(request.status==='saved')throw Error('已保存结果不能取消');request.status='cancelled';}
export async function collectVersionIntake(state,id,project,root,inspect=inspectVersionGit){
  const request=requestFor(state,id,project);
  if(request.status==='saved')return {status:'saved'};
  if(request.status==='ready')return {status:'ready',draft:request.draft,git:request.git};
  const target=receiptPath(root,id);
  let info;try{info=fs.lstatSync(target);}catch(e){if(e.code==='ENOENT')return {status:'waiting'};throw e;}
  if(!info.isFile()||info.isSymbolicLink()||info.size>65536)throw Error('版本结果必须是64 KiB以内的普通JSON文件');
  let report;try{report=JSON.parse(fs.readFileSync(target,'utf8').replace(/^\uFEFF/,''));}catch{throw Error('版本结果尚未写完或不是有效JSON，稍后会继续读取');}
  if(!report||Object.keys(report).some(k=>!['schemaVersion','requestId','projectPath',...fields].includes(k))||report.schemaVersion!==1||report.requestId!==id||typeof report.projectPath!=='string'||normalize(report.projectPath)!==normalize(project.path)||fields.some(f=>typeof report[f]!=='string'))throw Error('版本结果字段不完整，或请求/项目不匹配');
  const draft=versionValues(report);
  if(draft.ref&&!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(draft.ref))throw Error('版本结果必须给出完整Git提交SHA；无Git仓库时留空');
  const git=draft.ref?await inspect(project,draft.ref):null;
  if(git&&git.commit.toLowerCase()!==draft.ref.toLowerCase())throw Error('Git提交核验不一致，未填入');
  return {status:'ready',draft,git};
}
export function acceptVersionIntake(state,id,project,result){
  const request=requestFor(state,id,project);
  if(request.status==='waiting'&&result.status==='ready')Object.assign(request,{status:'ready',draft:result.draft,git:result.git,receivedAt:new Date().toISOString()});
  return request.status==='ready'?{status:'ready',draft:request.draft,git:request.git}:{status:request.status};
}
export function linkVersionIntake(state,id,project,record){
  const request=requestFor(state,id,project);
  if(!['ready','saved'].includes(request.status)||request.recordId&&request.recordId!==record.id)throw Error('版本结果尚未就绪或已经保存为另一条记录');
  Object.assign(request,{status:'saved',recordId:record.id});record.source='codex-assisted';record.sourceRequestId=id;
}
