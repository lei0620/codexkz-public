import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {normalize,sourcePathOf,sourceAwareJobs,sourceAwareJob,sourcePathsOverlap} from './core.mjs';
import {inspectRepository,assertSourceGitDirectory,githubRepository} from './repository-identity.mjs';

const active=new Set(['queued','sending','submitted','running','uncertain']);
const snapshot=(state,project)=>JSON.stringify([project.projectId,normalize(project.path),state.workspace.mappings[project.projectId]??null]);
const digest=value=>createHash('sha256').update(value).digest('hex');
export const sourceBindingRequired='当前会话入口未关联源码仓库；源码已上传时，请在项目设置中关联已有源码目录';

export function assertSourceBindingIdle(state,projectId){
  if(state.jobs.some(j=>j.projectId===projectId&&active.has(j.status))||state.automation?.plans?.some(p=>p.projectId===projectId&&p.status==='active'))throw Error('当前项目仍有执行或安排，请结束后再关联源码目录');
}
async function inspectSourceRoot(project,sourcePath,inspect){
  await assertSourceGitDirectory(sourcePath);
  const source={...project,path:sourcePath};delete source.sourcePath;
  return inspect(source,{fresh:true});
}
export async function previewSourceBinding(state,input,projects,{inspect=inspectRepository,requireLocalEntry=false}={}){
  const project=projects.find(p=>p.projectId===input.projectId&&p.hostId==='local');
  if(!project?.path||!state.workspace.mappings[project.projectId])throw Error('请先核对本机会话项目和原有身份');
  if(normalize(project.path)!==normalize(state.workspace.mappings[project.projectId].path))throw Error('会话目录与原绑定不一致，请先核对原项目');
  const value=input.sourcePath;
  if(typeof value!=='string'||!value.trim()||value.length>4096||/[\x00-\x1f]/.test(value)||!path.isAbsolute(value.trim())||/^(?:[e-z]:|\\\\)/i.test(value.trim()))throw Error('请填写本机C盘或D盘的实际源码绝对目录');
  const sourcePath=path.resolve(value.trim());
  if(normalize(sourcePath)===normalize(path.parse(sourcePath).root))throw Error('不能关联磁盘根目录');
  for(const directory of [project.path,sourcePath])if(normalize(await fs.realpath(directory))!==normalize(directory)||(await fs.lstat(directory)).isSymbolicLink())throw Error('会话或源码目录经过重定向，请核对真实目录');
  const actual=await inspectSourceRoot(project,sourcePath,inspect);
  if(!actual.repository||actual.repositoryReason)throw Error(actual.repositoryReason||'所选源码目录需要已有的GitHub origin，且必须是仓库根目录');
  const previous=state.workspace.mappings[project.projectId];
  const expected=previous.sourceRepository??previous.repository;
  if(expected&&expected!==actual.repository)throw Error('所选目录属于另一源码仓库，原有关联已保留');
  const entry={...project};delete entry.sourcePath;
  const own=await inspect(entry,{fresh:true});
  if(requireLocalEntry&&(own.repositoryStatus!=='local'||own.repositoryReason||own.repository))throw Error('会话入口的本地仓库状态尚未确认，未自动关联');
  if(own.repository&&own.repository!==actual.repository)throw Error('会话入口已有另一仓库，不能把两者合并');
  for(const other of projects)if(other.projectId!==project.projectId){
    const mapping=state.workspace.mappings[other.projectId];
    if(other.repository===actual.repository||mapping?.repository===actual.repository||mapping?.sourceRepository===actual.repository||normalize(sourcePathOf(other))===normalize(sourcePath))throw Error('本机已有此源码仓库或目录的其他项目关联，请先核对原项目');
  }
  const version=snapshot(state,project);
  return {projectId:project.projectId,path:project.path,sourcePath,repository:actual.repository,logicalId:previous.logicalId,logicalName:previous.logicalName,previewHash:digest(JSON.stringify([version,normalize(sourcePath),actual.repository]))};
}
export function saveSourceBinding(state,input,proof,projects){
  const project=projects.find(p=>p.projectId===input.projectId&&p.hostId==='local');
  if(input.confirmed!==true||!project||input.repository!==proof.repository||input.previewHash!==proof.previewHash||normalize(input.sourcePath)!==normalize(proof.sourcePath))throw Error('源码关联核对结果已变化，请重新核验并确认');
  if(digest(JSON.stringify([snapshot(state,project),normalize(proof.sourcePath),proof.repository]))!==proof.previewHash)throw Error('原项目身份已变化，未覆盖已有设置');
  assertSourceBindingIdle(state,project.projectId);
  const target={...project,sourcePath:proof.sourcePath};
  if(sourceAwareJobs(state).some(j=>active.has(j.status)&&sourcePathsOverlap(j,target))||state.automation?.plans?.some(p=>p.status==='active'&&projects.some(other=>other.projectId===p.projectId&&sourcePathsOverlap(sourceAwareJob(state,other),target))))throw Error('共用源码目录仍有执行或安排，请结束后再关联');
  if(Object.entries(state.workspace.mappings).some(([id,m])=>id!==project.projectId&&(m.repository===proof.repository||m.sourceRepository===proof.repository||m.sourcePath&&normalize(m.sourcePath)===normalize(proof.sourcePath))))throw Error('本机源码关联已变化，已有另一个项目占用该仓库');
  const previous=state.workspace.mappings[project.projectId];
  // Source association is local routing, not a migration of shared task identity.
  state.workspace.mappings[project.projectId]={...previous,sourcePath:proof.sourcePath,sourceRepository:proof.repository};
  return {projectId:project.projectId,sourcePath:proof.sourcePath,repository:proof.repository};
}
export async function verifySourceBinding(project,mapping,{inspect=inspectRepository}={}){
  if(!mapping?.sourcePath&&!project?.sourcePath)return project;
  if(!project?.sourcePath||normalize(project.sourcePath)!==normalize(mapping?.sourcePath)||project.repository!==mapping.sourceRepository)throw Error('源码关联已变化或尚未刷新，请重新核对');
  await assertSourceGitDirectory(mapping.sourcePath);
  const actual=await inspect(project,{fresh:true});
  if(actual.repository!==mapping.sourceRepository||actual.repositoryReason)throw Error(actual.repositoryReason||'实际源码仓库已变化，未执行操作');
  return {...project,...actual};
}
export function sourceContext(project){
  if(!project?.sourcePath||normalize(project.sourcePath)===normalize(project.path))return '';
  return '\n\n[本机已确认的源码关联]\n'+JSON.stringify({entryPath:project.path,sourcePath:project.sourcePath,repository:project.repository})+'\n会话归属和历史继续使用entryPath；Git检查、拉取、源码验证及已有部署流程只在sourcePath执行，先核对该目录规范和origin。不要在会话入口重新建库、添加远端或重新上传，不移动会话/任务，不复制本机路径到跨机待办或交付清单。';
}

