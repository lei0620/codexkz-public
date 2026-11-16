// Declared write scopes are scheduler constraints, not a filesystem sandbox.
export function writePaths(value=[]){
  if(!Array.isArray(value)||value.length>30)throw Error('修改范围最多填写30个项目相对文件或目录');
  const paths=value.map(raw=>{
    if(typeof raw!=='string')throw Error('修改范围必须是项目相对路径');
    const entry=raw.trim().replaceAll('\\','/').replace(/\/+$/,'');
    if(!entry||entry.length>240||entry.startsWith('/')||/[<>:"|?*\x00-\x1f]/.test(entry)||entry.split('/').some(p=>!p||['.','..'].includes(p)||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('修改范围请使用项目相对文件或目录，不能含盘符、通配符或上级路径');
    return entry;
  });
  return [...new Map(paths.map(p=>[p.toLowerCase(),p])).values()];
}
export function scopeConflict(a,b){
  let left,right;try{left=writePaths(a).map(p=>p.toLowerCase());right=writePaths(b).map(p=>p.toLowerCase());}catch{return '修改范围无效，按顺序执行';}
  if(!left.length||!right.length)return '未明确修改范围，按顺序执行';
  const overlap=left.find(x=>right.some(y=>x===y||x.startsWith(y+'/')||y.startsWith(x+'/')));
  return overlap?'修改范围重叠：'+overlap:'';
}
