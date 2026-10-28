import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Platform} from '../server/app.ts';
import {saveRoutingPolicy} from '../server/model-routing.ts';
import {Billing} from '../server/billing.ts';
import {readModelJSON} from './helpers/model-json.ts';
import {Store} from '../server/store.ts';
import {ControlledChat} from '../server/model.ts';

for(const engine of ['native','magpie'] as const)test(engine+': completed replies without credible token usage remain pending accounting, never zero-cost evidence',async()=>{
 let usage:any={prompt_tokens:0,completion_tokens:0},requests=0;
 const upstream=createServer(async(req,res)=>{await readModelJSON(req);requests++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'完整回复：保留原会话。'},finish_reason:'stop'}],...(usage===undefined?{}:{usage})})+'\n\ndata: [DONE]\n\n');});
 await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 const root=mkdtempSync(join(tmpdir(),'native-usage-evidence-')),app=new Platform({dataDir:root,mediaWorker:false,concurrency:500,videoConcurrency:500,model:{provider:'deepseek-official',model:'deepseek-flash',configId:'usage-fixture',fixture:true,apiKey:'synthetic-usage-only',baseURL:'http://127.0.0.1:'+(upstream.address() as any).port,reasoningEffort:'high'}});
 const admin=app.newUser({username:'usageadmin',password:'Synthetic-usage-20261021!'},'admin'),user=app.newUser({username:'usagemember',password:'Synthetic-usage-20261021!'},'member'),key='0123456789abcdef01234567',token='synthetic-local-hop';
 const instance={key,owner:user.id,project:'shared',token,active:0,closed:false};app.native.instances.set(key,instance as any);
 try{
  saveRoutingPolicy(app.store,app.catalog,admin,'shared',{engine,enabled:false,primaryModelId:'default',fallbackModelIds:[],maxAttempts:1,firstOutputTimeoutMs:10000,cooldownMs:0});await app.native.ensureModelServer();const base='http://127.0.0.1:'+(app.native as any).modelPort;
  const samples=[{name:'placeholder-zero',wire:{prompt_tokens:0,completion_tokens:0},known:false},{name:'absent',wire:undefined,known:false},{name:'reported',wire:{prompt_tokens:20,completion_tokens:10,prompt_tokens_details:{cached_tokens:8}},known:true},{name:'cached-input-only',wire:{prompt_tokens:20,completion_tokens:0,prompt_tokens_details:{cached_tokens:20}},known:true}];
  for(const [n,sample] of samples.entries()){
   usage=sample.wire;const r=await fetch(base+'/native-model/'+key+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Team-Native-Session':'session-usage'},body:JSON.stringify({model:'default',stream:true,max_tokens:256,messages:[{role:'user',content:'NATIVE_USAGE_'+n+'，保留完整回复，不重发。'}]})});
   const answer=await r.text();assert.equal(r.status,200,answer);assert.match(answer,/完整回复/);
   for(let t=0;t<100&&instance.active;t++)await delay(5);assert.equal(instance.active,0);assert.equal(requests,n+1,'usage accounting must not resend or create a fallback');
   const row=app.store.all('model-call').at(-1)!;assert.equal(row.completed,true);assert.equal(row.state,sample.known?'usage_recorded':'unconfirmed',sample.name);
   if(sample.known){assert(row.usage);assert.equal(row.usage.inputTokens+row.usage.cacheReadTokens,sample.wire!.prompt_tokens);assert(Number.isFinite(row.estimatedUsd));}
   else{assert.equal(row.usage,undefined);assert.equal(row.estimatedUsd,undefined);assert.equal(row.billing,'usage_unknown_pending_reconciliation');assert(row.reservedUsd>0);}
  }
  const billing=new Billing(app.store,app.catalog).list(admin,{details:true}),group=billing.groups.find((g:any)=>g.kind==='text')!;
  assert.equal(group.requestCount,4);assert.equal(group.usage.unknownCalls,2);assert.equal(group.estimate.unknownCount,2);assert.equal(group.usage.inputTokens,12);assert.equal(group.usage.cacheReadTokens,28);assert.equal(group.usage.outputTokens,10);
  assert.equal(app.store.all('image-job').length+app.store.all('video-job').length,0);assert.equal(app.options.concurrency,500);
 }finally{
  app.native.instances.delete(key);for(const u of app.store.all('user'))app.store.put('user',{...u,active:false});await app.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));rmSync(root,{recursive:true,force:true});
 }
});

test('legacy model adapter preserves successful output while zero or missing usage stays unconfirmed',async()=>{
 let usage:any={prompt_tokens:0,completion_tokens:0},requests=0;
 const upstream=createServer(async(req,res)=>{await readModelJSON(req);requests++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'旧入口回复保持正常。'},finish_reason:'stop'}],...(usage===undefined?{}:{usage})})+'\n\ndata: [DONE]\n\n');});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 const root=mkdtempSync(join(tmpdir(),'legacy-usage-evidence-')),store=new Store(root),owner='legacy-fixture-member';store.put('user',{id:owner,active:true});
 const connection={provider:'deepseek-official' as const,model:'deepseek-flash',configId:'legacy-usage',fixture:true,apiKey:'synthetic-usage-only',baseURL:'http://127.0.0.1:'+(upstream.address() as any).port,reasoningEffort:'high' as const};
 const execution:any={task:{id:'legacy-test',owner,project:'shared',workflow:'chat',release:{configId:connection.configId}},signal:new AbortController().signal,calls:0,onText:()=>{}};
 const model=new ControlledChat(store,connection,()=>execution);
 try{
  for(const [n,wire] of [{prompt_tokens:0,completion_tokens:0},undefined,{prompt_tokens:20,completion_tokens:10}].entries()){
   usage=wire;execution.calls=0;execution.modelCallId=undefined;const chunks:any[]=[];
   for await(const chunk of model.stream({provider:connection.provider,model:connection.model,sessionId:'session-legacy-usage',system:'合成验收',messages:[{role:'user',content:[{type:'text',text:'继续原聊天。'}]}],tools:[],maxTokens:128} as any))chunks.push(chunk);
   assert(chunks.some(c=>c.type==='text-delta'&&c.text.includes('旧入口回复')));assert.equal(requests,n+1);
   const row=store.all('model-call').at(-1)!;assert.equal(row.completed,true);assert.equal(row.state,n===2?'usage_recorded':'unconfirmed');if(n!==2){assert.equal(row.usage,undefined);assert.equal(row.estimatedUsd,undefined);assert(row.reservedUsd>0);}
  }
 }finally{store.put('user',{id:owner,active:false});store.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});