// Upload replies are hints, never filesystem authority. Only inspect exact
// reported paths inside the original entry; do not search neighboring projects.
export function uploadSourceHints(text,entry){
  if(typeof text!=='string'||text.length>100000)return null;
  const inside=value=>typeof value==='string'&&path.isAbsolute(value)&&!/[\x00-\x1f]/.test(value)&&!(/^(?:[e-z]:|\\\\)/i.test(value))&&(()=>{const r=path.relative(entry,path.resolve(value));return r&&!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);})();
  const blocks=[...text.matchAll(/```github-source-report\s*\n([\s\S]*?)\n```/g)];
  if(blocks.length){
    if(blocks.length!==1||blocks[0][1].length>8192)return null;
    try{const r=JSON.parse(blocks[0][1]);return r.version===1&&r.uploaded===true&&githubRepository('https://github.com/'+r.repository)===r.repository&&inside(r.sourcePath)?{repository:r.repository,paths:[path.resolve(r.sourcePath)]}:null;}catch{return null;}
  }
  // Compatibility for previous upload commands: an exact GitHub repository
  // link plus local document links. Only their bounded in-entry ancestors.
  if(!/^已(?:成功)?上传到/.test(text.trim())||!/(?:本地与远端(?:提交)?|远端与本地(?:提交)?).{0,8}一致/.test(text))return null;
  const repos=new Set([...text.matchAll(/\]\((https:\/\/github\.com\/[^\s)]+)\)/g)].map(m=>githubRepository(m[1])).filter(Boolean));
  if(repos.size!==1)return null;
  const paths=new Set();
  for(const match of text.matchAll(/\]\(([^\r\n)]+)\)/g)){
    if(!inside(match[1]))continue;
    let directory=path.dirname(match[1]);
    for(let i=0;i<6&&inside(directory);i++,directory=path.dirname(directory)){paths.add(path.resolve(directory));if(paths.size>8)return null;}
  }
  return paths.size?{repository:[...repos][0],paths:[...paths]}:null;
}

