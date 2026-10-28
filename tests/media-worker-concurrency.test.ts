import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Platform} from '../server/app.ts';
import {id,hash,type Doc} from '../server/store.ts';
import {activeMediaWorker} from '../server/media-worker-manager.ts';
import {mediaGallery} from '../server/media-gallery.ts';
async function until(fn:()=>boolean,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(fn())return;await delay(100);}throw Error('concurrency fixture timeout');}

test('eight members and 24 native tool conversations deliver independently while API is offline; reconnection does not repeat requests',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'arch-eight-'))),data=join(root,'data'),options={dataDir:data,mediaWorker:true,workerFixtureModule:resolve('tests/fixtures/media-worker-adapter.mjs'),simulatedVideo:true};let app=new Platform(options);let reader:DatabaseSync|undefined;
 try{
  const password='synthetic-24-conversation-fixture',admin=app.newUser({username:'admin',password},'admin'),users=Array.from({length:8},(_,n)=>app.newUser({username:'member'+n,password},'member'));
  const c0=app.pickups.catalog.saveChannel(admin,{name:'fixture',origin:'https://synthetic.invalid',adapter:'ruiyun',apiKey:'synthetic',enabled:true,concurrency:2,noRetryEvidence:'synthetic receipt'}),c:Doc={...app.store.get('video-channel',c0.id)!,verified:true,reachableModels:['gpt-image-2']};app.store.put('video-channel',c);app.store.put('video-channel-version',{...c,id:c.revision});const model={id:id(),revision:id(),name:'合成图片',aliases:[],remoteModel:'gpt-image-2',channelId:c.id,channelRevision:c.revision,status:'available',imageRoute:'multipart-edits',params:{resolution:['1k'],aspect_ratio:['1:1']},defaults:{resolution:'1k',aspect_ratio:'1:1'},maxReferences:2};app.store.put('image-model',model);app.store.put('runtime-concurrency',{id:'active',image:500});
  execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=1024x1024','-frames:v','1',join(data,'fixture.png')]);writeFileSync(join(data,'fixture-download-fail-once'),'1');await app.start(0);
  const requests=users.flatMap((user,n)=>Array.from({length:3},(_,tab)=>({user,instance:{key:'fixture-'+n,owner:user.id,project:'shared'} as any,request:{action:'image_generate',sessionId:'session-member-'+n+'-tab-'+tab,sourceMessageId:'message-'+n+'-'+tab,sourceText:'生成图片 '+n+'-'+tab,callId:id(),args:{model:model.name,prompt:'合成蓝色背景 '+n+'-'+tab}}})));
  const plans=await Promise.all(requests.map(r=>app.native.team.tool(r.instance,r.user,r.request)));assert(plans.every(p=>p!.plan.state==='confirmed'));assert.equal(new Set(plans.map(p=>p!.plan.session)).size,24);assert.equal(app.store.all('image-job').length,24);
  await app.close({keepMediaWorker:true});assert(activeMediaWorker(data));reader=new DatabaseSync(join(data,'platform.sqlite'),{readOnly:true});await until(()=>Number(reader!.prepare("SELECT count(*) AS n FROM docs WHERE kind='image-job' AND json_extract(body,'$.state')='ready'").get()!.n)===24);reader.close();reader=undefined;
  assert.equal(readFileSync(join(data,'fixture-image-creates'),'utf8'),'24');assert.equal(readFileSync(join(data,'fixture-image-downloads'),'utf8'),'25');app=new Platform(options);await app.start(0);
  const same=await Promise.all(requests.map(r=>app.native.team.tool(r.instance,r.user,{...r.request,callId:id()})));assert.deepEqual(same.map(p=>p!.plan.id),plans.map(p=>p!.plan.id));assert.equal(readFileSync(join(data,'fixture-image-creates'),'utf8'),'24');
  const sha=hash(readFileSync(join(data,'fixture.png')));for(const r of requests){const gallery=await mediaGallery(app,r.user,new URLSearchParams({project:'shared',owner:r.user.id,session:r.request.sessionId,kind:'all'}));assert.equal(gallery.items.length,1);const m=app.pickups.media.get(gallery.items[0].mediaId);assert.equal(m.owner,r.user.id);assert.equal(m.sha256,sha);}
  assert.equal(app.store.all('model-call').length,0);assert.equal(app.store.all('media-execution').length,0);assert.equal(app.store.all('image-job').length,24);
 }finally{reader?.close();if(!app.closing)await app.close();else await app.mediaWorker?.close();assert(!activeMediaWorker(data));rmSync(root,{recursive:true,force:true});}
});
