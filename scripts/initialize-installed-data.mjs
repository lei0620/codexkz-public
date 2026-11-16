import {initializeInstalledData} from '../installed-initialize.mjs';

const [programRoot,destination,backupRoot,...extra]=process.argv.slice(2);
if(!programRoot||!destination||!backupRoot||extra.length)throw Error('用法：node scripts/initialize-installed-data.mjs 程序目录 新数据目录 本机备份目录');
const result=initializeInstalledData({programRoot,destination,backupRoot});
console.log('独立数据目录已初始化：'+result.destination);
console.log('本机备份目录：'+result.backupRoot);
