import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Platform} from '../server/app.ts';
import {ChatCatalog} from '../server/chat-catalog.ts';
import {modelProtocol,discoverModels} from '../server/model-directory.ts';
import {fetchModel} from '../server/model-transport.ts';
import {modelPricing} from '../server/model.ts';
const password='Synthetic-catalog-123!';
test('complete credential-scoped catalogs refresh, persist, inherit secrets and expose enabled models to every member',async()=>{
 const root=mkdtempSync(join(tmpdir(),'model-directory-')),app=new Platform({dataDir:root});
 try{const admin=app.newUser({username:'admin',password},'admin'),member=app.newUser({username:'member',password},'member');
 const base={name:'fixture',provider:'opencode-zen',model:'glm-5.3-flash',baseURL:'https://opencode.ai/zen/v1',reasoningEffort:'high',apiKey:'fixture-catalog-secret',enabled:true,roles:['admin','member']};const original=app.catalog.saveModel(admin,base)!;
 let calls=0;const stub=(async(url,init)=>{calls++;assert.equal(url,base.baseURL+'/models');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+base.apiKey);return Response.json({data:[{id:'gpt-next'},{id:'claude-next'},{id:'gemini-next'},{id:'future-chat-model'},{id:'jev-1.13'},{id:'future-chat-model'}]});}) as typeof fetch;
 const directory=await app.catalog.directory(admin,{provider:base.provider,sourceId:original.id},stub);assert.equal(directory.models.length,5);assert.equal(directory.models.filter((m:any)=>m.selectable).length,4);assert(!JSON.stringify(directory).includes(base.apiKey));
 const created=app.catalog.saveModel(admin,{...base,apiKey:'',sourceId:original.id,model:'gpt-next'})!;assert.equal(created.protocol,'responses');assert.equal(app.catalog.available(member,'shared').length,3,'newly configured models are immediately selectable without project assignment');
 const restart=new ChatCatalog(app.store);await restart.directory(admin,{provider:base.provider,sourceId:created.id},stub);assert.equal(calls,1,'successful catalog persists');
 const stale=await restart.directory(admin,{provider:base.provider,sourceId:created.id,refresh:true},async()=>{throw Error('secret error');});assert((stale as any).stale);assert(!JSON.stringify(stale).includes('secret error'));
 await assert.rejects(restart.directory(admin,{provider:base.provider,apiKey:'different-fixture-key'},async()=>Response.json({},{status:401})),/401/);
 assert.throws(()=>restart.saveModel(admin,{...base,apiKey:'',sourceId:original.id,model:'unlisted'}),/目录/);assert.throws(()=>restart.saveModel(admin,{...base,apiKey:'',sourceId:original.id,model:'jev-1.13'}),/聊天/);
 assert.equal(modelPricing({...base,configId:'x',model:'gpt-next'} as any).inputPerMillion,null);
 const port=await app.start(0),url='http://127.0.0.1:'+port;const login=await fetch(url+'/api/login',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({username:'member',password})});const cookie=login.headers.get('set-cookie')!.split(';')[0],auth=await login.json();
 const denied=await fetch(url+'/api/admin/chat-model-directory',{method:'POST',headers:{Cookie:cookie,Origin:url,'Content-Type':'application/json','X-CSRF-Token':auth.csrf},body:JSON.stringify({provider:base.provider,sourceId:original.id})});assert.equal(denied.status,403);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
const sse=(rows:any[])=>new Response(rows.map(v=>'data: '+JSON.stringify(v)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
const responseEvents=(tool:boolean)=>[
 {type:'response.created',response:{id:'resp_fixture',created_at:1,model:'gpt-5-nano'}},
 ...(tool?[{type:'response.output_item.added',output_index:0,item:{type:'function_call',id:'fc_1',call_id:'call_1',name:'project_read',arguments:''}},{type:'response.output_item.done',output_index:0,item:{type:'function_call',id:'fc_1',call_id:'call_1',name:'project_read',arguments:'{"path":"scene.txt"}',status:'completed'}}]:[{type:'response.output_item.added',output_index:0,item:{type:'message',id:'msg_1',role:'assistant',content:[]}},{type:'response.output_text.delta',item_id:'msg_1',output_index:0,content_index:0,delta:'OK'},{type:'response.output_item.done',output_index:0,item:{type:'message',id:'msg_1'}}]),
 {type:'response.completed',response:{usage:{input_tokens:20,output_tokens:3,total_tokens:23,input_tokens_details:{cached_tokens:5},output_tokens_details:{reasoning_tokens:0}}}}
];
const messageEvents=(tool:boolean)=>[
 {type:'message_start',message:{id:'msg_1',model:'claude-haiku-4-5',role:'assistant',usage:{input_tokens:15,cache_read_input_tokens:5}}},
 {type:'content_block_start',index:0,content_block:tool?{type:'tool_use',id:'call_1',name:'project_read',input:{}}:{type:'text',text:''}},
 {type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:'{"path":"scene.txt"}'}:{type:'text_delta',text:'OK'}},
 {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:3}},{type:'message_stop'}
];
for(const protocol of ['responses','messages','google'] as const)test(protocol+' streams tools, preserves continuation and usage without retry or key crossover',async()=>{
 const root=mkdtempSync(join(tmpdir(),'protocol-')),app=new Platform({dataDir:root});
 const c:any={provider:'opencode-zen',protocol,baseURL:'https://opencode.ai/zen/v1',model:protocol==='responses'?'gpt-5-nano':protocol==='messages'?'claude-haiku-4-5':'gemini-3-flash',apiKey:'fixture-protocol-'+protocol,configId:protocol,reasoningEffort:'high'};
 const bodies:any[]=[];const fake=(async(url,options)=>{const b=JSON.parse(String(options?.body));bodies.push({url:String(url),body:b});assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+c.apiKey);const tool=bodies.length===1;return protocol==='responses'?sse(responseEvents(tool)):protocol==='messages'?sse(messageEvents(tool)):sse([{candidates:[{content:{role:'model',parts:tool?[{functionCall:{name:'project_read',args:{path:'scene.txt'}},thoughtSignature:'fixture-thought-signature'}]:[{text:'OK'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:20,candidatesTokenCount:3,totalTokenCount:23,cachedContentTokenCount:5}}]);}) as typeof fetch;
 const b:any={model:c.model,messages:[{role:'system',content:'project rules'},{role:'user',content:'read scene'}],tools:[{type:'function',function:{name:'project_read',description:'read scene',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}],stream:true,max_tokens:128};
 try{const r=await fetchModel(c,b,AbortSignal.timeout(5000),app.store,'member-a',fake);assert.equal(r.status,200);const raw=await r.text();const chunks=raw.split('\n').filter(s=>s.startsWith('data: {')).map(s=>JSON.parse(s.slice(6)));const call=chunks.flatMap(c=>c.choices?.[0]?.delta.tool_calls??[])[0];assert(call,'tool call must be preserved: '+raw);assert.equal(call.function.name,'project_read');assert.equal(JSON.parse(call.function.arguments).path,'scene.txt');const usage=chunks.find(c=>c.usage)?.usage;assert.equal(usage.prompt_tokens,20);assert.equal(usage.prompt_tokens_details.cached_tokens,5);
 b.messages.push({role:'assistant',content:'',tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:'scene content'},{role:'user',content:'revise that scene'});const next=await fetchModel(c,b,AbortSignal.timeout(5000),app.store,'member-a',fake);assert.match(await next.text(),/OK/);assert.equal(bodies.length,2);assert(JSON.stringify(bodies[1]).includes('scene content'));assert(JSON.stringify(bodies[1]).includes('revise that scene'));
 if(protocol==='google')assert(JSON.stringify(bodies[1]).includes('fixture-thought-signature'));if(protocol==='responses')assert(bodies[0].url.endsWith('/responses'));if(protocol==='messages')assert(bodies[0].url.endsWith('/messages'));if(protocol==='google')assert(bodies[0].url.includes(':streamGenerateContent'));
 let count=0;const denied=await fetchModel(c,b,AbortSignal.timeout(5000),app.store,'member-a',(async()=>{count++;return Response.json({error:{message:'fixture denied',type:'authentication_error'}},{status:403});}) as typeof fetch);assert.equal(denied.status,403);assert.equal(count,1);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('protocol bridge treats truncated streams and cancellation as failures without retry',async()=>{
 const c:any={provider:'opencode-zen',protocol:'messages',baseURL:'https://opencode.ai/zen/v1',model:'claude-haiku-4-5',apiKey:'fixture-cancel-key',configId:'cancel',reasoningEffort:'high'};
 const b:any={messages:[{role:'user',content:'hello'}],stream:true,max_tokens:128};let calls=0;
 const r=await fetchModel(c,b,AbortSignal.timeout(5000),undefined,'',async()=>{calls++;return sse(messageEvents(false).slice(0,3));});await assert.rejects(r.text());assert.equal(calls,1);
 const ac=new AbortController();ac.abort();await assert.rejects(fetchModel(c,b,ac.signal,undefined,'',async(_url,init)=>{init?.signal?.throwIfAborted();throw Error('unexpected');}));
});

test('legacy task adapter completes a Responses tool turn with durable history and accounting hooks',async()=>{
 const {createServer}=await import('node:http'),{ProtocolAdapter}=await import('../server/protocol-adapter.ts'),{resolveAdapterOptions}=await import('@deepseek-ai/dsh-llm-deepseek');
 const upstream=createServer(async(req,res)=>{for await(const _ of req){}res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(responseEvents(true).map(v=>'data: '+JSON.stringify(v)+'\n\n').join(''));});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 const root=mkdtempSync(join(tmpdir(),'legacy-protocol-')),app=new Platform({dataDir:root});let prepared=0,accepted=0;
 const c:any={provider:'opencode-zen',protocol:'responses',baseURL:'http://127.0.0.1:'+(upstream.address() as any).port,model:'gpt-5-nano',apiKey:'fixture-legacy-key',configId:'legacy',reasoningEffort:'high'};
 try{const adapter=new ProtocolAdapter(c,app.store,{options:()=>resolveAdapterOptions({baseURL:c.baseURL}),resolveAuth:async()=>({headers:{Authorization:"Bearer "+c.apiKey}}),resolveUserId:()=> 'fixture' as any,prepareExtensions:async r=>{prepared++;assert((r.body.messages as any[]).some(m=>m.content==='keep history'));return {fields:{},accept:async()=>{accepted++;}};}});
 const chunks=[];for await(const chunk of adapter.stream({provider:c.provider,model:c.model,sessionId:'fixture-session' as any,maxTokens:128,messages:[{role:'user',content:[{type:'text',text:'keep history'}]}] as any,tools:[]}))chunks.push(chunk);
 assert.equal(prepared,1);assert.equal(accepted,1);assert(chunks.some(c=>c.type==='block-end'&&c.block.type==='tool-call'));assert(chunks.some(c=>c.type==='usage'));assert(chunks.some(c=>c.type==='finish'&&c.reason.kind==='tool-calls'));
 }finally{await app.close();await new Promise<void>(r=>upstream.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});


test('Zen Qwen3.8 Max uses its documented chat endpoint while Flash keeps Messages',async()=>{
 const catalog=await discoverModels('opencode-zen','fixture-route-secret',async()=>Response.json({data:[{id:'qwen3.8-max'},{id:'qwen3.8-flash'}]}));
 assert.deepEqual(catalog.models.map(m=>[m.id,m.protocol]),[['qwen3.8-max','chat'],['qwen3.8-flash','messages']]);
 const connection:any={provider:'opencode-zen',model:'qwen3.8-max',protocol:modelProtocol('opencode-zen','qwen3.8-max'),apiKey:'fixture-route-secret',baseURL:'https://opencode.ai/zen/v1',configId:'fixture',reasoningEffort:'high'};
 let requests=0;const response=await fetchModel(connection,{messages:[{role:'user',content:'fixture'}],stream:true},AbortSignal.timeout(2000),undefined,'',async(url,options)=>{requests++;assert.equal(String(url),'https://opencode.ai/zen/v1/chat/completions');assert.equal(JSON.parse(String(options?.body)).messages[0].content,'fixture');return Response.json({ok:true});});
 assert.equal(response.status,200);assert.equal(requests,1);
});
