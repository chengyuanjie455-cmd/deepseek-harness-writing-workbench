import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync,spawn } from 'node:child_process';
import {once} from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Platform } from '../server/app.ts';
import { id, hash, Problem, type Doc } from '../server/store.ts';
import { parsePickup, validParams } from '../server/pickup-input.ts';
import type { VideoAdapter } from '../server/video-catalog.ts';
import { VideoNotSubmitted } from '../server/video-catalog.ts';
import { Pickups } from '../server/pickups.ts';
const password='Synthetic-test-123456!';
test('native template revisions stay attached to their own dispatch and pending assemblies resolve the exact original generation receipt',{timeout:60000},async()=>{
 const f=await fixture(2);let release=()=>{};try{
  const user=f.app.store.all('user').find(u=>u.username==='member0')!,other=f.app.store.all('user').find(u=>u.username==='member1')!,actor:any={key:'input-lineage',owner:user.id,project:'shared'},ws=f.app.workspace('shared'),sent:Doc[]=[],create=f.app.pickups.adapter.create,wait=new Promise<void>(r=>{release=r;});
  f.app.pickups.adapter.create=async(...args)=>{sent.push(structuredClone(args[2]));if(sent.length===1)await wait;return create(...args);};
  const t1=await f.admin.call('/admin/video-templates?project=shared','POST',{name:'本机版本模板',body:'版本一：{{script}}\n{{notes}}',status:'published',nativeEnabled:true,modelIds:[f.model.id],default:true},201);
  const request:any={action:'video_generate',sessionId:'session-input-lineage',sourceMessageId:'original-input',sourceText:'按原剧本生成',callId:'one',args:{model_id:f.model.id,script:'林一推开蓝门。',notes:'保留第一版动作。',params:{seconds:4}}},first:any=await f.app.native.team.tool(actor,user,request);
  for(let n=0;n<100&&!sent.length;n++)await delay(20);assert.equal(sent.length,1);let a=f.app.store.all('video-job').find(j=>j.planId===first.plan.id)!;const frozen=JSON.stringify(a.authorizedInput);assert.equal(a.authorizedInput.template.bodySHA256,hash(t1.body));assert.equal(a.dispatchInputs[0].input.content.promptSHA256,hash(sent[0].prompt));assert.equal(a.remoteTaskId,undefined);
  const assembling=ws.assembly.submit(user,request.sessionId,{clips:[{job_id:a.id}],name:'旧版原片拼接'},'original-assembly'),baseline=JSON.stringify(ws.store.get('assembly-job',assembling.id)!.sourceProvenance);assert.equal(assembling.sourceProvenance.generationInputs[0].receipt.acceptance,'not_proven');assert(assembling.sourceStatus.summary.includes('冻结输入已记录'));
  const t2=await f.admin.call('/admin/video-templates?project=shared','POST',{id:t1.id,name:t1.name,body:'版本二：{{script}}\n{{notes}}',status:'published',nativeEnabled:true,modelIds:[f.model.id],default:true},201);
  const second:any=await f.app.native.team.tool(actor,user,{...request,sourceMessageId:'revised-input',callId:'two',args:{...request.args,previous_plan_id:first.plan.id,script:'林一放慢动作推开蓝门。',notes:'使用第二版动作。'}});for(let n=0;n<100&&sent.length<2;n++)await delay(20);assert.equal(sent.length,2);release();const jobs=await settle(f);a=jobs.find(j=>j.planId===first.plan.id)!;const z=jobs.find(j=>j.planId===second.plan.id)!;assert.equal(a.state,'ready');assert.equal(z.state,'ready');assert.equal(JSON.stringify(a.authorizedInput),frozen);assert.equal(z.authorizedInput.template.bodySHA256,hash(t2.body));assert.notEqual(a.authorizedInput.digest,z.authorizedInput.digest);assert.equal(z.dispatchInputs[0].input.content.promptSHA256,hash(sent[1].prompt));
  f.app.pickups.adopt(z.id,user,{digest:second.plan.digest,humanAccepted:true});for(let n=0;n<300&&ws.assembly.get(user,assembling.id).state!=='ready';n++)await delay(20);const ready=ws.assembly.get(user,assembling.id);assert.equal(ready.state,'ready');assert.equal(JSON.stringify(ws.store.get('assembly-job',assembling.id)!.sourceProvenance),baseline);assert.equal(ready.resolvedGenerationInputs[0].receipt.acceptance,'provider_receipt_recorded');assert.equal(ready.resolvedGenerationInputs[0].receipt.input.template.bodySHA256,hash(t1.body));assert(ready.sourceStatus.changes.some((v:Doc)=>v.category==='template'));assert.equal(ready.clips[0].mediaId,a.mediaId);
  const owner=(await ws.content.page(user,{section:'videos'})).items.find((v:Doc)=>v.mediaId===z.mediaId)!;assert.equal(owner.generationInput.input.template.bodySHA256,hash(t2.body));const peer=(await ws.content.page(other,{section:'videos'})).items.find((v:Doc)=>v.mediaId===z.mediaId)!;assert(peer.sharedProjection);assert(!Object.hasOwn(peer,'generationInput'));assert(!JSON.stringify(peer).includes(a.authorizedInput.digest));assert.equal(f.creates(),2);assert.equal(f.app.store.all('video-job').length,2);assert.equal(f.app.store.all('image-job').length,0);
 }finally{release();await f.app.close();}
});
test('conversation video generation ignores unrelated project metadata while indexed inputs keep their publication checks',async()=>{
 const f=await fixture();try{
  const legacy=await plan(f);
  const root=f.app.projects.canonical;mkdirSync(join(root,'.video_agent'));writeFileSync(join(root,'.zcodeignore'),'native files');
  writeFileSync(join(root,'剧本.md'),'unpublished edits');
  const user=f.app.store.all('user').find(u=>u.username==='member0')!;
  const i:any={key:'video-native-metadata',owner:user.id,project:'shared'};
  const request={action:'video_generate',sessionId:'native-video-metadata',sourceMessageId:'video-request',sourceText:'生成蓝色房门镜头',callId:'video-call',args:{model_id:f.model.id,script:'蓝色房门缓慢打开',notes:'保持画面稳定',final_prompt:'蓝色房门缓慢打开。',params:{seconds:4}}};
  const card:any=await f.app.native.team.tool(i,user,request);assert.equal(card.plan.state,'confirmed');
  const [job]=await settle(f);assert.equal(job.state,'ready');assert.equal(job.createAttempts,1);assert.equal(f.creates(),1);
  const replay:any=await f.app.native.team.tool(i,user,{...request,callId:'reconnect'});assert.equal(replay.plan.id,card.plan.id);assert.equal(f.creates(),1);
  assert.equal(readFileSync(join(root,'剧本.md'),'utf8'),'unpublished edits');
  assert.throws(()=>f.app.pickups.validatePlan(legacy,user),/相对路径|平台外修改/);
 }finally{await f.app.close();}
});
test('proven transient pre-send failure retries once automatically, permanent and ambiguous failures do not',async()=>{
 const f=await fixture();try{
  let dispatches=0;const create=f.app.pickups.adapter.create;
  f.app.pickups.adapter.create=async(...args)=>{if(++dispatches===1)throw new VideoNotSubmitted('injected before fetch',true);return create(...args);};
  const p=await plan(f);await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});
  const [j]=await settle(f);assert.equal(j.state,'ready');assert.equal(j.safeRetryCount,1);assert.equal(dispatches,2);assert.equal(f.creates(),1);
  const verify=f.app.pickups.verifyAssets.bind(f.app.pickups);let checks=0;f.app.pickups.verifyAssets=async(...args)=>{if(++checks===1)throw new TypeError('asset readback temporarily offline');return verify(...args);};
  const recovered=await plan(f);await f.clients[0].call(`/pickups/${recovered.id}/confirm`,'POST',{digest:recovered.digest});const after=await settle(f);assert.equal(after.find(j=>j.planId===recovered.id)?.safeRetryCount,1);assert.equal(f.creates(),2);
  f.app.pickups.adapter.create=async()=>{throw new VideoNotSubmitted('permanent guard');};
  const p2=await plan(f);await f.clients[0].call(`/pickups/${p2.id}/confirm`,'POST',{digest:p2.digest});
  const jobs=await settle(f);assert.equal(jobs.find(j=>j.planId===p2.id)?.state,'blocked');assert.equal(f.creates(),2);
 }finally{await f.app.close();}
});

