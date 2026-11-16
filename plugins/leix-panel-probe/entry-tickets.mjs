import {randomBytes} from 'node:crypto';
import {hostThread} from './adapter.mjs';
const refuse=()=>{throw Object.assign(Error('入口凭据缺失、已过期或不属于当前宿主'),{status:409,notApplied:true,entryRejected:true});};
export class EntryTickets{
  constructor({now=Date.now,ttl=180000}={}){this.now=now;this.ttl=ttl;this.tickets=new Map();}
  issue(mode,meta){
    if(!['thread','global'].includes(mode))refuse();
    const ticket=randomBytes(32).toString('hex'),threadId=mode==='thread'?hostThread(meta):'';
    for(const [key,row] of this.tickets)if(row.expiresAt<=this.now())this.tickets.delete(key);
    if(this.tickets.size>=128)this.tickets.delete(this.tickets.keys().next().value);
    this.tickets.set(ticket,{mode,threadId,expiresAt:this.now()+this.ttl,viewId:null});return {mode,ticket};
  }
  take(ticket,viewId,meta){
    const row=this.tickets.get(ticket);if(!row||row.expiresAt<=this.now()||!/^[-a-zA-Z0-9]{8,100}$/.test(viewId??''))refuse();
    if(row.mode==='thread'&&hostThread(meta)!==row.threadId)refuse();
    if(row.viewId&&row.viewId!==viewId)refuse();row.viewId=viewId;return row.mode;
  }
}
