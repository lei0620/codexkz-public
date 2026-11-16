import {busy,normalize} from './core.mjs';
import {contextWriteAllowed} from './desktop-context.mjs';
import {readDesktopThread} from './local-session.mjs';
import {runWindowsComposer} from './composer.mjs';

const localPath=value=>normalize(typeof value==='string'?value:'').replace(/^\\\\\?\\/,'');
const statusOf=value=>value?.type??value;
const probeTimeout=6500;
const sendDetails={
  available:'已识别支持提交的按钮。',
  empty:'输入框为空，发送按钮尚未出现。',
  whitespace:'输入框仅有空白，待发送按钮出现后复查。',
  running:'当前对话正在运行，待发送或排队按钮可用后复查。',
  disabled:'已识别发送按钮，当前暂不可用。',
  unsupported:'已识别发送按钮，但无法确认它支持提交操作。',
  missing:'当前输入区有内容，未找到发送或排队按钮。',
  scope:'无法唯一核对发送按钮所在的聊天输入区。'
};

export async function checkDesktop({pageUrl,inspect,findProject,findThread,bridge,sessionReader,probe=runWindowsComposer}){
  const page=new URL(pageUrl),context=await inspect(pageUrl);
  const rows=[];
  const add=(id,label,status,detail)=>rows.push({id,label,status,detail});
  const isCurrent=contextWriteAllowed(context,pageUrl,{required:true});
  let project;
  try{
    const value=await bridge.call('list_projects',{}, {timeoutMs:probeTimeout});
    if(!Array.isArray(value.projects))throw Error();
    const expected=findProject(page.searchParams.get('projectId'));
    if(expected?.path&&value.projects.filter(row=>row.hostId==='local'&&localPath(row.path)===localPath(expected.path)).length===1)project=expected;
    add('connection','连接与项目目录',project?'pass':'pending',project?'本机目录可读，项目路径已核对。':'本机目录可读，当前项目路径待核对。');
  }catch{add('connection','连接与项目目录','fail','桌面项目目录读取失败。');}
  const confirmed=isCurrent&&context.kind==='thread';
  const scoped=confirmed&&project?findThread(context.threadId):null;
  const thread=scoped?.kind==='codex'&&scoped.hostId==='local'&&localPath(scoped.cwd)===localPath(project.path)?scoped:null;
  const followStatus=isCurrent?(context.ownerObserved?'pass':'pending'):context.status==='unresolved'?'fail':'pending';
  add('follow','项目跟随',followStatus,followStatus==='pass'?'桌面选中项目与当前白板一致。':followStatus==='fail'?'未能确认当前对话归属，请核对 Codex 中的项目选中行。':'请在 Codex 打开项目对话及右侧白板，核对选中项目。');

  if(thread){
    const limitedBridge={call:(name,args)=>bridge.call(name,args,{timeoutMs:probeTimeout})};
    const [recent,controls]=await Promise.allSettled([
      readDesktopThread(limitedBridge,{threadId:thread.id,hostId:'local',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:0},sessionReader),
      probe({origin:page.origin,projectId:project.projectId,threadId:thread.id,threadTitle:thread.title,inspectControls:true},{probe:true,timeoutMs:probeTimeout})
    ]);
    const value=recent.value;
    const identity=value?.thread?.id===thread.id&&value.thread.hostId==='local'&&value.thread.kind==='codex'&&localPath(value.thread.cwd)===localPath(project.path);
    const knownStatus=identity&&(busy(value.thread.status)||['idle','notLoaded'].includes(statusOf(value.thread.status)));
    const readable=identity&&Array.isArray(value.turns)&&value.turns.every(turn=>turn?.id&&(busy(turn.status)||['completed','interrupted','failed','cancelled'].includes(statusOf(turn.status))));
    const recentStatus=recent.reason?.code==='THREAD_READ_TOO_LARGE'?'pending':!readable||!knownStatus?'fail':value.turns.length?'pass':'pending';
    add('recent','对话状态与最近一轮',recentStatus,recentStatus==='pass'?'已读回当前对话状态及最近一轮标识。':recent.reason?.code==='THREAD_READ_TOO_LARGE'?'此对话超过安全读取上限，请用较短的对话检查。':recentStatus==='pending'?'当前对话暂无可核对的轮次。':'桌面未返回可核对的对话状态或轮次。');
    const found=controls.value?.status==='ready'?controls.value.controls:null;
    add('editor','主输入框',found?.editor==='pass'?'pass':'fail',found?.editor==='pass'?'可识别并读取主输入框。':'无法可靠读取主输入框。');
    add('attachment','附件入口',found?.attachment==='pass'?'pass':'fail',found?.attachment==='pass'?'已识别附件入口及支持的操作。':'无法确认附件入口可用。');
    const sendStatus=found?.send==='pass'?'pass':found?.send==='pending'?'pending':'fail';
    const sendDetail=Object.hasOwn(sendDetails,found?.sendReason)?sendDetails[found.sendReason]:'无法确认发送按钮可用。';
    add('send','发送按钮',sendStatus,sendDetail);
  }else{
    for(const [id,label] of [['recent','对话状态与最近一轮'],['editor','主输入框'],['attachment','附件入口'],['send','发送按钮']]){
      add(id,label,'pending','请在归属明确的项目对话中检查。');
    }
  }
  add('delivery','发送、回执与结果归卡','pending','需在专用测试对话实际发送一轮后核对。');

  // The user can change conversations during the two reads. A result for the
  // previous conversation cannot be shown for the current one.
  const fresh=await inspect(pageUrl);
  if(fresh.hostVersion!==context.hostVersion||fresh.status!==context.status||fresh.projectId!==context.projectId||fresh.threadId!==context.threadId||fresh.ownerObserved!==context.ownerObserved){
    return {changed:true};
  }
  return {hostVersion:context.hostVersion??'',checkedAt:new Date().toISOString(),rows};
}