test('model-specific prompt and correction image attachment are frozen without changing the source index',async()=>{
 const f=await fixture();try{
  const tpl=await f.admin.call('/admin/video-templates','POST',{name:'模型专用',body:'模型专用结构：{{dayPeriod}} {{duration}} {{storyboard}} {{notes}} {{assets}}',status:'published',modelIds:[f.model.id],default:false},201);
  const pic=join(f.root,'correction.png');execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=red:s=160x90','-frames:v','1',pic]);
  const m=await f.clients[0].call('/image-assets','POST',{name:'correction.png',base64:readFileSync(pic).toString('base64'),requestId:id()},201);
  const model=f.app.store.get('video-model',f.model.id)!;f.app.store.put('video-model',{...model,referenceField:'images',maxReferences:1});
  // Isolate planning from real upload/network, retaining original-byte validation.
  const c=f.app.store.get('video-channel',f.channel.id)!;f.app.store.put('video-channel',{...c,adapter:'xiaopei'});f.app.pickups.adapter.upload=async()=>{throw Error('not called in planning');};
  const index=f.app.pickups.index();const t=await f.clients[0].call('/tasks','POST',{session:f.sessions[0].id,requestId:id(),prompt:`剧本片段：${f.shots[0].scriptQuote}\n补抽意见：用附件红色替代原蓝色。\n视频模型：测试视频`,workflow:'pickup',paths:[m.attachmentPath]},202);
  let p:any;for(let n=0;n<100;n++){p=f.app.store.get('pickup',t.id);if(p)break;await delay(20);}
  assert.equal(p.state,'awaiting_confirmation',JSON.stringify(p.issues));assert.equal(p.template.id,tpl.id);assert.equal(p.shots[0].assets[0].sha256,m.sha256);assert.equal(p.reads[m.attachmentPath],m.sha256);assert.deepEqual(f.app.pickups.index(),index);
 }finally{await f.app.close();}
});
class Client {
  cookie='';csrf='';constructor(public base:string){}
  async call(path:string,method='GET',body?:any,status=200) {const r=await fetch(this.base+'/api'+path,{method,headers:{Origin:this.base,Cookie:this.cookie,'X-CSRF-Token':this.csrf,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json() as any;assert.equal(r.status,status,JSON.stringify(j));if(r.headers.get('set-cookie'))this.cookie=r.headers.get('set-cookie')!.split(';')[0];if(j.csrf)this.csrf=j.csrf;return j;}
  login(username:string){return this.call('/login','POST',{username,password});}
}
async function fixture(count=1,unknown=false,videoConcurrency=2) {
  const root=mkdtempSync(join(tmpdir(),'pickup-b07-'));const video=join(root,'fixture.mp4');
  execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=12','-t','4','-c:v','libx264','-pix_fmt','yuv420p',video]);
  let creates=0;
  const adapter:VideoAdapter={async create(){creates++;if(unknown)throw new Error('injected socket close after create');return {id:`fake-${creates}`,status:'queued'};},async query(_c,_k,taskId){return {id:taskId,status:'completed'};},async content(){return new Response(readFileSync(video),{headers:{'Content-Type':'video/mp4'}});}};
  const app=new Platform({dataDir:join(root,'data'),videoAdapter:adapter,simulatedVideo:true,mockDelay:1,videoConcurrency});const port=await app.start(0);const admin=new Client(`http://127.0.0.1:${port}`);
  await admin.call('/setup','POST',{username:'admin',password},201);await admin.login('admin');
  const chan=await admin.call('/admin/video-channels','POST',{name:'合成瑞云',origin:'https://synthetic.invalid',adapter:'ruiyun',apiKey:'fixture-only-not-a-real-key',enabled:true,concurrency:videoConcurrency,noRetryEvidence:'synthetic adapter is once-only; offline evidence only'},201);
  const c:Doc={...app.store.get('video-channel',chan.id)!,verified:true,reachableModels:['fixture-video']};app.store.put('video-channel',c);app.store.put('video-channel-version',{...c,id:c.revision,channelId:c.id});
  // Explicit isolated test capacity; never evidence for a real provider.
  app.store.put('runtime-concurrency',{...app.store.get('runtime-concurrency','active'),id:'active',testedVideo:videoConcurrency,testedChannels:{[c.id]:{limit:videoConcurrency,revision:c.revision}}});
  const m=await admin.call('/admin/video-models','POST',{name:'合成视频',aliases:['测试视频'],channelId:c.id,remoteModel:'fixture-video',status:'testing',default:true,params:{resolution:['90p'],aspect_ratio:['16:9'],audio:[false]},defaults:{resolution:'90p',aspect_ratio:'16:9',audio:false},secondsType:'number',durations:[4],referenceField:'none',maxReferences:0,capabilityEvidence:'fixture schema only',pricePerSecond:null,currency:'CNY'},201);
  // Deliberate test fixture, never production publication evidence.
  app.store.put('video-model',{...m,status:'published'});
  const template=await admin.call('/admin/video-templates','POST',{name:'合成补抽模板',body:'{{dayPeriod}} {{duration}}秒。分镜：{{storyboard}}\n意见：{{notes}}\n资产：{{assets}}\n服装：{{wardrobe}}\n对白：{{dialogue}}',status:'published',modelIds:[],default:true},201);
  const script=Array.from({length:count},(_,i)=>`第${i+1}位测试员推开独立的蓝色房门。`).join('\n');
  const base=(await admin.call('/project')).revision;const change=await admin.call('/changes','POST',{base,writes:{'剧本.md':script,'分镜.md':script}},201);await admin.call(`/changes/${change.id}/approve`,'POST',{digest:change.digest});
  const shots=Array.from({length:count},(_,i)=>({id:`S${i+1}`,episode:'合成验收',scriptPath:'剧本.md',scriptQuote:script.split('\n')[i],storyboardPath:'分镜.md',storyboardQuote:script.split('\n')[i],duration:4,dayPeriod:'day',kind:'action',framing:'medium',visualDescription:'蓝色房门缓慢打开。',characters:[],assets:[],dialogue:[]}));
  await admin.call('/admin/video-index','POST',{base:(await admin.call('/project')).revision,shots},201);
  const clients:Client[]=[];const sessions:Doc[]=[];
  for(let i=0;i<count;i++){await admin.call('/admin/users','POST',{username:`member${i}`,password,role:'member'},201);const member=new Client(admin.base);await member.login(`member${i}`);clients.push(member);sessions.push(await member.call('/sessions','POST',{title:`合成 ${i}`},201));}
  return {app,admin,clients,sessions,shots,template,model:m,channel:chan,root,video,creates:()=>creates};
}
async function plan(f:Awaited<ReturnType<typeof fixture>>,i=0,extra='',modelName='测试视频') {
  const t=await f.clients[i].call('/tasks','POST',{session:f.sessions[i].id,requestId:id(),prompt:`剧本片段：${f.shots[i].scriptQuote}\n补抽意见：保持蓝色房门一致，完整开门。\n视频模型：${modelName}\n模型参数：画幅：16:9，音频：关闭${extra}`,workflow:'pickup',paths:[]},202);
  for(let n=0;n<100;n++){const p=f.app.store.get('pickup',t.id);if(p)return p;await delay(20);}throw Error('plan timeout');
}
async function settle(f:Awaited<ReturnType<typeof fixture>>) {for(let n=0;n<300;n++){const jobs=f.app.store.all('video-job');if(jobs.length && jobs.every(j=>!['queued','preparing','submitting','running','downloading','checking'].includes(j.state)))return jobs;for(const j of jobs)if(['running','downloading','checking'].includes(j.state))f.app.store.put('video-job',{...j,nextPoll:0});f.app.pickups.pump();await delay(40);}throw Error('video timeout');}

test('old unknown images cannot starve the independent video channel',async()=>{
 const f=await fixture();try{
  for(let n=0;n<13;n++)f.app.store.put('image-job',{id:id(),owner:'old-member',state:'submission_unknown',channelId:f.channel.id,createAttempts:1});
  const p=await plan(f);await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});const [j]=await settle(f);assert.equal(j.state,'ready');assert.equal(f.creates(),1);assert.equal(f.app.store.all('image-job').filter(j=>j.state==='submission_unknown').length,13);
 }finally{await f.app.close();}
});
test('linked revisions execute alongside the original queued task and retain both records',async()=>{
 const f=await fixture();try{
  f.app.pickups.closing=true;const p=await plan(f);await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});const old=f.app.store.all('video-job')[0];assert.equal(old.state,'queued');
  const replacement=await plan(f);f.app.store.put('pickup',{...replacement,previousPlanId:p.id});await f.clients[0].call(`/pickups/${replacement.id}/confirm`,'POST',{digest:replacement.digest});
  assert.equal(f.app.store.get('video-job',old.id)!.state,'queued');assert.equal(f.app.store.get('video-job',old.id)!.supersededBy,undefined);assert.equal(f.creates(),0);
  f.app.pickups.closing=false;f.app.pickups.pump();const jobs=await settle(f);assert.equal(jobs.find(j=>j.planId===replacement.id)?.state,'ready');assert.equal(jobs.find(j=>j.id===old.id)?.state,'ready');assert.equal(f.creates(),2);
 }finally{f.app.pickups.closing=false;await f.app.close();}
});

