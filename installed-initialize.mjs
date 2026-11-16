import fs from 'node:fs';
import path from 'node:path';
import {safeLocalPath} from './maintenance-policy.mjs';
import {separateRoots,writeFresh} from './migration-files.mjs';
import {validateBackupRoot} from './backup-roots.mjs';

// A fresh installation is deliberately distinct from migration: it never
// adopts an existing directory, even if that directory currently appears empty.
export function initializeInstalledData({programRoot,destination,backupRoot}){
  if(!path.isAbsolute(programRoot??'')||!path.isAbsolute(destination??''))throw Error('程序和数据目录必须是本机绝对路径');
  programRoot=safeLocalPath(programRoot,{directory:true});
  destination=safeLocalPath(destination,{missing:true,directory:true});
  separateRoots(programRoot,destination);
  const parent=safeLocalPath(path.dirname(destination),{directory:true});
  if(path.join(parent,path.basename(destination))!==destination)throw Error('数据目录无效');
  if(fs.existsSync(destination))throw Error('数据目录已存在，未覆盖或接管');
  const backup=validateBackupRoot(destination,backupRoot);
  fs.mkdirSync(destination); // Non-recursive and exclusive; concurrent attempts cannot share it.
  writeFresh(path.join(destination,'.migration-incomplete'),'数据初始化尚未完成\n');
  fs.mkdirSync(path.join(destination,'data'));
  writeFresh(path.join(destination,'data','backup-paths.json'),JSON.stringify({version:1,backupRoot:backup},null,2)+'\n');
  fs.unlinkSync(path.join(destination,'.migration-incomplete'));
  writeFresh(path.join(destination,'.installed-data-ready'),'codexkz-installed-data-v1\n');
  return {destination,backupRoot:backup};
}
