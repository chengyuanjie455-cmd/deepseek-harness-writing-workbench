import vm from 'node:vm';
import {adaptNativeClient} from '../server/native-page.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Store,id,hash,type Doc} from '../server/store.ts';
import {Platform} from '../server/app.ts';
import {prepareConversation} from '../server/conversation-pickup.ts';
import {activeMediaWorker,mediaWorkerStatus} from '../server/media-worker-manager.ts';
import {deliveryStatus,deliveryMetrics,productionRecord} from '../server/delivery-status.ts';
import {hostFiles} from '../server/host-files.ts';
import {previewFile} from '../server/media-preview.ts';
import {verifyNativeCompatibility} from '../server/native-compatibility.ts';
import {claimExecution,executionActive,releaseExecution} from '../server/media-execution.ts';
import {operations,recoverOperation} from '../server/operations.ts';
import {backupOffline} from '../server/backup.ts';
import {Readable} from 'node:stream';
const password='synthetic-architecture-password';
async function until(fn:()=>boolean,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(fn())return;await delay(50);}throw Error('architecture wait timeout');}
test('indexed scheduling selects only active due jobs in the bound project and preserves legacy shared rows',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'arch-store-'))),store=new Store(root);try{
 store.tx(()=>{for(let n=0;n<10000;n++)store.put('video-job',{id:String(n),project:'other',state:'ready',owner:'a'});store.put('video-job',{id:'due',state:'running',nextPoll:1,owner:'a'});store.put('video-job',{id:'later',project:'shared',state:'running',nextPoll:999,owner:'a'});store.put('video-job',{id:'other',project:'other',state:'running',nextPoll:1,owner:'a'});});
 assert.deepEqual(store.scoped('shared').select('video-job',{states:['running'],due:{field:'nextPoll',at:5}}).map(j=>j.id),['due']);
 const plan=store.db.prepare("EXPLAIN QUERY PLAN SELECT body FROM docs WHERE kind=? AND json_extract(body,'$.state')=? AND coalesce(json_extract(body,'$.project'),'shared')=?").all('video-job','running','shared');assert.match(JSON.stringify(plan),/docs_state_project/);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('media executor survives API shutdown, reattaches once, delivers the original and prevents live offline backups',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'arch-worker-'))),data=join(root,'data');let app=new Platform({dataDir:data,mediaWorker:true,workerFixtureModule:resolve('tests/fixtures/media-worker-adapter.mjs'),simulatedVideo:true});
 try{
 execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=12','-t','4','-c:v','libx264','-pix_fmt','yuv420p',join(data,'fixture.mp4')]);
 const user=app.newUser({username:'admin',password},'admin');const c0=app.pickups.catalog.saveChannel(user,{name:'fixture',origin:'https://synthetic.invalid',adapter:'ruiyun',apiKey:'synthetic-key',enabled:true,concurrency:2,noRetryEvidence:'synthetic once-only'});
 const c:Doc={...app.store.get('video-channel',c0.id)!,verified:true,reachableModels:['fixture-video']};app.store.put('video-channel',c);app.store.put('video-channel-version',{...c,id:c.revision});
 const model={id:id(),revision:id(),name:'fixture-video',aliases:[],status:'published',channelId:c.id,channelRevision:c.revision,remoteModel:'fixture-video',params:{resolution:['90p'],audio:[false]},defaults:{resolution:'90p',audio:false},durations:[4],secondsType:'number',maxReferences:0,referenceField:'none'};app.store.put('video-model',model);
 app.store.put('runtime-concurrency',{id:'active',video:2,testedVideo:2,testedChannels:{[c.id]:{limit:2,revision:c.revision}}});
 await app.start(0);const p=prepareConversation(app.pickups,{id:id(),owner:user.id,session:'session-worker',nativeSession:'session-worker',base:app.projects.current().revision,prompt:'合成蓝色画面'},{model_id:model.id,script:'蓝色房门',notes:'慢推',params:{seconds:4}});app.pickups.confirm(p.id,user,{digest:p.digest});
 await until(()=>existsSync(join(data,'fixture-video-creates')));const pid=mediaWorkerStatus(data)!.pid;assert(activeMediaWorker(data));assert.throws(()=>backupOffline(data,join(root,'backup')),/媒体执行器/);
 await app.close({keepMediaWorker:true});assert(activeMediaWorker(data));writeFileSync(join(data,'fixture-release'),'1');
 app=new Platform({dataDir:data,mediaWorker:true,workerFixtureModule:resolve('tests/fixtures/media-worker-adapter.mjs'),simulatedVideo:true});await app.start(0);assert.equal(mediaWorkerStatus(data)!.pid,pid);
 await until(()=>app.store.select('video-job',{planId:p.id})[0]?.state==='ready',30000);const job=app.store.select('video-job',{planId:p.id})[0];assert.equal(readFileSync(join(data,'fixture-video-creates'),'utf8'),'1');assert.equal(job.mediaSHA256,hash(readFileSync(join(data,'fixture.mp4'))));assert(deliveryStatus(job).available);assert.equal(productionRecord(app.store,'video-job',job)!.notes,'慢推');
 }finally{if(!app.closing)await app.close();else await app.mediaWorker?.close();assert(!activeMediaWorker(data));rmSync(root,{recursive:true,force:true});}
});
test('file restore preserves the overwritten version and rejects stale edits and damaged history',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'arch-files-'))),store=new Store(join(root,'data')),user={id:id(),active:true,role:'member'},file=join(root,'script.txt');store.put('user',user);const files=hostFiles(store);try{
 writeFileSync(file,'first');const before=await files.info(file),saved=await files.action(user,{action:'write',path:file,etag:before.etag,content:'second'});const history=await files.revisions(user,file);assert.equal(history[0].sha256,hash('first'));
 await assert.rejects(files.restore(user,{revision:history[0].id,etag:before.etag}),/修改/);
 await files.restore(user,{revision:history[0].id,etag:saved.etag});assert.equal(readFileSync(file,'utf8'),'first');assert.equal((await files.revisions(user,file)).length,2);
 const original=join(store.root,'host-file-revisions',history[0].id,'original');writeFileSync(original,'xxxxx');await assert.rejects(files.restore(user,{revision:history[0].id,etag:(await files.info(file)).etag}),/哈希/);assert.equal(readFileSync(file,'utf8'),'first');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('cached image thumbnails preserve original bytes and concurrent previews reuse one output',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'arch-preview-'))),app=new Platform({dataDir:join(root,'data')});try{
 const file=join(root,'image.png');execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc=s=1024x1024','-frames:v','1',file]);const original=readFileSync(file),m=await app.pickups.media.ingest(Readable.from([original]),'member');
 const results=await Promise.all([previewFile(app.pickups.media,m.id,'thumb'),previewFile(app.pickups.media,m.id,'thumb')]);assert.equal(results[0],results[1]);assert.equal(hash(readFileSync(app.pickups.media.path(m.id))),hash(original));
 const meta=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=width,height','-of','json',results[0]],{encoding:'utf8'}));assert.equal(meta.streams[0].width,360);assert(readFileSync(results[0]).length>0);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
test('delivery does not confuse provider completion, saved but unchecked media, or unknown submissions with availability',()=>{
 assert.equal(deliveryStatus({state:'downloading',remoteCompletedAt:'2026-01-01'}).available,false);assert.equal(deliveryStatus({state:'checking',mediaId:'x'}).available,false);assert.equal(deliveryStatus({state:'submission_unknown'}).stage,'unconfirmed');assert.equal(deliveryStatus({state:'ready'}).available,false);
 const done=deliveryStatus({state:'ready',mediaId:'x',created:'2026-01-01T00:00:00Z',remoteCompletedAt:'2026-01-01T00:00:05Z',finished:'2026-01-01T00:00:07Z'});assert(done.available);assert.equal(done.deliveryLagMs,2000);
});

test('pinned native plugin contracts are verified against actual installed assets',()=>{const result=verifyNativeCompatibility(resolve('.'));assert(result.contracts.some(c=>c.package==='dsh-api-session-controller'&&c.passed));assert(result.contracts.every(c=>c.passed));assert(result.passed);});


test('separate executor claims prevent API cancellation and concurrent takeover, while recent metrics use bounded SQL',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'arch-claim-'))),app=new Platform({dataDir:root}),worker=new Store(root,undefined,undefined,'media-worker');try{
  const user=app.newUser({username:'member',password},'member');const job={id:id(),owner:user.id,state:'queued',createAttempts:0,planId:id()};app.store.put('image-job',job);
  const token=claimExecution(worker,'image-job',job.id,['queued'])!;assert(token);assert(executionActive(app.store,'image-job',job.id));assert.equal(claimExecution(app.store,'image-job',job.id,['queued']),undefined);assert.throws(()=>app.images.cancel(job.id,user),/不能取消/);assert.equal(operations(app).items.find(j=>j.id===job.id)?.processing,true);
  const video={id:id(),owner:user.id,state:'downloading',remoteTaskId:'original'};app.store.put('video-job',video);const vt=claimExecution(worker,'video-job',video.id,['downloading'])!;await assert.rejects(recoverOperation(app,user,{kind:'video-job',id:video.id,action:'resume'}),/正在处理/);releaseExecution(worker,'video-job',video.id,vt);
  releaseExecution(worker,'image-job',job.id,token);assert(!executionActive(app.store,'image-job',job.id));app.images.cancel(job.id,user);assert.equal(app.store.get('image-job',job.id)!.state,'cancelled');
  const clock=Date.parse('2026-09-30T12:00:00Z');for(const [id,finished] of [['old','2026-09-01T00:00:00Z'],['new','2026-09-30T11:00:00Z']])app.store.put('video-job',{id,state:'ready',finished,mediaId:'original'});assert.equal(deliveryMetrics(app.store,clock).delivered,1);
 }finally{worker.close();await app.close();rmSync(root,{recursive:true,force:true});}
});

