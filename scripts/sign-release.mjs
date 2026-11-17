import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createPrivateKey} from 'node:crypto';
import {signReleaseManifest,validateReleaseManifest,verifyReleaseFile} from '../release-manifest.mjs';

// The private key is supplied externally and is never copied into an artifact.
const [manifestFile,keyFile,assetDirectory,outputFile,...extra]=process.argv.slice(2);
if(!manifestFile||!keyFile||!assetDirectory||!outputFile||extra.length>1||extra.length===1&&extra[0]!=='--password-stdin')throw Error('用法：node scripts/sign-release.mjs 清单.json 私钥.pem 文件目录 输出.json [--password-stdin]');
const manifest=validateReleaseManifest(JSON.parse(await readFile(manifestFile,'utf8')));
for(const asset of manifest.assets){
  const name=new URL(asset.url).pathname.split('/').at(-1);
  await verifyReleaseFile(path.join(assetDirectory,name),asset);
}
let password;if(extra.length){process.stdin.setEncoding('utf8');password='';for await(const chunk of process.stdin){password+=chunk;if(password.length>1024)throw Error('口令过长');}password=password.replace(/\r?\n$/,'');if(!password)throw Error('签名口令为空');}
const key=createPrivateKey({key:await readFile(keyFile),format:'pem',...(password!==undefined?{passphrase:password}:{})});
const envelope=signReleaseManifest(manifest,key);
await writeFile(outputFile,JSON.stringify(envelope)+'\n',{flag:'wx',mode:0o600});
console.log('签名清单已生成；请先核对发行文件再发布。');
