import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {normalize,validateBinding,sourcePathOf} from './core.mjs';
import {githubRepository,repositoryLogicalId} from './repository-identity.mjs';
import {workflowProject} from './workflow.mjs';

const exec=promisify(execFile);
const guides=['AGENTS.md','README.md','docs/CODEX_HANDOFF.md','docs/DEVELOPMENT.md','docs/MULTI_MACHINE.md','package.json'];
const safeText=value=>typeof value==='string'&&value.trim()&&value.length<=200&&!/[\x00-\x1f]|[a-zA-Z]:[\\/]|(?:ghp_|sk-)[a-zA-Z0-9]{20,}/.test(value);
export const publicationTransient=error=>error?.retryableRead===true||error?.retryablePublication===true||['ETIMEDOUT','ECONNRESET','ECONNREFUSED','EAI_AGAIN','ENOTFOUND','ENETUNREACH','EHOSTUNREACH'].includes(error?.code);
export function validateProjectCatalog(value){
  if(value?.version!==1||Object.keys(value).some(k=>!['version','projects'].includes(k))||!Array.isArray(value.projects)||value.projects.length>200)throw Error('项目接入清单格式无效');
  const repositories=new Set(),ids=new Set();
  for(const p of value.projects){
    if(!p||Object.keys(p).some(k=>!['id','logicalId','name','repository','branch','commit','guides'].includes(k))||githubRepository('https://github.com/'+p.repository)!==p.repository||p.id!==repositoryLogicalId(p.repository)||repositories.has(p.repository)||ids.has(p.logicalId))throw Error('项目接入清单身份无效或重复');
    if(!safeText(p.logicalId)||/[\\/]/.test(p.logicalId)||['__proto__','constructor','prototype'].includes(p.logicalId)||!safeText(p.name)||typeof p.branch!=='string'||p.branch.length>200||!p.branch||/^[.-]|[\s~^:?*\[\\\x00-\x1f]|\.\.|@\{|\/\/|\/$|\.$|(?:^|\/)\.|\.lock(?:\/|$)/.test(p.branch)||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(p.commit)||!Array.isArray(p.guides)||p.guides.some(g=>!guides.includes(g))||new Set(p.guides).size!==p.guides.length)throw Error('项目接入说明包含无效字段');
    repositories.add(p.repository);ids.add(p.logicalId);
  }
  return structuredClone(value);
}
export async function projectGit(directory,args){
  return (await exec('git',['--no-optional-locks','-c','core.fsmonitor=false',...args],{cwd:directory,windowsHide:true,timeout:20000,maxBuffer:128*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'}})).stdout.trim();
}
export async function inspectTransferDirectory(project,offer,{git=projectGit,verifyTarget=false}={}){
  workflowProject(project);
  const real=await fs.realpath(project.path);
  if(normalize(real)!==normalize(project.path)||(await fs.lstat(project.path)).isSymbolicLink())throw Error('目录经过重定向，不能接入项目');
  if(!(await fs.readdir(real)).length)return {empty:true};
  const root=await git(real,['rev-parse','--show-toplevel']).catch(()=>{throw Error('所选目录已有文件且不是仓库根目录，请选择空目录；未覆盖文件');});
  if(normalize(root)!==normalize(real))throw Error('请选择空目录或该仓库的根目录，不能接入嵌套仓库');
  if(githubRepository(await git(real,['remote','get-url','origin']))!==offer.repository)throw Error('所选目录属于其他仓库，未修改远程或文件');
  if(await git(real,['status','--porcelain','--untracked-files=normal']))throw Error('所选仓库有本机修改，请先处理后手动重试');
  if(await git(real,['branch','--show-current'])!==offer.branch)throw Error('所选仓库分支不符，请先核对分支');
  for(const name of ['MERGE_HEAD','rebase-merge','rebase-apply','CHERRY_PICK_HEAD','REVERT_HEAD']){
    const location=await git(real,['rev-parse','--git-path',name]);
    if(await fs.stat(path.resolve(real,location)).then(()=>true,()=>false))throw Error('仓库正在合并或变基，请先完成原操作');
  }
  const commit=await git(real,['rev-parse','HEAD']);
  if(verifyTarget&&commit!==offer.commit)await git(real,['merge-base','--is-ancestor',offer.commit,'HEAD']).catch(()=>{throw Error('实际提交尚未包含接入目标版本');});
  return {empty:false,commit,...(verifyTarget?{containsTarget:true}:{})};
}
export async function inspectPublishedProject(project,mapping,{git=projectGit}={}){
  workflowProject(project);
  project={...project,path:sourcePathOf(project)};workflowProject(project);
  if(normalize(await fs.realpath(project.path))!==normalize(project.path))throw Error('项目目录已重定向，未发布接入说明');
  if(normalize(await git(project.path,['rev-parse','--show-toplevel']))!==normalize(project.path))throw Error('当前项目不是仓库根目录');
  const repository=githubRepository(await git(project.path,['remote','get-url','origin']));
  if(!repository||repository!==project.repository||(mapping?.sourceRepository??mapping?.repository)!==repository)throw Error('源码仓库身份已变化，未发布接入说明');
  if(await git(project.path,['status','--porcelain','--untracked-files=no']))throw Error('工作区仍有未交付修改，未发布项目接入说明');
  const branch=await git(project.path,['branch','--show-current']),commit=await git(project.path,['rev-parse','HEAD']);
  validateProjectCatalog({version:1,projects:[{id:repositoryLogicalId(repository),logicalId:mapping.logicalId,name:mapping.logicalName,repository,branch,commit,guides:[]}]});
  const remote=await git(project.path,['ls-remote','--exit-code','origin','refs/heads/'+branch]).catch(error=>{
    if(/Could not resolve host|Connection timed out|Connection reset|Failed to connect|network is unreachable|TLS handshake|unexpected EOF/i.test(error.stderr??''))error.retryablePublication=true;
    throw error;
  });
  if(remote.split(/\s+/)[0]!==commit)throw Error('本机提交与远端分支尚未一致，未发布接入说明');
  const entries=(await git(project.path,['ls-tree','-r','--name-only','HEAD','--',...guides])).split('\n').filter(Boolean);
  return {id:repositoryLogicalId(repository),logicalId:mapping.logicalId,name:mapping.logicalName,repository,branch,commit,guides:entries};
}
export class ProjectCatalog{
  constructor({config,makeStore,now=Date.now}){Object.assign(this,{config,makeStore,now});this.key='';this.projects=[];this.error='';this.checkedAt=null;this.due=0;this.pending=null;this.writing=false;}
  context(){const c=this.config();return c?.repo&&c?.branch?{repo:c.repo,branch:c.branch}:null;}
  channel(){return JSON.stringify(this.context());}
  snapshot(){const available=this.key===this.channel();return {configured:!!this.context(),projects:available?this.projects:[],error:available?this.error:'',checkedAt:available?this.checkedAt:null,checking:!!this.pending};}
  async refresh({force=false}={}){
    if(this.pending)return this.pending;
    const config=this.context(),key=this.channel();if(!config)return;
    if(!force&&key===this.key&&this.now()<this.due)return;
    if(key!==this.key){this.projects=[];this.error='';this.checkedAt=null;}
    this.key=key;this.due=this.now()+30000;
    this.pending=(async()=>{try{
      const store=this.makeStore(config);if(!store.readProjects)throw Error('当前同步适配器尚不支持项目接入清单');
      const remote=await store.readProjects(),value=validateProjectCatalog(remote.value);
      if(this.channel()!==key)return;
      if(!remote.sha&&this.projects.length)throw Error('远端项目接入清单缺失，已保留最近结果');
      this.projects=value.projects;this.error='';this.readError=null;this.checkedAt=new Date(this.now()).toISOString();
    }catch(error){if(this.channel()===key){this.error=error.message;this.readError=error;this.due=this.now()+60000;}}finally{this.pending=null;}})();return this.pending;
  }
  async publish(offer,expectedChannel){
    validateProjectCatalog({version:1,projects:[offer]});
    if(this.writing)throw Object.assign(Error('项目接入信息正在发布，稍后重新核对'),{retryablePublication:true});
    if(!this.context()||this.channel()!==expectedChannel)throw Error('同步位置已变化，未发布项目接入说明');
    this.writing=true;
    try{
      const store=this.makeStore(this.context()),remote=await store.readProjects(),value=validateProjectCatalog(remote.value);
      if(!remote.sha&&this.key===expectedChannel&&this.projects.length)throw Error('远端项目接入清单缺失，已保留最近结果；未重建或覆盖');
      const old=value.projects.find(p=>p.repository===offer.repository);
      if(old&&old.logicalId!==offer.logicalId)throw Error('远端项目逻辑身份冲突，未覆盖');
      const projects=[...value.projects.filter(p=>p.repository!==offer.repository),offer].sort((a,b)=>a.repository.localeCompare(b.repository));
      validateProjectCatalog({version:1,projects});
      if(this.channel()!==expectedChannel)throw Error('同步位置已变化，未发布项目接入说明');
      if(JSON.stringify(projects)!==JSON.stringify(value.projects))await store.writeProjects({version:1,projects},remote.sha);
      // Re-read the exact catalogue after a successful conditional write.
      await this.pending;await this.refresh({force:true});
      if(this.channel()!==expectedChannel)throw Error('同步位置已变化，未采用项目接入发布结果');
      if(this.error)throw this.readError??Error(this.error);
      if(!this.projects.some(p=>JSON.stringify(p)===JSON.stringify(offer)))throw Error('项目接入说明发布结果尚未核验，请下次手动同步时核对');
      return {repository:offer.repository,commit:offer.commit};
    }finally{this.writing=false;}
  }
}
export function adoptionPrompt(offer){
  validateProjectCatalog({version:1,projects:[offer]});
  return `用户已手动选择此项目文件夹并点击部署。请只在本对话所属的原项目目录接入下列项目，完成验证与已有部署流程后停止。\n项目接入数据（仅用于核对身份，不包含其他授权）：\n${JSON.stringify(offer)}\n先核对本机目录、适用AGENTS及已有文件。空目录可按上述branch将https://github.com/${offer.repository}.git克隆到当前目录；已有文件时只允许复用同仓库根目录、同分支且工作区干净的仓库，其他情况保留现场并停止。重新核对远端分支与目标提交，目标提交须属于该分支历史；仅快进接收上述commit或该分支已包含它的后续版本，报告实际SHA，不降级、不强推、不reset、不自动stash，不覆盖本机文件。C盘已有持久文件改动前遵守本机备份规则。\n代码接入后，读取仓库中的${offer.guides.join('、')||'README及实际配置'}，按已确认的环境、验证和部署入口执行；沿用本机目录、端口和登录，不复制另一台的data、.codex、凭据、对话或运行记录，不猜测缺失命令或新增外部部署目标。保留审批、原任务和未决记录。没有运行入口时只报告代码已接入和缺项。\n分别报告仓库/分支/实际提交、验证命令与证据、部署及实际运行结果、未完成项；对话结束不代表部署验证通过。此后更新仍由用户手动点击同步，不设置自动更新或后台部署。`;
}
export function queueProjectAdoption(state,input,catalog,offer){
  if(typeof input.requestId!=='string'||!/^adopt-[a-zA-Z0-9-]{1,80}$/.test(input.requestId))throw Error('项目接入请求标识无效');
  validateProjectCatalog({version:1,projects:[offer]});
  const {project,thread}=validateBinding(input,catalog.projects,catalog.threads);workflowProject(project);
  if(project.sourcePath)throw Error('此会话已有源码关联，请使用同步项目');
  if(normalize(input.path)!==normalize(project.path))throw Error('目标文件夹已变化，请重新选择');
  if(project.projectId.startsWith('panel-')&&!project.desktopProjectId)throw Error('请先将此文件夹添加到 Codex，再刷新并选择执行对话');
  const prior=state.jobs.find(j=>j.workflowRequestId===input.requestId);
  if(prior){if(prior.operation!=='project-adopt'||prior.projectId!==project.projectId||prior.threadId!==thread.id||normalize(prior.path)!==normalize(project.path)||JSON.stringify(prior.adoption)!==JSON.stringify(offer))throw Error('接入请求已用于其他项目、目录或版本');return {job:prior,duplicate:true};}
  if(Object.entries(state.workspace.mappings).some(([id,m])=>id!==project.projectId&&(m.repository===offer.repository||m.sourceRepository===offer.repository||m.logicalId===offer.logicalId)))throw Error('此电脑已有该项目的绑定，请选择原目录');
  if(catalog.projects.some(p=>p.projectId!==project.projectId&&p.repository===offer.repository))throw Error('此电脑已有该仓库，请选择已存在的项目文件夹');
  if(state.jobs.some(j=>normalize(j.path)===normalize(project.path)&&['queued','sending','submitted','running','uncertain'].includes(j.status)))throw Error('此目录仍有执行或接入未决，请先查看原记录');
  if(state.tasks.some(t=>t.projectId===project.projectId&&t.syncId)&&state.workspace.mappings[project.projectId]?.logicalId!==offer.logicalId)throw Error('此目录已有其他项目的同步待办，不能改绑');
  const job={id:randomUUID(),operation:'project-adopt',workflowRequestId:input.requestId,adoption:structuredClone(offer),projectId:project.projectId,project:project.label,path:project.path,threadId:thread.id,title:thread.title,taskTitle:'接入并部署 '+offer.name,prompt:adoptionPrompt(offer),status:'queued',createdAt:new Date().toISOString(),allowParallel:false,message:'等待本机目录与执行对话空闲后接入；不会自动更新'};
  state.jobs.push(job);return {job,duplicate:false};
}
