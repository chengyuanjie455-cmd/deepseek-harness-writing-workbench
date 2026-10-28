import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {WebSocketServer,WebSocket} from 'ws';import {Platform} from '../server/app.ts';
test('removing a vanished LAN listener closes its upgraded sockets without stopping the healthy host',async()=>{
 const root=mkdtempSync(join(tmpdir(),'lan-ws-close-')),app=new Platform({dataDir:root,mockDelay:1,allowLanHttp:true});app.newUser({username:'admin',password:'synthetic-pass-1234'},'admin');const port=await app.start(0),lanPort=await app.addLanListener('127.0.0.1',0);
 const server=(app as any).lanListeners.get('127.0.0.1:'+lanPort),wsServer=new WebSocketServer({noServer:true});server.removeAllListeners('upgrade');server.on('upgrade',(req:any,socket:any,head:any)=>wsServer.handleUpgrade(req,socket,head,ws=>wsServer.emit('connection',ws,req)));
 const client=new WebSocket('ws://127.0.0.1:'+lanPort),closed=new Promise<void>(r=>client.once('close',()=>r()));
 try{
  await new Promise<void>((r,j)=>{client.once('open',()=>r());client.once('error',j);});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([Promise.all([app.removeLanListener('127.0.0.1',lanPort),closed]),new Promise((_,j)=>{timer=setTimeout(()=>j(Error('upgraded socket prevented LAN shutdown')),2000);})]);}finally{clearTimeout(timer);}
  assert.equal((await fetch('http://127.0.0.1:'+port+'/api/status')).status,200);assert.equal(client.readyState,WebSocket.CLOSED);
 }finally{client.terminate();for(const c of wsServer.clients)c.terminate();wsServer.close();await app.close();rmSync(root,{recursive:true,force:true});}
});
