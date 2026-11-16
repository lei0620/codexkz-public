import fs from 'node:fs';
import net from 'node:net';
import {createHash} from 'node:crypto';
const leases=new WeakMap();
export const ownsDataLock=(lease,dataDir)=>leases.get(lease)?.active===true&&leases.get(lease).address===dataLockAddress(dataDir);

// File identity, not spelling or PID: junctions, short paths and drive aliases
// must contend for the same kernel object. No stale file is ever unlinked.
export function dataLockAddress(dataDir){
  const directory=fs.realpathSync.native(dataDir),stat=fs.statSync(directory,{bigint:true});
  if(!stat.isDirectory()||stat.ino===0n)throw Error('无法确认数据目录的文件系统身份，已停止启动');
  const key=createHash('sha256').update(`${stat.dev}:${stat.ino}`).digest('hex');
  if(process.platform==='win32')return `\\\\.\\pipe\\codexkz-data-${key}`;
  // Linux abstract sockets have the same kernel-owned lifetime (Node 20.8+).
  if(process.platform==='linux')return `\0codexkz-data-${key}`;
  throw Error('当前平台未实现数据目录内核锁，已停止启动');
}

export async function acquireDataLock(dataDir){
  const address=dataLockAddress(dataDir);
  const server=net.createServer(socket=>{socket.on('error',()=>{});socket.destroy();});
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen({path:address,exclusive:true},()=>{server.removeListener('error',reject);resolve();});
    });
  }catch(cause){
    server.close();
    const error=new Error(cause.code==='EADDRINUSE'
      ?'此数据目录已有服务持有写入锁；请使用已有面板，或等待其正常退出后再启动。'
      :'无法取得数据目录写入锁，已停止启动：'+cause.message,{cause});
    error.code=cause.code==='EADDRINUSE'?'PANEL_DATA_LOCKED':cause.code;
    throw error;
  }
  let released;const record={address,active:true};
  const lease={release:()=>{record.active=false;return released??=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
  leases.set(lease,record);return lease;
}