test('8 independent chats: confirm once, media privacy, technical QA, adoption, new round and restart',async()=>{
  const f=await fixture(8);try{
    const context=f.app.pickups.context({owner:f.app.store.all('user').find(u=>u.username==='member0')!.id,base:f.app.projects.current().revision,prompt:'时长：4'});const contextData=JSON.parse(context.slice(context.indexOf('\n')+1));
    assert.deepEqual(contextData.models[0].params.seconds,[4]);assert.equal(contextData.parameterAliases['时长'],'seconds');assert.equal(contextData.candidates[0].duration,4);
    const plans=await Promise.all(f.clients.map((_,i)=>plan(f,i)));assert(plans.every(p=>p.state==='awaiting_confirmation'),JSON.stringify(plans));
    await Promise.all(plans.map((p,i)=>f.clients[i].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest})));
    await f.clients[0].call(`/pickups/${plans[0].id}/confirm`,'POST',{digest:plans[0].digest});
    await f.clients[1].call(`/pickups/${plans[0].id}`,'GET',undefined,404);
    const jobs=await settle(f);assert.equal(f.creates(),8);assert(jobs.every(j=>j.state==='ready'),JSON.stringify(jobs.map(j=>[j.state,j.error])));
    const first=jobs.find(j=>j.planId===plans[0].id)!;
    const response=await fetch(f.admin.base+`/api/media/${first.mediaId}`,{headers:{Cookie:f.clients[1].cookie}});assert.equal(response.status,404);
    const own=await fetch(f.admin.base+`/api/media/${first.mediaId}`,{headers:{Cookie:f.clients[0].cookie,Range:'bytes=0-15'}});assert.equal(own.status,206);assert.equal((await own.arrayBuffer()).byteLength,16);
    const secretFree=JSON.stringify(await f.clients[0].call(`/pickups/${plans[0].id}`));assert(!secretFree.includes('fixture-only-not-a-real-key'));assert(!secretFree.includes('secretRef'));
    await f.clients[0].call(`/pickups/jobs/${first.id}/adopt`,'POST',{digest:plans[0].digest,humanAccepted:true});
    await f.clients[0].call(`/pickups/jobs/${first.id}/adopt`,'POST',{digest:plans[0].digest,humanAccepted:true});
    const shared=await fetch(f.admin.base+`/api/media/${first.mediaId}`,{headers:{Cookie:f.clients[1].cookie}});assert.equal(shared.status,200);assert.equal(hash(Buffer.from(await shared.arrayBuffer())),first.mediaSHA256);
    const newPlan=await plan(f,0);await f.clients[0].call(`/pickups/${newPlan.id}/confirm`,'POST',{digest:newPlan.digest});const again=await settle(f);assert.equal(f.creates(),9);assert.equal(again.find(j=>j.planId===newPlan.id)!.round,2);
    const data=f.app.store.root;await f.app.close();const restarted=new Platform({dataDir:data,videoAdapter:f.app.pickups.adapter,simulatedVideo:true,mockDelay:1});try{await restarted.start(0);assert.equal(restarted.store.all('video-job').length,9);assert.equal(restarted.store.get('video-job',first.id)?.state,'adopted');assert.equal(f.creates(),9);}finally{await restarted.close();}
  }finally{if(!f.app.closing)await f.app.close();}
});

