import {resolveInstalledVersion} from '../installed-version.mjs';
const [installRoot,dataRoot,...extra]=process.argv.slice(2);
if(!installRoot||!dataRoot||extra.length)throw Error('需要安装目录和数据目录');
console.log(JSON.stringify(await resolveInstalledVersion({installRoot,dataRoot})));
