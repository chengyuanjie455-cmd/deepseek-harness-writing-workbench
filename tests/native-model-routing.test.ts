import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Platform} from '../server/app.ts';
import {saveRoutingPolicy,AUTO_MODEL_ID,publicModelRoute} from '../server/model-routing.ts';
import {Billing} from '../server/billing.ts';
import {budgetStatus} from '../server/model.ts';
const password='Synthetic-routing-test-123!';
test('native automatic and manual routes keep eight contexts separate, preserve wire inputs and reconcile each sent attempt',async()=>{
 const requests:any[]=[],root=mkdtempSync(join(tmpdir(),'native-routing-http-'));let failPrimary=true,failAll=false,mode='normal',primaryArrivals=0;let releaseBatch:()=>void;const initialBatch=new Promise<void>(r=>{releaseBatch=r;});
 const upstream=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push({path:req.url,key:req.headers.authorization,session:req.headers['x-team-native-session'],body});
  if(req.url?.startsWith('/a/')&&primaryArrivals<8){primaryArrivals++;if(primaryArrivals===8)releaseBatch();await initialBatch;}
  if(failAll||failPrimary&&req.url?.startsWith('/a/')){res.writeHead(503,{'Content-Type':'application/json'});return res.end('{"error":{"message":"synthetic failure"}}');}
  if(mode==='bad-request'){res.writeHead(400);return res.end('{"error":{"message":"synthetic invalid input"}}');}
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:'synthetic reply'},finish_reason:null}]})+'\n\n');
  if(mode==='broken'){setTimeout(()=>res.destroy(),15);return;}
  res.end('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,prompt_tokens_details:{cached_tokens:8}}})+'\n\ndata: [DONE]\n\n');
 });await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+(upstream.address() as any).port;
 writeFileSync(join(root,'chat-model-connections.json'),JSON.stringify(['a','b','c'].map(id=>({id,name:'Synthetic '+id,enabled:true,connection:{provider:'ruiyun',model:id==='c'?'model-a':'model-'+id,configId:id,reasoningEffort:'high',baseURL:base+'/'+id,apiKey:'synthetic-key-'+id,fixture:true,metadata:{id:'model-'+id,name:id,protocol:'chat',selectable:true,inputModalities:['text','image'],contextWindow:64000,maxTokens:id==='a'?128:512,supportsTools:true,efforts:['off','high']}}}))),{mode:0o600});
 const app=new Platform({dataDir:root,concurrency:500,videoConcurrency:500}),admin=app.newUser({username:'routeadmin',password},'admin'),users=Array.from({length:8},(_,n)=>app.newUser({username:'routemember'+n,password},'member'));
 const keys=users.map((u,n)=>(n+1).toString(16).padStart(24,'0')),token='synthetic-native-token';
 for(let n=0;n<users.length;n++)app.native.instances.set(keys[n],{key:keys[n],owner:users[n].id,project:'shared',token,active:0,closed:false} as any);
 await app.native.ensureModelServer();const url='http://127.0.0.1:'+(app.native as any).modelPort;
 const policy=(extra:any={})=>saveRoutingPolicy(app.store,app.catalog,admin,'shared',{enabled:true,primaryModelId:'a',fallbackModelIds:['b','c'],maxAttempts:3,firstOutputTimeoutMs:1000,cooldownMs:0,...extra});
 const input=(n:number,model=AUTO_MODEL_ID)=>({model,stream:true,max_tokens:1000,messages:[{role:'user',content:'ONLY_MEMBER_'+n},{role:'assistant',content:'prior answer',tool_calls:[{id:'read-'+n,type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'read-'+n,content:'prior result'},{role:'user',content:[{type:'text',text:'revise member '+n},{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}}]}],tools:[{type:'function',function:{name:'read',parameters:{type:'object'}}}],dsh_session_log:{synthetic:true},dsh_plugin_packages:{synthetic:true}});
 const send=(n:number,model=AUTO_MODEL_ID)=>fetch(url+'/native-model/'+keys[n]+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Team-Native-Session':'session-member-'+n},body:JSON.stringify(input(n,model))});
 try{
  policy();const results=await Promise.all(users.map((_,n)=>send(n)));assert.deepEqual(results.map(r=>r.status),users.map(()=>200));await Promise.all(results.map(r=>r.text()));
  for(let n=0;n<users.length;n++){
   const sent=requests.filter(r=>r.body.messages.some((m:any)=>m.content==='ONLY_MEMBER_'+n));assert.equal(sent.length,2);assert.equal(sent[0].path,'/a/chat/completions');assert.equal(sent[1].path,'/b/chat/completions');
   for(const r of sent){assert.deepEqual(r.body.messages,input(n).messages);assert.deepEqual(r.body.tools,input(n).tools);assert.equal(r.session,undefined,'member session IDs stay on the authenticated local hop');assert.equal(r.body.dsh_session_log,undefined);}
   assert.equal(sent[1].body.max_tokens,512);assert.equal(sent[1].key,'Bearer synthetic-key-b');
   const readback=publicModelRoute(app.store,keys[n],'session-member-'+n).route!;assert.equal(readback.actualModel,'model-b');assert.equal(readback.state,'completed');assert.equal(readback.attempted,2);
   assert.equal(publicModelRoute(app.store,keys[n],'session-member-'+((n+1)%8)).route,null);
  }
  const rows=app.store.all('model-call'),parents=rows.filter(r=>!r.routingAttempt),attempts=rows.filter(r=>r.routingAttempt);assert.equal(parents.length,8);assert.equal(attempts.length,8);
  for(const r of parents){assert.equal(r.configId,'b');assert.equal(r.model,'model-b');assert.equal(r.state,'usage_recorded');assert.equal(r.usage.inputTokens,12);assert.equal(r.usage.cacheReadTokens,8);assert.equal(r.usage.outputTokens,10);}
  for(const r of attempts){assert.equal(r.configId,'a');assert.equal(r.providerStatus,503);assert.equal(r.state,'unconfirmed');assert(r.parentCallId);assert(!r.usage);}
  // A member can deliberately select a different fixed model in the same chat;
  // the complete original history and image remain unchanged.
  const before=requests.length,manual=await send(0,'c');await manual.text();assert.equal(manual.status,200);assert.equal(requests.length,before+1);assert.equal(requests.at(-1).path,'/c/chat/completions');assert.deepEqual(requests.at(-1).body.messages,input(0).messages);
  failAll=true;const failed=await send(1);assert.equal(failed.status,503);await failed.text();const logical=app.store.all('model-call').filter(r=>!r.routingAttempt).at(-1)!;assert.equal(logical.state,'routing_failed');assert.equal(logical.reservedUsd,0);assert.equal(logical.billing,'not_dispatched_logical_request');assert.equal(app.store.all('model-call').filter(r=>r.parentCallId===logical.id).length,3);assert.equal(budgetStatus(app.store).unconfirmedCalls,11);const accounting=new Billing(app.store,app.catalog).list(admin,{details:true});assert(!accounting.entries!.some((r:any)=>r.id===logical.id));assert.equal(accounting.entries!.filter((r:any)=>app.store.get('model-call',r.id)?.parentCallId===logical.id).length,3);
  failAll=false;failPrimary=false;mode='broken';const beforeBroken=requests.length;const broken=await send(2);await assert.rejects(broken.text());assert.equal(requests.length,beforeBroken+1);assert.equal(app.store.all('model-route').at(-1)!.state,'interrupted');
  // Policy off remains exactly one old-style request, even on an upstream error.
  mode='normal';failPrimary=true;policy({enabled:false});const beforeDisabled=requests.length,disabled=await send(3,'a');assert.equal(disabled.status,503);await disabled.text();assert.equal(requests.length,beforeDisabled+1);
  assert.equal(app.options.concurrency,500);assert.equal(app.options.videoConcurrency,500);assert.equal(app.store.all('image-job').length+app.store.all('video-job').length,0);
  // The existing admin boundary applies to routing configuration and is not a
  // member model-selection restriction.
  const port=await app.start(0),publicURL='http://127.0.0.1:'+port;
  async function login(username:string){const r=await fetch(publicURL+'/api/login',{method:'POST',headers:{Origin:publicURL,'Content-Type':'application/json'},body:JSON.stringify({username,password})});const body=await r.json();return {cookie:r.headers.get('set-cookie')!.split(';')[0],csrf:body.csrf};}
  const member=await login('routemember0'),auth=await login('routeadmin');
  const denied=await fetch(publicURL+'/api/admin/model-routing',{method:'POST',headers:{Origin:publicURL,Cookie:member.cookie,'X-CSRF-Token':member.csrf,'Content-Type':'application/json'},body:JSON.stringify({enabled:true})});assert.equal(denied.status,403);
  const settings=await(await fetch(publicURL+'/api/admin/chat-models',{headers:{Cookie:auth.cookie}})).json();assert.equal(settings.routing.enabled,false);assert(!JSON.stringify(settings).includes('synthetic-key'));
 }finally{
  for(const key of keys)app.native.instances.delete(key);await app.close();await new Promise<void>(r=>upstream.close(()=>r()));rmSync(root,{recursive:true,force:true});
 }
});