test('executor crash during image submission preserves unknown outcome without another charge, then recovers the original receipt',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'arch-crash-'))),data=join(root,'data'),app=new Platform({dataDir:data,mediaWorker:true,workerFixtureModule:resolve('tests/fixtures/media-worker-adapter.mjs'),simulatedVideo:true});try{
  const user=app.newUser({username:'admin',password},'admin'),c0=app.pickups.catalog.saveChannel(user,{name:'fixture',origin:'https://synthetic.invalid',adapter:'ruiyun',apiKey:'synthetic',enabled:true,concurrency:2,noRetryEvidence:'synthetic once only'});
  const c:Doc={...app.store.get('video-channel',c0.id)!,verified:true,reachableModels:['gpt-image-2']};app.store.put('video-channel',c);app.store.put('video-channel-version',{...c,id:c.revision});const m={id:id(),revision:id(),name:'合成图片',aliases:[],remoteModel:'gpt-image-2',channelId:c.id,channelRevision:c.revision,status:'available',imageRoute:'multipart-edits',params:{resolution:['1k'],aspect_ratio:['1:1']},defaults:{resolution:'1k',aspect_ratio:'1:1'},maxReferences:2};app.store.put('image-model',m);
  execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=1024x1024','-frames:v','1',join(data,'fixture.png')]);writeFileSync(join(data,'fixture-image-wait'),'1');await app.start(0);
  const p=await app.images.prepare({id:id(),owner:user.id,session:'session-crash',nativeSession:'session-crash',base:app.projects.current().revision,prompt:'图片描述：合成蓝色背景\n图片模型：合成图片'});assert.equal(p.state,'awaiting_confirmation',JSON.stringify(p.issues));app.images.confirm(p.id,user,{digest:p.digest});await until(()=>existsSync(join(data,'fixture-image-creates')));
  const pid=mediaWorkerStatus(data)!.pid;process.kill(pid,'SIGKILL');await until(()=>!activeMediaWorker(data));await app.mediaWorker!.ensure();await until(()=>app.store.select('image-job',{planId:p.id})[0]?.state==='submission_unknown');const j=app.store.select('image-job',{planId:p.id})[0];assert.equal(readFileSync(join(data,'fixture-image-creates'),'utf8'),'1');
  app.images.resolveUnknown(j.id,user,{outcome:'received',evidence:'synthetic fixture receipt',receipt:{data:[{url:'https://synthetic.invalid/image'}]}});await until(()=>app.store.get('image-job',j.id)?.state==='ready');assert.equal(readFileSync(join(data,'fixture-image-creates'),'utf8'),'1');assert.equal(app.store.get('image-job',j.id)!.mediaSHA256,hash(readFileSync(join(data,'fixture.png'))));
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('authenticated preview supports video seeking and rejects other members while original downloads stay byte-identical',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'arch-preview-http-'))),app=new Platform({dataDir:join(root,'data')});try{
  const member=app.newUser({username:'member',password},'member');app.newUser({username:'other',password},'member');const base='http://127.0.0.1:'+await app.start(0),file=join(root,'clip.mp4');execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=s=1280x720:r=12','-t','2','-c:v','libx264','-pix_fmt','yuv420p',file]);const bytes=readFileSync(file),m=await app.pickups.media.ingest(Readable.from([bytes]),member.id);
  const login=async(username:string)=>{const r=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username,password})});await r.text();return r.headers.get('set-cookie')!.split(';')[0];};const cookie=await login('member'),url=base+'/api/media/'+m.id;
  let r=await fetch(url+'/preview?variant=preview',{headers:{Cookie:cookie,Range:'bytes=0-99'}});assert.equal(r.status,206);assert.equal(r.headers.get('x-media-derivative'),'preview-only');assert.equal((await r.arrayBuffer()).byteLength,100);
  r=await fetch(url+'?download=1',{headers:{Cookie:cookie}});assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),hash(bytes));r=await fetch(url+'/preview?variant=thumb',{headers:{Cookie:await login('other')}});assert.equal(r.status,404);await r.text();r=await fetch(url+'/preview?variant=preview');assert.equal(r.status,401);await r.text();
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});


