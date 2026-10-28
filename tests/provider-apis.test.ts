import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {Platform} from '../server/app.ts';
import {ChatCatalog} from '../server/chat-catalog.ts';
import {Billing} from '../server/billing.ts';
import {budgetStatus,modelPricing} from '../server/model.ts';
import {CHAT_PROVIDERS} from '../shared/chat-providers.ts';

const password='Synthetic-provider-test-123!';
test('all administrator API presets persist privately; all members can select Coding Plan; cross-provider edits require a new key',async()=>{
 const root=mkdtempSync(join(tmpdir(),'provider-admin-')),app=new Platform({dataDir:root});
 try{
  const admin=app.newUser({username:'admin',password},'admin'),a=app.newUser({username:'membera',password},'member'),b=app.newUser({username:'memberb',password},'member');
  const ids:string[]=[];const codingIndex=CHAT_PROVIDERS.findIndex(p=>p.id==='zhipu-coding');
  for(const p of CHAT_PROVIDERS){const body={name:p.name,provider:p.id,model:p.models[0],baseURL:p.baseURL,reasoningEffort:'high',apiKey:'fixture-secret-'+p.id,enabled:true,roles:['admin','member'],...(p.id==='zhipu-coding'?{accountUserId:a.id}:{})};const saved=app.catalog.saveModel(admin,body)!;ids.push(saved.id);assert(!JSON.stringify(saved).includes(body.apiKey));assert.throws(()=>app.catalog.saveModel(admin,{...body,baseURL:'https://attacker.example/api'}));}
  app.catalog.savePolicy(admin,'shared',{modelIds:ids,permissions:['workspace-write'],multipleSessions:true});
  assert.equal(app.catalog.available(a,'shared').length,CHAT_PROVIDERS.length+1);assert.equal(app.catalog.available(b,'shared').length,CHAT_PROVIDERS.length+1);assert.equal(app.catalog.select(b,'shared',ids[codingIndex]).modelId,ids[codingIndex]);
  const coding=CHAT_PROVIDERS[codingIndex],base={id:ids[0],name:'changed',provider:coding.id,model:coding.models[0],baseURL:coding.baseURL,reasoningEffort:'high',apiKey:'',accountUserId:a.id,enabled:true,roles:['member']};assert.throws(()=>app.catalog.saveModel(admin,base),/密钥/);
  assert.equal(app.catalog.saveModel(admin,{...base,id:ids[codingIndex],accountUserId:''})!.id,ids[codingIndex]);
  assert.throws(()=>app.catalog.saveModel(admin,{...base,id:ids[codingIndex],reasoningEffort:'off'}),/推理档位/);
  const disk=JSON.parse(readFileSync(join(root,'chat-model-connections.json'),'utf8'));assert.equal(disk.length,CHAT_PROVIDERS.length);assert.equal(statSync(join(root,'chat-model-connections.json')).mode&0o777,0o600);
  const restarted=new ChatCatalog(app.store);assert.equal(restarted.available(a,'shared').length,CHAT_PROVIDERS.length+1);assert.equal(restarted.available(b,'shared').length,CHAT_PROVIDERS.length+1);
  const billing=new Billing(app.store,app.catalog),price=billing.prices().find(p=>p.key==='text:'+ids[codingIndex])!;assert.equal(price.pricing.billingMode,'subscription');assert.equal(price.pricing.inputPerMillion,null);assert.throws(()=>billing.reviewPrice(admin,{key:price.key,fingerprint:price.fingerprint,evidence:'fixture'}),/套餐/);
  assert.equal(modelPricing(disk.find((r:any)=>r.connection.provider==='deepseek-official').connection).inputPerMillion,0.3);assert.equal(modelPricing({...disk.find((r:any)=>r.connection.provider==='opencode-zen').connection,model:'glm-5.3'}).inputPerMillion,1.4);
  const port=await app.start(0),url='http://127.0.0.1:'+port;
  const auth=await fetch(url+'/api/login',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({username:'membera',password})}),cookie=auth.headers.get('set-cookie')!.split(';')[0];
  const denied=await fetch(url+'/api/admin/chat-models',{headers:{Cookie:cookie}});assert.equal(denied.status,403);
  const options=await(await fetch(url+'/api/chat-options',{headers:{Cookie:cookie}})).json();assert(!JSON.stringify(options).includes('fixture-secret'));assert(!JSON.stringify(options).includes('pricing'));
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('native concurrent providers keep independent keys, model parameters, multi-turn tools, subscription usage and no paid fallback',async()=>{
 const requests:any[]=[];let rejectCoding=false;
 const upstream=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push({path:req.url,key:req.headers.authorization,body});if(rejectCoding&&req.url?.includes('zhipu-coding')){res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'fixture subscription quota exceeded'}}));}res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'fixture response'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,prompt_tokens_details:{cached_tokens:8}}})+'\n\ndata: [DONE]\n\n');});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 const root=mkdtempSync(join(tmpdir(),'provider-wire-')),up='http://127.0.0.1:'+(upstream.address() as any).port;
 writeFileSync(join(root,'chat-model-connections.json'),JSON.stringify(CHAT_PROVIDERS.map(p=>({id:p.id,name:p.name,roles:['admin','member'],enabled:true,connection:{provider:p.id,model:p.models[0],baseURL:up+'/'+p.id,reasoningEffort:'max',configId:p.id,apiKey:'fixture-key-'+p.id,fixture:true,...(p.id==='ruiyun'?{metadata:{id:p.models[0],name:p.name,protocol:'chat',selectable:true,efforts:['off','low','high','max'],maxTokens:128,contextWindow:8192,inputModalities:['text']}}:{})}}))),{mode:0o600});
 const app=new Platform({dataDir:root}),member=app.newUser({username:'member',password},'member'),key='0123456789abcdef01234567',token='fixture-token';
 app.catalog.savePolicy(member,'shared',{modelIds:CHAT_PROVIDERS.map(p=>p.id),permissions:['workspace-write'],multipleSessions:true});
 app.native.instances.set(key,{key,owner:member.id,project:'shared',active:0,closed:false,token} as any);
 const proxy=createServer((req,res)=>void app.native.model(req,res).catch(e=>{res.writeHead(500);res.end(e.message);}));await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+(proxy.address() as any).port+'/native-model/'+key+'/chat/completions';
 const messages:any[]=[{role:'user',content:'first scene'},{role:'assistant',content:'plan',tool_calls:[{id:'call-1',type:'function',function:{name:'project_read',arguments:'{}'}}]},{role:'tool',tool_call_id:'call-1',content:'scene file'},{role:'user',content:'revise the prior scene'}],tool=[{type:'function',function:{name:'project_read',parameters:{type:'object'}}}];
 const send=async(provider:string)=>{const r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({model:provider,messages,tools:tool,stream:true,max_tokens:1000,thinking:{type:'disabled'},reasoning_effort:'off',dsh_plugin_packages:{fixture:true},dsh_session_log:{fixture:true}})});await r.text();return r.status;};
 try{
  assert.deepEqual(await Promise.all(CHAT_PROVIDERS.map(p=>send(p.id))),CHAT_PROVIDERS.map(()=>200));assert.equal(requests.length,CHAT_PROVIDERS.length);
  for(const p of CHAT_PROVIDERS){const r=requests.find(r=>r.path==='/'+p.id+'/chat/completions');assert.equal(r.key,'Bearer fixture-key-'+p.id);assert.equal(r.body.model,p.models[0]);assert.equal(r.body.max_tokens,p.id==='ruiyun'?128:1000);assert.deepEqual(r.body.messages,messages);assert.deepEqual(r.body.tools,tool);if(p.id==='deepseek-official'){assert.equal(r.body.reasoning_effort,undefined);assert.deepEqual(r.body.thinking,{type:'disabled'});}if(p.id==='opencode-zen')assert.equal(r.body.thinking,undefined);if(p.id==='zhipu-coding'){assert.deepEqual(r.body.thinking,{type:'enabled',clear_thinking:true});assert.equal(r.body.tool_stream,true);}if(p.id!=='deepseek-official'){assert.equal(r.body.reasoning_effort,p.id==='ruiyun'?undefined:'max');assert.equal(r.body.dsh_plugin_packages,undefined);}}
  const rows=app.store.all('model-call');assert.equal(rows.length,CHAT_PROVIDERS.length);for(const r of rows){assert.equal(r.state,'usage_recorded');assert.equal(r.usage.cacheReadTokens,8);assert.equal(r.usage.inputTokens,12);}
  const subscription=rows.find(r=>r.provider==='zhipu-coding')!;assert.equal(subscription.estimatedUsd,undefined);assert.equal(subscription.reservedUsd,undefined);assert.equal(subscription.billing,'subscription_usage_pending_reconciliation');assert(Number.isFinite(budgetStatus(app.store).usedEstimateUsd));
  rejectCoding=true;assert.equal(await send('zhipu-coding'),429);assert.equal(requests.length,CHAT_PROVIDERS.length+1,'quota failure must neither retry nor switch to another API');assert.equal(app.store.all('model-call').at(-1)!.providerStatus,429);
 }finally{app.native.instances.delete(key);await app.close();await Promise.all([new Promise<void>(r=>proxy.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);rmSync(root,{recursive:true,force:true});}
});


