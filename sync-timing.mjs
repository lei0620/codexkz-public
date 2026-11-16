import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const phases=new Set(['script-entered','assemblies-ready','native-ready','target-found','composer-checked','clipboard-ready','paste-issued','text-confirmed','submit-checked','submit-invoked','finally-complete']);
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
// Explicit one-shot diagnostics; no message/clipboard text or background timer.
export function beginSyncTiming(root,input,{receivedAt=Date.now()}={}){
  try{
    const directory=path.join(root,'data','sync-timing'),arm=path.join(directory,'arm.json');
    if(!fs.existsSync(arm))return null;
    if(fs.realpathSync(directory)!==directory||fs.lstatSync(arm).isSymbolicLink()||fs.statSync(arm).size>2048)return null;
    const config=JSON.parse(fs.readFileSync(arm,'utf8')),now=Date.now();
    if(config.projectId!==input.projectId||config.threadId!==input.threadId||!Number.isSafeInteger(config.expiresAt)||config.expiresAt<now||config.expiresAt>now+600000||!/^project-sync-[a-zA-Z0-9-]{1,70}$/.test(input.requestId??''))return null;
    const id=randomUUID();fs.renameSync(arm,path.join(directory,'claimed-'+id+'.json'));
    const start=performance.now(),report={version:1,requestId:input.requestId,receivedAt,startedAt:now,marks:[]};
    if(Number.isSafeInteger(input.clientClickedAt)&&input.clientClickedAt<=now&&now-input.clientClickedAt<60000)report.clientClickedAt=input.clientClickedAt;
    let finished=false;
    return {
      mark(phase){try{if(!finished&&report.marks.length<40&&/^[a-z][a-z.-]{1,40}$/.test(phase))report.marks.push({phase,at:Date.now(),elapsedMs:Math.round((performance.now()-start)*1000)/1000});}catch{}},
      helper(value){try{if(!value||value.version!==1)return;report.helper={version:1,...(number(value.scriptStartedAt)?{scriptStartedAt:value.scriptStartedAt}:{}),...(number(value.processStartedAt)?{processStartedAt:value.processStartedAt}:{}),marks:(Array.isArray(value.marks)?value.marks:[]).slice(0,40).filter(m=>phases.has(m.phase)&&number(m.elapsedMs)&&number(m.at)).map(({phase,elapsedMs,at})=>({phase,elapsedMs,at})),...(number(value.roundTripMs)?{roundTripMs:value.roundTripMs}:{})};}catch{}},
      outcome(value){try{report.outcome={...(typeof value.replayed==='boolean'?{replayed:value.replayed}:{}),...(typeof value.notApplied==='boolean'?{notApplied:value.notApplied}:{}),...(['invoked','finished','uncertain','not-applied'].includes(value.status)?{status:value.status}:{})};}catch{}},
      finish(status){try{if(finished)return;this.mark('http.finished');finished=true;report.httpStatus=status;report.finishedAt=Date.now();fs.writeFileSync(path.join(directory,'result-'+id+'.json'),JSON.stringify(report,null,2),{flag:'wx'});}catch{}},
    };
  }catch{return null;}
}
