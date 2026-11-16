import {backupInstalledData,verifyInstalledBackup} from '../installed-migration.mjs';

const [source,backup,...extra]=process.argv.slice(2);
if(!source||!backup||extra.length)throw Error('用法：node scripts/backup-installed-data.mjs 数据目录 新备份目录');
const result=await backupInstalledData({source,backup});verifyInstalledBackup(backup);
console.log(`离线备份已校验：${result.files} 个文件；源数据未覆盖。`);
