import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./scripts/read-desktop-context.ps1',import.meta.url));
const unknown=()=>({status:'unresolved',matched:true,retryableContext:true});

// One hidden, demand-driven STA reader. No timer or desktop input operation.
export class WindowsContextReader {
  constructor({spawnProcess=spawn,platform=process.platform,timeoutMs=5000}={}){Object.assign(this,{spawnProcess,platform,timeoutMs});this.child=null;this.pending=null;this.tail=Promise.resolve();this.closed=false;this.sequence=0;this.counts={requests:0,helperStarts:0,lightChecks:0,fullScans:0,invalidations:0};}
  read(input){const run=this.tail.catch(()=>{}).then(()=>this.request(input));this.tail=run;return run;}
  request(input){
    if(this.closed)return Promise.resolve(unknown());if(this.platform!=='win32')return Promise.resolve({status:'snapshot',observations:[]});
    this.counts.requests++;
    if(!this.child){
      const child=this.spawnProcess('pwsh.exe',['-NoProfile','-NonInteractive','-STA','-File',script,'-Serve'],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;this.counts.helperStarts++;let buffer='';
      child.stdout.setEncoding('utf8');child.stderr.resume();child.stdin.on('error',()=>this.fail(child));
      child.stdout.on('data',chunk=>{if(this.child!==child)return;buffer+=chunk;if(buffer.length>131072){this.fail(child);return;}let end;
        while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(!line)continue;
          try{const reply=JSON.parse(line),pending=this.pending;if(!pending||reply.id!==pending.id)throw Error('Invalid reader receipt');const value=reply.result;if(!value||typeof value.status!=='string')throw Error('Invalid reader result');for(const key of ['lightChecks','fullScans','invalidations'])this.counts[key]+=Number(value.stats?.[key]??0);pending.finish(value);}catch{this.fail(child);return;}
        }
      });child.on('error',()=>this.fail(child));child.on('close',()=>this.fail(child));
    }
    return new Promise(resolve=>{const child=this.child,id=++this.sequence,timer=setTimeout(()=>this.fail(child),this.timeoutMs);
      this.pending={id,finish:value=>{if(this.pending?.id!==id)return;this.pending=null;clearTimeout(timer);resolve(value);}};
      try{child.stdin.write(JSON.stringify({id,input})+'\n');}catch{this.fail(child);}
    });
  }
  fail(child){if(this.child!==child)return;this.child=null;this.pending?.finish(unknown());try{child.kill();}catch{}}
  diagnostics(){return {...this.counts,alive:!!this.child};}
  async close(){this.closed=true;const child=this.child;if(child)this.fail(child);await this.tail.catch(()=>{});}
}
