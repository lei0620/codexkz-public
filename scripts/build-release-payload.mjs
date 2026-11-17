import fs from 'node:fs';
import path from 'node:path';
import {createHash,createPublicKey} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {compareReleaseVersions} from '../release-manifest.mjs';
import {auditReleaseFiles,releaseCandidateFiles} from './audit-release-payload.mjs';
import {installedProgramInventory,verifyInstalledProgram} from '../installed-integrity.mjs';

const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function ordinaryFile(file){
  if(!path.isAbsolute(file)||/^(?:e:|\\\\)/i.test(file))throw Error('运行时文件必须来自获准的本机绝对路径');
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||fs.realpathSync.native(file)!==file)throw Error('运行时文件无效或被重定向');
  return stat.size;
}
function inventory(root){
  if(!path.isAbsolute(root)||/^(?:e:|\\\\)/i.test(root))throw Error('运行时目录必须是获准的本机绝对路径');
  if(!fs.lstatSync(root).isDirectory()||fs.realpathSync.native(root)!==root)throw Error('运行时目录无效或被重定向');
  const files=[];let total=0;
  function walk(dir){
    for(const item of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,item.name),relative=path.relative(root,file).replaceAll('\\','/');
      if(item.isSymbolicLink())throw Error('运行时包含链接');
      if(item.isDirectory())walk(file);
      else if(item.isFile()){total+=ordinaryFile(file);files.push(relative);}
      else throw Error('运行时包含非常规文件');
      if(files.length>10000||total>1024*1024*1024)throw Error('运行时文件数量或大小超限');
    }
  }
  walk(root);return files.sort();
}
function checkedHash(file,expected){
  ordinaryFile(file);
  if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)||sha(file)!==expected)throw Error('运行时摘要不匹配');
}
function requireWindowsX64(file){
  const fd=fs.openSync(file,'r'),header=Buffer.alloc(4096);let size;
  try{size=fs.readSync(fd,header,0,header.length,0);}finally{fs.closeSync(fd);}
  const offset=size>=64?header.readUInt32LE(0x3c):0;
  if(size<64||header.toString('ascii',0,2)!=='MZ'||offset<64||offset+6>size||header.readUInt32LE(offset)!==0x4550||header.readUInt16LE(offset+4)!==0x8664)throw Error('运行时不是 Windows x64 可执行文件');
}
function copyChecked(from,to,expected){
  checkedHash(from,expected);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);
  if(sha(to)!==expected||sha(from)!==expected)throw Error('复制期间文件发生变化');
}
function replaceOnce(source,oldValue,newValue){
  const first=source.indexOf(oldValue);if(first<0||source.indexOf(oldValue,first+oldValue.length)>=0)throw Error('插件版本声明异常，不能自动打包');
  return source.slice(0,first)+newValue+source.slice(first+oldValue.length);
}
function versionedHost(source,oldVersion,version){
  source=replaceOnce(source,`<small>${oldVersion}</small>`,`<small>${version}</small>`);
  return replaceOnce(source,`version:'${oldVersion}'`,`version:'${version}'`);
}
function versionedPluginHtml(html,oldVersion,version){
  const matches=[...html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)];
  if(matches.length!==1)throw Error('插件页面模块清单无效');
  const map=JSON.parse(matches[0][1]),key='@leix-ui/plugin-host.js',url=map?.imports?.[key],prefix='data:text/javascript;base64,';
  if(typeof url!=='string'||!url.startsWith(prefix))throw Error('插件页面入口无效');
  const host=versionedHost(Buffer.from(url.slice(prefix.length),'base64').toString('utf8'),oldVersion,version);
  map.imports[key]=prefix+Buffer.from(host).toString('base64');
  return replaceOnce(html,matches[0][1],JSON.stringify(map).replaceAll('<','\\u003c'));
}

