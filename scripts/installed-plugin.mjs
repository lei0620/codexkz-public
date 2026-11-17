import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectActiveVersion} from '../release-activation.mjs';
import {installedReleaseConfig} from '../release-config.mjs';
import {safeLocalPath} from '../maintenance-policy.mjs';
import {verifyInstalledProgram} from '../installed-integrity.mjs';

const script=fileURLToPath(import.meta.url);
const initialProgram=path.dirname(path.dirname(script));
const installRoot=path.dirname(initialProgram);

// Codex caches the packaged executable. It accepts a contained executable
// path and an absolute argument pointing to the stable installed bootstrap.
function createMarketplace(port){
  verifyInstalledProgram(initialProgram);
  const marketplace=path.join(installRoot,'codex-plugin');
  const name='paiban-board',plugin=path.join(marketplace,'plugins',name);
  const initialManifest=JSON.parse(fs.readFileSync(path.join(initialProgram,'plugins','leix-panel-probe','plugin.json'),'utf8'));
  const node=safeLocalPath(path.join(initialProgram,'plugins','leix-panel-probe','runtime','node.exe'));
  const license=safeLocalPath(path.join(installRoot,'runtime','node','LICENSE'));
  if(!fs.statSync(node).isFile())throw Error('安装运行时不可用');
  fs.mkdirSync(marketplace);
  fs.mkdirSync(path.join(marketplace,'.agents','plugins'),{recursive:true});
  fs.mkdirSync(path.join(plugin,'runtime'),{recursive:true});
  fs.copyFileSync(node,path.join(plugin,'runtime','node.exe'),fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(license,path.join(plugin,'runtime','LICENSE'),fs.constants.COPYFILE_EXCL);
  const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  initialManifest.name=name;
  initialManifest.extensions['com.openai'].interface.displayName='派板 · 本聊天白板';
  write(path.join(plugin,'plugin.json'),initialManifest);
  write(path.join(plugin,'mcp.json'),{
    $schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers:{paiban_panel_thread:{type:'stdio',command:'./runtime/node.exe',args:[script,'serve',String(port)]}}
  });
  write(path.join(marketplace,'.agents','plugins','marketplace.json'),{
    name:'paiban-local',interface:{displayName:'派板本机插件'},
    plugins:[{name,source:{source:'local',path:'./plugins/'+name},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]
  });
}

async function serve(port){
  verifyInstalledProgram(initialProgram);
  const active=inspectActiveVersion(installRoot);
  const trusted=installedReleaseConfig(initialProgram);
  const selected=installedReleaseConfig(active.program);
  if(!selected.publicKey.export({type:'spki',format:'der'}).equals(trusted.publicKey.export({type:'spki',format:'der'})))throw Error('插件版本的发行公钥不匹配');
  const origin='http://127.0.0.1:'+port;
  const response=await fetch(origin+'/api/view/status',{redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok||(await response.json()).service?.productVersion!==active.version)throw Error('请先启动已确认版本的派板');
  const plugin=path.join(active.program,'plugins','leix-panel-probe');
  const child=spawn(path.join(plugin,'runtime','node.exe'),[path.join(plugin,'server.mjs'),'--mode=thread'],{windowsHide:true,stdio:'inherit',env:{...process.env,PAIBAN_PLUGIN_PORT:String(port)}});
  await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(Error('派板插件已退出')));
  });
}

const [action,rawPort='4319',...extra]=process.argv.slice(2);
const port=Number(rawPort);
if(extra.length||!/^\d{4,5}$/.test(rawPort)||port<1024||port>65535)throw Error('派板插件端口无效');
if(action==='create')createMarketplace(port);
else if(action==='serve')await serve(port);
else throw Error('需要 create 或 serve 操作');