test('parameter validation and revoked models block, while same-shot submissions run concurrently',async()=>{
 const f=await fixture();try{
  const bad=await plan(f,0,'，不支持参数：test');assert.equal(bad.state,'needs_input');assert.equal(f.creates(),0);
  const p=await plan(f);const duplicate=await plan(f);await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});await f.clients[0].call(`/pickups/${duplicate.id}/confirm`,'POST',{digest:duplicate.digest});await settle(f);
  const later=await plan(f);const current=f.app.store.get('video-template',f.template.id)!;f.app.store.put('video-template',{...current,revision:id()});await f.clients[0].call(`/pickups/${later.id}/confirm`,'POST',{digest:later.digest},409);assert.equal(f.creates(),2);
  const stale=await plan(f);const m=f.app.store.get('video-model',f.model.id)!;f.app.store.put('video-model',{...m,status:'disabled'});await f.clients[0].call(`/pickups/${stale.id}/confirm`,'POST',{digest:stale.digest},409);
  await f.clients[0].call('/admin/video-channels','GET',undefined,403);
  await f.admin.call('/admin/video-channels','POST',{name:'bad',origin:'http://127.0.0.1:1',adapter:'ruiyun',apiKey:'x',enabled:true,concurrency:1},400);
 }finally{await f.app.close();}
});

test('ambiguous create stays occupied through restart; recovery queries original task without new POST',async()=>{
 const f=await fixture(1,true);try{const p=await plan(f);await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});let [j]=await settle(f);assert.equal(j.state,'submission_unknown');assert.equal(j.createAttempts,1);await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});assert.equal(f.app.store.all('video-job').length,1);
  const adapter=f.app.pickups.adapter, data=f.app.store.root;
  // Emulate a durable create intent at the instant the server exits.
  f.app.store.put('video-job',{...j,state:'submitting'});await f.app.close();
  f.app=new Platform({dataDir:data,videoAdapter:adapter,simulatedVideo:true,mockDelay:1});
  const base=`http://127.0.0.1:${await f.app.start(0)}`;f.admin.base=base;f.clients[0].base=base;await f.admin.login('admin');await f.clients[0].login('member0');
  assert.equal(f.app.store.get('video-job',j.id)!.state,'submission_unknown');assert.equal(f.creates(),1);
  await f.admin.call(`/admin/video-jobs/${j.id}/recover`,'POST',{remoteTaskId:'original-confirmed-1',evidence:'synthetic source account receipt correlates original request'});[j]=await settle(f);assert.equal(j.state,'ready');assert.equal(f.creates(),1);
 }finally{await f.app.close();}
});

test('SIGKILL after durable job state recovers WAL, writer lock and downloads without another create',async()=>{
 const f=await fixture();try{
  const p=await plan(f);await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});const [original]=await settle(f);
  const adapter=f.app.pickups.adapter,data=f.app.store.root;assert.equal(f.creates(),1);
  for(const phase of ['running','downloading','submitting']){
   await f.app.close();
   const body=`import {Store} from ${JSON.stringify(new URL('../server/store.ts',import.meta.url).href)};const s=new Store(process.env.CRASH_DATA);const j=s.get('video-job',process.env.CRASH_JOB);s.put('video-job',{...j,state:process.env.CRASH_PHASE,mediaId:null,mediaSHA256:null,nextPoll:0,remoteCompletedAt:process.env.CRASH_PHASE==='downloading'?new Date().toISOString():null});process.stdout.write('durable\\n');setInterval(()=>{},1000);`;
   const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',body],{env:{...process.env,CRASH_DATA:data,CRASH_JOB:original.id,CRASH_PHASE:phase},stdio:['ignore','pipe','pipe']});
   let output='';child.stdout.on('data',v=>output+=v);let errors='';child.stderr.on('data',v=>errors+=v);
   try{for(let n=0;n<100&&!output.includes('durable');n++){if(child.exitCode!==null)throw Error(errors);await delay(20);}assert.match(output,/durable/);const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
   finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}}
   f.app=new Platform({dataDir:data,videoAdapter:adapter,simulatedVideo:true,mockDelay:1});await f.app.start(0);
   assert.equal((f.app.store.db.prepare('PRAGMA integrity_check').get() as any).integrity_check,'ok');
   if(phase==='submitting'){await delay(100);assert.equal(f.app.store.get('video-job',original.id)!.state,'submission_unknown');}
   else {const jobs=await settle(f);assert.equal(jobs.find(j=>j.id===original.id)!.state,'ready');}
   assert.equal(f.creates(),1,'recovery must not issue a second paid creation');
  }
 }finally{if(!f.app.closing)await f.app.close();}
});

