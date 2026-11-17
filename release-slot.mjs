import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {ownsDataLock} from './data-lock.mjs';
import {safeLocalPath} from './maintenance-policy.mjs';
import {installedDataRoot} from './installed-paths.mjs';
import {installedReleaseConfig} from './release-config.mjs';
import {verifyInstalledProgram} from './installed-integrity.mjs';
import {verifyStagedRelease} from './release-staging.mjs';

const run=promisify(execFile),script=fileURLToPath(new URL('./scripts/expand-release.ps1',import.meta.url));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function ordinary(file){
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||fs.realpathSync.native(file)!==file)throw Error('版本运行时无效或被重定向');return file;
}
function executable(file){
  ordinary(file);const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(4096);let size;
  try{size=fs.readSync(fd,buffer,0,buffer.length,0);}finally{fs.closeSync(fd);}
  const offset=size>=64?buffer.readUInt32LE(0x3c):0;
  if(size<64||buffer.toString('ascii',0,2)!=='MZ'||offset<64||offset+6>size||buffer.readUInt32LE(offset)!==0x4550||buffer.readUInt16LE(offset+4)!==0x8664)throw Error('版本运行时不是 Windows x64 程序');
}
function directory(parent,name){
  const dir=path.join(parent,name);try{const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync.native(dir)!==dir)throw Error('版本目录被重定向');}
  catch(error){if(error.code!=='ENOENT')throw error;fs.mkdirSync(dir);}return dir;
}

// Prepares an additional signed version only. The caller must separately own
// the maintenance gate, journal, pointer switch and startup/recovery protocol.
export async function prepareInstalledVersion({installRoot,dataRoot,currentProgram,stageId,lease,powershellPath}){
  for(const value of [installRoot,dataRoot,currentProgram,powershellPath])if(!path.isAbsolute(value??''))throw Error('安装、数据和运行时路径必须是绝对路径');
  installRoot=safeLocalPath(installRoot,{directory:true});dataRoot=installedDataRoot(installRoot,dataRoot);currentProgram=safeLocalPath(currentProgram,{directory:true});
  powershellPath=safeLocalPath(powershellPath);ordinary(powershellPath);
  if(!ownsDataLock(lease,path.join(dataRoot,'data')))throw Error('准备版本需要持有对应的数据锁');
  const relative=path.relative(installRoot,currentProgram).replaceAll('\\','/');
  if(relative!=='program'&&!/^versions\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\/program$/.test(relative))throw Error('当前程序不属于安装目录');
  const current=installedReleaseConfig(currentProgram);if(!current)throw Error('当前发行配置缺失');verifyInstalledProgram(currentProgram);
  const staged=await verifyStagedRelease({root:dataRoot,stageId,publicKey:current.publicKey,version:current.version,platform:process.platform,arch:process.arch});
  if(!ownsDataLock(lease,path.join(dataRoot,'data')))throw Error('数据锁已失效，未准备新版本');
  const versions=directory(installRoot,'versions'),slot=path.join(versions,'v'+staged.version);
  try{await run(powershellPath,['-NoProfile','-NonInteractive','-File',script,'-ArchivePath',staged.assetFile,'-Destination',slot,'-Sha256',staged.sha256],{windowsHide:true,timeout:180000,maxBuffer:1024*1024});}
  catch(error){throw Object.assign(Error('新版本准备失败，当前程序和数据未切换'),{cause:error});}
  if(!ownsDataLock(lease,path.join(dataRoot,'data')))throw Error('数据锁已失效，未切换版本');
  const nextProgram=path.join(slot,'program'),next=installedReleaseConfig(nextProgram);
  if(!next||next.version!==staged.version||!next.publicKey.export({type:'spki',format:'der'}).equals(current.publicKey.export({type:'spki',format:'der'})))throw Error('新版本身份与签名清单不一致，未切换');
  verifyInstalledProgram(nextProgram);
  const plugin=JSON.parse(fs.readFileSync(path.join(nextProgram,'plugins','leix-panel-probe','plugin.json'),'utf8'));
  const pluginServer=fs.readFileSync(path.join(nextProgram,'plugins','leix-panel-probe','server.mjs'),'utf8');
  if(plugin.version!==staged.version||!pluginServer.includes(`version='${staged.version}'`))throw Error('插件版本与发行版本不一致，未切换');
  const node=path.join(slot,'runtime','node','node.exe'),pwsh=path.join(slot,'runtime','powershell','pwsh.exe'),pluginNode=path.join(nextProgram,'plugins','leix-panel-probe','runtime','node.exe');
  executable(node);executable(pwsh);ordinary(pluginNode);if(hash(node)!==hash(pluginNode))throw Error('插件运行时与发行运行时不一致，未切换');
  const ready=ordinary(path.join(slot,'.release-ready'));if(fs.readFileSync(ready,'utf8')!==staged.sha256)throw Error('版本准备标记不符');
  const final=await verifyStagedRelease({root:dataRoot,stageId,publicKey:current.publicKey,version:current.version,platform:process.platform,arch:process.arch});
  if(!ownsDataLock(lease,path.join(dataRoot,'data')))throw Error('数据锁已失效，未切换版本');
  if(final.version!==staged.version||final.sha256!==staged.sha256)throw Error('发行清单在准备期间变化，未切换');
  return {version:staged.version,slot:'v'+staged.version,directory:slot,program:nextProgram};
}
