import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {signReleaseManifest} from './release-manifest.mjs';
import {downloadReleaseAsset} from './release-download.mjs';

const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const asset={platform:'win32',arch:'x64',url:'https://github.com/lei0620/paiban/releases/download/v1.0.1/panel.zip',size:3,sha256:createHash('sha256').update('abc').digest('hex')};
const envelope=signReleaseManifest({schemaVersion:1,version:'1.0.1',notes:'更新',assets:[asset]},privateKey);
const options={envelope,publicKey,version:'1.0.0',platform:'win32',arch:'x64'};

test('download only verified target and preserve existing files',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'codexkz-download-test-'));
  try{
    const dest=path.join(dir,'asset');let calls=0;
    const fetchImpl=async url=>{calls++;return calls===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/test'}}):new Response('abc',{headers:{'content-length':'3'}});};
    assert.equal((await downloadReleaseAsset({...options,destination:dest,fetchImpl})).version,'1.0.1');
    assert.equal(await readFile(dest,'utf8'),'abc');assert.equal(calls,2);
    await assert.rejects(downloadReleaseAsset({...options,destination:dest,fetchImpl:async()=>new Response('abc')}));
    assert.equal(await readFile(dest,'utf8'),'abc');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('refuse unknown redirect and wrong content; do not write before verification',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'codexkz-download-test-'));
  try{
    const dest=path.join(dir,'asset');
    await assert.rejects(downloadReleaseAsset({...options,destination:dest,fetchImpl:async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/'}})}),/不受信任/);
    await assert.rejects(readFile(dest));
    await assert.rejects(downloadReleaseAsset({...options,destination:dest,fetchImpl:async()=>new Response('abd')}),/摘要/);
    assert.equal(await readFile(dest,'utf8'),'abd'); // partial files are never treated as verified
    const other=path.join(dir,'other');await writeFile(other,'original');
    await assert.rejects(downloadReleaseAsset({...options,destination:other,envelope:{...envelope,signature:Buffer.alloc(64).toString('base64')},fetchImpl:()=>{throw Error('must not fetch');}}));
    assert.equal(await readFile(other,'utf8'),'original');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('reject unsupported target, failed or oversized responses',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'codexkz-download-test-'));
  try{
    const destination=path.join(dir,'asset');
    await assert.rejects(downloadReleaseAsset({...options,platform:'darwin',destination,fetchImpl:()=>{throw Error('must not fetch');}}),/没有适用/);
    await assert.rejects(downloadReleaseAsset({...options,destination,fetchImpl:async()=>new Response(null,{status:404})}),/HTTP 404/);
    await assert.rejects(downloadReleaseAsset({...options,destination,fetchImpl:async()=>new Response('abcd',{headers:{'content-length':'4'}})}),/大小/);
    await assert.rejects(readFile(destination));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('interrupted download remains incomplete and cannot replace another file',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'codexkz-download-test-'));
  try{
    const destination=path.join(dir,'partial');
    const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('a'));controller.error(Error('connection lost'));}});
    await assert.rejects(downloadReleaseAsset({...options,destination,fetchImpl:async()=>new Response(stream)}),/connection lost/);
    assert.notEqual(await readFile(destination,'utf8'),'abc');
    await assert.rejects(downloadReleaseAsset({...options,destination,fetchImpl:async()=>new Response('abc')}));
  }finally{await rm(dir,{recursive:true,force:true});}
});