test('source quotes and closeup rule, original-byte asset import and template history',async()=>{
 const f=await fixture();try{const b={base:f.app.projects.current().revision,shots:[{...f.shots[0],kind:'dialogue',framing:'wide',characters:[]}]};await f.admin.call('/admin/video-index','POST',b,400);
  await f.admin.call('/admin/video-index','POST',{...b,shots:[{...f.shots[0],scriptQuote:'a fabricated quote'}]},409);
  const media=await f.admin.call('/admin/video-assets/import','POST',{path:realpathSync(f.video)},201);assert.equal(media.sha256,hash(readFileSync(f.video)));assert.equal(media.bytes,statSync(f.video).size);
  const before=f.app.store.all('video-template-version').length;const t=f.app.store.get('video-template',f.template.id)!;
  await f.admin.call('/admin/video-templates','POST',{id:t.id,name:t.name,body:'  '+t.body+'\n新规则。\n  ',status:'published',modelIds:[],default:true},201);assert.equal(f.app.store.all('video-template-version').length,before+1);assert.equal(f.app.store.get('video-template',t.id)!.body,'  '+t.body+'\n新规则。\n  ');
 }finally{await f.app.close();}
});

test('text input never silently ignores unsupported fields or conflicting duration',()=>{
 const p=parsePickup('剧本片段：原文\n补抽意见：修改\n模型参数：画幅：16:9，音频：关闭，时长：4秒');assert.deepEqual(p.params,{aspect_ratio:'16:9',audio:false,seconds:4});
 assert.throws(()=>parsePickup('视频模型：A\n视频模型：B'));
 assert.throws(()=>validParams({params:{audio:[true]},defaults:{audio:true},durations:[4]}, {seconds:8},3),/冲突/);
 assert.throws(()=>validParams({params:{},defaults:{},durations:[4]}, {apiKey:'injection'},4),/不支持/);
});


test('media download recovery never recreates; same-shot adoption conflict preserves earlier result',async()=>{
 const f=await fixture();try{
  const original=f.app.pickups.adapter.content;let downloads=0;
  f.app.pickups.adapter.content=async(...args)=>{if(++downloads===1)throw Error('injected download disconnect');return original(...args);};
  const p=await plan(f);await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});await settle(f);
  assert.equal(f.creates(),1);assert.equal(downloads,2);
  const p2=await plan(f);await f.clients[0].call(`/pickups/${p2.id}/confirm`,'POST',{digest:p2.digest});const jobs=await settle(f);
  const first=jobs.find(j=>j.planId===p.id)!,second=jobs.find(j=>j.planId===p2.id)!;
  await f.clients[0].call(`/pickups/jobs/${first.id}/adopt`,'POST',{digest:p.digest,humanAccepted:true});
  const revision=f.app.projects.current().revision;
  await f.clients[0].call(`/pickups/jobs/${second.id}/adopt`,'POST',{digest:p2.digest,humanAccepted:true},409);
  assert.equal(f.app.projects.current().revision,revision);assert.equal(f.app.store.get('video-job',second.id)!.state,'ready');
 }finally{await f.app.close();}
});

test('low disk blocks confirmation; returned dimensions are informational and allow adoption',async()=>{
 const f=await fixture();try{
  const p=await plan(f);const capacity=f.app.pickups.media.capacity.bind(f.app.pickups.media);
  f.app.pickups.media.capacity=()=>{throw new Problem(507,'injected low disk');};
  await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest},507);assert.equal(f.creates(),0);assert.equal(f.app.store.all('video-job').length,0);
  f.app.pickups.media.capacity=capacity;
  const model=f.app.store.get('video-model',f.model.id)!;f.app.store.put('video-model',{...model,revision:id(),params:{...model.params,resolution:['720p']},defaults:{...model.defaults,resolution:'720p'}});
  const mismatched=await plan(f);await f.clients[0].call(`/pickups/${mismatched.id}/confirm`,'POST',{digest:mismatched.digest});const [job]=await settle(f);
  assert.equal(job.state,'ready');assert.deepEqual(job.technicalQA.parameterChecks.warnings,['分辨率']);assert.deepEqual(job.technicalQA.parameterChecks.blockingMismatches,[]);
  await f.clients[0].call(`/pickups/jobs/${job.id}/adopt`,'POST',{digest:mismatched.digest,humanAccepted:true});assert.equal(f.creates(),1);
 }finally{await f.app.close();}
});

