import {configureInstalledBackup} from '../installed-backup-config.mjs';
const [root,backupRoot,...extra]=process.argv.slice(2);
if(!root||!backupRoot||extra.length)throw Error('用法：node scripts/configure-installed-backup.mjs 数据目录 备份目录');
const result=configureInstalledBackup({root,backupRoot});
console.log(result.changed?'本机备份位置已配置。':'本机备份位置保持不变。');
