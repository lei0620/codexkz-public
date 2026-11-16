import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const roles=[
  ['instructions','开发规则',/^(?:AGENTS|CONTRIBUTING|DEVELOPMENT)\.md$/i,/^#{1,3}\s+.*(?:开发规则|开发约定|development rules|working agreements)/im],
  ['state','唯一当前状态',/(?:handoff(?!.*archive)|project[-_]status|current[-_]state|交接|当前状态).*\.md$/i,/^#{1,3}\s+.*(?:当前状态|当前交接|current status|current state|handoff)/im],
  ['tasks','任务与验收',/(?:roadmap|tasks|plan|待办|任务).*\.md$/i,/^#{1,3}\s+.*(?:任务|验收|tasks|roadmap|acceptance)/im],
  ['workflow','开发与接续流程',/(?:workflow|development|contributing|流程|开发).*\.md$/i,/^#{1,3}\s+.*(?:开发流程|接续|验证|workflow|validation|development|handoff)/im]
];
const manifests={'package.json':'Node.js','pyproject.toml':'Python','requirements.txt':'Python','Cargo.toml':'Rust','go.mod':'Go','pom.xml':'Java','build.gradle':'JVM','composer.json':'PHP','Gemfile':'Ruby','pubspec.yaml':'Dart/Flutter'};
const priority=n=>/^(AGENTS\.md|README\.md|docs\/CODEX_HANDOFF\.md)$/i.test(n)?0:1;
export async function inspectWorkflow(root){
  const real=await fs.realpath(root),coverage=[],skipped=['结构检查限于所选目录的顶层和 docs 顶层，其他子项目未检查。'],documents=[];
  if(path.relative(path.resolve(root),real)!=='')throw Error('项目根目录实际路径不同，请核对链接目标后再检查');
  const entries=await fs.readdir(real,{withFileTypes:true});
  let names=entries.filter(e=>e.isFile()&&/\.md$/i.test(e.name)&&!/(?:archive|devlog|changelog|history)/i.test(e.name)).map(e=>e.name);
  const docDir=entries.find(e=>e.name==='docs');
  if(docDir?.isSymbolicLink())throw Error('规范目录是链接，请人工核对后再读取');
  if(docDir?.isDirectory())names.push(...(await fs.readdir(path.join(real,'docs'),{withFileTypes:true})).filter(e=>e.isFile()&&/\.md$/i.test(e.name)&&!/(?:archive|devlog|changelog|history)/i.test(e.name)).map(e=>'docs/'+e.name));
  names.sort((a,b)=>priority(a)-priority(b)||a.localeCompare(b));
  if(names.length>32)skipped.push('规范候选超过32份，仅检查优先入口；其余由执行任务按需核对');
  async function read(relative){
    const file=path.join(real,relative);let stat;
    try{stat=await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024){skipped.push(relative+'：不是普通小文件，未读取');return null;}
    const resolved=await fs.realpath(file),relativeReal=path.relative(real,resolved);
    if(relativeReal.startsWith('..')||path.isAbsolute(relativeReal)){skipped.push(relative+'：实际路径超出项目，未读取');return null;}
    const handle=await fs.open(file,'r');
    try{
      const opened=await handle.stat();if(!opened.isFile()||opened.dev!==stat.dev||opened.ino!==stat.ino){skipped.push(relative+'：读取期间文件已替换');return null;}
      // Bound reads even when the file grows after lstat; do not publish its contents.
      const buf=Buffer.alloc(128*1024+1),{bytesRead}=await handle.read(buf,0,buf.length,0);
      if(bytesRead>128*1024){skipped.push(relative+'：读取期间超过大小上限');return null;}
      const text=buf.subarray(0,bytesRead).toString('utf8');coverage.push({path:relative,sha256:createHash('sha256').update(text).digest('hex')});return text;
    }finally{await handle.close();}
  }
  for(const name of names.slice(0,32)){const text=await read(name);if(text!==null&&text.trim())documents.push({path:name,text});}
  const evidence=roles.map(([id,label,filePattern,headingPattern])=>({id,label,paths:documents.filter(d=>filePattern.test(path.basename(d.path))||headingPattern.test(d.text)).map(d=>d.path)}));
  const missing=evidence.filter(e=>!e.paths.length).map(e=>e.label),conflicts=[];
  // Multiple role matches can be an index and a linked detail, not competing truths.
  const canonical=documents.filter(d=>/^(?:docs\/CODEX_HANDOFF|PROJECT_STATUS)\.md$/i.test(d.path));
  if(canonical.length>1&&!canonical.some(d=>/仅作索引|已迁移|归档|superseded|index only|archived/i.test(d.text)))conflicts.push('存在多个当前状态候选，请核对权威入口，不能据文件名自动合并');
  const stacks=new Set();let scripts={};const commands=[];
  for(const [name,stack] of Object.entries(manifests)){
    if(!entries.some(e=>e.name===name))continue;const text=await read(name);if(text===null)continue;stacks.add(stack);
    if(name==='package.json')try{const p=JSON.parse(text);scripts=p.scripts&&typeof p.scripts==='object'&&!Array.isArray(p.scripts)?p.scripts:{};for(const [key,value] of Object.entries(scripts))if(typeof value==='string')commands.push({source:name,name:key,status:'not-run'});}catch{missing.push('package.json 无法解析');}
  }
  for(const e of entries.filter(e=>e.isFile()&&/\.(csproj|fsproj|sln)$/.test(e.name)).slice(0,5))if(await read(e.name)!==null)stacks.add('.NET');
  return {version:2,status:missing.length||conflicts.length?'needs-review':'ready',missing,conflicts,stateFile:evidence.find(e=>e.id==='state').paths[0]??null,scripts:Object.keys(scripts),stacks:[...stacks],commands,evidence,coverage,skipped,
    structure:{status:missing.length||conflicts.length?'needs-review':'present',note:'仅发现文档用途线索，需由执行任务核对内容与代码'},content:{status:'not-reviewed'},validation:{status:'not-run'},governance:{status:'not-reviewed'},
    note:'只读结构线索检查；未扫描业务实现，未运行命令，未验证内容正确性。未知技术栈不推测命令。'};
}
