import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyStagedRelease} from './release-staging.mjs';

const run=promisify(execFile),extractScript=fileURLToPath(new URL('./scripts/expand-release.ps1',import.meta.url));

// This only prepares a fresh candidate. It does not stop the service, switch
// versions, accept a new plugin, or claim that the prepared files are running.
export async function prepareStagedRelease({root,stageId,publicKey,version,platform,arch,powershellPath}){
  if(typeof powershellPath!=='string'||!path.isAbsolute(powershellPath))throw Error('需要明确的 PowerShell 运行时路径');
  const runtime=fs.lstatSync(powershellPath);
  if(!runtime.isFile()||runtime.isSymbolicLink()||fs.realpathSync.native(powershellPath)!==powershellPath)throw Error('PowerShell 运行时不可用或已重定向');
  const first=await verifyStagedRelease({root,stageId,publicKey,version,platform,arch});
  const destination=path.join(path.dirname(first.assetFile),'unpacked');
  try{await run(powershellPath,['-NoProfile','-NonInteractive','-File',extractScript,'-ArchivePath',first.assetFile,'-Destination',destination,'-Sha256',first.sha256],{windowsHide:true,timeout:180000,maxBuffer:1024*1024});}
  catch(error){throw Object.assign(Error('更新解包失败，原程序和数据未切换'),{cause:error});}
  const second=await verifyStagedRelease({root,stageId,publicKey,version,platform,arch});
  if(second.sha256!==first.sha256||second.version!==first.version)throw Error('更新清单在准备期间变化，未切换');
  const marker=path.join(destination,'.release-ready'),stat=fs.lstatSync(marker);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==64||fs.readFileSync(marker,'utf8')!==first.sha256)throw Error('更新准备标记无效，未切换');
  return {stageId,version:first.version,notes:first.notes,directory:destination};
}
