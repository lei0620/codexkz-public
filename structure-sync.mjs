const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
export function validateStructure(value){
  if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['section','dependsOn','sourceKey'].includes(k))||!Array.isArray(value.dependsOn)||value.dependsOn.length>20||new Set(value.dependsOn).size!==value.dependsOn.length||value.dependsOn.some(v=>!id(v))||typeof value.sourceKey!=='string'||value.sourceKey.length>240)throw Error('版块任务同步结构无效');
  const s=value.section;if(s!==null&&(!s||Object.keys(s).some(k=>!['name','description','keywords'].includes(k))||typeof s.name!=='string'||!s.name.trim()||s.name.length>80||typeof s.description!=='string'||s.description.length>4000))throw Error('同步版块信息无效');
  if(s&&(!Array.isArray(s.keywords??[])||(s.keywords??[]).length>30||(s.keywords??[]).some(k=>typeof k!=='string'||k.length>40)))throw Error('版块关键词无效');
  if(/[a-zA-Z]:[\\/]|\b(?:ghp_|sk-)[A-Za-z0-9]{20,}|[\x00]/.test([value.sourceKey,s?.name,s?.description,...(s?.keywords??[])].join('\n')))throw Error('版块信息含本机路径或疑似凭据');
}
export function validateStructureRelations(records){
  const byId=new Map(records.map(r=>[r.id,r]));const done=new Set(),visiting=new Set();
  const sources=new Set();for(const r of records){if(r.deleted||!r.structure?.sourceKey)continue;const source=r.logicalId+'\0'+r.structure.sourceKey.normalize('NFKC').toLowerCase();if(sources.has(source))throw Error('同步中存在重复来源任务，请核对后合并');sources.add(source);}
  function visit(r){if(done.has(r.id))return;if(visiting.has(r.id))throw Error('同步任务存在循环依赖');visiting.add(r.id);
    for(const id of r.structure?.dependsOn??[]){const dep=byId.get(id);if(!dep)continue;if(dep.logicalId!==r.logicalId)throw Error('同步依赖不属于同一项目');visit(dep);}visiting.delete(r.id);done.add(r.id);
  }
  const sections=new Map();for(const r of records){if(r.structure?.section&&!r.deleted){const key=r.logicalId+'\0'+r.structure.section.name.trim().normalize('NFKC').toLowerCase(),value=JSON.stringify(r.structure.section);if(sections.has(key)&&sections.get(key)!==value)throw Error('同一版块的同步说明不一致，请先处理冲突');sections.set(key,value);}visit(r);}
}
