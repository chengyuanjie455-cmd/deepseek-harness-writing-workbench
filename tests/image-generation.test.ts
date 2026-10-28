import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {Platform} from '../server/app.ts';
import {id,hash,type Doc} from '../server/store.ts';
import {imagePayload,publicIPv4,XiaopeiImageAdapter,ImageRequestFailure} from '../server/image-generation.ts';
import {xiaopeiKind} from '../server/xiaopei-directory.ts';
const password='synthetic-image-only-12345';
async function fixture(unknown=false){
  const root=mkdtempSync(join(tmpdir(),'team-image-'));const file=join(root,'synthetic.png');execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=1024x1024','-frames:v','1',file]);const bytes=readFileSync(file);let creates=0,downloads=0,failDownload=false;
  const adapter={async create(){creates++;if(unknown)throw Error('uncertain request');return {data:[{url:'https://synthetic.invalid/output.png'}]};},async download(){downloads++;if(failDownload)throw Error('injected download failure');return Readable.from([bytes]);}};
  const app=new Platform({dataDir:join(root,'data'),imageAdapter:adapter,simulatedVideo:true,mockDelay:1});await app.start(0);const base='http://127.0.0.1:'+(app.server.address() as any).port;
  const admin=app.newUser({username:'admin',password},'admin'),member=app.newUser({username:'member',password},'member'),other=app.newUser({username:'other',password},'member');
  const c0:Doc=app.pickups.catalog.saveChannel(admin,{name:'synthetic',origin:'https://synthetic.invalid',adapter:'ruiyun',apiKey:'test-secret-never-real',enabled:true,concurrency:2,noRetryEvidence:'fixture'});
  const c:Doc={...app.store.get('video-channel',c0.id)!,verified:true,reachableModels:['gpt-image-2']};app.store.put('video-channel',c);app.store.put('video-channel-version',{...c,id:c.revision,channelId:c.id});
  app.store.put('runtime-concurrency',{id:'active',testedChannels:{[c.id]:{limit:2,revision:c.revision}}});
  const m={id:id(),revision:id(),name:'合成图片',aliases:['gpt-image-2'],remoteModel:'gpt-image-2',channelId:c.id,channelRevision:c.revision,status:'available',imageRoute:'multipart-edits',params:{resolution:['1k'],aspect_ratio:['1:1']},defaults:{resolution:'1k',aspect_ratio:'1:1'},maxReferences:2};app.store.put('image-model',m);
  async function plan(extra='',owner=member){const t={id:id(),owner:owner.id,session:app.fixedChat(owner).id,base:app.projects.current().revision,prompt:'图片描述：蓝色背景。画面文字：测试\n图片模型：合成图片'+extra};return app.images.prepare(t);}
  async function settle(){for(let i=0;i<200;i++){if(!app.images.active.size)return;await delay(20);}throw Error('image settle timeout');}
  return {app,root,base,admin,member,other,c,m,bytes,adapter,plan,settle,creates:()=>creates,downloads:()=>downloads,fail:()=>{failDownload=true;},resume:()=>{failDownload=false;}};
}
test('native image batch uses its frozen inputs despite hidden or edited project files, while legacy publication validation remains strict',async()=>{
 const f=await fixture();try{
  const root=f.app.projects.canonical;
  mkdirSync(join(root,'.video_agent'));writeFileSync(join(root,'.video_agent','state.json'),'{}');writeFileSync(join(root,'.zcodeignore'),'temporary');
  writeFileSync(join(root,'README.md'),'unpublished native chat edits');
  const before=readFileSync(join(root,'README.md'));
  const original=await f.app.images.upload(f.member,{name:'reference.png',base64:f.bytes.toString('base64'),requestId:id()});
  const i:any={key:'hidden-project-images',owner:f.member.id,project:'shared'};
  const requests=Array.from({length:10},(_,n)=>({action:'image_generate',sessionId:'hidden-project-session',sourceMessageId:'ten-images',sourceText:'生成十张图片',callId:'call-'+n,args:{prompt:'蓝色背景 '+n,model:f.m.name,params:{resolution:'1k',aspect_ratio:'1:1'},generation_key:'image-'+n,...(n%2?{reference_media_ids:[original.id]}:{})}}));
  // Preparation remains available without creating a supplier job.
  const draft:any=await f.app.native.team.tool(i,f.member,{...requests[0],action:'image_prepare'});
  assert.equal(draft.plan.jobs.length,0);
  const cards=await Promise.all(requests.map(request=>f.app.native.team.tool(i,f.member,request)));
  await f.settle();assert.equal(f.creates(),10);assert.equal(f.app.store.all('image-job').length,10);
  assert(cards.every(c=>c!.plan.state==='confirmed'));assert(f.app.store.all('image-job').every(j=>j.state==='ready'&&j.createAttempts===1));
  for(const job of f.app.store.all('image-job')){assert.equal(job.dispatchInputs.length,1);assert.equal(job.dispatchInputs[0].authorizationInputDigest,job.authorizedInput.digest);assert.deepEqual(job.dispatchInputs[0].input.references,job.authorizedInput.references);for(const ref of job.authorizedInput.references){assert.equal(ref.mediaId,original.id);assert.equal(ref.sha256,hash(f.bytes));}assert.equal(job.dispatchInputs[0].requestHashBasis,'image_plan_and_media_digests');}
  const probe=f.app.store.all('image-job')[0];assert.equal((await f.app.workspace('shared').content.page(f.member,{section:'assets'})).items.find((v:Doc)=>v.mediaId===probe.mediaId)!.generationInput.state,'recorded');const corrupt=structuredClone(probe);corrupt.dispatchInputs[0].input.content.promptSHA256=hash('corrupt');f.app.store.put('image-job',corrupt);assert.equal((await f.app.workspace('shared').content.page(f.member,{section:'assets'})).items.find((v:Doc)=>v.mediaId===probe.mediaId)!.generationInput.state,'unverified');f.app.store.put('image-job',probe);
  await f.app.native.team.tool(i,f.member,{...requests[0],callId:'reconnected'});assert.equal(f.creates(),10);
  assert.deepEqual(readFileSync(join(root,'README.md')),before);assert.equal(readFileSync(join(root,'.zcodeignore'),'utf8'),'temporary');
  const legacy=await f.plan();assert.throws(()=>f.app.images.confirm(legacy.id,f.member,{digest:legacy.digest}),/相对路径|平台外修改/);
  const attached=cards[1]!.plan;f.app.store.put('media',{...f.app.store.get('media',original.id)!,sha256:'changed'});
  assert.throws(()=>f.app.images.validate(attached,f.member),/原图引用已失效/);
 }finally{await f.app.close();}
});
test('original download resumes automatically through publication and saturated unknown slots without recreating an image',async()=>{
 const f=await fixture();try{
  const p=await f.plan();f.fail();f.app.images.confirm(p.id,f.member,{digest:p.digest});await f.settle();const j=f.app.store.all('image-job')[0];assert.equal(j.state,'download_failed');assert(j.nextRecoveryAt>Date.now());assert.match(j.error,/自动重试下载/);
  f.app.store.put('runtime-concurrency',{...f.app.store.get('runtime-concurrency','active'),id:'active',image:1});f.app.store.put('image-job',{id:id(),state:'submission_unknown',owner:f.other.id});
  f.app.projects.pending=()=>[{id:'publishing'}];f.resume();f.app.store.put('image-job',{...j,nextRecoveryAt:1});f.app.images.pump();await f.settle();
  const done=f.app.store.get('image-job',j.id)!;assert.equal(done.state,'ready');assert.equal(done.downloadAttempts,2);assert.equal(done.nextRecoveryAt,null);assert.equal(f.creates(),1);assert.equal(done.mediaSHA256,hash(f.bytes));
 }finally{await f.app.close();}
});
test('explicit image rejection reports a safe failure promptly; uncertain HTTP errors retain original evidence without reposting',async()=>{
 for(const status of [400,503]){const f=await fixture();try{
  f.app.images.adapter.create=async()=>{throw new ImageRequestFailure(status,{error:{code:'invalid_media',message:'private https://signed.invalid/?token=secret'}});};
  const p=await f.plan();f.app.images.confirm(p.id,f.member,{digest:p.digest});await f.settle();const j=f.app.images.get(p.id,f.member).jobs[0];assert.equal(j.state,status===400?'failed':'submission_unknown');assert.equal(j.providerStatus,status);assert.match(j.error,/参考素材/);assert(!JSON.stringify(j).includes('secret'));assert.equal(j.createAttempts,1);f.app.images.pump();assert.equal(f.app.images.active.size,0);
 }finally{await f.app.close();}}
});
test('image confirmation is idempotent, original bytes private, download recovery and restart do not create',async()=>{
 const f=await fixture();try{
  const p=await f.plan();assert.equal(p.state,'awaiting_confirmation');assert.equal(p.prompt,'蓝色背景。画面文字：测试');assert.equal(f.creates(),0);
  f.fail();f.app.images.confirm(p.id,f.member,{digest:p.digest});f.app.images.confirm(p.id,f.member,{digest:p.digest});await f.settle();let j=f.app.store.all('image-job')[0];assert.equal(j.state,'download_failed');assert.equal(f.creates(),1);
  assert.throws(()=>f.app.images.get(p.id,f.other));assert.throws(()=>f.app.images.recover(j.id,f.other));f.resume();f.app.images.recover(j.id,f.member);await f.settle();j=f.app.store.get('image-job',j.id)!;assert.equal(j.state,'ready');assert.equal(j.mediaSHA256,hash(f.bytes));assert.equal(f.creates(),1);assert.equal(f.app.images.originals(f.member).length,0);
  assert.equal(f.app.pickups.media.canRead(f.app.pickups.media.get(j.mediaId),f.other),false);assert.equal(f.app.pickups.media.canRead(f.app.pickups.media.get(j.mediaId),f.admin),true);
  const publicPlan=JSON.stringify(f.app.images.get(p.id,f.member));assert(!publicPlan.includes('synthetic.invalid/output'));assert(!publicPlan.includes('test-secret'));assert(!publicPlan.includes('secretRef'));
  const bad=await f.plan('\n参考图：'+j.mediaId);assert.equal(bad.state,'needs_input');
  await f.app.close();const restored=new Platform({dataDir:join(f.root,'data'),imageAdapter:f.adapter,simulatedVideo:true,mockDelay:1});try{await restored.start(0);assert.equal(restored.store.get('image-job',j.id)!.state,'ready');assert.equal(f.creates(),1);}finally{await restored.close();}
 }finally{if(!f.app.closing)await f.app.close();}
});
test('unknown image POST never retries automatically; parameters, owner and model revisions gate confirmation',async()=>{
 const f=await fixture(true);try{
  const p=await f.plan();assert.throws(()=>f.app.images.confirm(p.id,f.other,{digest:p.digest}));
  f.app.images.confirm(p.id,f.member,{digest:p.digest});await f.settle();const j=f.app.store.all('image-job')[0];assert.equal(j.state,'submission_unknown');assert.equal(j.createAttempts,1);assert.throws(()=>f.app.images.recover(j.id,f.member));
  f.app.images.confirm(p.id,f.member,{digest:p.digest});assert.equal(f.creates(),1);assert.equal(f.app.store.all('image-job').length,1);
  const invalid=await f.plan('\n模型参数：api_key:redacted');assert.equal(invalid.state,'needs_input');
  const different=await f.plan('\n模型参数：分辨率：1k',f.other);f.app.store.put('image-model',{...f.m,revision:id()});assert.throws(()=>f.app.images.confirm(different.id,f.other,{digest:different.digest}),/变更/);
  const unknownId=j.id;f.app.store.put('image-job',{...j,state:'submitting'});await f.app.close();const restored=new Platform({dataDir:join(f.root,'data'),imageAdapter:f.adapter,simulatedVideo:true});try{await restored.start(0);assert.equal(restored.store.get('image-job',unknownId)!.state,'submission_unknown');assert.equal(f.creates(),1);}finally{await restored.close();}
 }finally{if(!f.app.closing)await f.app.close();}
});
test('member original upload preserves bytes and permissions; server image workflow prepares without paid call',async()=>{
 const f=await fixture();try{
  const request={name:'original.png',base64:f.bytes.toString('base64'),requestId:id()};const a=await f.app.images.upload(f.member,request);assert.equal(a.sha256,hash(f.bytes));assert.equal((await f.app.images.upload(f.member,request)).id,a.id);
  const p=await f.plan('\n参考图：'+a.id);assert.equal(p.state,'awaiting_confirmation');assert.equal((await f.plan('\n参考图：'+a.id,f.other)).state,'needs_input');
  let cookie='',csrf='';async function api(path:string,method='GET',body?:Doc){const r=await fetch(f.base+'/api'+path,{method,headers:{Origin:f.base,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const b=await r.json() as Doc;if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie')!.split(';')[0];if(b.csrf)csrf=b.csrf;return {status:r.status,body:b};}
  await api('/login','POST',{username:'member',password});const task=await api('/tasks','POST',{session:f.app.fixedChat(f.member).id,requestId:id(),workflow:'pickup',paths:[],prompt:'图片描述：蓝色灯光\n图片模型：合成图片'});assert.equal(task.status,202);await delay(100);assert(f.app.store.get('image-plan',task.body.id));assert.equal(f.creates(),0);
  assert.equal((await api('/images/'+p.id)).status,200);assert.equal((await api(`/admin/xiaopei-channels/${f.c.id}/sync`,'POST',{})).status,403);
 }finally{await f.app.close();}
});
test('image adapter uses per-family schema and multipart original bytes with a single create',async()=>{
 const f=await fixture();const original=globalThis.fetch;try{
  const bytes=f.bytes;const asset=await f.app.images.upload(f.member,{name:'raw.png',base64:bytes.toString('base64'),requestId:id()});const p=await f.plan('\n参考图：'+asset.id);let calls=0;
  globalThis.fetch=(async(url,options)=>{calls++;assert.equal(String(url),'https://api.aicopy.top/v1/images/edits');assert.equal(options?.redirect,'error');const form=options!.body as FormData;assert.equal(form.get('model'),'gpt-image-2');assert.equal(form.get('size'),'1024x1024');const blob=form.get('image') as Blob;assert.deepEqual(Buffer.from(await blob.arrayBuffer()),bytes);assert(!('Content-Type' in (options!.headers as any)));return new Response(JSON.stringify({data:[{b64_json:bytes.toString('base64')}]}));}) as typeof fetch;
  await new XiaopeiImageAdapter().create({adapter:'xiaopei',origin:'https://api.aicopy.top'},'fixture',p,f.app.images.media,[],new AbortController().signal);assert.equal(calls,1);
  const b=imagePayload({remoteModel:'香蕉2（标准接口）',imageRoute:'url-generations'},'文字完整',{aspect_ratio:'9:16',resolution:'2k'},['https://public.invalid/a.png']);assert.equal(b.image,'https://public.invalid/a.png');assert(!('size' in b));assert(!('n' in b));assert.equal(b.aspect_ratio,'9x16');
  for(const address of ['127.0.0.1','169.254.169.254','192.168.1.1','10.0.0.1','172.31.0.1','100.64.0.1','224.0.0.1'])assert.equal(publicIPv4(address),false);assert.equal(publicIPv4('8.8.8.8'),true);
 }finally{globalThis.fetch=original;await f.app.close();}
});
test('catalogue sync separates image/video, opens documented members trials, preserves disables, hides removed models',async()=>{
 const f=await fixture();const original=globalThis.fetch;try{
  const c:Doc={...f.c,adapter:'xiaopei',origin:'https://api.aicopy.top'};f.app.store.put('video-channel',c);let ids=['Adobe-gpt-image-2','gpt-image-2','【官方稳定版】2.5-720p','unidentified-chat-model','gpt-image-2.5-flare'];
  globalThis.fetch=(async(_url,options)=>{assert.equal(options?.method,'GET');return new Response(JSON.stringify({data:ids.map(id=>({id,supported_endpoint_types:['openai-video']}))}));}) as typeof fetch;
  assert.equal(xiaopeiKind('Adobe-gpt-image-2',['openai-video']),'image');assert.equal(xiaopeiKind('claude-opus-5',['openai']),undefined);
  const result=await f.app.images.directory.sync(f.admin,c.id);assert.equal(result.callableImage,2);assert.equal(result.callableVideo,1);assert.equal(result.needsAdapter,2);
  const models=f.app.pickups.catalog.models(f.member);assert(models.some(m=>m.remoteModel==='【官方稳定版】2.5-720p'&&m.memberAccess&&m.status==='testing'));assert(!JSON.stringify(models).includes('secretRef'));
  const m=f.app.store.all('video-model')[0];assert.equal(m.capabilityHash,hash(JSON.stringify([m.channelRevision,m.remoteModel,m.params,m.defaults,m.secondsType,m.durations,m.referenceField,m.maxReferences,m.capabilityEvidence])));f.app.store.put('video-model',{...m,status:'disabled'});await f.app.images.directory.sync(f.admin,c.id);assert.equal(f.app.store.get('video-model',m.id)?.status,'disabled');
  ids=['gpt-image-2'];await f.app.images.directory.sync(f.admin,c.id);assert(!f.app.images.directory.images().some(m=>m.name==='Adobe-gpt-image-2'));
 }finally{globalThis.fetch=original;await f.app.close();}
});

test('superadmin adds/edits/removes image models, members denied; removal blocks new plans but preserves original recovery',async()=>{
 const {MediaModelAdmin}=await import('../server/media-model-admin.ts');const f=await fixture();try{
  const manage=new MediaModelAdmin(f.app.store,f.app.pickups.catalog);
  assert.throws(()=>manage.list(f.member));assert.throws(()=>manage.remove(f.member,'image',f.m.id));
  f.app.store.put('video-channel',{...f.c,adapter:'xiaopei'});
  const input={id:f.m.id,name:'合成图片',aliases:['图测'],channelId:f.c.id,remoteModel:'gpt-image-2',params:f.m.params,defaults:f.m.defaults,imageRoute:'multipart-edits',maxReferences:2,capabilityEvidence:'mock adapter only',status:'available'};
  assert.throws(()=>manage.saveImage(f.member,input));assert.throws(()=>manage.saveImage(f.admin,{...input,defaults:{resolution:'2k',aspect_ratio:'1:1'}}));
  const before=await f.plan();const saved=manage.saveImage(f.admin,input);assert.notEqual(saved.revision,f.m.revision);assert.throws(()=>f.app.images.confirm(before.id,f.member,{digest:before.digest}),/变更/);
  const p=await f.plan(),unsent=await f.plan();f.fail();f.app.images.confirm(p.id,f.member,{digest:p.digest});await f.settle();const j=f.app.store.all('image-job')[0];assert.equal(j.state,'download_failed');
  manage.remove(f.admin,'image',saved.id);assert.equal(f.app.images.directory.images().length,0);assert.throws(()=>f.app.images.confirm(unsent.id,f.member,{digest:unsent.digest}),/变更/);
  assert.equal(f.app.store.get('image-job',j.id)?.receipt.data.length,1);f.resume();f.app.images.recover(j.id,f.member);await f.settle();assert.equal(f.app.store.get('image-job',j.id)?.state,'ready');assert.equal(f.creates(),1);assert.equal(f.app.images.get(p.id,f.member).jobs[0].mediaSHA256,hash(f.bytes));
  assert.deepEqual(manage.remove(f.admin,'image',saved.id),{removed:true});const {id:discard,...fresh}=input;manage.saveImage(f.admin,fresh);assert.equal(f.app.images.directory.images().length,1);
  let cookie='',csrf='';async function api(path:string,method='GET',body?:Doc){const r=await fetch(f.base+'/api'+path,{method,headers:{Origin:f.base,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const b=await r.json() as Doc;if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie')!.split(';')[0];if(b.csrf)csrf=b.csrf;return {status:r.status,body:b};}
  await api('/login','POST',{username:'member',password});for(const [path,method,body] of [['/admin/media-models','GET',undefined],['/admin/image-models','POST',fresh],[`/admin/media-models/image/${saved.id}/remove`,'POST',{}]] as const)assert.equal((await api(path,method,body)).status,403);
  await api('/login','POST',{username:'admin',password});assert.equal((await api('/admin/media-models')).status,200);assert.equal((await api('/admin/image-models','POST',{...fresh,id:f.app.images.directory.images()[0].id})).status,201);
 }finally{await f.app.close();}
});

test('catalog sync respects explicit removals and admin configuration including member access',async()=>{
 const {MediaModelAdmin}=await import('../server/media-model-admin.ts');const f=await fixture(),original=globalThis.fetch;try{
  const c:Doc={...f.c,adapter:'xiaopei',origin:'https://api.aicopy.top'};f.app.store.put('video-channel',c);const manage=new MediaModelAdmin(f.app.store,f.app.pickups.catalog);
  const ids=['Adobe-gpt-image-2','【官方稳定版】2.5-720p'];globalThis.fetch=(async()=>new Response(JSON.stringify({data:ids.map(id=>({id,supported_endpoint_types:['openai-video']}))}))) as typeof fetch;
  await f.app.images.directory.sync(f.admin,c.id);const video=f.app.store.all('video-model')[0],image=f.app.store.all('image-model').find(m=>m.remoteModel===ids[0])!;
  f.app.store.put('video-job',{id:'history',modelId:video.id,state:'ready',remoteTaskId:'original-task'});manage.remove(f.admin,'video',video.id);manage.remove(f.admin,'image',image.id);await f.app.images.directory.sync(f.admin,c.id);
  assert.equal(f.app.store.get('video-model',video.id),undefined);assert.equal(f.app.store.get('image-model',image.id),undefined);assert.equal(f.app.store.get('video-job','history')?.remoteTaskId,'original-task');assert.equal(f.app.images.directory.list().length,0);
  const restored=manage.saveImage(f.admin,{name:'管理员图片',aliases:['我的图'],channelId:c.id,remoteModel:ids[0],params:{resolution:['1k'],aspect_ratio:['1:1']},defaults:{resolution:'1k',aspect_ratio:'1:1'},imageRoute:'multipart-edits',maxReferences:0,capabilityEvidence:'synthetic contract',status:'disabled'});
  // Simulate an explicitly saved video configuration; sync must not grant access or replace its contract.
  f.app.store.put('video-model',{...video,managedBy:'admin',status:'draft',memberAccess:false});await f.app.images.directory.sync(f.admin,c.id);
  assert.deepEqual(f.app.store.get('image-model',restored.id),restored);assert.equal(f.app.store.get('video-model',video.id)?.memberAccess,false);assert.equal(f.app.store.get('video-model',video.id)?.status,'draft');assert(!f.app.images.directory.images().some(m=>m.id===restored.id));
 }finally{globalThis.fetch=original;await f.app.close();}
});

test('native image requests submit immediately, keep originals private, and accept own generated image for a revision',async()=>{
 const f=await fixture();try{
  const i:any={key:'native-image-fixture',owner:f.member.id,project:'shared'};
  const request={action:'image_generate',sessionId:'native-image-session',sourceMessageId:'image-user-1',sourceText:'生成一张蓝色背景图',callId:'image-call-1',args:{prompt:'蓝色背景',model:f.m.name}};
  const a=await f.app.native.team.tool(i,f.member,request);assert.equal(a!.plan.state,'confirmed');await f.settle();let jobs=f.app.store.all('image-job');assert.equal(jobs.length,1);assert.equal(jobs[0].state,'ready');assert.equal(f.creates(),1);
  const same=await f.app.native.team.tool(i,f.member,{...request,callId:'reconnect-call'});assert.equal(same!.plan.id,a!.plan.id);assert.equal(f.creates(),1);
  const revision=await f.app.native.team.tool(i,f.member,{...request,sourceMessageId:'image-user-2',sourceText:'基于上一张改为浅蓝背景',args:{...request.args,prompt:'浅蓝背景',reference_media_ids:[jobs[0].mediaId]}});assert.equal(revision!.plan.state,'confirmed');await f.settle();assert.equal(f.creates(),2);assert(f.app.store.all('image-job').every(j=>j.state==='ready'));
  const draft=await f.app.native.team.tool(i,f.member,{...request,action:'image_prepare',callId:'draft-only',args:{...request.args,prompt:'仅准备草稿'}});assert.equal(draft!.plan.state,'awaiting_confirmation');assert.equal(f.creates(),2);
  const other:any={key:'other-image-fixture',owner:f.other.id,project:'shared'};
  const blocked=await f.app.native.team.tool(other,f.other,{...request,sourceMessageId:'other-image',args:{...request.args,reference_media_ids:[jobs[0].mediaId]}});assert.equal(blocked!.plan.state,'needs_input');assert.equal(f.creates(),2);
 }finally{await f.app.close();}
});

test('unknown images in another channel do not consume workers; receipt recovery never creates again',async()=>{
 const f=await fixture(true);try{
  const p=await f.plan();f.app.images.confirm(p.id,f.member,{digest:p.digest});await f.settle();const unknown=f.app.store.all('image-job')[0];
  assert.throws(()=>f.app.images.resolveUnknown(unknown.id,f.member,{outcome:'not_submitted',evidence:'no'}),/管理员/);
  assert.throws(()=>f.app.images.resolveUnknown(unknown.id,f.admin,{outcome:'received',evidence:'checked',receipt:{data:[]}}));
  for(let n=0;n<2;n++)f.app.store.put('image-job',{id:id(),project:'other',channelId:'other',state:'submission_unknown'});
  f.app.images.adapter.create=async()=>({data:[{b64_json:f.bytes.toString('base64')}]});const next=await f.plan('',f.other);f.app.images.confirm(next.id,f.other,{digest:next.digest});await f.settle();assert.equal(f.app.images.get(next.id,f.other).jobs[0].state,'ready');
  f.app.images.resolveUnknown(unknown.id,f.admin,{outcome:'received',evidence:'供应商原响应已核对',receipt:{data:[{b64_json:f.bytes.toString('base64')}]}});await f.settle();const recovered=f.app.images.get(p.id,f.member).jobs[0];assert.equal(recovered.state,'ready');assert.equal(f.creates(),1);assert(!('resolution' in recovered));assert(recovered.timeline.some((v:any)=>v.state==='submission_unknown'));assert.throws(()=>f.app.images.resolveUnknown(unknown.id,f.admin,{outcome:'not_submitted',evidence:'duplicate'}));
 }finally{await f.app.close();}
});
test('download backlog drains with shared capacity; queued cancellation is final and idempotent',async()=>{
 const f=await fixture();try{
  f.app.images.closing=true;const plans:Doc[]=[];
  for(let n=0;n<5;n++){const p=await f.plan('\n模型参数：分辨率：1k',n%2?f.other:f.member);const job={id:id(),owner:p.owner,planId:p.id,channelId:f.c.id,channelRevision:f.c.revision,createAttempts:1,state:'downloading',receipt:{data:[{b64_json:f.bytes.toString('base64')}]}};f.app.store.put('image-job',job);plans.push(job);}
  const p=await f.plan(),j={id:id(),owner:f.member.id,planId:p.id,state:'queued',createAttempts:0};f.app.store.put('image-job',j);assert.equal(f.app.images.cancel(j.id,f.member).state,'cancelled');assert.equal(f.app.images.cancel(j.id,f.member).state,'cancelled');assert.throws(()=>f.app.images.cancel(plans[0].id,f.member));
  f.app.store.put('runtime-concurrency',{id:'active',image:2});f.app.images.closing=false;f.app.images.pump();await f.settle();assert(plans.every(j=>f.app.store.get('image-job',j.id)!.state==='ready'));assert.equal(f.creates(),0);
 }finally{await f.app.close();}
});

test('administrator recovery accepts a full original image receipt larger than the standard JSON limit',async()=>{
 const f=await fixture(true);try{
  const p=await f.plan();f.app.images.confirm(p.id,f.member,{digest:p.digest});await f.settle();const j=f.app.images.get(p.id,f.member).jobs[0];
  const login=await fetch(f.base+'/api/login',{method:'POST',headers:{Origin:f.base,'Content-Type':'application/json'},body:JSON.stringify({username:f.admin.username,password})}),auth:any=await login.json();
  const r=await fetch(f.base+'/api/admin/operations/recover',{method:'POST',headers:{Origin:f.base,Cookie:login.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':auth.csrf,'Content-Type':'application/json'},body:JSON.stringify({kind:'image-job',id:j.id,action:'resolve_image',outcome:'received',evidence:'完整回执已核对',receipt:{data:[{b64_json:f.bytes.toString('base64'),provider_details:'x'.repeat(2*1024*1024)}]}})});
  assert.equal(r.status,200,await r.text());await f.settle();assert.equal(f.app.images.get(p.id,f.member).jobs[0].state,'ready');assert.equal(f.creates(),1);
 }finally{await f.app.close();}
});

test('identical image inputs may run in parallel and a member can resubmit an aged unknown task once per message',async()=>{
 const f=await fixture(true);try{
  const i:any={key:'image-member',owner:f.member.id,project:'shared'},sessionId='image-parallel',team=f.app.native.team;
  const args={prompt:'相同构图的蓝色灯光',model:f.m.name,params:{resolution:'1k',aspect_ratio:'1:1'}};
  const request={action:'image_generate',sessionId,callId:'one',sourceMessageId:'images-request',sourceText:'同时生成两张相同画面',args:{...args,generation_key:'image-1'}};
  const a=(await team.tool(i,f.member,request))!.plan;
  const b=(await team.tool(i,f.member,{...request,callId:'two',args:{...args,generation_key:'image-2'}}))!.plan;
  assert.notEqual(a.id,b.id);await f.settle();assert.equal(f.creates(),2);
  const original=f.app.images.get(a.id,f.member).jobs[0];
  const retry={action:'resubmit',sessionId,callId:'retry',sourceMessageId:'retry-message',sourceText:'超过十分钟还没生成，再提交一次',args:{kind:'image',plan_id:a.id}};
  await assert.rejects(team.tool(i,f.member,retry),/10 分钟/);
  f.app.store.put('image-job',{...f.app.store.get('image-job',original.id)!,created:new Date(Date.now()-601000).toISOString()});
  const repeated=(await team.tool(i,f.member,retry))!.plan;await f.settle();assert.equal(f.creates(),3);assert.equal(repeated.resubmissionOf,a.id);assert.deepEqual(repeated.payload,a.payload);assert.deepEqual(repeated.assets,a.assets);
  const replay=(await team.tool(i,f.member,{...retry,callId:'reconnected'}))!.plan;assert.equal(repeated.id,replay.id);assert.equal(f.creates(),3);assert.equal(f.app.images.get(a.id,f.member).jobs[0].state,'submission_unknown');
  f.app.images.resolveUnknown(original.id,f.admin,{outcome:'received',evidence:'synthetic receipt recovered',receipt:{data:[{b64_json:f.bytes.toString('base64')}]}});await f.settle();assert.equal(f.app.images.get(a.id,f.member).jobs[0].state,'ready');
  await assert.rejects(team.tool(i,f.member,{...retry,sourceMessageId:'late-new-request'}),/已生成/);assert.equal((await team.tool(i,f.member,retry))!.plan.id,repeated.id);
 }finally{await f.app.close();}
});
