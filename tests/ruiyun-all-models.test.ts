import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {Readable} from 'node:stream';
import {videoShotPayload,VideoCatalog} from '../server/video-catalog.ts';
import {validParams} from '../server/pickup-input.ts';import {validateVideoReferences} from '../server/media-capabilities.ts';
import {XiaopeiDirectory} from '../server/xiaopei-directory.ts';import {Store,id,type Doc} from '../server/store.ts';
import {imagePayload,XiaopeiImageAdapter} from '../server/image-generation.ts';
import {chatImageReceipt} from '../server/chat-image.ts';import {ImageSelection} from '../server/image-selection.ts';
import {MediaStore} from '../server/media.ts';import {ProviderReferences} from '../server/provider-references.ts';import {prepareConversation} from '../server/conversation-pickup.ts';
import {Platform} from '../server/app.ts';import {ruiyunKind} from '../server/ruiyun-directory.ts';
const contracts=JSON.parse(readFileSync(new URL('../server/data/ruiyun-contracts.json',import.meta.url),'utf8')).models;
const origin='https://154.64.253.71/ruiyun',key='fixture-not-a-real-secret';
const rows=Object.entries(contracts).map(([name,c]:[string,any])=>({model_name:name,tags:c.kind==='image'?'图片生成':'视频生成',quota_type:c.billingMode==='token'?0:1,model_price:.2}));
const fake:typeof fetch=async(url,opt)=>{const path=new URL(String(url)).pathname;if(path.endsWith('/v1/models'))return Response.json({data:rows.map(r=>({id:r.model_name}))});if(path.endsWith('/api/pricing'))return Response.json({success:true,data:rows});if(path.endsWith('/api/status'))return Response.json({data:{quota_display_type:'CNY',usd_exchange_rate:1}});throw Error('unexpected fixture request '+path);};
test('full 150-media catalogue is member-visible, refresh preserves IDs and disables, old frozen jobs unchanged',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ruiyun-all-')),store=new Store(root),old=globalThis.fetch;
 try{globalThis.fetch=fake;const admin:Doc={id:'admin',role:'admin',active:true},member:Doc={id:'member',role:'member',active:true};store.put('user',admin);store.put('user',member);
  const catalog=new VideoCatalog(store,500),c=catalog.saveChannel(admin,{name:'test',origin,adapter:'ruiyun',apiKey:key,enabled:true,concurrency:500,noRetryEvidence:'fixture'}),directory=new XiaopeiDirectory(store,catalog);
  const result=await directory.sync(admin,c.id);assert.equal(result.callableImage,67);assert.equal(result.callableVideo,83);assert.equal(result.needsAdapter,0);
  store.put('video-storyboard-policy',{id:'active',enabled:true});assert.equal(catalog.models(member).length,83,'non-Wan families cannot disappear under storyboard policy');
  const choice=store.all('video-model')[0],frozen={id:'original-job',modelId:choice.id,payload:{model:choice.remoteModel,extra:{reference_images:[{url:'original',role:'reference_image'}]}},createAttempts:1};store.put('video-job',frozen);
  store.put('video-model',{...choice,status:'disabled'});await directory.sync(admin,c.id);assert.equal(store.get('video-model',choice.id)?.status,'disabled');assert.deepEqual(store.get('video-job',frozen.id),frozen);
  const selection=new ImageSelection(store,catalog),images=directory.images();await selection.refresh(images);assert.equal(selection.sorted(images).length,67);assert.notEqual(selection.pick(images,'auto').model.billingMode,'token');
  const token=images.find(m=>m.billingMode==='token')!;assert.equal(selection.pick(images,token.id,{},1).model.id,token.id);assert.throws(()=>selection.pick(images,token.id,{},0));
 }finally{globalThis.fetch=old;store.close();rmSync(root,{recursive:true,force:true});}
});
test('all media requests retain exact variant, valid declared parameters, reference roles and numeric/string wire contract',()=>{
 for(const [name,c] of Object.entries(contracts) as [string,Doc][]){
  const model={...c,remoteModel:name};
  if(c.kind==='image'){const body=imagePayload(model,'画面内容',c.defaults);assert.equal(body.model,name);continue;}
  const seconds=c.durations[0]??10,params=validParams(model,{seconds},seconds),assets:Doc[]=[];
  if(c.minReferences||c.requiresReference||c.modes&&!c.modes.includes('text')&&!c.modes.includes('video_edit'))assets.push({mediaId:'image-original',mediaKind:'image',url:'https://files.example/image.png'});
  if(c.minVideoReferences)assets.push({mediaId:'video-original',mediaKind:'video',url:'https://files.example/video.mp4'});
  const mode=validateVideoReferences(model,assets),body=videoShotPayload({adapter:'ruiyun'},model,{params,prompt:'画面内容',assets,referenceMode:mode});assert.equal(body.model,name);assert.equal(body.seconds,String(seconds));assert(!JSON.stringify(body).includes('asset:'));
 }
});
test('resolving references replaces every placeholder; edit video and audio never enter reference_images',()=>{
 const model=contracts['【api调用】sd2.5-1080p'],assets=[{mediaId:'i',mediaKind:'image'},{mediaId:'v',mediaKind:'video'},{mediaId:'a',mediaKind:'audio'}],shot={prompt:'画面',params:{...model.defaults,seconds:10},assets,referenceMode:'reference'};
 assert.equal(validateVideoReferences(model,assets),'reference');const planned=videoShotPayload({adapter:'ruiyun'},{...model,remoteModel:'【api调用】sd2.5-1080p'},shot);
 assert(JSON.stringify(planned).includes('asset:'));const resolved=assets.map(a=>({...a,url:'https://files.example/'+a.mediaId}));const sent=videoShotPayload({adapter:'ruiyun'},{...model,remoteModel:'【api调用】sd2.5-1080p'},shot,resolved);
 assert(!JSON.stringify(sent).includes('asset:'));assert.equal(sent.images,undefined);assert.deepEqual(sent.extra.reference_videos,[{url:'https://files.example/v'}]);assert.deepEqual(sent.extra.reference_audios,[{url:'https://files.example/a'}]);assert.equal(sent.extra.reference_images.length,1);
 const edit=contracts['omni-fast-视频编辑（无水印）'];assert.throws(()=>validateVideoReferences(edit,[]),/视频/);assert.equal(validateVideoReferences(edit,[resolved[1]]),'video_edit');
});
test('first/last frame roles and H3 reference requirements follow per-model contracts, no false duration caps for unknown aliases',()=>{
 const wan=contracts['官方wang3.0-720p'],assets=[{mediaId:'first'},{mediaId:'last'}];assert.equal(validateVideoReferences(wan,assets,'first_last'),'first_last');
 const body=videoShotPayload({adapter:'ruiyun'},{...wan,remoteModel:'官方wang3.0-720p'},{prompt:'过渡',params:{...wan.defaults,seconds:8},assets,referenceMode:'first_last'});assert.deepEqual(body.extra.reference_images.map((a:Doc)=>a.role),['first_frame','last_frame']);assert.throws(()=>validateVideoReferences(wan,assets.slice(0,1),'first_last'));
 const h3=contracts['官方h3-720p'];assert.throws(()=>validateVideoReferences(h3,[]));assert.equal(validateVideoReferences(h3,[{mediaKind:'audio'}]),'reference');assert.throws(()=>validateVideoReferences(h3,[{mediaKind:'video'}]));
 const unknown=contracts['doubao-seedance-2-5-260628'];assert.deepEqual(validParams(unknown,{seconds:22,resolution:'1080p',audio:false},22),{resolution:'1080p',audio:false,seconds:22});assert.throws(()=>validParams(unknown,{providerKey:'leak'},22));
});
test('image chat route processes fragmented SSE, inline originals, errors and truncated streams without retrying paid POST',async()=>{
 const raw='data: '+JSON.stringify({choices:[{delta:{content:'![原图](https://files.'}}]})+'\n\n'+'data: '+JSON.stringify({choices:[{delta:{content:'example/a.png)'}}],usage:{total_tokens:25}})+'\n\ndata: [DONE]\n\n';assert.equal(chatImageReceipt(raw,origin).data[0].url,'https://files.example/a.png');assert.equal(chatImageReceipt(raw,origin).usage.total_tokens,25);
 assert.throws(()=>chatImageReceipt(raw.replace('data: [DONE]',''),origin),/中断/);assert.throws(()=>chatImageReceipt('data: {"error":{"message":"上游失败"}}\n\ndata: [DONE]\n\n',origin),/上游失败/);
 const root=mkdtempSync(join(tmpdir(),'ruiyun-chat-image-')),p=join(root,'image.png');writeFileSync(p,'original-reference');const old=globalThis.fetch;let posts=0;
 try{globalThis.fetch=async(url,opt)=>{posts++;assert.equal(String(url),origin+'/v1/chat/completions');const b=JSON.parse(opt!.body as string);assert.equal(b.stream,true);assert.equal(b.messages[0].content[0].image_url.url,'data:image/png;base64,'+Buffer.from('original-reference').toString('base64'));return new Response(raw,{headers:{'Content-Type':'text/event-stream'}});};
  const result=await new XiaopeiImageAdapter().create({adapter:'ruiyun',origin},key,{model:{...contracts['GPT本地版（图生图）'],remoteModel:'GPT本地版（图生图）'},params:{},prompt:'修改画面',assets:[{mediaId:'x'}]}, {get:()=>({mime:'image/png'}),path:()=>p} as any,[],AbortSignal.timeout(3000));assert.equal(result.data[0].url,'https://files.example/a.png');assert.equal(posts,1);
 }finally{globalThis.fetch=old;rmSync(root,{recursive:true,force:true});}
});
test('video/audio originals are recognised, granted with original hash, and available in native conversation with ownership checks',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ruiyun-av-')),app=new Platform({dataDir:root,mockDelay:1});
 try{await app.start(0);const user=app.newUser({username:'av-member',password:'Synthetic-Test-Password'},'member'),other=app.newUser({username:'av-other',password:'Synthetic-Test-Password'},'member');
  const audio=Buffer.alloc(44);audio.write('RIFF',0);audio.write('WAVE',8);audio.write('fmt ',12);const a=await app.pickups.media.ingest(Readable.from(audio),user.id,'private','reference.wav');assert.equal(a.mime,'audio/wav');
  const link=await new ProviderReferences(app.store,app.pickups.media).prepare({mediaId:a.id,sha256:a.sha256},{origin:'https://files.example',revision:'fixture'},AbortSignal.timeout(1000));const r=await fetch('http://127.0.0.1:'+(app.server.address()as any).port+new URL(link).pathname);assert.deepEqual(Buffer.from(await r.arrayBuffer()),audio);
  const admin=app.newUser({username:'av-admin',password:'Synthetic-Test-Password'},'admin');const catalog=app.pickups.catalog,c0=catalog.saveChannel(admin,{name:'fixture',origin,adapter:'ruiyun',apiKey:key,enabled:true,concurrency:1,noRetryEvidence:'fixture'});const c:Doc={...app.store.get('video-channel',c0.id)!,verified:true,reachableModels:['官方h3-720p']};app.store.put('video-channel',c);app.store.put('video-channel-version',{...c,id:c.revision,channelId:c.id});const m={...contracts['官方h3-720p'],id:id(),revision:id(),remoteModel:'官方h3-720p',name:'官方h3-720p',channelId:c.id,channelRevision:c.revision,status:'testing',memberAccess:true};app.store.put('video-model',m);app.store.put('video-storage',{id:'active',revision:'fixture',enabled:true});const task={id:id(),owner:user.id,session:app.fixedChat(user).id,nativeSession:'native-fixture',base:app.projects.current().revision,prompt:'画面'};const plan=prepareConversation(app.pickups,task,{model_id:m.id,script:'人物说话',notes:'调整节奏',final_prompt:'人物近景说话。',params:{seconds:5},reference_audio_ids:[a.id]});assert.equal(plan.shots[0].assets[0].mediaKind,'audio');assert.throws(()=>prepareConversation(app.pickups,{...task,id:id(),owner:other.id},{model_id:m.id,script:'人物说话',notes:'调整',params:{seconds:5},reference_audio_ids:[a.id]}));
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
test('auxiliary token endpoint classification keeps 3D out of video and image job queues',()=>{assert.equal(ruiyunKind({tags:'其他,按Token计费',supported_endpoint_types:['openai']}),'chat');});
test('native queue submits resolved image/video/audio fields once and reports explicit provider parameter rejection',async()=>{
 const {hash}=await import('../server/store.ts'),{VideoHTTPFailure}=await import('../server/video-catalog.ts');
 const root=mkdtempSync(join(tmpdir(),'ruiyun-queue-av-'));let calls=0,last:Doc={},reject=false;
 const adapter={async create(_c:Doc,_key:string,p:Doc){calls++;last=p;if(reject)throw new VideoHTTPFailure(422,{error:{code:'invalid_parameter',message:'provider request rejected'}});return {id:'task_fixture_'+calls,status:'queued'};},async query(){return {id:'task_fixture_1',status:'queued'};},async content(){throw Error('no generated media fixture');}};
 const app=new Platform({dataDir:root,videoAdapter:adapter,mockDelay:1}),old=globalThis.fetch;
 try{await app.start(0);const user=app.newUser({username:'queue-member',password:'Synthetic-Test-Password'},'member'),admin=app.newUser({username:'queue-admin',password:'Synthetic-Test-Password'},'admin'),catalog=app.pickups.catalog;
  const c0=catalog.saveChannel(admin,{name:'fixture',origin,adapter:'ruiyun',apiKey:key,enabled:true,concurrency:2,noRetryEvidence:'fixture'}),c:Doc={...app.store.get('video-channel',c0.id)!,verified:true,reachableModels:['【api调用】sd2.5-1080p']};app.store.put('video-channel',c);app.store.put('video-channel-version',{...c,id:c.revision,channelId:c.id});
  app.store.put('runtime-concurrency',{id:'active',testedVideo:2,testedChannels:{[c.id]:{limit:2,revision:c.revision}}});const m={...contracts['【api调用】sd2.5-1080p'],id:id(),revision:id(),name:'【api调用】sd2.5-1080p',remoteModel:'【api调用】sd2.5-1080p',channelId:c.id,channelRevision:c.revision,status:'testing',memberAccess:true};app.store.put('video-model',m);const storage={id:'active',revision:id(),origin:'https://fixture.references',mode:'host-reference',enabled:true};app.store.put('video-storage',storage);app.store.put('video-storage-version',{...storage,id:storage.revision});
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP90AAAAASUVORK5CYII=','base64'),video=Buffer.alloc(40),audio=Buffer.alloc(44);video.write('ftyp',4);audio.write('RIFF');audio.write('WAVE',8);
  const refs=[];for(const [name,bytes]of[['ref.png',image],['ref.mp4',video],['ref.wav',audio]]as const)refs.push(await app.pickups.media.ingest(Readable.from(bytes),user.id,'private',name));
  globalThis.fetch=async(url,opt)=>{assert.equal(new URL(String(url)).hostname,'fixture.references');assert.equal(new Headers(opt?.headers).get('Authorization'),null);const token=new URL(String(url)).pathname.split('/').at(-1)!,grant=app.store.get('provider-reference',hash(token))!;return new Response(readFileSync(app.pickups.media.path(grant.mediaId)));};
  const task={id:id(),owner:user.id,session:app.fixedChat(user).id,nativeSession:'native-fixture',base:app.projects.current().revision,prompt:'test'},args={model_id:m.id,script:'人物说话',notes:'调整动作',final_prompt:'人物近景说话。',params:{seconds:8},reference_media_ids:[refs[0].id],reference_video_ids:[refs[1].id],reference_audio_ids:[refs[2].id]};const plan=prepareConversation(app.pickups,task,args);app.pickups.confirm(plan.id,user,{digest:plan.digest});
  for(let n=0;n<100&&app.store.all('video-job')[0].state!=='running';n++)await new Promise(r=>setTimeout(r,10));assert.equal(calls,1);assert(!JSON.stringify(last).includes('asset:'));assert.equal(last.extra.reference_images.length,1);assert.equal(last.extra.reference_videos.length,1);assert.equal(last.extra.reference_audios.length,1);assert.equal(last.images,undefined);
  reject=true;const second=prepareConversation(app.pickups,{...task,id:id()},args);app.pickups.confirm(second.id,user,{digest:second.digest});for(let n=0;n<100&&app.store.all('video-job').find(j=>j.planId===second.id)?.state!=='failed';n++)await new Promise(r=>setTimeout(r,10));const failure=app.store.all('video-job').find(j=>j.planId===second.id)!;assert.equal(calls,2);assert.equal(failure.createAttempts,1);assert.equal(failure.state,'failed');assert.match(failure.error,/参数/);assert.equal(failure.submissionDisposition,'rejected');
 }finally{globalThis.fetch=old;await app.close();rmSync(root,{recursive:true,force:true});}
});
