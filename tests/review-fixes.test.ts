import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,openSync,closeSync,ftruncateSync,writeSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Platform} from '../server/app.ts';
import {Store} from '../server/store.ts';
import {Billing} from '../server/billing.ts';
import {backupOffline,restoreOffline,verifyBackup} from '../server/backup.ts';
import {hashRegularFile} from '../server/file-hash.ts';
import {fileHash} from '../server/file-objects.ts';
import {videoCapacity,channelCapacity} from '../server/concurrency.ts';
import {operations} from '../server/operations.ts';
const password='Review-regression-fixture-2026!';

test('billing excludes proven pre-send media failures but preserves unknown submissions and administrator evidence',async()=>{
 const root=mkdtempSync(join(tmpdir(),'review-bill-')),app=new Platform({dataDir:root});
 try{
  const admin=app.newUser({username:'admin',password},'admin'),bill=new Billing(app.store,app.catalog);
  const cases=[
   {state:'blocked',createAttempts:0,submissionDisposition:'not_sent',sent:false},
   {state:'blocked',createAttempts:0,sent:false},
   {state:'preparing',createAttempts:0,sent:false},
   {state:'failed',createAttempts:0,sent:false},
   {state:'cancelled',createAttempts:0,sent:false},
   {state:'queued',createAttempts:0,sent:false},
   {state:'cancelled',createAttempts:1,submissionDisposition:'not_sent',receipt:{opaque:'retained'},resolution:{outcome:'not_submitted'},sent:false},
   {state:'submission_unknown',createAttempts:1,sent:true},
   {state:'submitting',createAttempts:1,sent:true},
   {state:'failed',createAttempts:1,submissionDisposition:'sent',sent:true},
   {state:'failed',remoteTaskId:'provider-original',sent:true},
   {state:'download_failed',receipt:{data:[{url:'https://synthetic.invalid/original'}]},sent:true},
   {state:'failed',sent:true}, // Legacy missing send metadata cannot imply zero cost.
   {state:'blocked',createAttempts:0,remoteTaskId:'contradictory-record',submissionDisposition:'not_sent',sent:true}
  ];
  for(const kind of ['video','image']){
   const planId=kind+'-plan';app.store.put(kind==='video'?'pickup':'image-plan',{id:planId,model:{remoteModel:kind+'-fixture',channelId:'fixture',currency:'CNY',pricePerSecond:.248,pricePerImage:.5},shots:[{source:{id:'shot'},params:{seconds:4}}],payload:{n:1}});
   cases.forEach(({sent,...fields},n)=>app.store.put(kind+'-job',{id:kind+n,planId,sourceId:'shot',owner:admin.id,payload:{model:kind+'-fixture',seconds:4,n:1},created:'2026-09-26T00:00:00Z',...fields}));
  }
  const before=JSON.stringify(app.store.all('video-job')),group=bill.list(admin).groups.find(g=>g.kind==='video')!;
  bill.reconcileModel(admin,{key:group.key,fingerprint:group.fingerprint,reviewVersion:null,amount:3,currency:'CNY',evidence:'isolated synthetic bill',...group.period});
  const rows=bill.list(admin,{details:true}).entries!;
  for(const kind of ['video','image'])for(let n=0;n<cases.length;n++){
   const row=rows.find((e:any)=>e.id===kind+n)!;assert.equal(row.submitted,cases[n].sent,kind+n);assert.equal(row.estimate.amount,cases[n].sent?(kind==='video'?.992:.5):0,kind+n);
  }
  let g=bill.list(admin).groups.find(g=>g.kind==='video')!;assert.equal(g.usage.seconds,cases.filter(c=>c.sent).length*4);assert.equal(g.submittedCount,cases.filter(c=>c.sent).length);assert.equal(g.actualAmount,3);assert.equal(JSON.stringify(app.store.all('video-job')),before);
  const unknown=app.store.get('video-job','video7')!;app.store.put('video-job',{...unknown,state:'cancelled',submissionDisposition:'not_sent',resolution:{outcome:'not_submitted'}});
  g=bill.list(admin).groups.find(g=>g.kind==='video')!;assert.equal(g.reconciliation!.amount,3);assert.equal(g.reconciliation!.stale,true);assert.equal(g.actualAmount,null,'retain original attestation; require reconciliation of changed summary');
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('257 MiB original survives complete backup and restore; same-length corruption is rejected and upload limit stays 256 MiB',()=>{
 const root=mkdtempSync(join(tmpdir(),'review-backup-')),data=join(root,'data');const store=new Store(data);store.close();
 try{
  mkdirSync(join(data,'media'));const original=join(data,'media','large-original'),bytes=257*1024**2,fd=openSync(original,'wx',0o600);
  try{ftruncateSync(fd,bytes);writeSync(fd,Buffer.from('END'),0,3,bytes-3);}finally{closeSync(fd);}
  const h=createHash('sha256'),zeros=Buffer.alloc(1024**2);for(let n=0;n<256;n++)h.update(zeros);h.update(zeros.subarray(0,zeros.length-3));h.update('END');const expected=h.digest('hex');
  assert.throws(()=>fileHash(original),/256 MiB/);
  const backup=backupOffline(data,join(root,'backup'));assert.equal(verifyBackup(backup.path).files.find((f:any)=>f.path==='data/media/large-original').sha256,expected);
  const restored=restoreOffline(backup.path,join(root,'restore')),copy=join(restored.data,'media','large-original');assert.equal(statSync(copy).size,bytes);assert.equal(hashRegularFile(copy),expected);assert.equal(hashRegularFile(original),expected);
  const damaged=join(backup.path,'data/media/large-original'),bad=openSync(damaged,'r+');try{writeSync(bad,Buffer.from('BAD'),0,3,bytes-3);}finally{closeSync(bad);}
  assert.throws(()=>verifyBackup(backup.path),/哈希/);assert.throws(()=>restoreOffline(backup.path,join(root,'rejected')),/哈希/);
  assert.equal(JSON.parse(readFileSync(join(data,'backup-status.json'),'utf8')).lastAttempt.status,'succeeded');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('video capacity gates span projects/channels, retain unknown slots and never block polling existing tasks',async()=>{
 const root=mkdtempSync(join(tmpdir(),'review-capacity-')),app=new Platform({dataDir:root,videoConcurrency:500});
 try{
  mkdirSync(join(root,'other-project'));
  const a=app.pickups,b=app.addWorkspace('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',{path:join(root,'other-project'),name:'second project',manifest:{}}).pickups,launches:string[]=[];
  for(const ws of [a,b])ws.launch=(id,create)=>{launches.push((create?'create:':'recover:')+id);ws.active.set(id,new AbortController());if(create)ws.update(ws.store.get('video-job',id)!,{state:'running',nextPoll:Date.now()+999999});};
  for(const id of ['a','b']){app.store.put('video-channel',{id,revision:id+'-v1',concurrency:500});app.store.put('video-channel-version',{id:id+'-v1',concurrency:500});}
  const policy={id:'active',video:500,testedVideo:3,testedChannels:{a:{limit:2,revision:'a-v1'},b:{limit:2,revision:'b-v1'}}};app.store.put('runtime-concurrency',policy);
  for(let n=0;n<7;n++)app.store.put('video-job',{id:'job'+n,project:n<4?'shared':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',owner:'member'+n%3,state:'queued',channelId:n<4?'a':'b',channelRevision:n<4?'a-v1':'b-v1',createAttempts:0});
  a.pump();b.pump();assert.equal(launches.filter(s=>s.startsWith('create:')).length,3);assert.equal(app.store.all('video-job').filter(j=>j.channelId==='a'&&j.state==='running').length,2);assert.equal(app.store.all('video-job').filter(j=>j.state==='queued').length,4);
  app.store.put('runtime-concurrency',{...policy,testedVideo:1});const running=app.store.all('video-job').filter(j=>j.state==='running');for(const j of running){a.active.delete(j.id);b.active.delete(j.id);app.store.put('video-job',{...j,nextPoll:0});}a.pump();b.pump();assert.equal(launches.filter(s=>s.startsWith('recover:')).length,3);assert.equal(launches.filter(s=>s.startsWith('create:')).length,3,'lower threshold only stops new submissions');
  for(const ws of [a,b])ws.active.clear();for(const j of running)app.store.put('video-job',{...j,state:j.id===running[0].id?'submission_unknown':'ready'});
  a.pump();b.pump();assert.equal(launches.filter(s=>s.startsWith('create:')).length,3,'unknown receipt retains a slot');
  app.store.put('video-job',{...running[0],state:'cancelled',submissionDisposition:'not_sent'});a.pump();b.pump();assert.equal(launches.filter(s=>s.startsWith('create:')).length,4);
  assert.equal(channelCapacity(app.store,'a').effective,2);app.store.put('video-channel',{id:'a',revision:'new-credentials',concurrency:500});assert.equal(channelCapacity(app.store,'a').effective,1,'new channel contract cannot inherit old acceptance');
  const view=operations(app);assert.equal(view.video,500);assert.equal(view.testedVideo,1);assert.equal(view.effectiveVideo,1);assert.equal(view.channels.find(c=>c.id==='a')!.registered,false);
 }finally{app.pickups.active.clear();app.workspaces.get('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')?.pickups.active.clear();await app.close();rmSync(root,{recursive:true,force:true});}
});

test('administrator registers video/channel limits atomically; old clients preserve them and restart retains them',async()=>{
 const root=mkdtempSync(join(tmpdir(),'review-capacity-api-'));let app=new Platform({dataDir:root});
 try{
  app.newUser({username:'admin',password},'admin');app.newUser({username:'member',password},'member');app.store.put('video-channel',{id:'a',revision:'a-v1',concurrency:500,name:'合成渠道'});
  const url='http://127.0.0.1:'+await app.start(0);
  async function login(username:string){const r=await fetch(url+'/api/login',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({username,password})});return {Origin:url,'Content-Type':'application/json',Cookie:r.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':(await r.json()).csrf};}
  const admin=await login('admin'),member=await login('member'),post=(body:any,headers=admin)=>fetch(url+'/api/admin/concurrency',{method:'POST',headers,body:JSON.stringify(body)});
  const body={text:500,video:500,testedVideo:8,testedChannels:{a:8}};assert.equal((await post(body,member)).status,403);
  let r=await post(body);assert.equal(r.status,200);let v=await r.json();assert.equal(v.effectiveVideo,8);assert.equal(v.channels[0].effective,8);assert.equal(v.video,500);
  const saved=JSON.stringify(app.store.get('runtime-concurrency','active'));
  for(const bad of [{testedVideo:501},{testedVideo:0},{testedChannels:{a:1.2}},{testedChannels:[]},{testedChannels:{missing:8}},{testedChannels:{a:'8'}}]){r=await post({...body,...bad});assert(r.status>=400);assert.equal(JSON.stringify(app.store.get('runtime-concurrency','active')),saved);}
  r=await post({text:300,video:500});assert.equal(r.status,200);assert.equal((await r.json()).effectiveVideo,8,'old clients do not reset tested limits');
  await app.close();app=new Platform({dataDir:root});assert.equal(videoCapacity(app.store,app.options.videoConcurrency!).effectiveVideo,8);assert.equal(channelCapacity(app.store,'a').effective,8);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
