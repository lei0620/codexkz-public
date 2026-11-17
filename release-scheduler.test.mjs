import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {signReleaseManifest} from './release-manifest.mjs';
import {ReleaseScheduler} from './release-scheduler.mjs';

const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const envelope=signReleaseManifest({schemaVersion:1,version:'1.2.3',notes:'更新内容',assets:[{platform:'win32',arch:'x64',url:'https://github.com/lei0620/paiban/releases/download/v1.2.3/panel.zip',size:1,sha256:'a'.repeat(64)}]},privateKey);
const hour=60*60*1000;
function harness(){
  let saved=null,clock=100*hour,calls=0,release=async()=>({envelope});
  const options={read:async()=>structuredClone(saved),write:async value=>{saved=structuredClone(value);},now:()=>clock,publicKey,version:'1.0.0',platform:'win32',arch:'x64',check:async()=>{calls++;return release();}};
  return {options,make:()=>new ReleaseScheduler(options),setClock:value=>clock=value,setRelease:value=>release=value,setSaved:value=>saved=value,get saved(){return saved;},get calls(){return calls;}};
}
test('automatic checks persist the daily limit and verified result across restarts',async()=>{
  const h=harness(),first=h.make();assert.deepEqual(await first.checkNow(),{status:'checked',available:true,version:'1.2.3',notes:'更新内容'});
  const second=h.make();h.setClock(110*hour);assert.equal((await second.checkNow()).status,'cached');assert.equal(h.calls,1);
  h.setClock(124*hour);assert.equal((await second.checkNow()).status,'checked');assert.equal(h.calls,2);
  h.setClock(100*hour);assert.equal((await second.checkNow()).status,'cached');assert.equal(h.calls,2);
  assert.equal((await second.checkNow({manual:true})).status,'checked');assert.equal(h.calls,3);
  h.setClock(124*hour);assert.equal((await second.checkNow()).status,'cached');assert.equal(h.calls,3);
});
test('failed check retains last verified result and does not retry on next startup',async()=>{
  const h=harness();await h.make().checkNow();h.setClock(125*hour);h.setRelease(async()=>{throw Error('offline');});
  assert.deepEqual(await h.make().checkNow(),{status:'error',available:true,version:'1.2.3',notes:'更新内容'});
  assert.equal((await h.make().checkNow()).status,'cached');assert.equal(h.calls,2);
});
test('concurrent requests share one check and persistence failure prevents networking',async()=>{
  const h=harness();let resolve;h.setRelease(()=>new Promise(r=>resolve=r));const scheduler=h.make();
  const a=scheduler.checkNow(),b=scheduler.checkNow({manual:true});assert.strictEqual(a,b);
  for(let i=0;i<100&&!resolve;i++)await new Promise(r=>setTimeout(r,10));assert.equal(typeof resolve,'function');resolve({envelope});await Promise.all([a,b]);assert.equal(h.calls,1);
  const blocked=harness();blocked.options.write=async()=>{throw Error('disk unavailable');};
  await assert.rejects(blocked.make().checkNow(),/disk unavailable/);assert.equal(blocked.calls,0);
});
test('corrupt or forged cached state fails closed',async()=>{
  const h=harness();h.setSaved({version:1,lastAttempt:1,envelope:{...envelope,signature:Buffer.alloc(64).toString('base64')}});
  await assert.rejects(h.make().checkNow(),/签名/);assert.equal(h.calls,0);
  h.setSaved({version:1,lastAttempt:'bad'});await assert.rejects(h.make().checkNow(),/记录异常/);assert.equal(h.calls,0);
});
test('a previously observed signed newer version cannot be replaced by an older manifest',async()=>{
  const h=harness();await h.make().checkNow();h.setClock(125*hour);
  const older=signReleaseManifest({schemaVersion:1,version:'1.2.2',notes:'旧版本',assets:[{platform:'win32',arch:'x64',url:'https://github.com/lei0620/paiban/releases/download/v1.2.2/panel.zip',size:1,sha256:'a'.repeat(64)}]},privateKey);
  h.setRelease(async()=>({envelope:older}));const result=await h.make().checkNow();
  assert.equal(result.status,'error');assert.equal(result.version,'1.2.3');assert.deepEqual(h.saved.envelope,envelope);
  h.setRelease(async()=>({}));const missing=await h.make().checkNow({manual:true});assert.equal(missing.status,'error');assert.deepEqual(h.saved.envelope,envelope);
  const replaced=signReleaseManifest({schemaVersion:1,version:'1.2.3',notes:'变更的内容',assets:[{platform:'win32',arch:'x64',url:'https://github.com/lei0620/paiban/releases/download/v1.2.3/panel.zip',size:1,sha256:'b'.repeat(64)}]},privateKey);
  h.setRelease(async()=>({envelope:replaced}));assert.equal((await h.make().checkNow({manual:true})).status,'error');assert.deepEqual(h.saved.envelope,envelope);
});