test('old dimension-only failures recheck the original without API calls; audio and damaged-video checks still block',async()=>{
 const f=await fixture();try{
  const p=await plan(f);await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});const [job]=await settle(f);
  await f.app.pickups.close();
  const saved=f.app.store.get('pickup',p.id)!;saved.shots[0].params={...saved.shots[0].params,resolution:'720p',aspect_ratio:'1:1',size:'1280x720'};f.app.store.put('pickup',saved);
  const error='原片与方案不符：分辨率、画幅、尺寸';
  f.app.store.put('video-job',{...job,state:'qa_failed',error,technicalQA:{...job.technicalQA,passed:false,error,parameterChecks:{expected:saved.shots[0].params,mismatches:['分辨率','画幅','尺寸']}}});
  const audioId=id(),damagedId=id();
  f.app.store.put('video-job',{...job,id:audioId,state:'qa_failed',error:'原片与方案不符：音频',technicalQA:{passed:false,error:'原片与方案不符：音频',parameterChecks:{mismatches:['音频']}}});
  f.app.store.put('video-job',{...job,id:damagedId,state:'qa_failed',error:'无法解码',technicalQA:{passed:false,error:'无法解码'}});
  const noNetwork:VideoAdapter={async create(){throw Error('must not submit');},async query(){throw Error('must not query');},async content(){throw Error('must not download');}};
  const resumed=new Pickups(f.app.store,f.app.projects,noNetwork,true);
  assert.equal(f.app.store.get('video-job',job.id)!.state,'checking');assert.equal(f.app.store.get('video-job',audioId)!.state,'qa_failed');assert.equal(f.app.store.get('video-job',damagedId)!.state,'qa_failed');
  await resumed.drive(job.id,false,new AbortController().signal);
  const ready=f.app.store.get('video-job',job.id)!;assert.equal(ready.state,'ready');assert.deepEqual(ready.technicalQA.parameterChecks.warnings,['分辨率','画幅','尺寸']);assert.equal(ready.mediaSHA256,job.mediaSHA256);assert.equal(ready.remoteTaskId,job.remoteTaskId);assert.equal(f.creates(),1);
  assert.equal((await resumed.media.technicalQA(job.mediaId,99)).passed,false);
  resumed.media.technicalQA=async()=>({...ready.technicalQA,passed:true,hasAudio:true});
  await resumed.drive(job.id,false,new AbortController().signal);
  const failed=f.app.store.get('video-job',job.id)!;assert.equal(failed.state,'qa_failed');assert.deepEqual(failed.technicalQA.parameterChecks.blockingMismatches,['音频']);
  await f.clients[0].call(`/pickups/jobs/${job.id}/adopt`,'POST',{digest:p.digest,humanAccepted:true},409);
  writeFileSync(resumed.media.path(job.mediaId),Buffer.from('invalid mp4'));
  assert.equal((await f.app.pickups.media.technicalQA(job.mediaId,4)).passed,false);
 }finally{await f.app.close();}
});


test('duplicate display names are rejected; ambiguous aliases ask for a unique published name',async()=>{
 const f=await fixture();try{
  const fields=['name','aliases','channelId','remoteModel','status','default','params','defaults','secondsType','durations','referenceField','maxReferences','capabilityEvidence','pricePerSecond','currency'];
  const body=Object.fromEntries(fields.map(k=>[k,f.model[k]]));body.status='testing';body.default=false;
  await f.admin.call('/admin/video-models','POST',body,409);
  const second=await f.admin.call('/admin/video-models','POST',{...body,name:'其他渠道合成视频'},201);f.app.store.put('video-model',{...second,status:'published'});
  const ambiguous=await plan(f);assert.equal(ambiguous.state,'needs_input');assert.match(ambiguous.issues[0],/其他渠道合成视频/);
  const chosen=await plan(f,0,'','其他渠道合成视频');assert.equal(chosen.state,'awaiting_confirmation');assert.equal(chosen.model.id,second.id);
  await f.admin.call('/admin/video-models','POST',{...body,id:second.id,name:second.name,status:'published'},409);
  assert.equal(f.creates(),0);
 }finally{await f.app.close();}
});

test('durable polling reports provider progress and survives read failures, disabled models and pending publication',async()=>{
 const f=await fixture();const originalPending=f.app.projects.pending.bind(f.app.projects);
 try {
  const p=await plan(f);await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});
  for(let n=0;n<100&&!f.app.store.all('video-job')[0]?.remoteTaskId;n++)await delay(20);
  const id=f.app.store.all('video-job')[0].id;assert.equal(f.app.store.get('video-job',id)!.remoteStatus,'queued');let queries=0;
  f.app.pickups.adapter.query=async(_c,_k,taskId)=>{queries++;if(queries===2)throw Error('synthetic network interruption with secret');return {id:taskId,status:queries===4?'completed':queries===1?'queued':'in_progress',progress:queries===1?'fake 100':42};};
  f.app.projects.pending=()=>[{id:'publication-recovery'}];
  f.app.store.put('video-model',{...f.app.store.get('video-model',f.model.id)!,status:'disabled'});
  async function poll(){const j=f.app.store.get('video-job',id)!;f.app.store.put('video-job',{...j,nextPoll:0});f.app.pickups.pump();for(let n=0;n<100&&f.app.pickups.active.has(id);n++)await delay(20);return f.app.store.get('video-job',id)!;}
  let j=await poll();assert.equal(j.remoteStatus,'queued');assert.equal(j.remoteProgress,null);assert.equal(j.pollAttempts,1);assert(j.lastPolledAt);
  j=await poll();assert.equal(j.state,'running');assert.equal(j.consecutiveErrors,1);assert.equal(j.pollAttempts,2);assert(!j.error.includes('secret'));assert(j.nextPoll>Date.now());
  j=await poll();assert.equal(j.remoteProgress,42);assert.equal(j.consecutiveErrors,0);assert.equal(j.error,null);
  const visible=await f.clients[0].call(`/pickups/${p.id}`);assert.equal(visible.jobs[0].remoteProgress,42);assert(!JSON.stringify(visible).includes('queryReceipt'));
  j=await poll();assert.equal(j.state,'ready');assert.equal(queries,4);assert.equal(f.creates(),1);assert.equal(j.downloadBytes,statSync(f.video).size);assert(j.remoteCompletedAt&&j.downloadCompletedAt);
 }finally{f.app.projects.pending=originalPending;await f.app.close();}
});

