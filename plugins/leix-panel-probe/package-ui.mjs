import {readFile,realpath} from 'node:fs/promises';
import {dirname,extname,isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const defaultPublic=fileURLToPath(new URL('../../public/',import.meta.url));
const assetTypes={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf'};
const fail=message=>{throw Error(`Panel UI package: ${message}`);};
const within=(root,path)=>{const name=relative(root,path);return name!==''&&!isAbsolute(name)&&name!=='..'&&!name.startsWith('..'+sep);};
const moduleName=name=>'@leix-ui/'+name.replaceAll('\\','/');
const dataUrl=(mime,bytes)=>`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const json=value=>JSON.stringify(value).replaceAll('<','\\u003c');

// Only literal module specifiers are supported. A lexer avoids treating imports
// inside comments, quoted text, regex literals or template text as dependencies.
function tokensOf(source){
  const tokens=[];let index=0;
  const push=(kind,value,start,end=index)=>tokens.push({kind,value,start,end});
  function string(quote){const start=index++;while(index<source.length){const ch=source[index++];if(ch==='\\'){index++;continue;}if(ch===quote){push('string',source.slice(start+1,index-1),start);return;}}fail('unterminated JavaScript string');}
  function regex(){let bracket=false;index++;while(index<source.length){const ch=source[index++];if(ch==='\\'){index++;continue;}if(ch==='[')bracket=true;if(ch===']')bracket=false;if(ch==='/'&&!bracket){while(/[a-z]/i.test(source[index]??'')&&index<source.length)index++;return;}if(ch==='\n'||ch==='\r')break;}fail('unterminated JavaScript regular expression');}
  function template(){index++;while(index<source.length){const ch=source[index++];if(ch==='\\'){index++;continue;}if(ch==='`')return;if(ch==='$'&&source[index]==='{'){index++;code(true);}}fail('unterminated JavaScript template');}
  function code(nested=false){let braces=0;while(index<source.length){
    const ch=source[index],start=index;
    if(/\s/.test(ch)){index++;continue;}
    if(ch==='/'&&source[index+1]==='/'){index+=2;while(index<source.length&&!/[\r\n]/.test(source[index]))index++;continue;}
    if(ch==='/'&&source[index+1]==='*'){const end=source.indexOf('*/',index+2);if(end<0)fail('unterminated JavaScript comment');index=end+2;continue;}
    if(ch==='"'||ch==="'"){string(ch);continue;}
    if(ch==='`'){template();push('template','template',start);continue;}
    if(ch==='/'&&source[index+1]!=='='){
      const last=tokens.at(-1),canStart=!last||last.kind==='punct'&&![')',']','}','++','--'].includes(last.value)||last.kind==='word'&&['return','throw','case','delete','void','typeof','new','in','instanceof','yield','await','else','do'].includes(last.value);
      if(canStart){regex();push('regex','regex',start);continue;}
    }
    if(/[a-zA-Z_$]/.test(ch)){index++;while(/[a-zA-Z0-9_$]/.test(source[index]??'')&&index<source.length)index++;push('word',source.slice(start,index),start);continue;}
    if(/[0-9]/.test(ch)){index++;while(/[a-zA-Z0-9_.]/.test(source[index]??'')&&index<source.length)index++;push('number',source.slice(start,index),start);continue;}
    if(ch==='}'){if(nested&&braces===0){index++;return;}braces--;}
    if(ch==='{')braces++;
    const pair=source.slice(index,index+2);index+=['++','--','?.','=>'].includes(pair)?2:1;push('punct',source.slice(start,index),start);
  }if(nested)fail('unterminated JavaScript template expression');}
  code();return tokens;
}

function importsOf(source){
  const tokens=tokensOf(source),imports=[];
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i];if(token.kind!=='word'||!['import','export'].includes(token.value)||['.','?.'].includes(tokens[i-1]?.value))continue;
    const next=tokens[i+1];
    if(token.value==='import'&&next?.value==='.'){
      if(tokens[i+2]?.value==='meta'&&tokens[i+3]?.value==='.'&&tokens[i+4]?.value==='url')fail('import.meta.url assets require an explicit transport');
      continue;
    }
    if(token.value==='import'&&next?.value==='('){
      const value=tokens[i+2];if(value?.kind!=='string'||![')',','].includes(tokens[i+3]?.value))fail('dynamic imports must use a literal relative module path');imports.push(value);continue;
    }
    if(token.value==='import'&&next?.kind==='string'){imports.push(next);continue;}
    if(token.value==='export'&&!['{','*'].includes(next?.value))continue;
    let found=false;
    for(let j=i+1;j<tokens.length&&tokens[j].value!==';';j++){
      if(tokens[j].value==='from'&&tokens[j+1]?.kind==='string'){imports.push(tokens[j+1]);found=true;break;}
      if(j>i+1&&tokens[j].kind==='word'&&['import','export'].includes(tokens[j].value))break;
    }
    if(token.value==='import'&&!found)fail('unsupported JavaScript import declaration');
  }
  return imports;
}

