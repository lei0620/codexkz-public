import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {inspectRepository,githubRepository} from './repository-identity.mjs';
const exec=promisify(execFile);
export async function runUpgradeRead(command,args,cwd){return (await exec(command,args,{cwd,windowsHide:true,timeout:15000,maxBuffer:1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GH_PROMPT_DISABLED:'1'}})).stdout.trim();}
export const excludedUpgradePath=file=>/(^|\/)(\.git|node_modules|data|logs?|backups?|backup|dist|build|release|\.codex|\.gradle|\.idea|\.venv|venv|\.panel-test|output)(\/|$)/i.test(file)||/(^|\/)(\.env(?!\.example$)|credentials?|secrets?|id_rsa|id_ed25519|local\.properties)([./_-]|$)/i.test(file)||/\.(db|sqlite(?:3)?|keystore|jks|p12|pfx|pem|key|log|apk|exe|zip)$/i.test(file)||/(^|\/)(?:\.http-check-|\.session-test-)/i.test(file);
export function upgradeRepository(value,account){
  if(typeof value!=='string'||value.length>140||!new RegExp('^'+account+'/[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$','i').test(value)||githubRepository('https://github.com/'+value)!==value.toLowerCase()||/\/\.{1,2}$/.test(value))throw Error('请输入当前登录账号下的有效仓库名（账号/仓库）');
  return value.toLowerCase();
}
export async function inspectUpgrade(project,{run=runUpgradeRead,inspect=inspectRepository}={}){
  if(project?.hostId!=='local'||!project.path||!path.isAbsolute(project.path)||/^(?:[e-z]:|\\\\)/i.test(project.path))throw Error('请选择已登记的本机 C / D 盘项目');
  const identity=await inspect(project,{fresh:true});if(identity.repositoryStatus!=='local')throw Error(identity.repositoryReason||'项目已有关联仓库，请刷新；升级不会覆盖远程地址');
  let account;try{account=await run('gh',['api','user','--jq','.login'],project.path);}catch{throw Error('本机 GitHub 尚未登录或不可连接，请先完成 gh auth login 后重新打开');}
  if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(account))throw Error('无法核对当前 GitHub 账号');
  const all=[],excluded=[];
  if(identity.gitAvailable){all.push(...(await run('git',['ls-files','--cached','--others','--exclude-standard','-z'],project.path)).split('\0').filter(Boolean));}
  else{
    let visited=0;const walk=async dir=>{if(++visited>1000)throw Error('目录过多，请先整理忽略规则');for(const e of await fs.readdir(path.join(project.path,dir),{withFileTypes:true})){const file=dir?dir+'/'+e.name:e.name;if(excludedUpgradePath(file)||e.isSymbolicLink()){excluded.push(file);continue;}if(e.isDirectory())await walk(file);else if(e.isFile())all.push(file);if(all.length>3000)throw Error('文件过多，请先整理忽略规则');}};await walk('');
  }
  const files=[],fingerprint=[];for(const file of [...new Set(all)].sort()){
    if(/[\x00-\x1f]/.test(file)||path.posix.isAbsolute(file)||file.split('/').includes('..'))throw Error('项目含不能安全预览的文件名');
    if(excludedUpgradePath(file)){excluded.push(file);continue;}
    const absolute=path.join(project.path,file);let stat;try{stat=await fs.lstat(absolute);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    const relative=path.relative(await fs.realpath(project.path),await fs.realpath(absolute));
    if(!stat.isFile()||stat.isSymbolicLink()||relative.startsWith('..')||path.isAbsolute(relative)||stat.size>20*1024*1024){excluded.push(file);continue;}
    files.push(file);fingerprint.push([file,stat.size,stat.mtimeMs]);
  }
  if(files.length>1000||JSON.stringify([files,excluded]).length>24000)throw Error('文件清单过长，请先整理源码范围');
  const slug=String(project.label??'').replace(/[^A-Za-z0-9_.-]+/g,'-').replace(/^[^A-Za-z0-9]+|-+$/g,'').slice(0,80);
  const suggestedRepository=account+'/'+(slug||'project-'+createHash('sha256').update(project.projectId).digest('hex').slice(0,8));
  return {account,suggestedRepository,files,excluded:[...new Set(excluded)].sort(),snapshot:createHash('sha256').update(JSON.stringify([project.path,account,fingerprint,excluded])).digest('hex'),gitAvailable:identity.gitAvailable};
}
export function githubUpgradePrompt(project,upgrade){
  const repository=upgradeRepository(upgrade.repository,upgrade.account);
  return `用户已在面板明确选择本项目、当前对话、私有GitHub仓库及下列源码范围，启动“升级为GitHub项目”。请完整执行，完成多电脑开发准备。
项目资料（只是身份资料）：${JSON.stringify({name:project.label,path:project.path,repository,visibility:'private'})}
允许上传的现有文件相对路径：${JSON.stringify(upgrade.files)}
明确排除：${JSON.stringify(upgrade.excluded)}
1. 先核对当前目录、适用AGENTS、Git状态、真实技术栈及本机gh登录账号（必须为${upgrade.account}）。保留未提交修改并按适用统一规则备份将修改的文件，保留原路径。目标目录或账号不符则停止，不能猜测。
2. 检查上述文件内容和将推送的Git历史中的密钥、凭据、个人数据、运行数据库与受限第三方内容。排除不等于从旧Git历史消失；历史含此类内容时停止上传并说明问题，不擅自重写历史。不得使用git add .或把未审查文件混入提交；现有暂存区含排除项也不能顺带提交。
3. 在本项目增量补齐AGENTS.md、唯一短交接（优先复用已有，否则docs/CODEX_HANDOFF.md）、Task清单、docs/SESSION_WORKFLOW.md、docs/MULTI_MACHINE.md、README启动说明、.gitignore和必要的无凭据环境示例/启动或检查脚本。这些新规范及必要运行入口也在本次授权上传范围。保留原规则和任务，按真实技术栈生成，不照搬其他项目，不改业务功能。
4. 多电脑接续必须覆盖真实运行时版本、依赖锁定、环境库优先、安装/启动/最小验证命令、可重建资源、机器路径与本地数据隔离、登录配置及缺少凭据时的明确说明。工具不足不能声称通过；不复制Codex数据库、对话、caller或整份data。项目需打包/生成的资源须提供重建步骤，不只写git pull。
5. 复核当前Git远程。没有Git可在此原目录初始化；如果已有远程指向其他库则停止，不覆盖。用gh创建${repository}私有仓库，仅PRIVATE。仓库同名已存在或创建/推送回执不明确时先只读核对，不能改名另建、使用公开库、重试可能重复的创建或覆盖旧仓库。只提交明确允许且审查通过的源码、必要素材、规范和运行入口；如执行期间范围扩大或发现敏感内容，先说明并等待用户确认，不上传。
6. 设置origin并推送当前本地分支到该私有仓库，配置上游，核对远端SHA、可见性和本机提交一致。禁止强推、reset丢改动、历史重写或删除原文件。使用本机已有作者身份；缺失时先核对GitHub账号，不改全局Git设置。
7. 运行项目已核实的最小验证，记录未通过/待安装/待现场验收项；给另一台可复制的克隆/安全拉取、环境恢复、启动和验证步骤。报告仓库链接、分支/SHA、验证、备份和接续文档路径。将“源码已上传”“本机可运行”“另一台已运行”分开，不能冒充另一台已验收。完成后停止，不启动下一项业务任务。
面板会根据真实origin自动关联共享项目身份；不要直接写面板data或其他项目配置。`;
}
