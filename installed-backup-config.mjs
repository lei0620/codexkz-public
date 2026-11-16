import fs from 'node:fs';
import path from 'node:path';
import {safeLocalPath} from './maintenance-policy.mjs';
import {configureBackupRoot} from './backup-roots.mjs';
import {backupRestartState} from './restart.mjs';

export function configureInstalledBackup({root,backupRoot}){
  if(!path.isAbsolute(root??''))throw Error('数据目录必须是本机绝对路径');
  root=safeLocalPath(root,{directory:true});
  if(fs.existsSync(path.join(root,'.migration-incomplete')))throw Error('数据迁移尚未完成');
  const ready=path.join(root,'.installed-data-ready'),stat=fs.lstatSync(ready);
  if(!stat.isFile()||stat.isSymbolicLink()||fs.readFileSync(ready,'utf8')!=='codexkz-installed-data-v1\n')throw Error('独立数据目录尚未初始化完成');
  safeLocalPath(path.join(root,'data'),{directory:true});
  return configureBackupRoot(root,backupRoot,{backup:(source,target)=>backupRestartState(source,target,'修改备份配置')});
}
