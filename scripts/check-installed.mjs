import {verifyInstalledProgram} from '../installed-integrity.mjs';
const [root,...extra]=process.argv.slice(2);
if(!root||extra.length)throw Error('需要安装程序目录');
const result=verifyInstalledProgram(root);
console.log(`安装程序检查通过：${result.version}，${result.files} 个文件。`);
