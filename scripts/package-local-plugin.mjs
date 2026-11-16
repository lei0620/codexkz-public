import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {packagePanelUi} from '../plugins/leix-panel-probe/package-ui.mjs';
const directory=new URL('../plugins/leix-panel-probe/ui/',import.meta.url);
await fs.mkdir(directory,{recursive:true});
for(const mode of ['global','thread']){
  const html=await packagePanelUi({mode}),file=new URL(mode+'.html',directory);
  if(await fs.readFile(file,'utf8').catch(()=>null)!==html)await fs.writeFile(file,html);
}
console.log('本机插件界面已打包：'+fileURLToPath(directory));
