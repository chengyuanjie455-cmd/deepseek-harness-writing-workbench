import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {Platform} from '../server/app.ts';
import {id} from '../server/store.ts';
const password='Synthetic-Test-Password';
function client(base:string){let cookie='',csrf='';return async(path:string,body?:any,status=200,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+'/api'+path,{method,headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json() as any;assert.equal(r.status,status,JSON.stringify(data));if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie')!.split(';')[0];if(data.csrf)csrf=data.csrf;assert(!JSON.stringify(data).includes('fixture-secret'));return data;};}
async function until(fn:()=>boolean){for(let i=0;i<800;i++){if(fn())return;await delay(15);}throw Error('Timed out');}
const body=(session:string,prompt='测试消息')=>({session,prompt,workflow:'chat',paths:[],requestId:id()});

test('multi-session, renaming, archives, private ownership and administrator restrictions survive restart',async()=>{
 const root=mkdtempSync(join(tmpdir(),'chat-parity-'));let app=new Platform({dataDir:root,mockDelay:1});let base='http://127.0.0.1:'+await app.start(0);let admin=client(base),member=client(base);
 try{
  await admin('/setup',{username:'admin',password},201);await admin('/login',{username:'admin',password});app.newUser({username:'member1',password},'member');await member('/login',{username:'member1',password});
  const first=await member('/sessions',{fresh:true,title:'第一个会话'},201),second=await member('/sessions',{fresh:true},201);assert.notEqual(first.id,second.id);
  const bytes=Buffer.from('新会话的原始附件'),uploadBody={name:'聊天附件.txt',bytes:bytes.length,session:second.id,requestId:id()},upload=await member('/uploads',uploadBody,201);await member('/uploads/'+upload.id+'/chunk',{offset:0,base64:bytes.toString('base64')});const saved=await member('/uploads/'+upload.id+'/complete',{});assert.equal(saved.state,'published');const uploadMessages=await member('/sessions/'+second.id+'/messages');assert.equal(uploadMessages[0].attachments[0].path,saved.path);assert.equal((await member('/sessions/'+first.id+'/messages')).length,0);await member('/sessions/'+second.id,{archived:true},200,'PATCH');await member('/uploads',{...uploadBody,requestId:id()},409);await member('/sessions/'+second.id,{archived:false},200,'PATCH');
  await member('/sessions/'+first.id,{title:'重命名完成',modelId:'default',permission:'workspace-write'},200,'PATCH');
  const forbidden=app.fixedChat(app.store.all('user').find(u=>u.role==='admin')!);await member('/sessions/'+forbidden.id+'/messages',undefined,404);await member('/sessions/'+forbidden.id,{title:'越权'},404,'PATCH');
  await member('/tasks',{...body(first.id),permission:'read-only'},403);await member('/tasks',{...body(first.id),modelId:'made-up'},403);await member('/tasks',{...body(first.id),permission:'danger-full-access'},403);
  await member('/sessions/'+first.id,{archived:true},200,'PATCH');await member('/tasks',body(first.id),409);await member('/sessions/'+first.id,{archived:false},200,'PATCH');
  await admin('/admin/chat-policy',{modelIds:['default'],permissions:['workspace-write'],multipleSessions:false});await member('/sessions',{fresh:true},403);await member('/sessions/'+second.id,{permission:'read-only'},403,'PATCH');await admin('/admin/chat-policy',{modelIds:['default'],permissions:['danger-full-access'],multipleSessions:true},400);await member('/admin/chat-policy',{modelIds:['default'],permissions:['workspace-write'],multipleSessions:true},403);
  await app.close();app=new Platform({dataDir:root,mockDelay:1});base='http://127.0.0.1:'+await app.start(0);member=client(base);await member('/login',{username:'member1',password});
  const sessions=await member('/sessions');assert.equal(sessions.find((s:any)=>s.id===first.id).title,'重命名完成');assert.equal(sessions.find((s:any)=>s.id===first.id).archived,false);assert.equal((await member('/chat-options')).multipleSessions,false);await member('/sessions',{fresh:true},403);
 }finally{await app.close();}
});

test('queue is durable, editable, cancellable, ordered and each request is admitted once',async()=>{
 const app=new Platform({dataDir:mkdtempSync(join(tmpdir(),'chat-queue-')),mockDelay:35,concurrency:1});const call=client('http://127.0.0.1:'+await app.start(0));
 try{
  await call('/setup',{username:'admin',password},201);await call('/login',{username:'admin',password});const s=await call('/sessions',{fresh:true},201);
  const a=await call('/tasks',body(s.id,'首条消息 '+'.'.repeat(300)),202);await until(()=>!!app.store.get('task',a.id)?.partial);
  const request=body(s.id,'第二条消息'),b=await call('/tasks',request,202);assert.equal(b.state,'queued');assert.equal((await call('/tasks',request)).id,b.id);
  await call('/tasks/'+b.id,{prompt:'修改后的第二条消息'},200,'PATCH');const c=await call('/tasks',body(s.id,'应取消的第三条'),202);await call('/tasks/'+c.id+'/cancel',{});
  await until(()=>app.store.get('task',b.id)?.state==='completed');assert.equal(app.store.get('task',c.id)?.state,'cancelled');assert.equal(app.store.all('task').length,3);assert(app.store.get('task',b.id)!.started>=app.store.get('task',a.id)!.finished);
  const ms=await call('/sessions/'+s.id+'/messages');assert.equal(ms.filter((m:any)=>m.task===b.id&&m.role==='user').length,1);assert(ms.some((m:any)=>m.text==='修改后的第二条消息'));await call('/tasks/'+a.id,{prompt:'已运行不能编辑'},409,'PATCH');
 }finally{await app.close();}
});

test('native Harness steering is consumed once within the running conversation',async()=>{
 const app=new Platform({dataDir:mkdtempSync(join(tmpdir(),'chat-steer-')),mockDelay:40});const call=client('http://127.0.0.1:'+await app.start(0));
 try{await call('/setup',{username:'admin',password},201);await call('/login',{username:'admin',password});const s=await call('/sessions',{fresh:true},201);const a=await call('/tasks',body(s.id,'运行中插话测试 '+'.'.repeat(300)),202);await until(()=>!!app.store.get('task',a.id)?.partial);
  const request={...body(s.id,'插话唯一校验词-steer-one'),delivery:'steer'},b=await call('/tasks',request,202);assert.equal(b.parentTask,a.id);assert.equal((await call('/tasks',request)).id,b.id);await until(()=>app.store.get('task',a.id)?.state==='completed');assert.equal(app.store.get('task',b.id)?.state,'completed');const log=JSON.stringify(app.store.get('harness',s.id));assert(log.includes('插话唯一校验词-steer-one'));assert.equal(app.store.all('message',s.id).filter(m=>m.text==='插话唯一校验词-steer-one').length,1);
 }finally{await app.close();}
});

test('two selected connections route independently, reasoning is displayed, legacy project allowlists do not revoke queued work',async()=>{
 const requests:any[]=[];const fixture=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);requests.push({model:b.model,auth:req.headers.authorization,effort:b.reasoning_effort});res.writeHead(200,{'Content-Type':'text/event-stream'});for(const j of [{choices:[{index:0,delta:{role:'assistant',reasoning_content:'合成推理可见',content:'## 模型切换成功\n\n'+b.model},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}])res.write('data: '+JSON.stringify({id:'fixture-response',...j})+'\n\n');res.end('data: [DONE]\n\n');});await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));
 const root=mkdtempSync(join(tmpdir(),'chat-models-')),baseURL='http://127.0.0.1:'+(fixture.address() as any).port;
 const model={provider:'deepseek-official' as const,model:'deepseek-flash',reasoningEffort:'high' as const,baseURL,apiKey:'fixture-secret-default',configId:'fixture-default',fixture:true};
 writeFileSync(join(root,'chat-model-connections.json'),JSON.stringify([{id:'alternate',name:'另一个模型',enabled:true,roles:['admin','member'],connection:{provider:'opencode-zen',model:'glm-5.3-flash',reasoningEffort:'max',baseURL,apiKey:'fixture-secret-alternate',configId:'fixture-alternate',fixture:true}}]),{mode:0o600});
 const app=new Platform({dataDir:root,model});const call=client('http://127.0.0.1:'+await app.start(0));
 try{await call('/setup',{username:'admin',password},201);await call('/login',{username:'admin',password});await call('/admin/chat-policy',{modelIds:['default','alternate'],permissions:['workspace-write'],multipleSessions:true});const a=await call('/sessions',{fresh:true},201),b=await call('/sessions',{fresh:true},201);await call('/sessions/'+b.id,{modelId:'alternate'},200,'PATCH');
  const ts=await Promise.all([call('/tasks',body(a.id),202),call('/tasks',body(b.id),202)]);await until(()=>ts.every(t=>app.store.get('task',t.id)?.state==='completed'));assert.equal(requests.length,2);assert(requests.some(r=>r.model==='deepseek-flash'&&r.auth==='Bearer fixture-secret-default'));assert(requests.some(r=>r.model==='glm-5.3-flash'&&r.auth==='Bearer fixture-secret-alternate'));assert(ts.every(t=>app.store.get('task',t.id)?.reasoning==='合成推理可见'));
  app.options.concurrency=0;const queued=await call('/tasks',body(b.id),202);assert.equal(queued.state,'queued');await call('/admin/chat-policy',{modelIds:['default'],permissions:['workspace-write'],multipleSessions:true});app.options.concurrency=4;app.pump();await until(()=>app.store.get('task',queued.id)?.state==='completed');assert.equal(requests.length,3);assert((await call('/chat-options')).models.some((m:any)=>m.id==='alternate'));await call('/admin/chat-models');
 }finally{await app.close();await new Promise<void>(r=>fixture.close(()=>r()));}
});
