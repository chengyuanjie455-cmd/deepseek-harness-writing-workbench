import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,type Doc} from '../server/store.ts';
import {ChatCatalog} from '../server/chat-catalog.ts';
import {ModelRouting,AUTO_MODEL_ID,saveRoutingPolicy,routingPolicy,nativeContextPressure} from '../server/model-routing.ts';
import {connectionEvidenceId} from '../server/model-capabilities.ts';
const encoder=new TextEncoder(),frame=(delta:Doc,finish_reason:any=null)=>'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\n\n';
const success=()=>new Response(frame({content:'synthetic answer'},'stop')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'model-routing-')),store=new Store(root);
 const rows=['a','b','c'].map(id=>({id,name:'Synthetic '+id,enabled:true,connection:{provider:'ruiyun',model:'model-'+id,baseURL:'http://127.0.0.1/'+id,apiKey:'synthetic-secret-'+id,configId:'config-'+id,fixture:true,reasoningEffort:'high',metadata:{id:'model-'+id,name:id,selectable:true,protocol:'chat',contextWindow:128000,maxTokens:8192,inputModalities:['text','image'],supportsTools:true,efforts:['off','high']}}}));
 writeFileSync(join(root,'chat-model-connections.json'),JSON.stringify(rows),{mode:0o600});const catalog=new ChatCatalog(store),admin={id:'synthetic-admin',role:'admin'};
 const policy=(patch:Doc={})=>saveRoutingPolicy(store,catalog,admin,'project',{enabled:true,primaryModelId:'a',fallbackModelIds:['b','c'],maxAttempts:3,firstOutputTimeoutMs:5000,cooldownMs:1000,...patch});policy();
 return {root,store,catalog,policy,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
const body=()=>({model:AUTO_MODEL_ID,stream:true,max_tokens:2048,messages:[{role:'system',content:'synthetic project scope'},{role:'user',content:'synthetic script'},{role:'assistant',content:'prior',tool_calls:[{id:'tool-1',type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'tool-1',content:'synthetic result'},{role:'user',content:'second round'}],tools:[{type:'function',function:{name:'read',parameters:{type:'object'}}}]});

test('native token pressure keeps a large serialized image intact while excluding a genuinely smaller context route',async()=>{
 const f=fixture(),input=body(),calls:string[]=[];try{
  f.catalog.all().find(r=>r.id==='a')!.connection.metadata!.inputModalities=['text'];f.catalog.all().find(r=>r.id==='b')!.connection.metadata!.contextWindow=4096;
  (input.messages.at(-1)! as any).content=[{type:'text',text:'完整的原聊天'},{type:'image_url',image_url:{url:'data:image/png;base64,'+'c3lu'.repeat(100000)}}];const before=JSON.stringify(input);
  const router=new ModelRouting(f.store,f.catalog,async(c,b)=>{calls.push(c.configId);assert.deepEqual(b.messages,input.messages);return success();});
  const pressure=nativeContextPressure({'x-team-native-context-tokens':'6000','x-team-native-context-revision':'123','x-team-native-context-basis':'usage'})!;
  const result=await router.fetch('project',AUTO_MODEL_ID,input,AbortSignal.timeout(2000),'same-chat','native-call',()=>true,()=>{},pressure);await result.response.text();assert.deepEqual(calls,['config-c']);assert.equal(JSON.stringify(input),before);const record=f.store.get('model-route',result.routeId)!;assert.equal(record.contextPressure.tokens,6000);assert.equal(record.events.find((e:Doc)=>e.modelId==='b').reason,'context_window_insufficient');assert(!JSON.stringify(record).includes('data:image'));
 }finally{f.close();}
});

test('native context metadata must be finite, bounded and tied to an explicit measurement basis',()=>{
 const headers={'x-team-native-context-tokens':'6000','x-team-native-context-revision':'123','x-team-native-context-basis':'estimated'};
 assert.equal(nativeContextPressure(headers)?.source,'native-token-meter');
 for(const bad of ['-1','NaN','Infinity','1000000001',['123']])assert.equal(nativeContextPressure({...headers,'x-team-native-context-tokens':bad}),undefined);
 assert.equal(nativeContextPressure({...headers,'x-team-native-context-basis':'bytes'}),undefined);assert.equal(nativeContextPressure({...headers,'x-team-native-context-revision':'-1'}),undefined);
});

test('automatic fallback preserves every message and tool, exposes actual route and never stores prompt or secrets',async()=>{
 const f=fixture(),calls:Doc[]=[],failures:Doc[]=[],original=body();
 try{const routing=new ModelRouting(f.store,f.catalog,async(c,b)=>{calls.push({id:c.configId,body:structuredClone(b)});return c.configId==='config-a'?new Response('unavailable',{status:503}):success();});
 const result=await routing.fetch('project',AUTO_MODEL_ID,original,AbortSignal.timeout(2000),'scope','call',()=>true,(r)=>failures.push(r));
 assert.equal(result.attempted,2);assert.equal(result.connection?.configId,'config-b');assert.equal(result.response.headers.get('x-team-actual-model'),'model-b');await result.response.text();assert.equal(failures.length,1);
 for(const c of calls){assert.deepEqual(c.body.messages,original.messages);assert.deepEqual(c.body.tools,original.tools);}assert.equal(original.model,AUTO_MODEL_ID);
 const route=f.store.get('model-route',result.routeId)!;assert.equal(route.actualModelId,'b');assert(!JSON.stringify(route).includes('synthetic script'));assert(!JSON.stringify(route).includes('synthetic-secret'));
 }finally{f.close();}
});

test('fixed model can use another connection to the same exact model but never crosses model types',async()=>{
 const f=fixture(),calls:string[]=[];
 try{f.catalog.all().find(r=>r.id==='c')!.connection.model='model-a';const route=new ModelRouting(f.store,f.catalog,async(c)=>{calls.push(c.configId);return c.configId==='config-a'?new Response('',{status:401}):success();});
 const r=await route.fetch('project','a',body(),AbortSignal.timeout(2000),'scope','call',()=>true);await r.response.text();assert.deepEqual(calls,['config-a','config-c']);assert.equal(r.modelId,'c');
 }finally{f.close();}
});

test('fallback excludes unverified image, tool and insufficient context candidates without deleting input',async()=>{
 for(const kind of ['image','tools','context','unknown-context','reasoning','structured']){const f=fixture(),calls:string[]=[],input=body();
 try{const b=f.catalog.all().find(r=>r.id==='b')!.connection;const metadata:any=b.metadata;
 if(kind==='image'){metadata.inputModalities=['text'];(input.messages.at(-1)! as any).content=[{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}}];}
 if(kind==='structured'){(input as any).response_format={type:'json_schema',json_schema:{name:'fixture',schema:{type:'object'}}};b.protocol='responses';}if(kind==='tools')metadata.supportsTools=false;if(kind==='context')metadata.contextWindow=1024;if(kind==='unknown-context')delete metadata.contextWindow;if(kind==='reasoning'){(input as any).reasoning_effort='max';f.catalog.all().find(r=>r.id==='a')!.connection.metadata!.efforts.push('max');f.catalog.all().find(r=>r.id==='c')!.connection.metadata!.efforts.push('max');}
 const router=new ModelRouting(f.store,f.catalog,async(c,b)=>{calls.push(c.configId);assert.deepEqual(b.messages,input.messages);return c.configId==='config-a'?new Response('',{status:503}):success();});
 const r=await router.fetch('project',AUTO_MODEL_ID,input,AbortSignal.timeout(2000),'scope','call',()=>true);await r.response.text();assert.deepEqual(calls,['config-a','config-c']);assert.equal(f.store.get('model-route',r.routeId)!.events.find((e:Doc)=>e.modelId==='b').state,'skipped');
 }finally{f.close();}}
});

test('400 and content-policy rejection stop instead of silently evading provider rejection',async()=>{
 for(const contentRejected of [false,true]){const f=fixture(),calls:string[]=[];
 try{const router=new ModelRouting(f.store,f.catalog,async(c)=>{calls.push(c.configId);return contentRejected?new Response('data: '+JSON.stringify({error:{code:'content_policy_violation'}})+'\n\n',{headers:{'Content-Type':'text/event-stream'}}):new Response('',{status:400});});
 const r=await router.fetch('project',AUTO_MODEL_ID,body(),AbortSignal.timeout(2000),'scope','call',()=>true);assert.equal(r.response.status,contentRejected?422:400);assert.deepEqual(calls,['config-a']);assert.equal(f.store.all('model-route-health').length,0);
 }finally{f.close();}}
});

test('role-only empty responses and first-output timeout may switch before committing content',async()=>{
 for(const timeout of [false,true]){const f=fixture(),calls:string[]=[];f.policy({firstOutputTimeoutMs:100});let cancelled=false;
 try{const router=new ModelRouting(f.store,f.catalog,async(c)=>{calls.push(c.configId);if(c.configId!=='config-a')return success();
 return new Response(new ReadableStream({start(controller){controller.enqueue(encoder.encode(frame({role:'assistant'})+(timeout?'':'data: [DONE]\n\n')));if(!timeout)controller.close();},cancel(){cancelled=true;}}),{headers:{'Content-Type':'text/event-stream'}});});
 const r=await router.fetch('project',AUTO_MODEL_ID,body(),AbortSignal.timeout(2000),'scope','call',()=>true);await r.response.text();assert.deepEqual(calls,['config-a','config-b']);if(timeout)assert(cancelled);
 }finally{f.close();}}
});

test('after content, reasoning or a tool-call fragment is visible a broken stream never triggers fallback',async()=>{
 for(const delta of [{content:'partial'}, {reasoning_content:'partial reasoning'},{tool_calls:[{index:0,id:'call-1',function:{name:'write',arguments:'{'}}]}]){const f=fixture(),calls:string[]=[];
 try{const router=new ModelRouting(f.store,f.catalog,async(c)=>{calls.push(c.configId);return new Response(new ReadableStream({start(controller){controller.enqueue(encoder.encode(frame(delta)));setTimeout(()=>controller.error(Error('synthetic interrupted stream')),15);}}),{headers:{'Content-Type':'text/event-stream'}});});
 const r=await router.fetch('project',AUTO_MODEL_ID,body(),AbortSignal.timeout(2000),'scope','call',()=>true);await assert.rejects(r.response.text(),/interrupted/);assert.deepEqual(calls,['config-a']);assert.equal(r.failures.length,0);
 }finally{f.close();}}
});

test('429 Retry-After applies to that immutable connection and half-open recovery uses one probe for eight members',async()=>{
 const f=fixture(),counts=new Map<string,number>();f.policy({firstOutputTimeoutMs:10000});let clock=Date.now(),phase='fail',resume:(()=>void)|undefined;
 try{const router=new ModelRouting(f.store,f.catalog,async(c)=>{counts.set(c.configId,(counts.get(c.configId)??0)+1);if(c.configId==='config-a'){
 if(phase==='fail')return new Response('',{status:429,headers:{'Retry-After':'5'}});if(phase==='probe')await new Promise<void>(r=>{resume=r;});
 }return success();},()=>clock);
 const first=await router.fetch('project',AUTO_MODEL_ID,body(),AbortSignal.timeout(2000),'scope','initial',()=>true);await first.response.text();assert.equal(f.store.get('model-route-health',connectionEvidenceId(f.catalog.all().find(r=>r.id==='a')!.connection))!.retryAt,clock+5000);
 const cooling=await router.fetch('project',AUTO_MODEL_ID,body(),AbortSignal.timeout(2000),'scope','cooling',()=>true);await cooling.response.text();assert.equal(counts.get('config-a'),1);
 clock+=5001;phase='probe';const concurrent=Array.from({length:8},(_,n)=>router.fetch('project',AUTO_MODEL_ID,body(),AbortSignal.timeout(2000),'member-'+n,'parallel-'+n,()=>true));
 await Promise.all(concurrent.slice(1));assert.equal(counts.get('config-a'),2);assert(resume);phase='healthy';resume();
 const results=await Promise.all(concurrent);await Promise.all(results.map(r=>r.response.text()));assert.equal(results.filter(r=>r.modelId==='a').length,1);assert.equal(results.filter(r=>r.modelId==='b').length,7);
 const recovered=await router.fetch('project',AUTO_MODEL_ID,body(),AbortSignal.timeout(2000),'scope','recovered',()=>true);await recovered.response.text();assert.equal(recovered.modelId,'a');
 }finally{f.close();}
});

test('all failing candidates stop at bounded attempts and duplicate connection aliases are not retried',async()=>{
 const f=fixture(),calls:string[]=[];try{f.policy({maxAttempts:2});const a=f.catalog.all().find(r=>r.id==='a')!.connection;f.catalog.all().find(r=>r.id==='b')!.connection=a;
 const router=new ModelRouting(f.store,f.catalog,async(c)=>{calls.push(c.configId);return new Response('',{status:502});});
 const r=await router.fetch('project',AUTO_MODEL_ID,body(),AbortSignal.timeout(2000),'scope','call',()=>true);assert.equal(r.response.status,503);assert.deepEqual(calls,['config-a','config-c']);assert.equal(r.attempted,2);assert.equal(f.store.get('model-route',r.routeId)!.state,'failed');
 }finally{f.close();}
});

test('cancel after send records one uncertain attempt and never dispatches the next candidate',async()=>{
 const f=fixture(),calls:string[]=[],controller=new AbortController(),failures:Doc[]=[];
 try{const router=new ModelRouting(f.store,f.catalog,async(c)=>{calls.push(c.configId);setTimeout(()=>controller.abort(),10);return new Response(new ReadableStream({start(s){s.enqueue(encoder.encode(frame({role:'assistant'})));}}),{headers:{'Content-Type':'text/event-stream'}});});
 await assert.rejects(router.fetch('project',AUTO_MODEL_ID,body(),controller.signal,'scope','cancelled',()=>true,r=>failures.push(r)));assert.deepEqual(calls,['config-a']);assert.equal(failures[0].stage,'cancelled_after_send');assert.equal(f.store.all('model-route')[0].state,'cancelled');
 }finally{f.close();}
});

test('disabled or rotated connections are skipped and account revocation prevents further dispatch',async()=>{
 for(const mode of ['disabled','rotated','revoked']){const revoked=mode==='revoked',f=fixture(),calls:string[]=[];let active=true;
 try{const router=new ModelRouting(f.store,f.catalog,async(c)=>{calls.push(c.configId);if(c.configId==='config-a'){if(revoked)active=false;else if(mode==='rotated')f.catalog.all().find(r=>r.id==='b')!.connection.apiKey='synthetic-rotated-key';else f.catalog.all().find(r=>r.id==='b')!.enabled=false;return new Response('',{status:503});}return success();});
 if(revoked){await assert.rejects(router.fetch('project',AUTO_MODEL_ID,body(),AbortSignal.timeout(2000),'scope','revoked',()=>active),/停用/);assert.deepEqual(calls,['config-a']);assert.equal(f.store.all('model-route')[0].state,'revoked');}
 else {const r=await router.fetch('project',AUTO_MODEL_ID,body(),AbortSignal.timeout(2000),'scope','disabled',()=>active);await r.response.text();assert.deepEqual(calls,['config-a','config-c']);}
 }finally{f.close();}}
});

test('routing settings default off, accept only saved connections and never accept credentials or URL overrides',()=>{
 const f=fixture();try{assert.equal(routingPolicy(f.store,'other-project').enabled,false);assert(!f.catalog.available({role:'member'},'other-project').some(m=>m.id===AUTO_MODEL_ID));assert(f.catalog.available({role:'member'},'project').some(m=>m.id===AUTO_MODEL_ID));
 assert.throws(()=>saveRoutingPolicy(f.store,f.catalog,{id:'member',role:'member'},'project',{}),/超级管理员/);
 for(const patch of [{apiKey:'forbidden'},{baseURL:'https://invalid.example'},{fallbackModelIds:['unknown']},{fallbackModelIds:['b','b']},{maxAttempts:0},{firstOutputTimeoutMs:0}])assert.throws(()=>f.policy(patch));
 f.policy({enabled:false});assert(!f.catalog.available({role:'member'},'project').some(m=>m.id===AUTO_MODEL_ID));
 }finally{f.close();}
});