// Build only from an explicit source allowlist and caller-supplied, independently
// verified runtime digests. This does not attest vendor provenance, create an
// installer, sign a release, or publish anything.
export function buildReleasePayload({source,destination,version,publicKey,nodeBinary,nodeLicense,powershellRoot,runtimeHashes}){
  if(!path.isAbsolute(source??'')||!path.isAbsolute(destination??'')||/^(?:e:|\\\\)/i.test(source)||/^(?:e:|\\\\)/i.test(destination))throw Error('程序和输出位置必须是获准的本机绝对路径');
  source=fs.realpathSync.native(source);destination=path.resolve(destination);
  if(/^(?:e:|\\\\)/i.test(source))throw Error('源码位置被重定向到未授权的磁盘或网络位置');
  const relative=path.relative(source,destination),reverse=path.relative(destination,source);
  if(!relative||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)||!reverse||!reverse.startsWith('..'+path.sep)&&reverse!=='..'&&!path.isAbsolute(reverse))throw Error('输出目录必须与源码目录独立');
  if(fs.existsSync(destination))throw Error('输出目录已存在，未覆盖');
  const parent=path.dirname(destination);if(fs.realpathSync.native(parent)!==parent)throw Error('输出父目录被重定向');
  compareReleaseVersions(version,version);
  if(publicKey?.type!=='public'&&(typeof publicKey!=='string'||!publicKey.startsWith('-----BEGIN PUBLIC KEY-----\n')))throw Error('只接受公开的发行公钥');
  const key=publicKey?.type==='public'?publicKey:createPublicKey(publicKey);if(key.asymmetricKeyType!=='ed25519')throw Error('发行公钥必须为 Ed25519');
  const pem=key.export({type:'spki',format:'pem'}).toString();
  const candidate=releaseCandidateFiles(source),issues=auditReleaseFiles(source,candidate);
  if(issues.length)throw Error('发行候选文件未通过隐私规则检查');
  const runtimeFiles=inventory(powershellRoot),hashes=runtimeHashes?.powershell;
  const runtimeRelative=path.relative(powershellRoot,destination),runtimeReverse=path.relative(destination,powershellRoot);
  if(!runtimeRelative||!runtimeRelative.startsWith('..'+path.sep)&&runtimeRelative!=='..'&&!path.isAbsolute(runtimeRelative)||!runtimeReverse||!runtimeReverse.startsWith('..'+path.sep)&&runtimeReverse!=='..'&&!path.isAbsolute(runtimeReverse))throw Error('输出目录必须与运行时目录独立');
  if(!hashes||Array.isArray(hashes)||typeof hashes!=='object'||JSON.stringify(Object.keys(hashes).sort())!==JSON.stringify(runtimeFiles)||!runtimeFiles.includes('pwsh.exe'))throw Error('PowerShell 文件清单不完整');
  checkedHash(nodeBinary,runtimeHashes?.node);checkedHash(nodeLicense,runtimeHashes?.nodeLicense);
  for(const file of runtimeFiles)checkedHash(path.join(powershellRoot,...file.split('/')),hashes[file]);
  requireWindowsX64(nodeBinary);requireWindowsX64(path.join(powershellRoot,'pwsh.exe'));
  const pluginConfig=JSON.parse(fs.readFileSync(path.join(source,'plugins','leix-panel-probe','mcp.json'),'utf8'));
  if(pluginConfig?.mcpServers?.leix_panel_thread?.command!=='node'||Object.keys(pluginConfig.mcpServers).length!==1)throw Error('插件运行时声明发生变化，不能自动打包');
  const pluginManifest=JSON.parse(fs.readFileSync(path.join(source,'plugins','leix-panel-probe','plugin.json'),'utf8'));
  const oldPluginVersion=pluginManifest.version;compareReleaseVersions(oldPluginVersion,oldPluginVersion);
  const pluginServer=replaceOnce(fs.readFileSync(path.join(source,'plugins','leix-panel-probe','server.mjs'),'utf8'),`version='${oldPluginVersion}'`,`version='${version}'`);
  const pluginHost=versionedHost(fs.readFileSync(path.join(source,'public','plugin-host.js'),'utf8'),oldPluginVersion,version);
  const pluginHtml=versionedPluginHtml(fs.readFileSync(path.join(source,'plugins','leix-panel-probe','ui','thread.html'),'utf8'),oldPluginVersion,version);
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination,'.payload-incomplete'),'incomplete',{flag:'wx'});
  const program=path.join(destination,'program');fs.mkdirSync(program);
  const pluginFile=path.join('plugins','leix-panel-probe','mcp.json'),manifestFile=path.join('plugins','leix-panel-probe','plugin.json'),serverFile=path.join('plugins','leix-panel-probe','server.mjs'),htmlFile=path.join('plugins','leix-panel-probe','ui','thread.html'),hostFile=path.join('public','plugin-host.js');
  const transformed=new Set([pluginFile,manifestFile,serverFile,htmlFile,hostFile]);
  for(const file of candidate){
    if(transformed.has(file))continue;
    const from=path.join(source,file),to=path.join(program,file),hash=sha(from);copyChecked(from,to,hash);
  }
  for(const file of transformed)fs.mkdirSync(path.dirname(path.join(program,file)),{recursive:true});
  pluginConfig.mcpServers.leix_panel_thread.command='./runtime/node.exe';
  fs.writeFileSync(path.join(program,pluginFile),JSON.stringify(pluginConfig,null,2)+'\n',{flag:'wx'});
  pluginManifest.version=version;
  fs.writeFileSync(path.join(program,manifestFile),JSON.stringify(pluginManifest,null,2)+'\n',{flag:'wx'});
  fs.writeFileSync(path.join(program,serverFile),pluginServer,{flag:'wx'});
  fs.writeFileSync(path.join(program,hostFile),pluginHost,{flag:'wx'});
  fs.writeFileSync(path.join(program,htmlFile),pluginHtml,{flag:'wx'});
  fs.writeFileSync(path.join(program,'product-release.json'),JSON.stringify({version,publicKey:pem},null,2)+'\n',{flag:'wx'});
  copyChecked(nodeBinary,path.join(destination,'runtime','node','node.exe'),runtimeHashes.node);
  copyChecked(nodeLicense,path.join(destination,'runtime','node','LICENSE'),runtimeHashes.nodeLicense);
  copyChecked(nodeBinary,path.join(program,'plugins','leix-panel-probe','runtime','node.exe'),runtimeHashes.node);
  for(const file of runtimeFiles)copyChecked(path.join(powershellRoot,...file.split('/')),path.join(destination,'runtime','powershell',...file.split('/')),hashes[file]);
  if(auditReleaseFiles(program,candidate).length)throw Error('打包后的候选文件未通过隐私规则检查');
  fs.writeFileSync(path.join(program,'program-inventory.json'),JSON.stringify({version:1,productVersion:version,files:installedProgramInventory(program)},null,2)+'\n',{flag:'wx'});
  verifyInstalledProgram(program);
  fs.unlinkSync(path.join(destination,'.payload-incomplete'));
  fs.writeFileSync(path.join(destination,'.payload-ready'),JSON.stringify({version,files:candidate.length,runtimeFiles:runtimeFiles.length})+'\n',{flag:'wx'});
  return {destination,version,sourceFiles:candidate.length,runtimeFiles:runtimeFiles.length};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [configFile,...extra]=process.argv.slice(2);
  if(!configFile||extra.length)throw Error('用法：node scripts/build-release-payload.mjs 构建配置.json');
  ordinaryFile(configFile);
  const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
  ordinaryFile(config.publicKeyFile);
  config.publicKey=fs.readFileSync(config.publicKeyFile,'utf8');delete config.publicKeyFile;
  console.log(JSON.stringify(buildReleasePayload(config)));
}
