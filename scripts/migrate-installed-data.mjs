import {migrateInstalledData} from '../installed-migration.mjs';

const [source,destination,backup,backupRoot,...extra]=process.argv.slice(2);
if(!source||!destination||!backup||extra.length)throw Error('用法：node scripts/migrate-installed-data.mjs 原项目目录 新数据目录 新备份目录 [本机备份目录]');
const result=await migrateInstalledData({source,destination,backup,...(backupRoot?{backupRoot}:{})});
console.log(`迁移校验通过：${result.files} 个文件；原数据保留。`);
console.log('数据目录：'+result.destination);
console.log('备份目录：'+result.backup);
