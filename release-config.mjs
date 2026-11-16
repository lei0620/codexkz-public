import fs from 'node:fs';
import path from 'node:path';
import {createPublicKey} from 'node:crypto';
import {compareReleaseVersions} from './release-manifest.mjs';

// The installer supplies this file inside its verified program directory.
export function installedReleaseConfig(programRoot){
  const file=path.join(programRoot,'product-release.json');let stat;
  try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error('发行配置无效');
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='publicKey,version'||typeof value.publicKey!=='string'||!value.publicKey.startsWith('-----BEGIN PUBLIC KEY-----\n'))throw Error('发行配置无效');
  compareReleaseVersions(value.version,value.version);
  const publicKey=createPublicKey(value.publicKey);if(publicKey.asymmetricKeyType!=='ed25519')throw Error('发行公钥无效');
  return {publicKey,version:value.version,platform:process.platform,arch:process.arch};
}
