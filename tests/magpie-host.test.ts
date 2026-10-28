import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync,readdirSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import {ChatCatalog} from '../server/chat-catalog.ts';
import {MagpieHost} from '../server/magpie-host.ts';
import {ModelRouting,saveRoutingPolicy,AUTO_MODEL_ID,publicModelRoute} from '../server/model-routing.ts';

const frame=(model:string,delta:any,finish_reason:any=null)=>'data: '+JSON.stringify({id:'chatcmpl-synthetic',object:'chat.completion.chunk',created:1,model,choices:[{index:0,delta,finish_reason}]})+'\n\n';
const input=()=>({model:'synthetic',stream:true,max_tokens:256,messages:[{role:'system',content:'synthetic private host instruction'},{role:'user',content:'Write a synthetic script.'}],tools:[{type:'function',function:{name:'read_project',parameters:{type:'object',properties:{}}}}]});
async function fixture(mode='normal'){
 const calls:any[]=[],sockets=new Set<any>();
 const server=createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks).toString());calls.push({path:req.url,body,auth:req.headers.authorization});
  if(body.model==='model-a'&&mode==='fallback'){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'synthetic unavailable'}}));return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  if(mode==='partial'){res.write(frame(body.model,{content:'partial synthetic answer'}));setTimeout(()=>res.destroy(),30);return;}
  if(mode==='wait'){res.write(frame(body.model,{role:'assistant'}));return;}
  const delta=mode==='tool'&&!body.messages.some((m:any)=>m.role==='tool')?{tool_calls:[{index:0,id:'call-synthetic',type:'function',function:{name:'read_project',arguments:'{}'}}]}:{content:'synthetic complete answer'};
  res.end(frame(body.model,delta)+frame(body.model,{},delta.tool_calls?'tool_calls':'stop')+'data: [DONE]\n\n');
 });server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const baseURL=`http://127.0.0.1:${(server.address() as any).port}/v1`;
 const root=mkdtempSync(join(tmpdir(),'embedded-magpie-')),store=new Store(root);
 const records=['a','b'].map(id=>({id,name:'Synthetic '+id,enabled:true,connection:{provider:'ruiyun',model:'model-'+id,protocol:'chat',baseURL,apiKey:'synthetic-private-key-'+id,configId:'synthetic-config-'+id,reasoningEffort:'off',metadata:{contextWindow:32768,maxOutputTokens:2048,inputModalities:['text'],supportsTools:true,efforts:['off']}}}));
 writeFileSync(join(root,'chat-model-connections.json'),JSON.stringify(records),{mode:0o600});
 const catalog=new ChatCatalog(store);saveRoutingPolicy(store,catalog,{id:'synthetic-admin',role:'admin'},'project',{engine:'magpie',enabled:true,primaryModelId:'a',fallbackModelIds:['b'],maxAttempts:2,firstOutputTimeoutMs:10000,cooldownMs:0});
 return {root,store,catalog,calls,baseURL,router:new ModelRouting(store,catalog),async close(){await catalog.magpie.close();store.close();for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}};
}

test('compiled Magpie sends an exact chosen model, preserving full context and private tool round trips',async()=>{
 const f=await fixture('tool');try{const body=input(),before=JSON.stringify(body),signal=AbortSignal.timeout(30000);
  const first=await f.router.fetch('project','b',body,signal,'workspace:chat','call-1',()=>true);const text=await first.response.text();
  assert.match(text,/call-synthetic/);assert.match(text,/read_project/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.model,'model-b');assert.deepEqual(f.calls[0].body.messages,body.messages);assert.deepEqual(f.calls[0].body.tools,body.tools);assert.equal(JSON.stringify(body),before);
  const second={...body,messages:[...body.messages,{role:'assistant',content:null,tool_calls:[{id:'call-synthetic',type:'function',function:{name:'read_project',arguments:'{}'}}]},{role:'tool',tool_call_id:'call-synthetic',content:'synthetic project result'},{role:'user',content:'continue'}]};
  const result=await f.router.fetch('project','b',second,signal,'workspace:chat','call-2',()=>true);assert.match(await result.response.text(),/synthetic complete answer/);assert.deepEqual(f.calls[1].body.messages,second.messages);assert.equal(result.response.headers.get('x-team-model-engine'),'magpie');
  const publicRoute=JSON.stringify(publicModelRoute(f.store,'workspace','chat'));assert.match(publicRoute,/magpie/);assert(!publicRoute.includes('synthetic-private-key'));assert(!publicRoute.includes('private host instruction'));
  assert.equal(statSync(join(f.root,'magpie-private')).mode&0o777,0o700);
  await f.catalog.magpie.close();assert.deepEqual(readdirSync(join(f.root,'magpie-private')),[]);
 }finally{await f.close();}
});

test('Magpie and the workbench perform one failed primary plus one compatible fallback, without hidden retries',async()=>{
 const f=await fixture('fallback');try{const body=input(),result=await f.router.fetch('project',AUTO_MODEL_ID,body,AbortSignal.timeout(30000),'workspace:chat','auto',()=>true);assert.match(await result.response.text(),/complete answer/);assert.deepEqual(f.calls.map(c=>c.body.model),['model-a','model-b']);assert.equal(result.attempted,2);assert.equal(result.connection?.model,'model-b');assert.equal(f.store.get('model-route',result.routeId)?.engine,'magpie');assert.deepEqual(f.calls[1].body.messages,body.messages);
 }finally{await f.close();}
});

