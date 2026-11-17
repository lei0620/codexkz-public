import {RELEASE_REPOSITORY,verifyReleaseManifest,selectReleaseAsset} from './release-manifest.mjs';
import {fetchReleaseResponse} from './release-http.mjs';

export const RELEASE_MANIFEST_URL='https://github.com/'+RELEASE_REPOSITORY+'/releases/latest/download/manifest.json';
const MAX_ENVELOPE=96*1024;

export async function checkRelease({publicKey,version,platform,arch,fetchImpl=fetch,timeoutMs=15000}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetchReleaseResponse(RELEASE_MANIFEST_URL,{fetchImpl,signal:controller.signal,accept:'application/json'});
    if(!response.ok||!response.body)throw Error('检查更新失败：HTTP '+response.status);
    const length=response.headers.get('content-length');
    if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_ENVELOPE))throw Error('更新信息过大');
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>MAX_ENVELOPE)throw Error('更新信息过大');chunks.push(Buffer.from(chunk));}
    let envelope;try{envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw Error('更新信息格式无效');}
    const manifest=verifyReleaseManifest(envelope,publicKey),asset=selectReleaseAsset(manifest,{version,platform,arch});
    return {available:!!asset,version:manifest.version,notes:manifest.notes,asset,envelope};
  }finally{clearTimeout(timer);}
}
