import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Platform} from '../server/app.ts';
import {NativeHarness} from '../server/native-harness.ts';
import {NativeStaticCache,nativeStaticPath} from '../server/native-static.ts';

test('simultaneous opens share one startup; existing and active environments are retained',async()=>{
 const native=new NativeHarness({root:'/tmp/native-startup-fixture',get:()=>({active:true}),all:()=>[]} as any,{available:()=>[{id:'fixture'}],modelConnection:()=>undefined} as any,()=>({} as any));let starts=0;let release:any;const gate=new Promise<void>(r=>release=r);
 native.start=async i=>{starts++;native.phase(i,'runtime');await gate;native.phase(i,'ready');};native.runtimeHealth=async()=>({healthy:true,running:true});
 const user={id:'fixture'},opens=Array.from({length:8},()=>native.open(user,'shared'));release();const instances=await Promise.all(opens);assert.equal(starts,1);assert(instances.every(i=>i===instances[0]));assert.equal((await native.connection(user,'shared')).state,'ready');await native.open(user,'shared');assert.equal(starts,1);
 native.runtimeHealth=async()=>({healthy:false,running:false});instances[0].active=1;await native.open(user,'shared');assert.equal(starts,1);instances[0].active=0;await native.open(user,'shared');assert.equal(starts,2);native.instances.clear();await native.close();
});
test('distinct account/project environments can exceed twelve without evicting existing sessions',async()=>{
 const native=new NativeHarness({root:'/tmp/native-unlimited-fixture',get:()=>({active:true}),all:()=>[]} as any,{available:()=>[{id:'fixture'}],modelConnection:()=>undefined} as any,()=>({} as any));let starts=0;
 native.start=async i=>{starts++;native.phase(i,'ready');};native.runtimeHealth=async()=>({healthy:true,running:true});
 try{
  const users=Array.from({length:16},(_,n)=>({id:'member-'+n}));
  const instances=await Promise.all(users.flatMap(u=>['project-a','project-b'].map(p=>native.open(u,p))));
  assert.equal(starts,32);assert.equal(new Set(instances.map(i=>i.key)).size,32);assert(instances.every(i=>!i.closed));
  const original=instances[0];original.active=1;
  assert.equal(await native.open(users[0],'project-a'),original);assert.equal(starts,32);assert.equal(original.active,1);
 }finally{native.instances.clear();await native.close();}
});
test('bundled cache is bounded and excludes HTML, API and project data',()=>{assert(nativeStaticPath('GET','/plugins/@deepseek/client.js'));for(const path of ['/','/api/session/export.js','/plugins/user.json','/assets/picture.png','/files/secret.css'])assert(!nativeStaticPath('GET',path));assert(!nativeStaticPath('POST','/assets/app.js'));const cache=new NativeStaticCache(6);cache.put('one',Buffer.from('1111'),'text/css');cache.put('two',Buffer.from('2222'),'text/css');assert(!cache.get('one'));assert.equal(cache.get('two')?.body.toString(),'2222');});
test('static revalidation returns 304 after authentication; HTML and API remain private and uncached',async()=>{
 let upstreamHits=0;const upstream=createServer((req,res)=>{upstreamHits++;res.setHeader('Content-Type',req.url==='/plugins/app.js'?'text/javascript':req.url==='/'?'text/html':'application/json');res.end(req.url==='/plugins/app.js'?'const file="/assets/app.css";':req.url==='/'?'<html><head></head><body></body></html>':'{"private":true}');});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 const root=mkdtempSync(join(tmpdir(),'native-cache-')),app=new Platform({dataDir:root,mockDelay:1});const base='http://127.0.0.1:'+await app.start(0),user=app.newUser({username:'cacheadmin',password:'synthetic-cache-123'},'admin');
 const i:any={key:'fixture',owner:user.id,project:'shared',port:(upstream.address() as any).port,cookie:'fixture',token:'fixture',closed:false,active:0};app.native.get=async()=>i;
 try{
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'cacheadmin',password:'synthetic-cache-123'})});const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const first=await fetch(base+'/harness/shared/plugins/app.js',{headers:{Cookie:cookie}});const text=await first.text(),etag=first.headers.get('etag')!;assert(text.includes('/harness/shared/assets/app.css'));assert.equal(first.headers.get('cache-control'),'private, no-cache');assert(etag);assert.equal(upstreamHits,1);
  const again=await fetch(base+'/harness/shared/plugins/app.js',{headers:{Cookie:cookie,'If-None-Match':etag}});assert.equal(again.status,304);assert.equal(upstreamHits,1);
  const blocked=await fetch(base+'/harness/shared/plugins/app.js',{headers:{'If-None-Match':etag}});assert.equal(blocked.status,401);
  const html=await fetch(base+'/harness/shared/',{headers:{Cookie:cookie}});assert.equal(html.headers.get('cache-control'),'no-store');assert((await html.text()).includes('team-native-ready'));
  const api=await fetch(base+'/harness/shared/api/read',{headers:{Cookie:cookie}});assert.equal(api.headers.get('cache-control'),'no-store');assert.equal(api.headers.get('etag'),null);await api.text();
 }finally{await app.close();await new Promise<void>(r=>upstream.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
