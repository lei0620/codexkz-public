import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {releaseCheckStore} from './release-check-store.mjs';
import {ReleaseScheduler} from './release-scheduler.mjs';
import {signReleaseManifest} from './release-manifest.mjs';
import {generateKeyPairSync} from 'node:crypto';

const parent=path.dirname(process.cwd());
test('update metadata is stored independently and refuses corrupt or non-file paths',async()=>{
  const root=await fs.mkdtemp(path.join(parent,'.codexkz-update-test-'));
  try{
    await fs.mkdir(path.join(root,'data'));const store=releaseCheckStore(root),file=path.join(root,'data','release-check.json');
    assert.equal(await store.read(),null);await store.write({version:1,lastAttempt:1,envelope:null});assert.deepEqual(await store.read(),{version:1,lastAttempt:1,envelope:null});
    await store.write({version:1,lastAttempt:2,envelope:null});assert.equal((await store.read()).lastAttempt,2);
    await fs.writeFile(file,'bad json');await assert.rejects(store.read());
    await fs.rm(file);await fs.mkdir(file);await assert.rejects(store.write({version:1}),/普通文件/);
  }finally{assert.equal(path.dirname(root),parent);assert.match(path.basename(root),/^\.codexkz-update-test-/);await fs.rm(root,{recursive:true,force:true});}
});

test('daily limit and signed cached result survive store and scheduler recreation',async()=>{
  const root=await fs.mkdtemp(path.join(parent,'.codexkz-update-test-'));
  try{
    await fs.mkdir(path.join(root,'data'));const {publicKey,privateKey}=generateKeyPairSync('ed25519');let calls=0;
    const envelope=signReleaseManifest({schemaVersion:1,version:'1.0.1',notes:'更新',assets:[{platform:'win32',arch:'x64',url:'https://github.com/lei0620/paiban/releases/download/v1.0.1/file.zip',size:1,sha256:'a'.repeat(64)}]},privateKey);
    const make=()=>new ReleaseScheduler({...releaseCheckStore(root),publicKey,version:'1.0.0',platform:'win32',arch:'x64',now:()=>1000000,check:async()=>{calls++;return {envelope};}});
    assert.equal((await make().checkNow()).status,'checked');const result=await make().checkNow();
    assert.equal(result.status,'cached');assert.equal(result.available,true);assert.equal(calls,1);
  }finally{assert.equal(path.dirname(root),parent);assert.match(path.basename(root),/^\.codexkz-update-test-/);await fs.rm(root,{recursive:true,force:true});}
});
