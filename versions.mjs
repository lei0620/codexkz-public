import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {normalize} from './core.mjs';
const exec=promisify(execFile);
const text=(value,max,required=false)=>{if(typeof value!=='string'||value.trim().length>max||(required&&!value.trim())||/[\x00]/.test(value))throw Error('版本记录字段无效或过长');return value.trim();};
export function versionProject(projects,id){const p=projects.find(p=>p.projectId===id);if(!p?.path||p.hostId!=='local')throw Error('请选择本机项目');return p;}
export function versionRef(value){if(typeof value!=='string'||!value||value.length>120||!/^[-\w./]+$/.test(value)||value.startsWith('-')||value.includes('..'))throw Error('请填写有效提交号、标签或分支');return value;}
async function git(project,args){return (await exec('git',['--no-optional-locks','-c','core.fsmonitor=false',...args],{cwd:project.path,windowsHide:true,timeout:12000,maxBuffer:2*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'}})).stdout.trim();}
async function repository(project){
  let root;try{root=await git(project,['rev-parse','--show-toplevel']);}catch{throw Error('此项目不是可读取的 Git 仓库；可留空 Git 引用，仅记录版本说明和备份位置。');}
  if(normalize(root)!==normalize(project.path))throw Error('当前目录不是 Git 仓库根目录，请先核对项目绑定。');
}
export async function inspectVersionGit(project,ref='HEAD'){
  versionRef(ref);await repository(project);
  let commit;try{commit=await git(project,['rev-parse','--verify','--end-of-options',ref+'^{commit}']);}catch{throw Error('Git 引用不存在或不是提交，请核对标签/提交号。');}
  const [branch,status,history,tags]=await Promise.all([
    git(project,['rev-parse','--abbrev-ref','HEAD']),git(project,['status','--porcelain=v1','--untracked-files=normal']),
    git(project,['log','-8','--format=%H%x09%s','--no-decorate']),git(project,['for-each-ref','--count=20','--sort=-creatordate','--format=%(refname:short)','refs/tags'])
  ]);
  return {commit,branch,dirty:!!status,changes:status?status.split('\n').length:0,history:history?history.split('\n').map(line=>{const i=line.indexOf('\t');return {commit:line.slice(0,i),subject:line.slice(i+1)};}):[],tags:tags?tags.split('\n'):[],capturedAt:new Date().toISOString()};
}
export function versionValues(input){return {name:text(input.name,80,true),summary:text(input.summary??'',4000),ref:text(input.ref??'',120),validation:text(input.validation??'',2000),backupPath:text(input.backupPath??'',1000),rollbackNotes:text(input.rollbackNotes??'',4000)};}
export function saveVersion(state,input,project,snapshot=null){
  state.versionRecords??=[];
  const previous=input.id?state.versionRecords.find(v=>v.id===input.id&&v.projectId===project.projectId):null;
  if(input.id&&!previous)throw Error('版本记录不存在');
  if(previous?.deletedAt)throw Error('版本记录已删除，请新建记录');
  if(previous&&input.revision!==previous.revision)throw Error('版本记录已被更新，请重新打开后编辑');
  const values=versionValues(input);
  if(previous&&values.ref!==previous.ref)throw Error('已记录版本的 Git 引用不可变更，请新增版本记录');
  if(values.ref&&!previous&&!snapshot?.commit)throw Error('Git 引用尚未核对，不能保存为可定位版本');
  const signature=JSON.stringify(values),requestId=text(input.requestId??'',100,!previous);
  if(!previous){const duplicate=state.versionRecords.find(v=>v.projectId===project.projectId&&v.requestId===requestId);if(duplicate){if(duplicate.deletedAt)throw Error('该请求对应的版本已删除，请新建记录');if(duplicate.signature!==signature)throw Error('请求标识已用于其他版本内容');return {record:duplicate,duplicate:true};}}
  const now=new Date().toISOString();
  if(previous){Object.assign(previous,values,{updatedAt:now,revision:previous.revision+1});return {record:previous};}
  if(state.versionRecords.filter(v=>v.projectId===project.projectId&&!v.deletedAt).length>=200)throw Error('每项目最多记录200个版本');
  const record={id:randomUUID(),projectId:project.projectId,projectPath:project.path,...values,commit:snapshot?.commit??'',branch:snapshot?.branch??'',dirtyAtCapture:snapshot?.dirty??null,changesAtCapture:snapshot?.changes??null,capturedAt:snapshot?.capturedAt??null,createdAt:now,updatedAt:now,revision:1,requestId,signature};
  state.versionRecords.push(record);return {record};
}
export function deleteVersion(state,input,project){
  const record=state.versionRecords?.find(v=>v.id===input.id&&v.projectId===project.projectId);
  if(!record||normalize(record.projectPath)!==normalize(project.path))throw Error('版本记录不存在或项目目录已变化');
  if(!Number.isInteger(input.revision)||input.revision<1)throw Error('请刷新版本记录后再删除');
  if(record.deletedAt)return {id:record.id,deleted:true,alreadyDeleted:true};
  if(input.revision!==record.revision)throw Error('版本记录已被更新，请刷新后再删除');
  record.deletedAt=new Date().toISOString();record.updatedAt=record.deletedAt;record.revision++;
  return {id:record.id,deleted:true};
}
export async function prepareVersionRollback(project,record){
  if(record.deletedAt)throw Error('版本记录已删除，无法准备回滚');
  if(record.projectId!==project.projectId||normalize(record.projectPath)!==normalize(project.path))throw Error('版本记录的项目目录已变化，请先核对绑定');
  const guide=[`目标项目：${project.label}`,`目标版本：${record.name}`,record.commit?`固定提交：${record.commit}`:'此记录没有固定 Git 提交，需要核对备份文件。',`版本说明：${record.summary||'未填写'}`,`验证记录（记录信息，未独立复核）：${record.validation||'未填写'}`,`备份位置（记录，未验证）：${record.backupPath||'未填写'}`,`回滚注意：${record.rollbackNotes||'未填写'}`,'执行前先核对项目路径、当前修改和运行任务，按项目规则备份当前源码及相关数据，再展示具体回滚方案。确认后执行并验证。不要把源码回退当作数据或安装包也已恢复。'].join('\n');
  if(!record.commit)return {gitAvailable:false,guide,message:'这是说明/备份记录，未验证备份存在，也未固定 Git 提交。'};
  const current=await inspectVersionGit(project,'HEAD');
  try{await git(project,['cat-file','-e',versionRef(record.commit)+'^{commit}']);}catch{throw Error('此版本的固定提交已不在本机仓库，请先恢复提交或核对备份。');}
  const [stat,files]=await Promise.all([git(project,['diff','--no-ext-diff','--no-textconv','--stat',current.commit,record.commit,'--']),git(project,['diff','--no-ext-diff','--no-textconv','--name-status',current.commit,record.commit,'--'])]);
  const rows=files?files.split('\n'):[];
  return {gitAvailable:true,current:{commit:current.commit,branch:current.branch,dirty:current.dirty,changes:current.changes},target:record.commit,stat:stat.slice(0,16000),files:rows.slice(0,100),fileCount:rows.length,truncated:rows.length>100,guide,message:record.dirtyAtCapture?'保存此记录时存在未提交修改：固定提交不包含那些修改，需结合备份核对。':'这里只检查源码提交差异，尚未执行回滚；备份位置与验证记录均为记录信息，未独立复核。'};
}