function uploadCandidate(state,project){
  if(project.hostId!=='local'||project.sourcePath||project.repository||project.repositoryStatus!=='local'||project.repositoryReason)return null;
  const mapping=state.workspace.mappings[project.projectId];
  if(!mapping||mapping.sourcePath||mapping.repository||normalize(mapping.path)!==normalize(project.path))return null;
  const task=state.tasks.filter(t=>t.projectId===project.projectId&&t.createRequestId?.startsWith('github-upload-')&&!t.archivedAt).at(-1);
  if(!task||!['review','done'].includes(task.status)||normalize(task.path)!==normalize(project.path))return null;
  const job=state.jobs.find(j=>j.id===task.currentJobId);
  if(!job||job.taskId!==task.id||job.projectId!==project.projectId||!task.jobIds?.includes(job.id)||job.status!=='completed'||job.awaitingUser||job.modelMismatch||!job.threadId||!job.turnId||normalize(job.path)!==normalize(project.path))return null;
  const hints=uploadSourceHints(job.finalResult??job.result,project.path);
  return hints?{task,job,hints,stamp:JSON.stringify([mapping,task,job])}:null;
}

export class AutomaticSourceBinding {
  constructor({getState,getProjects,mutate,inspect,validate,busy=()=>false,blocked=()=>false,now=Date.now}){Object.assign(this,{getState,getProjects,mutate,inspect,validate,busy,blocked,now});this.pending=null;this.attempts=new Map();}
  run(){
    if(this.pending)return this.pending;
    this.pending=this.advance().finally(()=>{this.pending=null;});return this.pending;
  }
  async advance(){
    if(this.blocked())return false;
    for(const project of this.getProjects()){
      const candidate=uploadCandidate(this.getState(),project);if(!candidate)continue;
      const key=project.projectId,old=this.attempts.get(key);
      if(old?.stamp===candidate.stamp&&this.now()<old.next)continue;
      if(this.attempts.size>=128)this.attempts.delete(this.attempts.keys().next().value);
      this.attempts.set(key,{stamp:candidate.stamp,next:this.now()+60000});
      try{
        assertSourceBindingIdle(this.getState(),key);
        if(this.busy(key))return false;
        const guard=await this.validate(candidate.job,project);
        const proofs=[];
        for(const sourcePath of candidate.hints.paths){
          try{const proof=await previewSourceBinding(this.getState(),{projectId:key,sourcePath},this.getProjects(),{inspect:this.inspect,requireLocalEntry:true});if(proof.repository===candidate.hints.repository)proofs.push(proof);}catch{/* Invalid legacy ancestors are hints only. */}
        }
        if(proofs.length!==1||this.blocked()||this.busy(key,proofs[0]))return false;
        const proof=proofs[0];
        // Entry and alternate candidate reads can take time. Verify the chosen
        // repository again before the state transaction, never trust that old read.
        const latestSource=await inspectSourceRoot(project,proof.sourcePath,this.inspect??inspectRepository);
        if(latestSource.repository!==proof.repository||latestSource.repositoryReason)return false;
        const result=await this.mutate(draft=>{
          const current=this.getProjects().find(p=>p.projectId===key),latest=current&&uploadCandidate(draft,current);
          if(!latest||latest.stamp!==candidate.stamp||this.blocked()||this.busy(key,proof)||typeof guard==='function'&&!guard())return false;
          return saveSourceBinding(draft,{...proof,confirmed:true},proof,this.getProjects());
        });
        if(result)return result;
      }catch{/* Busy/unknown/changed identity is retried on a later normal tick. */}
      // Bound work per pass, including ambiguous results.
      return false;
    }
    return false;
  }
}
