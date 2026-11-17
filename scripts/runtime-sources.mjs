import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Only the running service's module graph requires a restart. Independent
// maintenance CLIs are loaded when invoked; their timestamps are not evidence
// that a healthy server is stale. Worker entry URLs are included too.
export function runtimeSources(root,{entries=['server.mjs','panel-runner.mjs']}={}){
  root=path.resolve(root);const seen=new Set();
  function visit(file){
    const relative=path.relative(root,file);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('运行模块超出项目目录');
    if(seen.has(file))return;seen.add(file);
    const source=fs.readFileSync(file,'utf8');
    for(const match of source.matchAll(/['"](\.{1,2}\/[^'"\r\n]+\.(?:mjs|js|ps1))['"]/g))visit(path.resolve(path.dirname(file),match[1]));
  }
  for(const entry of entries)visit(path.resolve(root,entry));
  return {files:[...seen].map(file=>path.relative(root,file)).sort(),latestModifiedAt:new Date(Math.max(...[...seen].map(file=>fs.statSync(file).mtimeMs))).toISOString()};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(runtimeSources(process.argv[2]??process.cwd())));
