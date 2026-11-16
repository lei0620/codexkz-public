import fs from 'node:fs';
import path from 'node:path';

// 模型表：key 是面板内的稳定标识，suffix 用于对话命名后缀，aliases 用于把本机索引/标题里的模型名归一化。
// 本机 Codex 默认模型（gpt/codex 系列）不加后缀；第三方模型加缩写后缀，用于人工识别与派发门禁。
export const builtinModels=[
  {key:'codex',label:'Codex 默认',suffix:'',aliases:['gpt','codex','chatgpt','o3','o4','o5']},
  {key:'deepseek',label:'DeepSeek',suffix:'-ds',aliases:['deepseek']},
  {key:'claude',label:'Claude',suffix:'-cl',aliases:['claude','sonnet','opus','haiku']},
  {key:'gemini',label:'Gemini',suffix:'-gm',aliases:['gemini','gemma']},
  {key:'qwen',label:'Qwen',suffix:'-qw',aliases:['qwen','qwq']},
  {key:'glm',label:'GLM',suffix:'-glm',aliases:['glm','chatglm','zhipu']},
  {key:'kimi',label:'Kimi',suffix:'-km',aliases:['kimi','moonshot']},
  {key:'grok',label:'Grok',suffix:'-gk',aliases:['grok']},
  {key:'mistral',label:'Mistral',suffix:'-ml',aliases:['mistral','mixtral','codestral','devstral']}
];
export const defaultModelKey='codex';
export const modelRegistryFile=path.join('config','model-registry.json');
const text=value=>String(value??'').trim();
const lower=value=>text(value).toLowerCase();

