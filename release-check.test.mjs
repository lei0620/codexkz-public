import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {signReleaseManifest} from './release-manifest.mjs';
import {checkRelease,RELEASE_MANIFEST_URL} from './release-check.mjs';

const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const manifest={schemaVersion:1,version:'1.0.1',notes:'更新说明',assets:[{platform:'win32',arch:'x64',url:'https://github.com/lei0620/paiban/releases/download/v1.0.1/panel.zip',size:3,sha256:'a'.repeat(64)}]};
const envelope=signReleaseManifest(manifest,privateKey),options={publicKey,version:'1.0.0',platform:'win32',arch:'x64'};

test('checks fixed release endpoint and verifies response before selection',async()=>{
  const result=await checkRelease({...options,fetchImpl:async url=>{assert.equal(url.href,RELEASE_MANIFEST_URL);return new Response(JSON.stringify(envelope));}});
  assert.equal(result.available,true);assert.equal(result.version,'1.0.1');
  assert.equal((await checkRelease({...options,version:'1.0.1',fetchImpl:async()=>new Response(JSON.stringify(envelope))})).available,false);
});

test('rejects network failures, oversized and unsigned metadata',async()=>{
  await assert.rejects(checkRelease({...options,fetchImpl:async()=>{throw Error('offline');}}),/offline/);
  await assert.rejects(checkRelease({...options,fetchImpl:async()=>new Response('x'.repeat(100000))}),/过大/);
  await assert.rejects(checkRelease({...options,fetchImpl:async()=>new Response(JSON.stringify({...envelope,signature:Buffer.alloc(64).toString('base64')}))}),/签名验证失败/);
  await assert.rejects(checkRelease({...options,fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://evil.example/file'}})}),/不受信任/);
});
