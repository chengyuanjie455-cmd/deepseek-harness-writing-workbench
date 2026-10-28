import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Writable} from 'node:stream';import {createServer} from 'node:http';import vm from 'node:vm';
import {Platform} from '../server/app.ts';
import {Store,hash} from '../server/store.ts';
import {serveMediaBundle} from '../server/media-bundle.ts';
import {memberSubmissions} from '../server/member-submissions.ts';
import {operations,recoverOperation} from '../server/operations.ts';
import {taskTrace} from '../server/task-trace.ts';
const password='Isolated-boundary-fixture-2026!';
const client=readFileSync(new URL('../native-harness/team-project/client.js',import.meta.url),'utf8');

test('video unknown closure requires admin evidence, preserves charges and attempts, and releases queue without resending',async()=>{
 const root=mkdtempSync(join(tmpdir(),'video-close-')),app=new Platform({dataDir:root,videoConcurrency:1});
 try{
  const admin=app.newUser({username:'admin',password},'admin'),member=app.newUser({username:'member',password},'member');
  const j={id:'unknown',owner:member.id,project:'shared',planId:'plan',state:'submission_unknown',channelId:'a',createAttempts:1,cost:{status:'unverified',amount:null,currency:'CNY'},receipt:{opaque:'kept'},created:new Date().toISOString()};
  app.store.put('video-job',j);app.store.put('video-channel-version',{id:'b-v1',concurrency:1});app.store.put('video-channel',{id:'b',concurrency:1});
  app.store.put('video-job',{id:'queued',owner:member.id,state:'queued',channelId:'b',channelRevision:'b-v1',createAttempts:0});
  const launched:string[]=[];app.pickups.launch=(id)=>{launched.push(id);};app.pickups.pump();assert.deepEqual(launched,[]);
  const body={kind:'video-job',id:j.id,action:'resolve_video',outcome:'not_submitted',evidence:'供应商工单核实：未收到此请求'};
  await assert.rejects(recoverOperation(app,member,body),/管理员/);
  await assert.rejects(recoverOperation(app,admin,{...body,evidence:'  '}),/依据/);
  await assert.rejects(recoverOperation(app,admin,{...body,outcome:'unverified'}),/核对结果/);
  app.pickups.active.set(j.id,new AbortController());await assert.rejects(recoverOperation(app,admin,body),/停止执行/);app.pickups.active.delete(j.id);
  const value=await recoverOperation(app,admin,body);assert.equal(value.state,'cancelled');assert.equal(value.resolution,undefined);
  const saved=app.store.get('video-job',j.id)!;assert.deepEqual(saved.cost,j.cost);assert.deepEqual(saved.receipt,j.receipt);assert.equal(saved.createAttempts,1);assert.equal(saved.resolution.by,admin.id);assert.equal(saved.resolution.outcome,'not_submitted');assert.deepEqual(launched,['queued']);
  assert.equal(taskTrace(app.store,'video-job',j.id).resolution.evidence,body.evidence);
  await assert.rejects(recoverOperation(app,admin,body),/未知请求/);assert.deepEqual(launched,['queued']);
  app.store.put('video-job',{...j,id:'unknown-failed'});
  await recoverOperation(app,admin,{...body,id:'unknown-failed',outcome:'failed'});
  assert.equal(app.store.get('video-job','unknown-failed')!.state,'failed');assert(!operations(app).items.some(j=>j.id==='unknown-failed'));
  assert(operations(app,new URLSearchParams('taskStatus=completed')).items.some(j=>j.id==='unknown-failed'&&j.group==='completed'));
  assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='pickup.resolve_unknown'").get()!.n,2);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('streamed ZIP rejects same-size original alteration and does not write a valid archive',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bundle-hash-'));
 try{
  const original=Buffer.from('ORIGINAL'),file=join(root,'original'),chunks:Buffer[]=[];writeFileSync(file,'CHANGED!');
  const media:any={get:()=>({id:'one',mime:'video/mp4',bytes:original.length,sha256:hash(original)}),path:()=>file};
  const res:any=new Writable({write(b,_e,cb){chunks.push(Buffer.from(b));cb();}});res.writeHead=()=>{};
  await assert.rejects(serveMediaBundle(media,['one'],res),/完整性/);assert(res.destroyed);assert(!Buffer.concat(chunks).includes(Buffer.from([0x50,0x4b,0x05,0x06])));
  const upstream=createServer((_req,res)=>{void serveMediaBundle(media,['one'],res).catch(e=>res.destroy(e));});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
  try{await assert.rejects(async()=>{const r=await fetch('http://127.0.0.1:'+(upstream.address() as any).port);await r.arrayBuffer();});}finally{await new Promise<void>(r=>upstream.close(()=>r()));}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('task center separates completed chat turns from cancelled and partial generation results',()=>{
 const root=mkdtempSync(join(tmpdir(),'task-outcomes-')),s=new Store(root);
 try{
  const u={id:'u',role:'member',active:true};s.put('user',u);s.put('project',{id:'shared'});
  const dir=join(root,'native-harness',hash(JSON.stringify([u.id,'shared'])).slice(0,24),'state');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'team-submissions.json'),JSON.stringify({version:1,at:Date.now(),items:[{id:'m',session:'s',state:'completed',prompt:'生成两条短剧视频'}]}));
  s.put('pickup',{id:'p',owner:u.id});s.audit(u.id,'native.video.generate','p',{session:'s',sourceMessageId:'m'});
  const j={owner:u.id,planId:'p',state:'cancelled'};s.put('video-job',{...j,id:'j1'});s.put('video-job',{...j,id:'j2'});
  const cancelled=memberSubmissions(s,u,new URLSearchParams('state=cancelled'));assert.equal(cancelled.summary.completed,0);assert.equal(cancelled.summary.cancelled,1);assert.equal(cancelled.items[0].chatState,'completed');assert.equal(cancelled.items[0].state,'cancelled');assert.equal(memberSubmissions(s,u,new URLSearchParams('state=completed')).items.length,0);
  s.put('video-job',{...j,id:'j1',state:'ready'});const partial=memberSubmissions(s,u,new URLSearchParams('state=partial'));assert.equal(partial.summary.partial,1);assert.equal(partial.summary.completed,0);assert.equal(partial.items[0].results.length,2);
  s.put('video-job',{...j,id:'j2',state:'ready'});assert.equal(memberSubmissions(s,u).summary.completed,1);
  s.put('video-job',{...j,id:'j2',state:'failed'});assert.equal(memberSubmissions(s,u).summary.attention,1);
 }finally{s.close();rmSync(root,{recursive:true,force:true});}
});

test('native history pages every version with stable numbers and owner isolation, including insertion between pages',async()=>{
 const root=mkdtempSync(join(tmpdir(),'lineage-pages-')),app=new Platform({dataDir:root});
 try{
  const u=app.newUser({username:'member',password},'member'),other=app.newUser({username:'other',password},'member'),i:any={owner:u.id,project:'shared'};
  const plan=(n:number)=>({id:hash('version-'+n),owner:u.id,project:'shared',nativeSession:'s',created:new Date(10000+n*1000).toISOString(),previousPlanId:n?hash('version-'+(n-1)):null,shots:[]});
  for(let n=0;n<60;n++)app.store.put('pickup',plan(n));
  app.store.put('pickup',{...plan(60),owner:other.id});
  const first=app.native.team.history(i,'video',plan(59).id);assert.equal(first.total,60);assert.equal(first.items.length,50);assert.equal(first.items[0].versionNumber,11);assert.equal(first.items.at(-1)!.versionNumber,60);assert(first.nextCursor);
  app.store.put('pickup',plan(61)); // Another root must not change this lineage.
  app.store.put('pickup',{...plan(62),previousPlanId:plan(59).id});
  let body='';const res:any={writeHead(){},end(b:string){body=b;}};
  await app.native.team.route(i,u,{method:'GET'} as any,res,'/api/team/video/'+plan(59).id+'/history?cursor='+first.nextCursor);
  const earlier=JSON.parse(body);assert.equal(earlier.items.length,10);assert.equal(earlier.items[0].versionNumber,1);assert.equal(earlier.items.at(-1).versionNumber,10);assert.equal(earlier.nextCursor,null);assert.equal(earlier.total,61);
  assert.equal(new Set([...first.items,...earlier.items].map(p=>p.plan.id)).size,60);
  assert.throws(()=>app.native.team.history(i,'video',plan(59).id,{cursor:'bad?'}),/游标/);
  assert.throws(()=>app.native.team.history(i,'video',plan(59).id,{limit:0}),/数量/);
  assert.throws(()=>app.native.team.history({owner:other.id,project:'shared'} as any,'video',plan(59).id),/权限|成员/);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('real project adoption identifies only the current published result while preserving historic adoption',async()=>{
 const root=mkdtempSync(join(tmpdir(),'current-adoption-')),app=new Platform({dataDir:root});
 try{
  const u=app.newUser({username:'member',password,name:'成员'},'member'),path='成果/补抽/shot/当前采用.json';
  for(let n=1;n<=2;n++){
   const p={id:'plan-'+n,owner:u.id,digest:'digest-'+n,base:app.projects.current().revision,reads:{},shots:[{source:{id:'shot'},previousPath:path,previousDigest:app.projects.revision().manifest[path]??null}]};
   app.store.put('pickup',p);app.store.put('video-job',{id:'job-'+n,owner:u.id,planId:p.id,sourceId:'shot',round:n,state:'ready',technicalQA:{passed:true},mediaId:'media-'+n,mediaSHA256:hash('media-'+n),modelName:'fixture'});
   app.pickups.adopt('job-'+n,u,{digest:p.digest,humanAccepted:true});assert.equal(app.pickups.get(p.id,u).jobs[0].currentAdopted,true);
  }
  assert.equal(app.pickups.get('plan-1',u).jobs[0].state,'adopted');assert.equal(app.pickups.get('plan-1',u).jobs[0].currentAdopted,false);assert.equal(app.pickups.get('plan-2',u).jobs[0].currentAdopted,true);assert.equal(JSON.parse(app.projects.read(path).toString()).mediaId,'media-2');
  app.pickups.adopt('job-1',u,{digest:'digest-1',humanAccepted:true});assert.equal(app.pickups.get('plan-1',u).jobs[0].currentAdopted,false);assert.equal(JSON.parse(app.projects.read(path).toString()).mediaId,'media-2');
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('project-owned templates stay scoped when native switch is disabled and at legacy validation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'template-scope-')),app=new Platform({dataDir:root});
 try{
  const admin=app.newUser({username:'admin',password},'admin'),catalog=app.pickups.catalog;
  const b={name:'A 专属模板',body:'{{notes}} {{storyboard}} {{assets}} {{dayPeriod}} {{duration}}',status:'published',modelIds:[],default:true,nativeEnabled:true};
  const t=catalog.saveTemplate(admin,b,'project-a');catalog.saveTemplate(admin,{...b,id:t.id,nativeEnabled:false},'project-a');
  const global=catalog.saveTemplate(admin,{...b,name:'全局模板',nativeEnabled:false});
  assert.deepEqual(catalog.legacyTemplates('project-a').map(t=>t.id).sort(),[t.id,global.id].sort());assert.deepEqual(catalog.legacyTemplates('project-b').map(t=>t.id),[global.id]);assert.deepEqual(catalog.legacyTemplates('shared').map(t=>t.id),[global.id]);
  assert.throws(()=>catalog.saveTemplate(admin,{...b,id:t.id,nativeEnabled:false},'project-b'),/其他项目/);
  catalog.saveTemplate(admin,{...b,id:t.id,nativeEnabled:true},'project-a');assert(!catalog.legacyTemplates('project-a').some(v=>v.id===t.id));
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('adopted cards refresh across visible windows, refresh immediately after adoption and stop when hidden',async()=>{
 let timer:any,visible:any,hidden=false,clock=0,queries=0,isCurrent=true;class Clock extends Date{static now(){return clock;}}
 const script=client.split('window.__ModuleLoader__.load')[0],factory=vm.runInNewContext(script+';createTeamPlanPoller',{Date:Clock});const labels=vm.runInNewContext(script+';adoptedLabel');
 const card=()=>({kind:'video',plan:{id:'p',jobs:[{state:'adopted',currentAdopted:isCurrent}]}});const states:boolean[]=[];
 const poll=factory({fetchBatch:async()=>{queries++;return {items:[card()]};},setTimer:(fn:any)=>{timer=fn;return 1;},clearTimer:()=>{},hidden:()=>hidden,onVisible:(fn:any)=>{visible=fn;return()=>{};}});
 const off=poll.subscribe('video/p',card(),(v:any)=>states.push(v.plan.jobs[0].currentAdopted));await timer();assert.equal(queries,1);
 clock=5000;await timer();assert.equal(queries,1);clock=60000;isCurrent=false;await timer();assert.equal(queries,2);assert.equal(states.at(-1),false);
 hidden=true;clock=120000;await timer();assert.equal(queries,2);hidden=false;visible();await timer();assert.equal(queries,3);poll.refreshAll();await timer();assert.equal(queries,4);
 assert.equal(labels({currentAdopted:true}),'当前采用');assert.match(labels({currentAdopted:false}),/曾经采用/);assert.match(labels({}),/待核对/);off();poll.dispose();
});

test('returned video learns adoption in another window without a visibility change; immutable results stop polling',async()=>{
 let timer:any,clock=0,queries=0,adopted=false;class Clock extends Date{static now(){return clock;}}
 const factory=vm.runInNewContext(client.split('window.__ModuleLoader__.load')[0]+';createTeamPlanPoller',{Date:Clock});
 const card=()=>({kind:'video',plan:{id:'p',jobs:[{state:adopted?'adopted':'ready',...(adopted?{currentAdopted:true}:{})}]}});const states:string[]=[];
 const poll=factory({fetchBatch:async()=>{queries++;return {items:[card()]};},setTimer:(fn:any)=>{timer=fn;return 1;},clearTimer:()=>{timer=null;},hidden:()=>false,onVisible:()=>()=>{}});
 poll.subscribe('video/p',card(),(v:any)=>states.push(v.plan.jobs[0].state));await timer();assert.equal(queries,1);
 assert(timer,'a returned video can still be adopted in another window');clock=5000;await timer();assert.equal(queries,1,'completed videos do not retain the frequent generation poll');
 clock=60000;adopted=true;await timer();assert.equal(queries,2);assert.equal(states.at(-1),'adopted');poll.dispose();assert.equal(timer,null);
});
