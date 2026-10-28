import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Platform} from '../server/app.ts';
import {id} from '../server/store.ts';
const password='Billing-fixture-only-123';
function client(base:string){let cookie='',csrf='';return async(path:string,body?:any,status=200,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+'/api'+path,{method,headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json() as any;assert.equal(r.status,status,JSON.stringify(data));if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie')!.split(';')[0];if(data.csrf)csrf=data.csrf;return data;};}
function noBilling(data:any){const s=JSON.stringify(data);assert(!/"(?:pricing|pricePerSecond|currency|estimate|cost|estimatedUsd|reservedUsd|budget|budgetMode|onlineBudgetEnabled)"\s*:/.test(s),s);}
test('ordinary responses omit accounting for both roles; execution snapshots and administrator APIs retain it',async()=>{
 const app=new Platform({dataDir:mkdtempSync(join(tmpdir(),'billing-private-')),mockDelay:1});const base='http://127.0.0.1:'+await app.start(0),admin=client(base),member=client(base);
 try{
  noBilling(await admin('/status'));await admin('/setup',{username:'admin',password},201);await admin('/login',{username:'admin',password});const user=app.newUser({username:'member',password},'member');await member('/login',{username:'member',password});
  app.store.put('release',{...app.release(),pricing:{currency:'USD',inputPerMillion:0.15},limits:{taskUsd:5}});
  app.options.concurrency=0;const session=await member('/sessions',{fresh:true},201),body={session:session.id,requestId:id(),prompt:'只验证权限',workflow:'chat',paths:[]};
  const task=await member('/tasks',body,202);noBilling(task);assert(app.store.get('task',task.id)!.release.pricing);noBilling(await member('/tasks',body));noBilling(await member('/requests/'+body.requestId+'?session='+session.id));noBilling(await member('/requests/'+body.requestId+'/close',{session:session.id}));noBilling(await member('/tasks/'+task.id,{prompt:'修改排队内容'},200,'PATCH'));noBilling(await member('/tasks/'+task.id+'/cancel',{}));
  const channelId=id(),modelId=id(),planId=id(),jobId=id(),imageId=id();app.store.put('video-channel',{id:channelId,enabled:true,reachableModels:['fixture-video']});app.store.put('video-model',{id:modelId,name:'test',remoteModel:'fixture-video',status:'published',channelId,pricePerSecond:0.25,currency:'CNY'});
  const plan={id:planId,owner:user.id,session:session.id,model:{id:modelId,pricePerSecond:0.25,currency:'CNY'},shots:[{source:{id:'S1'},estimate:{amount:1,currency:'CNY'}}],state:'confirmed',digest:'confirmed-digest'};app.store.put('pickup',plan);app.store.put('video-job',{id:jobId,owner:user.id,planId,sourceId:'S1',state:'ready',payload:{model:'fixture-video',seconds:4},cost:{status:'unverified',amount:null,currency:'CNY'}});
  app.store.put('image-plan',{id:imageId,owner:user.id,model:{pricePerImage:0.5,currency:'CNY'},state:'confirmed',digest:'image-digest'});app.store.put('image-job',{id:id(),owner:user.id,planId:imageId,state:'ready',cost:{status:'unverified',amount:null,currency:'CNY'}});
  for(const c of [admin,member])for(const p of ['/project','/tasks','/video-models','/pickups','/pickups/'+planId,'/images','/images/'+imageId])noBilling(await c(p));
  noBilling(await member('/pickups/'+planId+'/confirm',{digest:plan.digest}));noBilling(await member('/images/'+imageId+'/confirm',{digest:'image-digest'}));
  assert.equal((await admin('/admin/video-models'))[0].pricePerSecond,0.25);assert.equal((await admin('/admin/video-jobs'))[0].cost.status,'unverified');assert((await admin('/admin/billing?details=1')).entries.length===2);
  for(const p of ['/admin/billing?details=1','/admin/model-usage','/admin/health','/admin/video-models','/admin/video-jobs'])await member(p,undefined,403);
  await member('/admin/billing/prices/verify',{},403);await member('/admin/billing/reconcile',{},403);
  assert.deepEqual(app.store.get('pickup',planId),plan);
 }finally{await app.close();}
});

test('administrator price and bill reconciliation validates input, detects conflicts, audits corrections and persists across restart',async()=>{
 const root=mkdtempSync(join(tmpdir(),'billing-review-'));let app=new Platform({dataDir:root,mockDelay:1});let admin=client('http://127.0.0.1:'+await app.start(0));
 try{
  await admin('/setup',{username:'admin',password},201);const login=await admin('/login',{username:'admin',password});
  const modelId=id(),jobId=id();app.store.put('video-model',{id:modelId,name:'视频费率',remoteModel:'fixture',revision:'v1',pricePerSecond:0.2,currency:'CNY'});app.store.put('video-job',{id:jobId,owner:login.user.id,modelName:'fixture',state:'failed',cost:{status:'unverified',amount:null,currency:'CNY'},created:new Date().toISOString()});
  let data=await admin('/admin/billing?details=1');let price=data.prices.find((p:any)=>p.key==='video:'+modelId);
  await admin('/admin/billing/prices/verify',{key:price.key,fingerprint:'old',evidence:'fixture evidence'},409);
  await admin('/admin/billing/prices/verify',{key:price.key,fingerprint:price.fingerprint,evidence:'  '},400);
  await admin('/admin/billing/prices/verify',{key:price.key,fingerprint:price.fingerprint,evidence:'合成供应商价格页，CNY/秒；不是实际价格'});
  data=await admin('/admin/billing?details=1');assert.equal(data.prices[0].priceReview.stale,false);
  app.store.put('video-model',{...app.store.get('video-model',modelId)!,revision:'v2',pricePerSecond:0.3});data=await admin('/admin/billing?details=1');assert.equal(data.prices[0].priceReview.stale,true);
  const request={key:'video-job:'+jobId,reviewVersion:null,amount:0,currency:'CNY',evidence:'合成失败退款账单，零元有效'};
  await admin('/admin/billing/reconcile',{...request,amount:-1},400);await admin('/admin/billing/reconcile',{...request,amount:'0'},400);await admin('/admin/billing/reconcile',{...request,currency:'BAD'},400);await admin('/admin/billing/reconcile',{...request,evidence:''},400);
  await admin('/admin/billing/reconcile',request);await admin('/admin/billing/reconcile',request,409);
  data=await admin('/admin/billing?details=1');const entry=data.entries[0];assert.equal(entry.reconciliation.amount,0);assert.equal(entry.reconciliation.verifiedBy,login.user.id);assert.equal(entry.estimate.amount,null);
  await admin('/admin/billing/reconcile',{...request,reviewVersion:entry.reviewVersion,amount:0.8,evidence:'合成账单更正'});
  assert.equal(app.store.get('video-job',jobId)!.cost.status,'unverified','do not rewrite execution estimates');
  const audits=app.store.db.prepare("SELECT detail FROM audit WHERE action='billing.bill.verify'").all();assert.equal(audits.length,2);assert.equal(JSON.parse(String(audits[1].detail)).previous.amount,0);
  await app.close();app=new Platform({dataDir:root,mockDelay:1});admin=client('http://127.0.0.1:'+await app.start(0));await admin('/login',{username:'admin',password});data=await admin('/admin/billing?details=1');assert.equal(data.entries[0].reconciliation.amount,0.8);assert.equal(data.prices[0].priceReview.stale,true);
 }finally{await app.close();}
});