test('new settings shell uses native actions and current file cards retain native actions alongside original download',()=>{
 const listeners=new Map(),cleanup:Function[]=[],calls:string[]=[];const input='function SettingsRoot(props) { const {actions}=props; const { close, openSection } = actions; }';
 vm.runInNewContext(adaptNativeClient(input)+';SettingsRoot({actions});',{actions:{openSection:(v:string)=>calls.push(v),close:()=>calls.push('closed')},react:{useEffect:(fn:Function)=>cleanup.push(fn())},window:{addEventListener:(k:string,v:Function)=>listeners.set(k,v),removeEventListener:(k:string)=>listeners.delete(k)}});
 listeners.get('team-open-settings')({detail:'models'});listeners.get('team-close-settings')();assert.deepEqual(calls,['models','closed']);cleanup.forEach(fn=>fn());assert.equal(listeners.size,0);
 const raw=readFileSync('native-harness/node_modules/@deepseek-ai/dsh-client-ui-deliverables/lib/client.js','utf8'),adapted=adaptNativeClient(raw),begin=adapted.indexOf('function PresentedFileCard('),end=adapted.indexOf('//#endregion',begin),jsx=(type:any,props:any)=>({type,props}),action={type:'original-action'},scope:any={react_jsx_runtime:{jsx,jsxs:jsx},Deliverables_module_css_default:new Proxy({},{get:(_t,k)=>String(k)}),basename:(p:string)=>p.split('/').at(-1),cardDescription:()=>'',resolveWorkspacePath:(_:string,p:string)=>p,_deepseek_ai_dsh_client_ui_primitives:{fileExtension:()=> 'zip',FileTypeIcon:'icon'},window:{__TEAM_WORKSPACE_DOWNLOAD_URL__:(p:string)=>'/download?path='+encodeURIComponent(p)},action};
 const tree=vm.runInNewContext(adapted.slice(begin,end)+';PresentedFileCard({file:{path:"/workspace/result.zip"},actions:action,t:x=>x});',scope),nodes:any[]=[];const walk=(v:any)=>{if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object'){nodes.push(v);walk(v.props?.children);}};walk(tree);assert(nodes.includes(action));const link=nodes.find(v=>v.type==='a');assert.equal(link.props.download,'result.zip');assert.equal(link.props.href,'/download?path='+encodeURIComponent('/workspace/result.zip'));
});
