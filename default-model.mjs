import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {modelKeyOf,modelLabel,builtinModels} from './model-routing.mjs';

// Read only the routing fields. Never expose provider credentials or write Codex settings.
function routingFields(source){
  const tables=new Map([['',{}]]);let section='';
  for(const raw of source.split(/\r?\n/)){
    const line=raw.trim();if(!line||line.startsWith('#'))continue;
    if(line.startsWith('[')){
      const match=line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);if(!match){section='!unsupported';continue;}
      section=match[1].replace(/"([^"\\]+)"|'([^']+)'/g,(_,a,b)=>a??b);if(!tables.has(section))tables.set(section,{});continue;
    }
    const match=line.match(/^(model|model_provider|profile)\s*=\s*(.*)$/);if(!match)continue;
    const value=match[2].match(/^("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$/);
    if(!value)throw Error('默认模型配置字段无法安全解析：'+match[1]);
    let parsed;try{parsed=value[1][0]==='"'?JSON.parse(value[1]):value[1].slice(1,-1);}catch{throw Error('默认模型配置字符串无效');}
    if(!tables.has(section))throw Error('默认模型所在配置段无法安全解析');tables.get(section)[match[1]]=parsed;
  }
  return tables;
}
const read=file=>{const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>512*1024)throw Error('默认模型配置不是可核对的小型本机文件');return fs.readFileSync(file,'utf8');};
export function desiredModel(value,models=builtinModels){
  if(value?.available===false)throw Error(value.error||'无法确认本机默认模型');
  const modelRaw=String(value?.modelRaw??value?.model??'').trim(),modelProvider=String(value?.modelProvider??value?.provider??'openai').trim();
  if(!modelRaw||!modelProvider)throw Error('本机默认模型或提供方缺失，未发送');
  const modelKey=modelKeyOf(modelRaw,models),identity=modelKey+'\0'+modelProvider;
  return {available:true,modelRaw,modelKey,modelProvider,modelLabel:modelLabel(modelKey,models),identity,revision:value?.revision??createHash('sha256').update(JSON.stringify([modelRaw,modelProvider])).digest('hex'),source:value?.source??'本机当前默认'};
}
export function readDefaultModel({directory=process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),models=builtinModels}={}){
  try{
    const tables=routingFields(read(path.join(directory,'config.toml'))),base=tables.get(''),profile=base.profile;let effective={...base};
    if(profile){
      if(!/^[a-zA-Z0-9_-]{1,80}$/.test(profile))throw Error('默认profile名称无法安全核对');
      const file=path.join(directory,profile+'.config.toml');
      if(fs.existsSync(file))effective={...effective,...routingFields(read(file)).get('')};
      else if(tables.has('profiles.'+profile))effective={...effective,...tables.get('profiles.'+profile)};
      else throw Error('默认profile配置未找到');
    }
    if(effective.profile&&effective.profile!==profile)throw Error('默认profile存在递归覆盖，未猜测');
    return desiredModel({modelRaw:effective.model,modelProvider:effective.model_provider??'openai',source:profile?'本机默认 · '+profile:'本机当前默认',revision:createHash('sha256').update(JSON.stringify([effective.model,effective.model_provider??'openai',profile??''])).digest('hex')},models);
  }catch(error){return {available:false,error:'无法确认本机默认模型：'+error.message};}
}
export const seriesRouteKey=(base,target)=>createHash('sha256').update(base+'\0'+target.identity).digest('hex');
export function sameModelSeries(thread,target){return !!thread?.modelRaw&&thread.modelSource==='index'&&thread.modelKey===target.modelKey&&thread.modelProvider===target.modelProvider;}
export function trustedSeriesThread(state,thread,target,models=builtinModels){
  if(!sameModelSeries(thread,target))return false;
  const jobs=state.jobs.filter(j=>j.threadId===thread.id&&j.origin!=='archive'&&!['queued','cancelled'].includes(j.status));
  if(jobs.some(j=>(j.modelKey&&j.modelKey!==target.modelKey)||(j.modelProvider&&j.modelProvider!==target.modelProvider)||(j.modelActual&&modelKeyOf(j.modelActual,models)!==target.modelKey)))return false;
  return !Object.values(state.automation?.routes??{}).some(r=>r.threadId===thread.id&&r.status==='ready'&&((r.modelKey&&r.modelKey!==target.modelKey)||(r.modelProvider&&r.modelProvider!==target.modelProvider)));
}
export function modelReallocation(message='默认模型已切换，重新分配对话'){return Object.assign(Error(message),{code:'MODEL_REALLOCATION'});}
