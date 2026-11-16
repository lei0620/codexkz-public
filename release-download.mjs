import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {selectReleaseAsset,verifyReleaseManifest} from './release-manifest.mjs';
import {fetchReleaseResponse} from './release-http.mjs';

// Never accept an unsigned URL or an existing destination. The caller owns the
// private staging directory and may clean up its own incomplete files later.
export async function downloadReleaseAsset({envelope,publicKey,version,platform,arch,destination,fetchImpl=fetch,timeoutMs=120000}){
  const manifest=verifyReleaseManifest(envelope,publicKey);
  const asset=selectReleaseAsset(manifest,{version,platform,arch});
  if(!asset)throw Error('没有适用于当前系统的新版本');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  let handle;
  try{
    const response=await fetchReleaseResponse(asset.url,{fetchImpl,signal:controller.signal});
    if(!response.ok||!response.body)throw Error('下载失败：HTTP '+response.status);
    const length=response.headers.get('content-length');
    if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==asset.size))throw Error('下载文件大小不符');
    handle=await open(destination,'wx',0o600);
    const hash=createHash('sha256');let size=0;
    for await(const chunk of response.body){
      size+=chunk.length;if(size>asset.size)throw Error('下载文件大小不符');hash.update(chunk);
      let offset=0;while(offset<chunk.length){const {bytesWritten}=await handle.write(chunk,offset,chunk.length-offset);if(!bytesWritten)throw Error('下载文件写入失败');offset+=bytesWritten;}
    }
    if(size!==asset.size||hash.digest('hex')!==asset.sha256)throw Error('下载文件大小或摘要不符');
    await handle.sync();
    return {version:manifest.version,notes:manifest.notes,asset};
  }finally{clearTimeout(timer);await handle?.close();}
}
