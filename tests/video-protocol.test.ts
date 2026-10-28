import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { Store } from '../server/store.ts';
import { MediaStore } from '../server/media.ts';
import { VideoCatalog, RuiyunAdapter, apiOrigin } from '../server/video-catalog.ts';
import { VideoStorage } from '../server/video-storage.ts';

test('Ruiyun sends one POST, refuses redirects and retains explicit local HTTP policy',async()=>{
 let calls=0,authorized=false;const server=createServer((req,res)=>{calls++;authorized=req.headers.authorization==='Bearer fixture';req.resume();if(req.url==='/v1/videos'){res.writeHead(502,{'Content-Type':'application/json'});res.end('{"error":"injected"}');}else{res.writeHead(302,{Location:'http://127.0.0.1:1/'});res.end();}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 try{const adapter=new RuiyunAdapter();await assert.rejects(adapter.create({origin},'fixture',{model:'fixture',prompt:'synthetic'},new AbortController().signal));assert.equal(calls,1);assert(authorized);await assert.rejects(adapter.content({origin},'fixture','known',new AbortController().signal));assert.equal(calls,2);
  assert.equal(apiOrigin(origin,true).origin,origin);assert.throws(()=>apiOrigin(origin,false));assert.throws(()=>apiOrigin('http://114.66.27.232:3000',true));assert.throws(()=>apiOrigin('https://user:key@example.com',false));
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('S3 original bytes, upload readback, reuse and pre-upload drift fencing; secrets remain server-only',async()=>{
 const root=mkdtempSync(join(tmpdir(),'video-storage-test-'));const store=new Store(root);const originalFetch=globalThis.fetch;
 try{
  store.put('user',{id:'admin',role:'admin',active:true});new VideoCatalog(store);const media=new MediaStore(store);const storage=new VideoStorage(store,media);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6TSEAAAAASUVORK5CYII=','base64');
  const asset=await media.ingest(Readable.from(png),'admin','project','fixture.png');
  const conf=storage.save({id:'admin'},{origin:'https://storage.invalid',bucket:'team-fixture',region:'auto',accessKeyId:'fixture-access',secretAccessKey:'fixture-secret-never-expose',enabled:true});
  assert(!JSON.stringify(conf).includes('fixture-secret'));assert(!JSON.stringify(conf).includes('fixture-access'));
  let uploaded:Buffer|undefined,puts=0;
  globalThis.fetch=async (input:any,init:any)=>{const u=new URL(String(input));assert.equal(u.origin,'https://storage.invalid');assert(!u.toString().includes('fixture-secret'));assert(u.searchParams.has('X-Amz-Signature'));
   if(init?.method==='PUT'){puts++;const parts:Buffer[]=[];for await(const c of init.body)parts.push(c);uploaded=Buffer.concat(parts);return new Response('',{status:200});}
   return uploaded?new Response(new Uint8Array(uploaded)):new Response('',{status:404});
  };
  await storage.prepare({mediaId:asset.id,sha256:asset.sha256},conf!.revision,new AbortController().signal);assert.deepEqual(uploaded,png);assert.equal(puts,1);
  await storage.prepare({mediaId:asset.id,sha256:asset.sha256},conf!.revision,new AbortController().signal);assert.equal(puts,1);assert.equal(store.all('video-upload').filter(u=>u.uploaded).length,1);
  writeFileSync(media.path(asset.id),Buffer.from('changed'));await assert.rejects(storage.prepare({mediaId:asset.id,sha256:asset.sha256},conf!.revision,new AbortController().signal),/哈希/);assert.equal(puts,1);
 }finally{globalThis.fetch=originalFetch;store.close();}
});