test('restart during technical checks reuses the downloaded original without query, download or create duplication',async()=>{
 const f=await fixture();let downloads=0,queries=0;const adapter=f.app.pickups.adapter,content=adapter.content,query=adapter.query;
 adapter.content=async(...args)=>{downloads++;return content(...args);};adapter.query=async(...args)=>{queries++;return query(...args);};
 try {
  f.app.pickups.media.technicalQA=async(_id,_seconds,signal)=>{await new Promise((_r,reject)=>{signal!.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});return {passed:true};};
  const p=await plan(f);await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});
  let saved:Doc|undefined;
  for(let n=0;n<150;n++){const j=f.app.store.all('video-job')[0];if(j?.state==='checking'&&j.mediaId){saved=j;break;}if(j?.state==='running')f.app.store.put('video-job',{...j,nextPoll:0});f.app.pickups.pump();await delay(20);}
  assert(saved);assert.equal(downloads,1);const data=f.app.store.root;await f.app.close();
  f.app=new Platform({dataDir:data,videoAdapter:adapter,simulatedVideo:true,mockDelay:1});await f.app.start(0);
  const [recovered]=await settle(f);assert.equal(recovered.state,'ready');assert.equal(recovered.mediaId,saved.mediaId);assert.equal(recovered.mediaSHA256,saved.mediaSHA256);assert.equal(downloads,1);assert.equal(queries,1);assert.equal(f.creates(),1);
 }finally{if(!f.app.closing)await f.app.close();}
});

test('short content is not marked delivered; read-only recovery stores one complete original with checksum',async()=>{
 const f=await fixture();let downloads=0;try {
  const original=readFileSync(f.video);f.app.pickups.adapter.content=async()=>{downloads++;return new Response(original,{headers:{'Content-Type':'video/mp4','Content-Length':String(original.length+(downloads===1?8:0))}});};
  const p=await plan(f);await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});const [j]=await settle(f);
  assert.equal(j.state,'ready');assert.equal(downloads,2);assert.equal(j.pollAttempts,1);assert.equal(j.downloadAttempts,2);assert.equal(f.creates(),1);
  const response=await fetch(f.admin.base+`/api/media/${j.mediaId}`,{headers:{Cookie:f.clients[0].cookie}});
  assert.equal(response.headers.get('x-content-sha256'),hash(original));assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(original));
 }finally{await f.app.close();}
});


test('explicit acceptance capacity admits eight independent creates; repeated confirmation never duplicates',async()=>{
 const f=await fixture(8,false,8);let active=0,peak=0;const create=f.app.pickups.adapter.create;
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 // Keep every admitted create in flight until all eight arrive. A fixed sleep
 // measures HTTP/scheduler speed under suite load rather than admission capacity.
 f.app.pickups.adapter.create=async(...args)=>{active++;peak=Math.max(peak,active);try{await gate;return await create(...args);}finally{active--;}};
 try{
  assert.equal((await f.admin.call('/status')).videoConcurrency,8);
  const plans=await Promise.all(f.clients.map((_,i)=>plan(f,i)));
  await Promise.all(plans.map((p,i)=>f.clients[i].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest})));
  await Promise.all(plans.map((p,i)=>f.clients[i].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest})));
  const deadline=Date.now()+10000;while(peak<8&&Date.now()<deadline)await delay(20);assert.equal(peak,8,'all eight independent creates must enter before release');release();
  const jobs=await settle(f);assert.equal(peak,8);assert.equal(f.creates(),8);assert.equal(new Set(jobs.map(j=>j.owner)).size,8);assert(jobs.every(j=>j.state==='ready'&&j.createAttempts===1));
 }finally{release();await f.app.close();}
});

test('capacity-only changes reuse verified contract, but simulated, bad QA and changed credentials or parameters cannot publish',async()=>{
 const f=await fixture(1,false,8);
 try{
  const p=await plan(f);await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});const [job]=await settle(f);
  const channel=f.app.store.get('video-channel',f.channel.id)!;
  const next:Doc={...channel,revision:id(),concurrency:4};f.app.store.put('video-channel',next);f.app.store.put('video-channel-version',{...next,id:next.revision,channelId:next.id});
  const fields=['id','name','aliases','channelId','remoteModel','default','params','defaults','secondsType','durations','referenceField','maxReferences','capabilityEvidence','pricePerSecond','currency'];
  const body={...Object.fromEntries(fields.map(k=>[k,f.model[k]])),status:'published'};
  await f.admin.call('/admin/video-models','POST',body,409);
  // Unit-only attestation: no production database or real provider is touched.
  f.app.store.put('video-job',{...job,simulated:false,technicalQA:{passed:false}});await f.admin.call('/admin/video-models','POST',body,409);
  f.app.store.put('video-job',{...job,simulated:false});await f.admin.call('/admin/video-models','POST',body,201);
  for(const patch of [{origin:'https://different.invalid'},{secretRef:id()},{adapter:'xiaopei'},{allowLocalHTTP:true}]){
   f.app.store.put('video-channel',{...next,...patch});await f.admin.call('/admin/video-models','POST',body,409);
  }
  f.app.store.put('video-channel',next);
  for(const patch of [{defaults:{resolution:'90p',aspect_ratio:'16:9',audio:true},params:{resolution:['90p'],aspect_ratio:['16:9'],audio:[true]}},{durations:[4,5]},{capabilityEvidence:'different contract'}])await f.admin.call('/admin/video-models','POST',{...body,...patch},409);
  await f.admin.call('/admin/video-models','POST',body,201);
 }finally{await f.app.close();}
});

