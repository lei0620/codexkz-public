import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalize} from './core.mjs';
import {readDesktopThread} from './local-session.mjs';

export function panelTarget(state,root,origin){
  const project=state.projects?.find(p=>p.path&&normalize(p.path)===normalize(root));
  if(!project)throw Error('当前项目尚未被 Codex 发现，可先在独立面板中选择项目。');
  if(!state.caller)throw Error('尚未保存本机调度任务，请先在面板连接设置中绑定。');
  const url=new URL('/',origin);
  url.searchParams.set('projectId',project.projectId);
  url.searchParams.set('threadId',state.caller);
  url.searchParams.set('view','project');
  return {project,threadId:state.caller,url:url.href};
}

export async function openProjectPanel({state,root,origin,bridge,sessionReader}){
  const target=panelTarget(state,root,origin);
  return openProjectSidebar({project:target.project,threadId:target.threadId,origin,bridge,sessionReader,view:new URL(target.url).searchParams.get('view')});
}

export async function openProjectSidebar({project,threadId,origin,bridge,sessionReader,view='project',attach,recreate=false}){
  if(!project?.path||(project.hostId&&project.hostId!=='local')||typeof threadId!=='string'||!/^[-a-zA-Z0-9]{1,100}$/.test(threadId))throw Error('请选择本机项目和已有对话');
  const response=await readDesktopThread(bridge,{threadId,turnLimit:1,maxOutputCharsPerItem:0},sessionReader);
  const thread=response?.thread;
  if(!thread||thread.id!==threadId||thread.kind!=='codex'||thread.hostId!=='local'||normalize(thread.cwd)!==normalize(project.path))throw Error('所选对话不属于本机当前项目，请重新选择。');
  const url=new URL('/',origin);url.searchParams.set('projectId',project.projectId);url.searchParams.set('threadId',threadId);url.searchParams.set('view',view==='control'?'control':'project');
  // Queue the panel before navigation, so activating a hidden task reveals it.
  const mounted=attach?await attach({key:JSON.stringify([project.projectId,threadId]),projectId:project.projectId,threadId,url:url.href},{recreate}):null;
  const receipt=mounted?{status:mounted.status==='attached'?'opened':mounted.status}:await bridge.call('open_in_codex',{threadId,target:{type:'browser',url:url.href},placement:'right'});
  if(!['opened','queued'].includes(receipt?.status))throw Error('Codex 未确认打开侧栏，已停止重试。');
  await bridge.call('navigate_to_codex_page',{threadId});
  return {status:receipt.status,url:mounted?.url??url.href,reused:!!mounted?.reused};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const port=Number(process.argv[2]??4319);
    if(!Number.isInteger(port)||port<1024||port>65535)throw Error('面板端口无效');
    const origin=`http://127.0.0.1:${port}`,root=path.dirname(fileURLToPath(import.meta.url));
    const response=await fetch(origin+'/api/state',{signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error('面板服务尚未就绪');
    const state=await response.json(),target=panelTarget(state,root,origin);
    const opened=await fetch(origin+'/api/boards/open',{method:'POST',headers:{'Content-Type':'application/json','X-Panel-Token':state.token},body:JSON.stringify({projectId:target.project.projectId,threadId:target.threadId})});
    const result=await opened.json();if(!opened.ok)throw Error(result.error||'侧栏打开失败');
    console.log(JSON.stringify(result));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
