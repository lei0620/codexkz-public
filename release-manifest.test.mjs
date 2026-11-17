import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {compareReleaseVersions,selectReleaseAsset,signReleaseManifest,validateReleaseManifest,verifyReleaseFile,verifyReleaseManifest} from './release-manifest.mjs';

const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const asset={platform:'win32',arch:'x64',url:'https://github.com/lei0620/paiban/releases/download/v1.2.3/panel.zip',size:3,sha256:createHash('sha256').update('abc').digest('hex')};
const manifest={schemaVersion:1,version:'1.2.3',notes:'修复和更新',assets:[asset]};

test('signed exact payload and release target round-trip',()=>{
  const envelope=signReleaseManifest(manifest,privateKey);
  const verified=verifyReleaseManifest(envelope,publicKey);
  assert.deepEqual(verified,manifest);
  assert.deepEqual(selectReleaseAsset(verified,{version:'1.2.2',platform:'win32',arch:'x64'}),asset);
  assert.equal(selectReleaseAsset(verified,{version:'1.2.3',platform:'win32',arch:'x64'}),null);
  assert.equal(selectReleaseAsset(verified,{version:'0.9.0',platform:'darwin',arch:'arm64'}),null);
});

test('reject modified payload, signature, key and malformed encoding',()=>{
  const envelope=signReleaseManifest(manifest,privateKey),other=generateKeyPairSync('ed25519');
  assert.throws(()=>verifyReleaseManifest({...envelope,payload:Buffer.from('{}').toString('base64')},publicKey));
  assert.throws(()=>verifyReleaseManifest({...envelope,signature:Buffer.alloc(64).toString('base64')},publicKey));
  assert.throws(()=>verifyReleaseManifest(envelope,other.publicKey));
  assert.throws(()=>verifyReleaseManifest({...envelope,payload:envelope.payload+'\n'},publicKey));
  assert.throws(()=>verifyReleaseManifest({...envelope,extra:true},publicKey));
});

test('reject signed malformed UTF-8 and invalid shape',()=>{
  const payload=Buffer.from([0xff]),signature=sign(null,payload,privateKey);
  assert.throws(()=>verifyReleaseManifest({payload:payload.toString('base64'),signature:signature.toString('base64')},publicKey));
  assert.throws(()=>signReleaseManifest({...manifest,assets:[asset,asset]},privateKey));
  assert.throws(()=>validateReleaseManifest({...manifest,version:'1.2.3-beta'}));
  assert.throws(()=>validateReleaseManifest({...manifest,assets:[{...asset,url:'https://github.com.evil.test/lei0620/paiban/releases/download/v1.2.3/x'}]}));
  assert.throws(()=>validateReleaseManifest({...manifest,assets:[{...asset,url:'https://github.com/lei0620/paiban/releases/download/v1.2.3/%2e%2e/other'}]}));
  assert.throws(()=>validateReleaseManifest({...manifest,assets:[{...asset,size:0}]}));
});

test('compare release versions numerically without accepting ambiguous versions',()=>{
  assert.equal(compareReleaseVersions('2.0.0','1.100.100'),1);
  assert.equal(compareReleaseVersions('1.2.3','1.2.3'),0);
  assert.equal(compareReleaseVersions('1.2.3','1.2.10'),-1);
  for(const invalid of ['01.2.3','1.2','1.2.3+meta','-1.0.0','1.2.3\n'])assert.throws(()=>compareReleaseVersions(invalid,'1.0.0'));
});

test('file size and digest must both match',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'codexkz-release-test-'));
  try{
    const file=path.join(directory,'asset');await writeFile(file,'abc');assert.equal(await verifyReleaseFile(file,asset),true);
    await writeFile(file,'abd');await assert.rejects(verifyReleaseFile(file,asset));
    await writeFile(file,'abcd');await assert.rejects(verifyReleaseFile(file,asset));
    await writeFile(file,'ab');await assert.rejects(verifyReleaseFile(file,asset));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('signing tool checks local asset and refuses to overwrite output',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'codexkz-sign-test-'));
  try{
    const file=path.join(directory,'manifest.json'),key=path.join(directory,'key.pem'),output=path.join(directory,'signed.json');
    await writeFile(file,JSON.stringify(manifest));await writeFile(key,privateKey.export({format:'pem',type:'pkcs8'}));await writeFile(path.join(directory,'panel.zip'),'abc');
    const run=promisify(execFile),script=fileURLToPath(new URL('./scripts/sign-release.mjs',import.meta.url));
    await run(process.execPath,[script,file,key,directory,output]);
    assert.deepEqual(verifyReleaseManifest(JSON.parse(await readFile(output,'utf8')),publicKey),manifest);
    await assert.rejects(run(process.execPath,[script,file,key,directory,output]));
    await writeFile(path.join(directory,'panel.zip'),'bad');
    await assert.rejects(run(process.execPath,[script,file,key,directory,path.join(directory,'bad.json')]));
  }finally{await rm(directory,{recursive:true,force:true});}
});
