// Serializable entity/map changes for the legacy domain reducer adapter.
// A transaction carries a store revision; no callback or SQL crosses threads.
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const entities=rows=>Array.isArray(rows)&&rows.every(row=>object(row)&&typeof row.id==='string')&&new Set(rows.map(row=>row.id)).size===rows.length;
export function stateChanges(before,after){
  const changes=[];
  function visit(a,b,path){
    if(equal(a,b))return;
    if(entities(a)&&entities(b)){
      const old=new Map(a.map(row=>[row.id,row])),next=new Set(b.map(row=>row.id));
      changes.push({path,kind:'entities',remove:a.filter(row=>!next.has(row.id)).map(row=>row.id),upsert:b.filter(row=>!equal(old.get(row.id),row)),...(!equal(a.map(row=>row.id),b.map(row=>row.id))?{order:b.map(row=>row.id)}:{})});return;
    }
    if(object(a)&&object(b)){
      for(const key of Object.keys(a))if(!Object.hasOwn(b,key))changes.push({path:[...path,key],kind:'delete'});
      for(const key of Object.keys(b))visit(a[key],b[key],[...path,key]);return;
    }
    changes.push({path,kind:'set',value:b});
  }
  visit(before??{},after,[]);return changes;
}
export function applyStateChanges(state,changes){
  if(!Array.isArray(changes)||changes.length>10000)throw Error('存储变更数量无效');
  for(const change of changes){
    if(!Array.isArray(change.path)||!change.path.length||change.path.length>32||change.path.some(key=>typeof key!=='string'))throw Error('存储变更路径无效');
    let parent=state;
    for(const key of change.path.slice(0,-1)){if(!Object.hasOwn(parent,key)||!object(parent[key]))throw Error('存储父对象已变化');parent=parent[key];}
    const key=change.path.at(-1),set=value=>Object.defineProperty(parent,key,{value:structuredClone(value),enumerable:true,writable:true,configurable:true});
    if(change.kind==='delete'){delete parent[key];continue;}
    if(change.kind==='set'){set(change.value);continue;}
    if(change.kind!=='entities'||!entities(parent[key])||!Array.isArray(change.remove)||!entities(change.upsert))throw Error('存储实体变更无效');
    const rows=new Map(parent[key].map(row=>[row.id,row]));for(const id of change.remove){if(!rows.delete(id))throw Error('待移除实体不存在');}
    for(const row of change.upsert)rows.set(row.id,row);
    const order=change.order??[...rows.keys()];if(!Array.isArray(order)||new Set(order).size!==rows.size||order.length!==rows.size||order.some(id=>!rows.has(id)))throw Error('存储实体顺序不完整');
    set(order.map(id=>rows.get(id)));
  }
}
