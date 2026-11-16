import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {MAX_FILE} from './attachments.mjs';
import {goalContextText} from './public/rounds.js';

// Clipboard wrappers may prefix requests with encoded spaces. Leave inline
// code examples and other HTML entities untouched; never interpret HTML.
export const cleanSourcePrefix=text=>goalContextText(text).replace(/^(?:\s|&#x0*20;|&#0*32;|&nbsp;)+/i,'');
export function sourceTaskTitle(text){const clean=cleanSourcePrefix(text).replace(/\s+/g,' ').replace(/^(?:请|我(?:现在)?需要你?|我想要|帮我|现在)/,'');const parts=clean.split(/[，。；;\n]/).map(s=>s.trim()).filter(Boolean);return (parts.find(s=>/^(优化|增加|新增|添加|实现|开发|修复|改善|调整|审查|审视|分析)/.test(s))??parts[0]??'待确认需求').slice(0,48);}
export function taskContentInput(input){
  const description=typeof input.description==='string'?input.description.trim():'',title=typeof input.title==='string'?input.title.trim():'';
  if(input.autoTitle===true&&!description)throw Error('请填写任务内容');
  return input.autoTitle===true||!title?{...input,title:description?sourceTaskTitle(description):''}:input;
}
export function presentTask(task){
  if(task.sourceKind!=='conversation')return task;
  const broken=/^(?:\s|&#x0*20;?|&#0*32;?|&nbsp;?)+$/i.test(task.title??'');
  return {...task,title:broken?sourceTaskTitle(task.description):cleanSourcePrefix(task.title),description:cleanSourcePrefix(task.description)};
}

export function sourceContent(source){
  const images=[];
  const text=cleanSourcePrefix(source.text).replace(/<image\b[^>]*>(?:\s*<\/image>)?/gi,tag=>{
    const file=/\bpath\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if(file&&images.length<8)images.push({path:file,name:/\bname\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]??`截图 ${images.length+1}`});
    return '';
  }).replace(/<\/image>/gi,'').trim();
  return {text,images};
}
export function presentSource(event){
  const {text,images}=sourceContent(event.source);
  return {...event,source:{...event.source,presentation:{text,images:images.map(({name},index)=>({name,index})),hasAttachments:!!event.source.hasAttachments||images.length>0}}};
}
export function readSourceImage(source,index,{clipboardDirectory=os.tmpdir(),attachmentDirectory=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'attachments')}={}){
  const image=sourceContent(source).images[index];
  if(!Number.isInteger(index)||index<0||!image)throw Error('截图不存在');
  const file=path.resolve(image.path),isWithin=dir=>{const relative=path.relative(path.resolve(dir),file);return !!relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);};
  const clipboard=path.dirname(file).toLowerCase()===path.resolve(clipboardDirectory).toLowerCase()&&/^codex-clipboard-[a-f0-9-]{36}\.(png|jpe?g|webp|gif)$/i.test(path.basename(file));
  if(!clipboard&&!isWithin(attachmentDirectory))throw Error('此附件请在原对话中查看');
  const root=clipboard?clipboardDirectory:attachmentDirectory;
  try{
    const stat=fs.lstatSync(file),relative=path.relative(fs.realpathSync(root),fs.realpathSync(file));
    if(!stat.isFile()||stat.isSymbolicLink()||relative.startsWith('..')||path.isAbsolute(relative)||stat.size>MAX_FILE)throw Error('invalid');
    const bytes=fs.readFileSync(file);if(bytes.length>MAX_FILE)throw Error('large');
    const type=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':/^GIF8[79]a$/.test(bytes.subarray(0,6).toString())?'image/gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
    if(!type)throw Error('not image');return {bytes,type};
  }catch{throw Error('截图已失效或无法读取，请在原对话中查看');}
}
