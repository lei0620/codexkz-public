import {normalize} from './core.mjs';
import {workflowProject} from './workflow.mjs';
import {createTask} from './board.mjs';
import {sourceBindingRequired} from './source-binding.mjs';

export const projectSyncCommand={title:'同步项目',description:`用户点击“同步项目”。只处理面板绑定的当前原项目；按项目实际能力对齐源码、待办和本机功能，不适用项说明原因。
1. 读取本项目适用规范、交接及同步/运行入口，核对原目录、绑定、仓库、分支、上游、远端和所需本机认证。缺项或目标变化时停止相关写入并说明；不猜测目标、不新建副本或更换远端。
2. 核对工作区与待交付提交后，先fetch已确认远端并比较提交。远端独有且工作区干净才安全快进拉取；本机独有时逐个确认提交归属和验证结果，再推送并核对远端SHA；未提交成果仅在本次获准且验证通过时按范围提交。两端一致且无待交付修改则不操作Git。分叉、脏工作区阻止拉取、上游不明或范围不清时保留现场；不强推、不reset、不自动stash或覆盖修改，推送回执未知只读核对。
3. 按项目已有流程先检查实际服务；确有缺项且已授权才恢复依赖/资源、验证、构建、部署或安全重启。复用正确实例，在途任务正常等待不强停；不臆造命令、安装全局工具或修改全局配置，修改C盘已有持久文件前按规则备份。核实运行代码、静态资源、健康、原数据和本次相关能力；排队更新或发送回执只记待核验。
4. 已配置待办同步时用正常入口同步允许字段及附件，核对远端内容和附件大小/SHA；冲突或关系阻塞留存并报告，未配置则标不适用。不复制整份data、数据库、凭据、.codex、对话/执行历史或另一台的caller；不重发、解除领取或转交未决安排。
5. 必要时更新已有交接与换机步骤；只提交推送本次获准且验证通过的源码/测试/文档，排除本机运行资料。报告同步方向、最终远端SHA、待办/附件、本机加载证据和另一台接续指令；另一台未实测标待验收。不把同步当新业务开发或历史任务验收。完成后停止。`};

// Resolve against the complete durable task list, not a paginated browser view.
// A repeated creation receipt must never resurrect an archived/completed task.
export function ensureProjectSyncTask(state,input,project){
  workflowProject(project);
  if(normalize(input.path??'')!==normalize(project.path))throw Error('项目目录已变化，请刷新后重试');
  if(!project.repository||project.repositoryReason)throw Error(project.repositoryReason||sourceBindingRequired);
  if(typeof input.requestId!=='string'||!/^project-sync-[a-zA-Z0-9-]{1,70}$/.test(input.requestId))throw Error('同步请求标识无效，请刷新后重试');
  const prior=state.tasks.find(t=>t.createRequestId===input.requestId);
  if(prior){if(prior.projectId!==project.projectId||normalize(prior.path)!==normalize(project.path))throw Error('同步请求已用于其他项目');return {task:prior,duplicate:true};}
  const active=state.tasks.find(t=>{
    if(t.projectId!==project.projectId||t.archivedAt||!t.createRequestId?.startsWith('project-sync-'))return false;
    if(state.jobs.some(j=>j.taskId===t.id&&['queued','sending','submitted','running','uncertain'].includes(j.status)))return true;
    const last=state.jobs.find(j=>j.id===t.currentJobId&&j.taskId===t.id&&j.projectId===t.projectId);
    // Review is a human decision; a successfully ended run need not block a new sync.
    return t.status!=='done'&&!(t.status==='review'&&last?.status==='completed'&&!last.awaitingUser);
  });
  if(active)return {task:active,duplicate:true};
  if(state.tasks.some(t=>t.projectId===project.projectId&&!t.archivedAt&&t.status!=='done'&&t.createRequestId?.startsWith('github-upload-')))throw Error('本项目已有上传任务，请先完成或处理原任务');
  return createTask(state,{projectId:project.projectId,...projectSyncCommand,tag:'improvement',sectionName:'功能-GitHub交付',execution:{mode:'match',unit:'GitHub交付',parallel:false,threadId:''},requestId:input.requestId},[project]);
}
