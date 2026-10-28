import {test} from 'node:test';
import assert from 'node:assert/strict';
import {videoPayload, ConfiguredVideoAdapter, VideoCatalog} from '../server/video-catalog.ts';
import {Store,hash} from '../server/store.ts';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {reserveSingleShot} from '../server/single-shot-authorization.ts';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('frozen live acceptance has one permanent dispatch across retries and changed plans',()=>{
 const root=mkdtempSync(join(tmpdir(),'once-live-'));const channel={adapter:'xiaopei',origin:'https://api.aicopy.top'};const payload={model:'wan',prompt:'single shot',seconds:4,extra:{resolution:'720p'}};
 const auth={provider:'xiaopei',origin:channel.origin,model:'wan',maxCreates:1,requestSHA256:hash(JSON.stringify(payload)),sourceId:'TEST-S1'};
 writeFileSync(join(root,'authorization.json'),JSON.stringify(auth));
 assert.throws(()=>reserveSingleShot(root,channel,{...payload,seconds:5}));assert(!existsSync(join(root,'single-create-intent.json')));
 reserveSingleShot(root,channel,payload);const original=readFileSync(join(root,'single-create-intent.json'));
 assert.throws(()=>reserveSingleShot(root,channel,payload));assert.deepEqual(readFileSync(join(root,'single-create-intent.json')),original);
 const changed={...payload,prompt:'new round'};writeFileSync(join(root,'authorization.json'),JSON.stringify({...auth,requestSHA256:hash(JSON.stringify(changed))}));
 assert.throws(()=>reserveSingleShot(root,channel,changed));assert.deepEqual(JSON.parse(readFileSync(join(root,'request.json'),'utf8')),payload);
});

test('Xiaopei exact body mapping preserves prompt and references, without leaking generic fields',()=>{
 const p={model:'wan',prompt:'白天。原始提示词\n保持原样。',seconds:4,resolution:'720p',aspect_ratio:'16:9',audio:true,size:'1280x720',images:['https://example.invalid/original.png']};
 assert.deepEqual(videoPayload({adapter:'xiaopei'},p),{model:p.model,prompt:p.prompt,seconds:4,size:'1280x720',extra:{resolution:'720p',aspect_ratio:'16:9',generate_audio:true,reference_images:[{url:p.images[0],role:'reference_image'}]}});
 assert.deepEqual(videoPayload({adapter:'ruiyun'},p),{model:p.model,prompt:p.prompt,seconds:'4',size:'1280x720',extra:{resolution:'720p',aspect_ratio:'16:9',generate_audio:true,reference_images:[{url:p.images[0],role:'reference_image'}]}});
 assert.throws(()=>videoPayload({adapter:'xiaopei'},{...p,apiKey:'not-permitted'}));
});

test('Xiaopei dispatch sends exactly one POST after 429, 500 or network ambiguity; reads keep task ID',async()=>{
 const original=globalThis.fetch;const calls:any[]=[];const adapter=new ConfiguredVideoAdapter();const c={adapter:'xiaopei',origin:'https://api.aicopy.top'};const signal=new AbortController().signal;
 try {
  for(const status of [429,500]) {
   calls.length=0;globalThis.fetch=async(url,options)=>{calls.push({url:String(url),...options});return new Response('{"error":"upstream error"}',{status});};
   await assert.rejects(adapter.create(c,'test-secret',{model:'wan',seconds:4},signal));assert.equal(calls.length,1);assert.equal(calls[0].method,'POST');assert.equal(calls[0].redirect,'error');
  }
  calls.length=0;globalThis.fetch=async(url,options)=>{calls.push({url:String(url),...options});throw Error('ambiguous transport');};
  await assert.rejects(adapter.create(c,'test-secret',{model:'wan',seconds:4},signal));assert.equal(calls.length,1);
  calls.length=0;globalThis.fetch=async(url,options)=>{calls.push({url:String(url),...options});return new Response('{"id":"original-task","status":"completed"}');};
  await adapter.query(c,'test-secret','original-task',signal);await adapter.content(c,'test-secret','original-task',signal);
  assert(calls.every(x=>x.method==='GET'));assert(calls[1].url.endsWith('/original-task/content'));
  await assert.rejects(adapter.create({...c,origin:'https://unverified.invalid'},'test-secret',{},signal));assert.equal(calls.length,2);
 }finally{globalThis.fetch=original;}
});

test('catalog preserves Xiaopei identity and rejects a different credential destination',()=>{
 const store=new Store(mkdtempSync(join(tmpdir(),'xiaopei-catalog-')));try{
  const admin={id:'admin',role:'admin',active:true};store.put('user',admin);const cat=new VideoCatalog(store);
  const b={name:'小裴',origin:'https://api.aicopy.top',adapter:'xiaopei',apiKey:'synthetic-only',enabled:true,concurrency:1,noRetryEvidence:'test only'};
  const channel:any=cat.saveChannel(admin,b);assert.equal(channel.adapter,'xiaopei');assert.equal(channel.secretRef,undefined);assert.equal(channel.apiKey,undefined);assert.equal(channel.credentialConfigured,true);
  assert.throws(()=>cat.saveChannel(admin,{...b,origin:'http://127.0.0.1:1',allowLocalHTTP:true}));
 }finally{store.close();}
});

test('Xiaopei explicit queue message maps to queued, preserves raw status, and other unknown states remain unresolved',async()=>{
 const original=globalThis.fetch,adapter=new ConfiguredVideoAdapter(),c={adapter:'xiaopei',origin:'https://api.aicopy.top'};
 try{
  for(const message of ['排队中','处理中','',null]){
   globalThis.fetch=async()=>new Response(JSON.stringify({id:'known-id',status:'unknown',status_message:message,progress:0}));
   const value=await adapter.query(c,'fixture','known-id',new AbortController().signal);
   assert.equal(value.status,message==='排队中'?'queued':'unknown');assert.equal(value.status_message,message);
   if(message==='排队中')assert.equal(value.providerStatus,'unknown');
  }
 }finally{globalThis.fetch=original;}
});
