import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function checkSqliteRuntime(version=process.versions.node){
  const [major,minor]=version.split('.').map(Number);
  if(!Number.isInteger(major)||major<24||major===24&&minor<12)throw Object.assign(Error('SQLite写入适配器需要Node24.12或更高版本'),{code:'UNSUPPORTED_RUNTIME'});
}
export function isolatedSqliteRoot(root){
  const project=path.dirname(fileURLToPath(import.meta.url)),base=fs.realpathSync.native(path.join(project,'.panel-test'));
  const real=fs.realpathSync.native(root),relative=path.relative(base,real);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('R41只允许项目.panel-test中的隔离目录');
  const marker=path.join(real,'.r41-synthetic');
  if(fs.lstatSync(marker).isSymbolicLink()||fs.readFileSync(marker,'utf8')!=='sqlite-isolated-v1')throw Error('缺少R41隔离目录标记');
  const data=path.join(real,'data');fs.mkdirSync(data,{recursive:true});
  if(fs.realpathSync.native(data)!==data)throw Error('隔离data目录不能重定向');
  for(const name of ['panel.sqlite','panel.sqlite-journal','panel.sqlite-wal','panel.sqlite-shm']){
    const file=path.join(data,name);if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('SQLite文件不能重定向');
  }
  return real;
}
