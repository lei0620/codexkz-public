import fs from 'node:fs';
import path from 'node:path';
import {downloadReleaseAsset} from './release-download.mjs';
import {selectReleaseAsset,verifyReleaseFile,verifyReleaseManifest} from './release-manifest.mjs';

function stageParent(root,{create=false}={}){
  const directory=path.join(root,'updates');
  if(fs.existsSync(directory)){const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('更新暂存目录不可用');}
  else if(create)fs.mkdirSync(directory);else throw Error('没有可用的更新暂存目录');
  if(fs.realpathSync.native(directory)!==directory)throw Error('更新暂存目录已重定向');
  return directory;
}

// Only a complete and verified download receives a ready marker. Failed or
// interrupted staging is retained, never used or silently retried.
export async function stageRelease({root,envelope,publicKey,version,platform,arch,fetchImpl,timeoutMs}){
  const manifest=verifyReleaseManifest(envelope,publicKey);
  if(!selectReleaseAsset(manifest,{version,platform,arch}))throw Error('没有适用于当前系统的新版本');
  const directory=fs.mkdtempSync(path.join(stageParent(root,{create:true}),'stage-'));
  const asset=path.join(directory,'asset');
  const result=await downloadReleaseAsset({envelope,publicKey,version,platform,arch,destination:asset,...(fetchImpl?{fetchImpl}:{}),...(timeoutMs?{timeoutMs}:{})});
  const ready=path.join(directory,'ready.json'),fd=fs.openSync(ready,'wx');
  try{fs.writeFileSync(fd,JSON.stringify({version:1,envelope}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return {stageId:path.basename(directory),version:result.version,notes:result.notes};
}

export async function verifyStagedRelease({root,stageId,publicKey,version,platform,arch}){
  if(typeof stageId!=='string'||!/^stage-[a-zA-Z0-9]{6}$/.test(stageId))throw Error('更新暂存标识无效');
  const directory=path.join(stageParent(root),stageId),stat=fs.lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync.native(directory)!==directory)throw Error('更新暂存目录无效');
  const ready=path.join(directory,'ready.json'),assetFile=path.join(directory,'asset');
  for(const file of [ready,assetFile]){const item=fs.lstatSync(file);if(!item.isFile()||item.isSymbolicLink())throw Error('更新暂存文件无效');}
  if(fs.statSync(ready).size>96*1024)throw Error('更新暂存记录过大');
  const record=JSON.parse(fs.readFileSync(ready,'utf8'));
  if(!record||Object.keys(record).sort().join(',')!=='envelope,version'||record.version!==1)throw Error('更新暂存记录无效');
  const manifest=verifyReleaseManifest(record.envelope,publicKey),asset=selectReleaseAsset(manifest,{version,platform,arch});
  if(!asset)throw Error('暂存版本不适用于当前系统');
  await verifyReleaseFile(assetFile,asset);
  return {assetFile,version:manifest.version,notes:manifest.notes,sha256:asset.sha256};
}