test('a fixed model never changes type, and partial output never starts a fallback',async()=>{
 for(const mode of ['fallback','partial']){const f=await fixture(mode);try{const result=await f.router.fetch('project','a',input(),AbortSignal.timeout(30000),'workspace:chat','fixed',()=>true);
  if(mode==='partial'){const text=await result.response.text();assert.match(text,/partial synthetic answer/);assert.match(text,/error|incomplete/i);}else assert.equal(result.response.status,503);
  assert.deepEqual(f.calls.map(c=>c.body.model),['model-a']);
 }finally{await f.close();}}
});

test('embedded gateway refuses unauthenticated/admin HTTP and terminates its own listener on close',async()=>{
 const f=await fixture();try{const c=f.catalog.modelConnection('a','project')!;await(await f.catalog.magpie.fetch(c,input(),AbortSignal.timeout(30000))).text();
  const runtime=f.catalog.magpie as any,url=runtime.url,token=runtime.token;
  assert.equal((await fetch(url+'/chat/completions',{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(url+'/models',{headers:{Authorization:'Bearer '+token}})).status,404);
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(f.catalog.magpie.fetch(c,input(),cancelled.signal));assert.equal(f.calls.length,1);
  await f.catalog.magpie.close();await assert.rejects(fetch(url+'/models'));
 }finally{await f.close();}
});

test('missing embedded binary fails closed without silently using a different transport',async()=>{
 const root=mkdtempSync(join(tmpdir(),'magpie-unavailable-')),host=new MagpieHost(root,join(root,'missing-binary'));
 try{await assert.rejects(host.fetch({provider:'ruiyun',configId:'synthetic',apiKey:'synthetic-private-key',baseURL:'http://127.0.0.1:1/v1',model:'synthetic',reasoningEffort:'off'},input(),AbortSignal.timeout(1000)),(error:any)=>error.code==='MAGPIE_UNAVAILABLE');assert(!host.status().available);}finally{await host.close();rmSync(root,{recursive:true,force:true});}
});

test('eight simultaneous host requests keep each context and selected model independent',async()=>{
 const f=await fixture();try{await Promise.all(Array.from({length:8},async(_,index)=>{const body=input();body.messages.push({role:'user',content:'synthetic member '+index});const result=await f.router.fetch('project',index%2?'a':'b',body,AbortSignal.timeout(30000),'workspace:chat-'+index,'parallel-'+index,()=>true);assert.match(await result.response.text(),/complete answer/);}));assert.equal(f.calls.length,8);for(let index=0;index<8;index++){const calls=f.calls.filter(c=>c.body.messages.at(-1).content==='synthetic member '+index);assert.equal(calls.length,1);assert.equal(calls[0].body.model,index%2?'model-a':'model-b');}}
 finally{await f.close();}
});

test('Magpie translates Messages, Responses and Gemini through the same native Chat interface',async()=>{
 for(const protocol of ['messages','responses','google'] as const){const calls:any[]=[],root=mkdtempSync(join(tmpdir(),'magpie-protocol-')),host=new MagpieHost(root);
  const server=createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);calls.push({path:req.url,body:JSON.parse(Buffer.concat(chunks).toString())});res.writeHead(200,{'Content-Type':'text/event-stream'});
   if(protocol==='messages')res.end('event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{id:'synthetic-message',type:'message',role:'assistant',model:'synthetic-model',content:[],usage:{input_tokens:10,output_tokens:0}}})+'\n\nevent: content_block_start\ndata: '+JSON.stringify({type:'content_block_start',index:0,content_block:{type:'text',text:''}})+'\n\nevent: content_block_delta\ndata: '+JSON.stringify({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'synthetic protocol answer'}})+'\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
   if(protocol==='responses')res.end('event: response.created\ndata: '+JSON.stringify({type:'response.created',response:{id:'synthetic-response',object:'response',status:'in_progress',model:'synthetic-model',output:[]}})+'\n\nevent: response.output_text.delta\ndata: '+JSON.stringify({type:'response.output_text.delta',item_id:'synthetic-item',output_index:0,content_index:0,delta:'synthetic protocol answer'})+'\n\nevent: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'synthetic-response',object:'response',status:'completed',model:'synthetic-model',output:[{id:'synthetic-item',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'synthetic protocol answer',annotations:[]}]}],usage:{input_tokens:10,output_tokens:3,total_tokens:13}}})+'\n\n');
   if(protocol==='google')res.end('data: '+JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'synthetic protocol answer'}]},finishReason:'STOP',index:0}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:3,totalTokenCount:13}})+'\n\n');
  });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{const body=input(),result=await host.fetch({provider:'ruiyun',model:'synthetic-model',protocol,configId:'protocol-'+protocol,baseURL:`http://127.0.0.1:${(server.address() as any).port}/v1`,apiKey:'synthetic-protocol-key',reasoningEffort:'off'},body,AbortSignal.timeout(30000),'','protocol-chat');const text=await result.text();assert.equal(result.status,200,text);assert.match(text,/synthetic protocol answer/);assert.equal(calls.length,1);assert(!text.includes('synthetic-protocol-key'));assert(JSON.stringify(calls[0].body).includes('Write a synthetic script.'));}
  finally{await host.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});}
 }
});
