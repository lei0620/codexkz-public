import {createHash,createPublicKey,sign,verify} from 'node:crypto';
import {createReadStream} from 'node:fs';

// Sign the exact payload bytes; parsing and reserializing JSON is never part of
// signature verification. A verifier must provide its own trusted public key.
const MAX_MANIFEST=64*1024;
export const RELEASE_REPOSITORY='lei0620/paiban';
const fail=message=>{throw Error('发行清单无效：'+message);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const base64=value=>typeof value==='string'&&value.length>0&&value.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(value)&&Buffer.from(value,'base64').toString('base64')===value;

export function compareReleaseVersions(a,b){
  const parse=value=>{
    if(typeof value!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)||value.length>64)fail('版本号必须是稳定版 X.Y.Z');
    return value.split('.').map(BigInt);
  };
  const left=parse(a),right=parse(b);
  for(let i=0;i<3;i++)if(left[i]!==right[i])return left[i]>right[i]?1:-1;
  return 0;
}

export function validateReleaseManifest(manifest){
  if(!exact(manifest,['schemaVersion','version','notes','assets'])||manifest.schemaVersion!==1)fail('格式或协议版本不支持');
  compareReleaseVersions(manifest.version,manifest.version);
  if(typeof manifest.notes!=='string'||manifest.notes.length>8000||!manifest.notes.trim())fail('更新说明无效');
  if(!Array.isArray(manifest.assets)||manifest.assets.length<1||manifest.assets.length>8)fail('平台文件无效');
  const seen=new Set();
  for(const asset of manifest.assets){
    if(!exact(asset,['platform','arch','url','size','sha256'])||!['win32','darwin'].includes(asset.platform)||!['x64','arm64'].includes(asset.arch))fail('平台或架构无效');
    const target=asset.platform+'/'+asset.arch;if(seen.has(target))fail('平台文件重复');seen.add(target);
    if(!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>1024*1024*1024||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/.test(asset.sha256))fail('大小或摘要无效');
    let url;try{url=new URL(asset.url);}catch{fail('下载地址无效');}
    const prefix='/'+RELEASE_REPOSITORY+'/releases/download/v'+manifest.version+'/';
    if(url.protocol!=='https:'||url.hostname!=='github.com'||url.port||url.username||url.password||url.search||url.hash||!url.pathname.startsWith(prefix)||!/^[-a-zA-Z0-9_.]+$/.test(url.pathname.slice(prefix.length)))fail('下载地址不属于指定公开发行版本');
  }
  return manifest;
}

export function signReleaseManifest(manifest,privateKey){
  validateReleaseManifest(manifest);
  const key=createPublicKey(privateKey);if(key.asymmetricKeyType!=='ed25519')fail('仅支持 Ed25519 签名');
  const payload=Buffer.from(JSON.stringify(manifest),'utf8');
  if(payload.length>MAX_MANIFEST)fail('清单过大');
  return {payload:payload.toString('base64'),signature:sign(null,payload,privateKey).toString('base64')};
}

export function verifyReleaseManifest(envelope,publicKey){
  if(!exact(envelope,['payload','signature'])||!base64(envelope.payload)||!base64(envelope.signature)||envelope.payload.length>Math.ceil(MAX_MANIFEST/3)*4)fail('签名封装无效');
  const key=publicKey?.type==='public'?publicKey:createPublicKey(publicKey);if(key.asymmetricKeyType!=='ed25519')fail('仅支持 Ed25519 验证密钥');
  const payload=Buffer.from(envelope.payload,'base64'),signature=Buffer.from(envelope.signature,'base64');
  if(payload.length>MAX_MANIFEST||signature.length!==64||!verify(null,payload,key,signature))fail('签名验证失败');
  let manifest;try{manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(payload));}catch{fail('清单不是有效 UTF-8 JSON');}
  return validateReleaseManifest(manifest);
}

export function selectReleaseAsset(manifest,{version,platform,arch}){
  validateReleaseManifest(manifest);
  if(compareReleaseVersions(manifest.version,version)<=0)return null;
  return manifest.assets.find(asset=>asset.platform===platform&&asset.arch===arch)??null;
}

export async function verifyReleaseFile(file,asset){
  const hash=createHash('sha256');let size=0;
  for await(const chunk of createReadStream(file)){size+=chunk.length;if(size>asset.size)throw Error('下载文件大小不符');hash.update(chunk);}
  if(size!==asset.size||hash.digest('hex')!==asset.sha256)throw Error('下载文件大小或摘要不符');
  return true;
}
