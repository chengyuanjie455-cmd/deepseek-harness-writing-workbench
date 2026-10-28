import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {id,hash,type Doc} from '../server/store.ts';
import {MemberModels} from '../server/member-models.ts';
import {fixture,exercise,until,password} from './helpers/native-team-fixture.ts';


test('one project chat: eight concurrent members, private references, four model routes, retry, downloads and revision',{timeout:120000},async()=>{const f=await fixture();try{await exercise(f,false);}finally{await f.close();}});

test('eight official native sessions submit and revise through the integrated project tools',{skip:process.env.NATIVE_TEAM_TEST!=='1',timeout:1200000},async()=>{const f=await fixture(true);try{
 // Fixture boot pacing is independent of the eight simultaneous submissions.
 // A loaded local Docker Desktop can opt for serial boot without narrowing
 // the application's member/session admission or generation concurrency.
 const coldStartWidth=process.env.NATIVE_TEAM_COLD_START_WIDTH==='1'?1:2;
 console.log(JSON.stringify({fixtureColdStartWidth:coldStartWidth,concurrentMembersAfterBoot:8}));
 for(let n=0;n<8;n+=coldStartWidth)await Promise.all(Array.from({length:Math.min(coldStartWidth,8-n)},(_,k)=>n+k).map(async index=>{f.instances[index]=await f.app.native.get(f.users[index],'shared');await f.login(index);}));
 await exercise(f,true);
 // Eight account-owned native runtimes, three independent chats each. Text
 // turns use the same real admission/journal path, but never create more media.
 const chats=await Promise.all(f.users.flatMap((user,n)=>Array.from({length:3},async(_,k)=>({owner:n,key:`ONLY-M${n}-C${k}`,session:(await f.app.native.rpc(f.instances[n],'session/create',{cwd:'/workspace'})).sessionId}))));
 const createsBefore=f.creates();
 for(let round=1;round<=2;round++){
  await Promise.all(chats.map(c=>f.clients[c.owner]('/api/session/prompt','POST',{type:'client-request',rpcId:id(),method:'session/prompt',payload:{args:{request:{sessionId:c.session,requestId:id(),mode:'queue',content:[{type:'text',text:`NATIVE_TEAM_chat-${c.owner}-${c.key} ${c.key} 第${round}轮合成文字测试，不生成媒体。`}]}}}})));
  // Automatic native titles are auxiliary model calls, not completed chat
  // turns. Counting them would finish this wait before round two executes.
  await until(()=>f.textRequests.filter(b=>b.tools?.length&&JSON.stringify(b.messages).includes('ONLY-M')).length>=round*24&&f.instances.every(i=>i.active===0),90);
 }
 if(process.env.NATIVE_CHAT_EVIDENCE)writeFileSync(process.env.NATIVE_CHAT_EVIDENCE,JSON.stringify({chats,requests:f.textRequests.filter(b=>JSON.stringify(b.messages).includes('ONLY-M')).map(b=>({kind:b.tools?.length?'agent':'auxiliary',model:b.model,messages:b.messages}))},null,2));
 for(const chat of chats){const requests=f.textRequests.filter(b=>b.tools?.length&&b.messages.some((m:Doc)=>m.role==='user'&&JSON.stringify(m.content).includes(chat.key)));assert.equal(requests.length,2,chat.key+' request count');assert(JSON.stringify(requests[1].messages).includes(chat.key+' 第1轮'),chat.key+' missing round 1');assert(JSON.stringify(requests[1].messages).includes(chat.key+' 第2轮'),chat.key+' missing round 2');for(const other of chats.filter(c=>c.key!==chat.key))assert(!JSON.stringify(requests).includes(other.key),'other chat context leaked');}
 assert.equal(f.creates(),createsBefore);console.log(JSON.stringify({evidence:'native_8_members_24_chats',rounds:2,completedTextTurns:48,contextsIsolated:true,extraMediaCreates:0,supplierCalls:0}));
 // Wait for the native agent heartbeat, not just the outbound model stream.
 // Title jobs and journal settlement may still be finishing after HTTP ends.
 await until(()=>f.instances.every(i=>{const a=f.app.native.activity(i);return a&&!a.error&&!a.agents&&!a.queued&&!a.jobs&&!a.schedules&&i.active===0;}),30);
 assert(f.textRequests.some(b=>JSON.stringify(b.messages).includes('持续上下文约定：主角叫陈山')),'legacy history remains in native model context');
 await f.app.native.stop(f.users[0],'shared',f.instances[0].key);const resumed=await f.app.native.get(f.users[0],'shared');const listed=await f.app.native.rpc(resumed,'session/list',{_request:{}},true);assert(JSON.stringify(listed).includes('成员原有长期聊天'));const imported=listed.items.find((v:any)=>v.sessionId==='session-team-legacy-history-member0');assert.equal(imported.projections.values.modelSelection.next.provider,'deepseek-official');assert(existsSync(join(resumed.root,'legacy-native-ready.json')));
 writeFileSync(join(resumed.work,'成员自动发布.txt'),'项目内直接发布');const published=await f.app.native.team.tool(resumed,f.users[0],{action:'workspace',sessionId:'session-team-legacy-history-member0',callId:'publish',args:{operation:'publish',paths:['成员自动发布.txt']}});assert.equal(published!.state,'committed');assert.equal(f.app.projects.read('成员自动发布.txt').toString(),'项目内直接发布');
 rmSync(join(resumed.work,'成员自动发布.txt'));await assert.rejects(f.app.native.team.tool(resumed,f.users[0],{action:'workspace',sessionId:'session-team-legacy-history-member0',callId:'delete',args:{operation:'publish',paths:['成员自动发布.txt']}}),/不能删除/);assert(f.app.projects.revision().manifest['成员自动发布.txt']);
 const exported=await fetch(`http://127.0.0.1:${resumed.port}/api/session.export?sessionId=session-team-legacy-history-member0`,{headers:{Cookie:resumed.cookie}});if(exported.status!==200)throw Error('session export '+exported.status+': '+await exported.text());assert((await exported.arrayBuffer()).byteLength>100);
 if(process.env.NATIVE_TEAM_PREVIEW){writeFileSync(process.env.NATIVE_TEAM_PREVIEW,JSON.stringify({url:f.base,root:f.root}));await until(()=>existsSync(process.env.NATIVE_TEAM_PREVIEW+'.done'),900);}assert(f.textRequests.some(b=>b.tools?.some((t:any)=>t.function.name==='team_video_generate')));
 }finally{await f.close();}});