function normalizeEntries(value){
  const rows=Array.isArray(value)?value:value?.models;
  if(!Array.isArray(rows)||!rows.length)throw Error('模型表需要 models 数组');
  const seen=new Set();
  return rows.map((row,index)=>{
    if(!row||typeof row!=='object'||Array.isArray(row))throw Error('模型表第 '+index+' 项无效');
    const key=lower(row.key);
    if(!/^[a-z][a-z0-9-]{0,30}$/.test(key))throw Error('模型标识无效：'+row.key);
    if(seen.has(key))throw Error('模型标识重复：'+key);
    seen.add(key);
    const suffix=text(row.suffix);
    if(suffix&&!/^-[a-z0-9]{1,5}$/.test(suffix))throw Error('模型后缀需形如 -ds：'+key);
    const aliases=(Array.isArray(row.aliases)?row.aliases:[]).map(lower).filter(Boolean);
    return {key,label:text(row.label)||key,suffix,aliases:[key,...aliases]};
  });
}
// 可选 config/model-registry.json 覆盖内置表；缺失或损坏都不阻止面板启动，只提示。
export function loadModelRegistry(root){
  try{
    const source=fs.readFileSync(path.join(root,modelRegistryFile),'utf8');
    return {models:normalizeEntries(JSON.parse(source)),source:modelRegistryFile,error:''};
  }catch(error){
    if(error?.code==='ENOENT')return {models:builtinModels,source:'内置模型表',error:''};
    return {models:builtinModels,source:'内置模型表',error:'模型表配置无效，已使用内置模型表：'+error.message};
  }
}
function aliasTable(models){
  return models.flatMap(entry=>(entry.aliases??[]).map(alias=>({alias:lower(alias),key:entry.key})))
    .filter(row=>row.alias).sort((a,b)=>b.alias.length-a.alias.length);
}
export function modelEntry(key,models=builtinModels){const name=text(key);return models.find(entry=>entry.key===name)??null;}
export function modelKeyOf(raw,models=builtinModels){
  const value=lower(raw);if(!value)return '';
  const hit=aliasTable(models).find(row=>value.includes(row.alias));
  return hit?hit.key:'model:'+value;
}
export function modelLabel(key,models=builtinModels){const entry=modelEntry(key,models);return entry?.label??(text(key).replace(/^model:/,'')||'未确认');}
export function suffixOf(key,models=builtinModels){
  if(!text(key))return '';
  const entry=modelEntry(key,models);if(entry)return entry.suffix??'';
  if(String(key).startsWith('model:suffix-'))return String(key).slice('model:suffix'.length);
  const slug=lower(key).replace(/^model:/,'').split(/[^a-z0-9]+/).filter(Boolean).join('').slice(0,4);
  return '-'+(slug||'x');
}
export function titleSuffix(title){const match=text(title).match(/-([a-z][a-z0-9]{0,4})$/i);return match?'-'+match[1].toLowerCase():'';}
export function keyOfSuffix(suffix,models=builtinModels){const want=lower(suffix);if(!want)return '';const entry=models.find(row=>row.suffix&&row.suffix===want);return entry?entry.key:'';}
function withoutProjectPrefix(title,projectLabel){
  const name=text(title),project=text(projectLabel);
  if(!project||!name.startsWith(project))return name;
  const rest=name.slice(project.length);
  return rest===''||/^[\s·\-–—|]+/.test(rest)?rest.replace(/^[\s·\-–—|]+/,''):name;
}
// 线程模型来源优先级：本机索引的实际模型 > 标题声明的后缀 > 未确认。
export function threadModelView(thread,record,models=builtinModels){
  const raw=text(record?.model),suffix=titleSuffix(thread?.title);
  if(raw){const key=modelKeyOf(raw,models);return {modelRaw:raw,modelProvider:text(record?.provider),modelKey:key,modelLabel:modelLabel(key,models),modelSource:'index',titleSuffix:suffix};}
  const key=keyOfSuffix(suffix,models);
  if(key)return {modelRaw:'',modelProvider:'',modelKey:key,modelLabel:modelLabel(key,models),modelSource:'title',titleSuffix:suffix};
  if(suffix)return {modelRaw:'',modelProvider:'',modelKey:'model:suffix'+suffix,modelLabel:'未登记模型'+suffix,modelSource:'title',titleSuffix:suffix};
  return {modelRaw:'',modelProvider:'',modelKey:'',modelLabel:'未确认',modelSource:'unknown',titleSuffix:''};
}
export function namingIssue({title,projectLabel,key,models=builtinModels}={}){
  const name=text(title);
  if(!name)return '对话标题为空，无法识别用途与模型';
  const issues=[];
  if(withoutProjectPrefix(name,projectLabel)!==name)issues.push('标题含多余项目名前缀');
  const expected=suffixOf(key,models),actual=titleSuffix(name),known=keyOfSuffix(actual,models);
  if(expected&&!name.endsWith(expected))issues.push('标题缺少模型后缀 '+expected);
  else if(!expected&&actual&&known&&known!==defaultModelKey)issues.push('标题后缀 '+actual+' 与默认模型不符');
  return issues.join('；');
}
export function canonicalTitle({purpose,key,models=builtinModels}={}){
  const unit=text(purpose)||'面板执行';
  return unit+suffixOf(key,models);
}
export function titlePurpose({title,projectLabel,models=builtinModels}={}){
  let value=withoutProjectPrefix(title,projectLabel);
  const suffix=titleSuffix(value);
  if(suffix&&(keyOfSuffix(suffix,models)||/^-[a-z]{1,5}$/.test(suffix)))value=value.slice(0,-suffix.length);
  return text(value)||'面板执行';
}
// 模型只作本轮记录；完整快照覆盖排队时的旧值，未知时不沿用历史模型。
export function threadModelRecord(thread){
  const modelKey=text(thread?.modelKey);
  return {modelKey,modelProvider:modelKey?text(thread?.modelProvider):'',modelRaw:modelKey?text(thread?.modelRaw):'',modelSource:modelKey?text(thread?.modelSource):'unknown',modelLabel:modelKey?text(thread?.modelLabel):'未确认',modelUnverified:modelKey?'':'模型未确认'};
}
