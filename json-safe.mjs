const failure=(code,message,diagnostics=[])=>Object.assign(new Error(message),{code,diagnostics});

export function parseSource(bytes){
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{throw failure('CORRUPT_JSON','源JSON不是有效UTF-8，未进行有损转换');}let value;
  try{value=JSON.parse(text);}catch{throw failure('CORRUPT_JSON','源JSON损坏，未进行迁移');}
  const stack=[],duplicates=[];
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){
      const start=i;for(i++;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]==='"')break;}
      const frame=stack.at(-1);if(frame?.object&&frame.key){const key=JSON.parse(text.slice(start,i+1));if(frame.seen.has(key))duplicates.push({code:'DUPLICATE_JSON_KEY',path:'offset:'+start,key});frame.seen.add(key);frame.key=false;}
    }else if(c==='{')stack.push({object:true,key:true,seen:new Set()});
    else if(c==='[')stack.push({object:false});
    else if(c==='}'||c===']')stack.pop();
    else if(c===','&&stack.at(-1)?.object)stack.at(-1).key=true;
  }
  if(duplicates.length)throw failure('VALIDATION_FAILED','JSON存在重复字段，不能静默丢弃',duplicates);
  return value;
}