test('automatic generation is idempotent, model-scoped, unlimited by legacy shot quota; drafts never create', {timeout:120000},async()=>{
 const f=await fixture();try{const user=f.users[0],i=f.instances[0],sessionId='auto-validation',args={script:'白天，木门前的人停顿并回头。',notes:'保持连续',model_id:f.models[0].id,params:{seconds:4}};
 const draft=await f.app.native.team.tool(i,user,{action:'video_prepare',sessionId,callId:'draft',args});assert.equal(draft!.plan.state,'awaiting_confirmation');assert.equal(f.app.store.all('video-job').length,0);
 for(let n=0;n<5;n++)f.app.store.put('video-job',{id:'prior-'+n,owner:user.id,project:'shared',sourceId:draft!.plan.shots[0].source.id,planId:draft!.plan.id,round:n+1,state:'failed',createAttempts:1});
 const request={action:'video_generate',sessionId,callId:'first',sourceMessageId:'member-request-1',sourceText:'请生成视频',args:{...args,previous_plan_id:draft!.plan.id}};
 const a=await f.app.native.team.tool(i,user,request),b=await f.app.native.team.tool(i,user,{...request,callId:'different-call-after-reconnect'});assert.equal(a!.plan.id,b!.plan.id);const aliasArgs:any={...request.args,model:f.models[0].name};delete aliasArgs.model_id;const alias=await f.app.native.team.tool(i,user,{...request,args:aliasArgs});assert.equal(alias!.plan.id,a!.plan.id);const reordered=await f.app.native.team.tool(i,user,{...request,args:Object.fromEntries(Object.entries(request.args).reverse())});assert.equal(reordered!.plan.id,a!.plan.id);assert.equal(f.app.store.all('video-job').length,6);await until(()=>f.app.store.all('video-job').some(j=>j.planId===a!.plan.id&&j.state==='ready'));assert.equal(f.creates(),1);
 const admin=f.app.store.all('user').find(u=>u.role==='admin')!,policy=new MemberModels(f.app.store);policy.save(admin,{video:[f.models[1].id],image:[]});assert(!f.app.pickups.catalog.models(user).some(m=>m.id===f.models[0].id));await assert.rejects(f.app.native.team.tool(i,user,{...request,sourceMessageId:'member-request-2'}),/开放/);assert.equal(f.creates(),1);
 await assert.rejects(Promise.resolve().then(()=>policy.save(user,{video:[],image:[]})),/管理员/);
 f.app.options.nativeOnly=true;const legacy=await fetch(f.base+'/api/login',{method:'POST',headers:{Origin:f.base,'Content-Type':'application/json'},body:JSON.stringify({username:user.username,password})});const auth=await legacy.json() as any;const rejected=await fetch(f.base+'/api/tasks',{method:'POST',headers:{Origin:f.base,Cookie:legacy.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':auth.csrf,'Content-Type':'application/json'},body:JSON.stringify({prompt:'生成视频'})});assert.equal(rejected.status,409);assert.equal((await rejected.json() as any).code,'NATIVE_CHAT_REQUIRED');assert.equal(f.app.store.all('task').length,0);
 const other=f.users[1];await assert.rejects(f.app.native.team.tool(f.instances[1],other,{action:'status',sessionId:'foreign',callId:'foreign',args:{plan_id:a!.plan.id}}),/权限|不存在|成员/);
 }finally{await f.close();}
});

test('project native templates freeze versions; round history, batched status, ZIP and QA cache stay private', {timeout:120000},async()=>{
 const f=await fixture();try{
  const admin=f.app.store.all('user').find(u=>u.role==='admin')!,catalog=f.app.pickups.catalog;
  const body='{{script}}\n{{storyboard}}\n{{notes}}\n{{assets}}\n{{dayPeriod}}\n{{duration}}';
  const t=catalog.saveTemplate(admin,{name:'当前项目镜头准则',body,status:'published',modelIds:[],default:true,nativeEnabled:true},'shared');assert.equal(t.version,1);
  const u=f.users[0],i=f.instances[0],args={script:'院门前回头',notes:'第一次意见',model_id:f.models[0].id,params:{seconds:4}};
  const first=(await f.app.native.team.tool(i,u,{action:'video_generate',sessionId:'rounds',callId:'one',sourceMessageId:'round-one',sourceText:'第一次生成',args}))!.plan;assert.equal(first.promptTemplate.revision,t.revision);assert(first.shots[0].prompt.includes('项目提示词模板'));
  const newer=catalog.saveTemplate(admin,{id:t.id,name:t.name,body:body+'\n新版本',status:'published',modelIds:[],default:true,nativeEnabled:true},'shared');assert.equal(newer.version,2);assert.throws(()=>catalog.saveTemplate(admin,{id:t.id,name:t.name,body,status:'published',modelIds:[],default:true,nativeEnabled:true},'other'));
  await until(()=>f.app.store.all('video-job').every(j=>j.state==='ready'));
  const next=(await f.app.native.team.tool(i,u,{action:'video_generate',sessionId:'rounds',callId:'two',sourceMessageId:'round-two',sourceText:'第二次生成',args:{...args,notes:'第二次意见',previous_plan_id:first.id}}))!.plan;assert.equal(next.promptTemplate.revision,newer.revision);assert.equal(f.app.store.get('pickup',first.id)!.promptTemplate.revision,t.revision);
  await until(()=>f.app.store.all('video-job').every(j=>j.state==='ready'));const history=await f.clients[0]('/api/team/video/'+next.id+'/history');assert.equal(history.total,2);assert.deepEqual(history.items.map((v:any)=>v.plan.promptTemplate.version),[1,2]);await f.clients[1]('/api/team/video/'+next.id+'/history','GET',undefined,404);
  const status=await f.clients[0]('/api/team/status?plans=video/'+first.id+',video/'+id());assert.equal(status.items.length,1);assert.equal(Object.keys(status.errors).length,1);
  const job=f.app.pickups.get(first.id,u).jobs[0],count=f.app.store.all('media').length;const qa=await f.app.pickups.media.technicalQA(job.mediaId,4);assert(qa.passed);assert.equal(f.app.store.all('media').length,count);assert.deepEqual(qa.frames,job.technicalQA.frames);
  const zip=await f.clients[0]('/api/team/video/'+first.id+'/bundle','GET',undefined,200,true);assert.equal(zip.readUInt32LE(0),0x04034b50);await f.clients[1]('/api/team/video/'+first.id+'/bundle','GET',undefined,404);
  assert.equal(f.creates(),2);
 }finally{await f.close();}
});

test('native revisions and model switches run concurrently; explicit ten-minute retry preserves originals and idempotency', {timeout:120000},async()=>{
 const f=await fixture();try{
  const team=f.app.native.team,u=f.users[0],i=f.instances[0],sessionId='concurrent-revisions';f.app.pickups.closing=true;
  const asset=await f.app.pickups.media.ingest((await import('node:stream')).Readable.from([readFileSync(f.pic)]),u.id,'private','reference.png');
  const args={script:'夜间推门回头。',notes:'保留原图。',final_prompt:'人物近景，推门回头。',model_id:f.models[0].id,params:{seconds:4},reference_media_ids:[asset.id]};
  const request={action:'video_generate',sessionId,callId:'one',sourceMessageId:'first-message',sourceText:'生成这条视频',args};
  const first=(await team.tool(i,u,request))!.plan,old=f.app.store.all('video-job')[0];
  const switched=(await team.tool(i,u,{...request,sourceMessageId:'switch-now',args:{...args,model_id:f.models[1].id,previous_plan_id:first.id}}))!.plan;
  assert.equal(f.app.store.get('video-job',old.id)!.state,'queued');assert.equal(f.app.store.get('video-job',old.id)!.supersededBy,undefined);
  for(const [n,state] of ['preparing','running','submission_unknown'].entries()){
   f.app.store.put('video-job',{...old,state,createAttempts:1});
   const next=(await team.tool(i,u,{...request,sourceMessageId:'revision-'+n,args:{...args,notes:'新的修改 '+n,previous_plan_id:first.id}}))!.plan;
   assert.equal(next.state,'confirmed');assert.equal(f.app.store.get('video-job',old.id)!.state,state);
  }
  const retry={action:'resubmit',sessionId,callId:'retry',sourceMessageId:'member-retry',sourceText:'十分钟还没生成，再次提交',args:{kind:'video',plan_id:first.id}};
  await assert.rejects(team.tool(i,u,retry),/10 分钟/);
  f.app.store.put('video-job',{...old,created:new Date(Date.now()-601000).toISOString()});
  const second=(await team.tool(i,u,retry))!.plan;assert.deepEqual(second.quotas,[]);assert.equal(second.resubmissionOf,first.id);assert.deepEqual(second.shots,first.shots);assert.equal(second.model.id,first.model.id);
  const replay=(await team.tool(i,u,{...retry,callId:'new-call-after-reconnect'}))!.plan;assert.equal(replay.id,second.id);assert.equal(f.app.store.all('video-job').length,6);
  await assert.rejects(team.tool(f.instances[1],f.users[1],{...retry,sourceMessageId:'foreign'}),/不存在|权限|成员/);
  await assert.rejects(team.tool(i,u,{...retry,sourceMessageId:undefined}),/成员消息/);
  f.app.pickups.closing=false;f.app.pickups.pump();await until(()=>f.app.store.all('video-job').every(j=>j.state==='ready'));
  assert.equal(f.creates(),6);assert.equal(f.app.store.get('video-job',old.id)!.state,'ready');assert(f.payloads.some(p=>p.model===f.models[1].remoteModel));
  await assert.rejects(team.tool(i,u,{...retry,sourceMessageId:'after-completion'}),/已生成/);assert.equal((await team.tool(i,u,retry))!.plan.id,second.id);assert.equal(f.creates(),6);
  const history=team.history(i,'video',switched.id);assert.equal(history.total,6);assert(history.items.every((v:any)=>v.plan.jobs[0].mediaId));
 }finally{f.app.pickups.closing=false;await f.close();}
});
