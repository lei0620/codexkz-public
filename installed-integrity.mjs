import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseSource} from './json-safe.mjs';
import {installedReleaseConfig} from './release-config.mjs';

const inventoryFile='program-inventory.json';
const hash=file=>{const digest=createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.allocUnsafe(1024*1024);try{for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;digest.update(buffer.subarray(0,n));}}finally{fs.closeSync(fd);}return digest.digest('hex');};

// Detect accidental changes to an installed program. This local inventory is
// not a signature: applying updates still requires the signed release archive.
export function installedProgramInventory(root){
  root=fs.realpathSync.native(root);const files={};let count=0,total=0;
  function walk(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name),relative=path.relative(root,file).replaceAll('\\','/');
      if(relative===inventoryFile)continue;
      if(entry.isSymbolicLink())throw Error('安装目录包含链接');
      if(entry.isDirectory())walk(file);
      else if(entry.isFile()){
        const stat=fs.lstatSync(file);if(fs.realpathSync.native(file)!==file)throw Error('安装文件已重定向');
        count++;total+=stat.size;if(count>10000||total>1024*1024*1024)throw Error('安装文件过多');
        files[relative]={size:stat.size,sha256:hash(file)};
      }else throw Error('安装目录包含非常规文件');
    }
  }
  walk(root);return Object.fromEntries(Object.entries(files).sort(([a],[b])=>a<b?-1:a>b?1:0));
}
export function verifyInstalledProgram(root){
  const release=installedReleaseConfig(root);if(!release)throw Error('发行配置缺失');
  const file=path.join(root,inventoryFile),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw Error('安装文件清单无效');
  const expected=parseSource(fs.readFileSync(file));
  if(!expected||Array.isArray(expected)||expected.version!==1||expected.productVersion!==release.version||!expected.files||Array.isArray(expected.files)||Object.keys(expected).sort().join(',')!=='files,productVersion,version')throw Error('安装文件清单无效');
  if(JSON.stringify(installedProgramInventory(root))!==JSON.stringify(expected.files))throw Error('安装文件已变化或损坏，旧服务保持运行');
  return {version:release.version,files:Object.keys(expected.files).length};
}