test('legacy project lists, administrator roles and account ownership no longer block member model selection',async()=>{
 const root=mkdtempSync(join(tmpdir(),'free-models-'));const connection={provider:'zhipu-coding',model:'glm-5.3',baseURL:'https://open.bigmodel.cn/api/coding/paas/v4',apiKey:'fixture-free-selection-secret',configId:'free',reasoningEffort:'high'};
 writeFileSync(join(root,'chat-model-connections.json'),JSON.stringify([{id:'coding',name:'Coding fixture',enabled:true,roles:['admin'],accountUserId:'another-account',connection},{id:'disabled',name:'disabled',enabled:false,roles:['admin','member'],connection:{...connection,configId:'disabled'}}]));
 const app=new Platform({dataDir:root});try{const a=app.newUser({username:'membera',password},'member'),b=app.newUser({username:'memberb',password},'member');
 app.store.put('chat-policy',{id:'shared',modelIds:['default'],multipleSessions:true,permissions:['workspace-write']});
 for(const member of [a,b])for(const project of ['shared','new-project']){assert.deepEqual(app.catalog.available(member,project).map(m=>m.id),['default','coding']);assert.equal(app.catalog.select(member,project,'coding').modelId,'coding');assert.throws(()=>app.catalog.select(member,project,'disabled'),/未启用/);}
 assert.deepEqual(app.catalog.policy('shared').modelIds,['default','coding']);assert(!JSON.stringify(app.catalog.options(a,'shared')).includes(connection.apiKey));assert(!JSON.stringify(app.catalog.options(a,'shared')).includes('another-account'));
 const restarted=new ChatCatalog(app.store);assert.equal(restarted.select(b,'new-project','coding').modelId,'coding');
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