test('five shared submissions, private quota requests, admin rejection/approval, idempotency and restart',async()=>{
 const f=await fixture(2);try{
  f.app.pickups.adapter.query=async(_c,_k,taskId)=>({id:taskId,status:'failed'});
  // Same source from two independent members and chats: budget is shared.
  f.shots[1]=f.shots[0];
  for(let n=0;n<5;n++){const p=await plan(f,n%2);await f.clients[n%2].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});await settle(f);}
  assert.equal(f.creates(),5);
  const sixth=await plan(f),other=await plan(f,1);
  await f.clients[0].call(`/pickups/${sixth.id}/confirm`,'POST',{digest:sixth.digest},409);
  await f.clients[1].call(`/pickups/${other.id}/confirm`,'POST',{digest:other.digest},409);assert.equal(f.creates(),5);
  const q=(await f.clients[0].call(`/pickups/${sixth.id}`)).quotas[0];assert.equal(q.used,5);assert.equal(q.remaining,0);assert.equal(q.limit,5);
  const body={sourceId:'S1',requestedAdditional:2,reason:'两个新的调整方案，需要分别确认'};
  await f.clients[1].call(`/pickups/${sixth.id}/quota-requests`,'POST',body,404);
  const request=await f.clients[0].call(`/pickups/${sixth.id}/quota-requests`,'POST',body);
  assert.equal((await f.clients[0].call(`/pickups/${sixth.id}/quota-requests`,'POST',body)).id,request.id);
  assert.equal((await f.clients[1].call(`/pickups/${other.id}`)).quotas[0].requests.length,0);
  await f.clients[0].call(`/admin/video-quota-requests/${request.id}/decision`,'POST',{decision:'approve',additional:2,reason:''},403);
  await f.admin.call(`/admin/video-quota-requests/${request.id}/decision`,'POST',{decision:'reject',reason:'先补齐调整依据'});
  assert.equal((await f.clients[0].call(`/pickups/${sixth.id}`)).quotas[0].remaining,0);
  const request2=await f.clients[0].call(`/pickups/${sixth.id}/quota-requests`,'POST',body);assert.notEqual(request2.id,request.id);
  await f.admin.call(`/admin/video-quota-requests/${request2.id}/decision`,'POST',{decision:'approve',additional:3,reason:''},400);
  const approval={decision:'approve',additional:2,reason:'已核对修改意见'};
  await Promise.all([f.admin.call(`/admin/video-quota-requests/${request2.id}/decision`,'POST',approval),f.admin.call(`/admin/video-quota-requests/${request2.id}/decision`,'POST',approval)]);
  await f.admin.call(`/admin/video-quota-requests/${request2.id}/decision`,'POST',{...approval,additional:1},409);
  assert.equal((await f.clients[0].call(`/pickups/${sixth.id}`)).quotas[0].limit,7);assert.equal(f.creates(),5,'approval must not create');
  for(const [i,p] of [[0,sixth],[1,other]] as const){await f.clients[i].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});await settle(f);}
  const eighth=await plan(f);await f.clients[0].call(`/pickups/${eighth.id}/confirm`,'POST',{digest:eighth.digest},409);assert.equal(f.creates(),7);
  const data=f.app.store.root,adapter=f.app.pickups.adapter;await f.app.close();f.app=new Platform({dataDir:data,videoAdapter:adapter,simulatedVideo:true,mockDelay:1});
  const status=f.app.pickups.quota.status('shared','S1');assert.equal(status.used,7);assert.equal(status.limit,7);assert.equal(status.remaining,0);assert.equal(f.creates(),7);
 }finally{await f.app.close();}
});

test('proven pre-send rejection releases count; ambiguous send retains its record while another round can be submitted',async()=>{
 const f=await fixture();try{
  const {VideoNotSubmitted}=await import('../server/video-catalog.ts');
  f.app.pickups.adapter.create=async()=>{throw new VideoNotSubmitted('fixture pre-send guard');};
  const p=await plan(f);await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest});let jobs=await settle(f);assert.equal(jobs[0].state,'blocked');assert.equal(jobs[0].createAttempts,0);assert.equal(jobs[0].submissionDisposition,'not_sent');assert.equal(f.app.pickups.quota.status('shared','S1').remaining,5);
  f.app.pickups.adapter.create=async()=>{throw Error('unknown transport result');};const p2=await plan(f);await f.clients[0].call(`/pickups/${p2.id}/confirm`,'POST',{digest:p2.digest});jobs=await settle(f);assert.equal(jobs.find(j=>j.planId===p2.id)!.state,'submission_unknown');
  const q=f.app.pickups.quota.status('shared','S1');assert.equal(q.used,1);assert.equal(q.remaining,4);assert.equal(q.unresolved,true);
  const next=await plan(f);await f.clients[0].call(`/pickups/${next.id}/confirm`,'POST',{digest:next.digest});await settle(f);assert.equal(f.app.store.all('video-job').filter(j=>j.state==='submission_unknown').length,2);
 }finally{await f.app.close();}
});

test('last slot cannot be double reserved and multi-shot confirmation rolls back atomically',async()=>{
 const f=await fixture(2);try{
  for(let i=0;i<4;i++)f.app.store.put('video-job',{id:id(),project:'shared',sourceId:'S1',state:'failed',createAttempts:1});
  f.shots[1]=f.shots[0];const a=await plan(f),b=await plan(f,1);
  const submit=async(i:number,p:Doc)=>{const c=f.clients[i];return fetch(c.base+`/api/pickups/${p.id}/confirm`,{method:'POST',headers:{Origin:c.base,Cookie:c.cookie,'X-CSRF-Token':c.csrf,'Content-Type':'application/json'},body:JSON.stringify({digest:p.digest})});};
  const responses=await Promise.all([submit(0,a),submit(1,b)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);await settle(f);assert.equal(f.creates(),1);assert.equal(f.app.pickups.quota.status('shared','S1').used,5);
  const p=await plan(f);const stored=f.app.store.get('pickup',p.id)!;f.app.store.put('pickup',{...stored,shots:[{...stored.shots[0],source:{...stored.shots[0].source,id:'UNUSED'}},stored.shots[0]]});
  const before=f.app.store.all('video-job').length;await f.clients[0].call(`/pickups/${p.id}/confirm`,'POST',{digest:p.digest},409);assert.equal(f.app.store.all('video-job').length,before);assert.equal(f.app.pickups.quota.status('shared','UNUSED').reserved,0);
 }finally{await f.app.close();}
});


test('two-field pickup template publishes and prepares without asking members for derived shot fields',async()=>{
 const f=await fixture(1);try{
  const first=await plan(f),frozen=JSON.stringify(f.app.store.get('pickup',first.id)!.template);
  const body='剧本片段：\n{{script}}\n\n补抽意见：\n{{notes}}';
  const saved=await f.admin.call('/admin/video-templates','POST',{id:f.template.id,name:f.template.name,body,status:'published',modelIds:[],default:true},201);
  assert.equal(saved.body,body);assert.equal(JSON.stringify(f.app.store.get('pickup',first.id)!.template),frozen);
  const next=await plan(f);assert.equal(next.state,'awaiting_confirmation');assert(next.shots[0].prompt.includes(f.shots[0].scriptQuote));assert(next.shots[0].prompt.includes(next.parsed.notes));assert(!next.shots[0].prompt.includes('{{'));
 }finally{await f.app.close();}
});