function attributes(tag){
  const attributes=new Map();const body=tag.replace(/^<\/?[a-z][\w:-]*/i,'').replace(/\/?\s*>$/,'');
  const pattern=/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for(const match of body.matchAll(pattern)){const key=match[1].toLowerCase();if(attributes.has(key))fail(`duplicate HTML attribute ${key}`);attributes.set(key,match[2]??match[3]??match[4]??'');}
  return attributes;
}

/** Return one self-contained MCP App HTML document; never writes artifacts. */
export async function packagePanelUi({publicDir=defaultPublic,mode='thread',bootstrap='./plugin-host.js',entry='./app.js'}={}){
  if(!['global','thread'].includes(mode))fail('unknown interface mode');
  const root=await realpath(publicDir instanceof URL?fileURLToPath(publicDir):publicDir),modules=new Map();
  async function local(specifier,from,extension,rootRelative=false){
    if(typeof specifier!=='string'||specifier.length===0||/[\\%?#\u0000-\u0020]/.test(specifier)||specifier.startsWith('//')||/^[a-z][a-z0-9+.-]*:/i.test(specifier))fail('only local public paths are allowed');
    if(!rootRelative&&!specifier.startsWith('./')&&!specifier.startsWith('../'))fail('module imports must be relative');
    if(specifier.split('/').includes('..'))fail('directory traversal is not allowed');
    const path=resolve(specifier.startsWith('/')?root:dirname(from),specifier.replace(/^\//,''));
    if(!within(root,path)||!extension.includes(extname(path).toLowerCase()))fail('path is outside the public asset whitelist');
    const actual=await realpath(path);if(!within(root,actual))fail('symbolic link escapes public');return actual;
  }
  async function module(specifier,from){
    const path=await local(specifier,from,['.js','.mjs']);
    if(modules.has(path))return moduleName(relative(root,path));
    modules.set(path,null);
    let source=await readFile(path,'utf8');const replacements=[];
    for(const ref of importsOf(source))replacements.push({start:ref.start,end:ref.end,value:json(await module(ref.value,path))});
    for(const replacement of replacements.sort((a,b)=>b.start-a.start))source=source.slice(0,replacement.start)+replacement.value+source.slice(replacement.end);
    const name=moduleName(relative(root,path));modules.set(path,{name,url:dataUrl('text/javascript',source+`\n//# sourceURL=leix-ui/${relative(root,path).replaceAll('\\','/')}\n`)});return name;
  }
  async function asset(value,from){
    if(value.startsWith('#')||value==='data:,'||/^data:(?:image\/(?:png|jpeg|gif|webp|avif|x-icon)|font\/(?:woff|woff2|ttf|otf));base64,[a-z0-9+/=]*$/i.test(value))return value;
    const path=await local(value,from,Object.keys(assetTypes),true);return dataUrl(assetTypes[extname(path).toLowerCase()],await readFile(path));
  }
  async function css(value,from,seen=new Set()){
    const path=await local(value,from,['.css'],true);if(seen.has(path))fail('cyclic CSS import');const next=new Set([...seen,path]);let source=(await readFile(path,'utf8')).replace(/\/\*[\s\S]*?\*\//g,'');
    const imported=[];for(const match of source.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)')\s*\)?\s*;/gi))imported.push({start:match.index,end:match.index+match[0].length,value:await css(match[1]??match[2],path,next)});
    for(const replacement of imported.sort((a,b)=>b.start-a.start))source=source.slice(0,replacement.start)+replacement.value+source.slice(replacement.end);
    if(/@import\b/i.test(source))fail('unsupported CSS import');
    const urls=[];for(const match of source.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi))urls.push({start:match.index,end:match.index+match[0].length,value:`url(${json(await asset((match[1]??match[2]??match[3]).trim(),path))})`});
    for(const replacement of urls.sort((a,b)=>b.start-a.start))source=source.slice(0,replacement.start)+replacement.value+source.slice(replacement.end);
    if(/<\/style/i.test(source))fail('unsafe CSS closing tag');return source;
  }
  const indexPath=await local('/index.html',resolve(root,'index.html'),['.html'],true);let html=await readFile(indexPath,'utf8');
  if(/<(?:base|iframe|object|embed)\b/i.test(html))fail('embedded documents are not supported');
  const scripts=[...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)];if(scripts.length!==1)fail('expected one external application module');
  const script=scripts[0],scriptTag=script[0].match(/^<script\b[^>]*>/i)[0],scriptAttrs=attributes(scriptTag);
  const entryPath=await local(entry,indexPath,['.js','.mjs']),htmlEntry=await local(scriptAttrs.get('src'),indexPath,['.js','.mjs'],true);
  if(scriptAttrs.get('type')!=='module'||htmlEntry!==entryPath||!/^<script\b[^>]*>\s*<\/script\s*>$/i.test(script[0]))fail('unexpected application script');
  const start=await module(bootstrap,indexPath),main=await module(entry,indexPath);
  const importmap={imports:Object.fromEntries([...modules.values()].map(value=>[value.name,value.url]))};
  const packed=`<script type="importmap">${json(importmap)}</script><script type="module">const host=await import(${json(start)});if(host.startSharedApplication!==false)await import(${json(main)});</script>`;
  html=html.slice(0,script.index)+packed+html.slice(script.index+script[0].length);
  const links=[];for(const match of html.matchAll(/<link\b[^>]*>/gi)){
    const attrs=attributes(match[0]),rel=attrs.get('rel'),href=attrs.get('href');
    if(rel==='stylesheet')links.push({start:match.index,end:match.index+match[0].length,value:`<style>${await css(href,indexPath)}</style>`});
    else if(rel==='icon')links.push({start:match.index,end:match.index+match[0].length,value:`<link rel="icon" href="${await asset(href,indexPath)}">`});
    else fail('unsupported HTML link resource');
  }
  for(const replacement of links.sort((a,b)=>b.start-a.start))html=html.slice(0,replacement.start)+replacement.value+html.slice(replacement.end);
  const images=[];for(const match of html.matchAll(/<(?:img|source)\b[^>]*>/gi)){
    const attrs=attributes(match[0]);if(attrs.has('srcset'))fail('responsive image lists require explicit packaging');if(!attrs.has('src'))continue;
    const value=await asset(attrs.get('src'),indexPath);images.push({start:match.index,end:match.index+match[0].length,value:match[0].replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,`src="${value}"`)});
  }
  for(const replacement of images.sort((a,b)=>b.start-a.start))html=html.slice(0,replacement.start)+replacement.value+html.slice(replacement.end);
  if(!/<html\b/i.test(html))fail('missing HTML root');
  return html.replace(/<html\b[^>]*>/i,tag=>tag.replace(/\sdata-leix-mode\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'').replace(/>$/,` data-leix-mode="${mode}">`));
}
