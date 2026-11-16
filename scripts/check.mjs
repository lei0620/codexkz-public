import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {packagePanelUi} from '../plugins/leix-panel-probe/package-ui.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
for(const file of ['panel-runner.mjs','server.mjs','plugins/leix-panel-probe/server.mjs']){
  execFileSync(process.execPath,['--check',path.join(root,file)],{stdio:'inherit'});
}
for(const file of ['README.md','README.en.md','LICENSE.md']){
  const content=fs.readFileSync(path.join(root,file),'utf8');
  const links=[...content.matchAll(/\]\(([^)]+)\)|\bsrc="([^"]+)"/g)];
  for(const link of links){
    const target=(link[1]??link[2]).split('#')[0];
    if(!target||/^https?:\/\//.test(target))continue;
    if(!fs.existsSync(path.resolve(root,target)))throw Error(file+' references a missing file: '+target);
  }
}
await packagePanelUi();
console.log('Source entry points, local documentation links, and plugin bundle passed.');
