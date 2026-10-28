import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Platform} from '../server/app.ts';import {Billing} from '../server/billing.ts';import {id} from '../server/store.ts';import {billingPeriod} from '../server/billing-summary.ts';
const password='Billing-summary-fixture-2026!';
function fixture(){const root=mkdtempSync(join(tmpdir(),'bill-summary-')),app=new Platform({dataDir:root}),admin=app.newUser({username:'admin',password,name:'管理员'},'admin'),member=app.newUser({username:'member',password,name:'历史成员'},'member');return {root,app,admin,member,billing:new Billing(app.store,app.catalog)};}
function video(app:Platform,owner:string,params:any={}){const key=id(),planId=id(),model={id:'model-video',name:params.name??'视频模型',remoteModel:'wan-video',channelId:'channel',currency:'CNY',pricePerSecond:params.rate??.2};app.store.put('pickup',{id:planId,model,shots:[{source:{id:'S1'},params:{seconds:4},estimate:{amount:model.pricePerSecond*4,currency:'CNY'}}]});app.store.put('video-job',{id:key,planId,sourceId:'S1',owner,project:params.project??'shared',channelId:'channel',modelName:model.name,state:'ready',payload:{model:model.remoteModel,seconds:params.seconds??4},created:params.created??'2026-09-24T17:00:00Z',...params.job});return key;}
test('models aggregate across members/projects using historical rates and actual submitted units; unknowns, currencies and simulations stay separate',async()=>{
 const f=fixture(),{app,billing,admin,member}=f;try{
 app.store.put('video-channel',{id:'channel',name:'视频渠道'});video(app,admin.id);video(app,member.id,{rate:.3,seconds:6,name:'同模型另一配置',project:'project-two'});
 const imagePlan=id();app.store.put('image-plan',{id:imagePlan,model:{remoteModel:'image-x',channelId:'channel',pricePerImage:.5,currency:'CNY'},payload:{n:2},params:{resolution:'1k'}});app.store.put('image-job',{id:id(),owner:member.id,planId:imagePlan,state:'ready',created:'2026-09-25T01:00:00Z'});
 const pricing={currency:'USD',inputPerMillion:1,cacheReadPerMillion:.1,outputPerMillion:2};
 app.store.put('model-call',{id:'known-text',owner:admin.id,provider:'deepseek-official',model:'ds',state:'usage_recorded',usage:{inputTokens:100,cacheReadTokens:200,cacheWriteTokens:10,outputTokens:50},pricing,created:'2026-09-25T01:00:00Z'});
 app.store.put('model-call',{id:'unknown-text',owner:member.id,provider:'deepseek-official',model:'ds',state:'unconfirmed',pricing,created:'2026-09-25T02:00:00Z'});
 app.store.put('model-call',{id:'cancelled-text',owner:member.id,provider:'deepseek-official',model:'ds',state:'cancelled_before_send',pricing,reservedUsd:100,created:'2026-09-25T02:00:00Z'});
 app.store.put('model-call',{id:'cny-text',owner:member.id,provider:'deepseek-official',model:'ds',state:'usage_recorded',pricing:{currency:'CNY'},estimatedUsd:null,created:'2026-09-25T02:00:00Z'});
 app.store.put('model-call',{id:'subscription',owner:admin.id,provider:'zhipu-coding',model:'glm',state:'usage_recorded',usage:{inputTokens:20,outputTokens:10},pricing:{currency:'CNY',billingMode:'subscription'},created:'2026-09-25T02:00:00Z'});
 app.store.put('model-call',{id:'simulation',owner:member.id,provider:'deepseek-official',model:'ds',state:'usage_recorded',pricing,estimatedUsd:999,fixture:true,created:'2026-09-25T02:00:00Z'});
 app.store.put('video-model',{id:'current-only',name:'不能重算历史',remoteModel:'orphan',channelId:'channel',currency:'CNY',pricePerSecond:900});app.store.put('video-job',{id:id(),modelId:'current-only',owner:member.id,state:'failed',payload:{model:'orphan',seconds:4},created:'2026-09-25T01:00:00Z'});
 const data=billing.list(admin);assert(!('entries' in data));const v=data.groups.find(g=>g.model==='wan-video')!;assert.equal(v.requestCount,2);assert.equal(v.memberCount,2);assert.equal(v.projectCount,2);assert.equal(v.usage.seconds,10);assert.equal(v.estimate.amount,2.6);
 const image=data.groups.find(g=>g.kind==='image')!;assert.equal(image.usage.images,2);assert.equal(image.estimate.amount,1);
 const t=data.groups.find(g=>g.kind==='text'&&g.model==='ds'&&g.currency==='USD'&&!g.simulated)!;assert.equal(t.requestCount,3);assert.equal(t.submittedCount,2);assert.equal(t.usage.inputTokens,100);assert.equal(t.usage.cacheReadTokens,200);assert.equal(t.usage.cacheWriteTokens,10);assert.equal(t.estimate.amount,.00023);assert.equal(t.estimate.unknownCount,1);assert.equal(t.usage.unknownCalls,1);
 assert.equal(data.groups.find(g=>g.model==='orphan')!.estimate.amount,null);assert.equal(data.groups.find(g=>g.model==='glm')!.estimate.amount,null);assert.equal(data.totals.find(t=>t.kind==='text')!.amounts.find(a=>a.currency==='USD')!.estimated,.00023);
 assert.equal(billing.list(admin,{from:'2026-09-25',to:'2026-09-25'}).groups.find(g=>g.model==='wan-video')!.requestCount,2,'UTC+8 calendar date includes previous UTC evening');assert.equal(billing.list(admin,{from:'2026-09-26'}).groups.length,0);
 assert.throws(()=>billingPeriod('2026-02-30',''),/日期/);assert.throws(()=>billingPeriod('2026-09-26','2026-09-25'),/结束日期/);
 }finally{await app.close();rmSync(f.root,{recursive:true,force:true});}
});
test('model total reconciliation replaces legacy subtotals, detects live changes and conflicting edits, and persists without modifying jobs',async()=>{
 const f=fixture();let {app,billing,admin,member}=f;try{
 const a=video(app,member.id),b=video(app,admin.id);const original=JSON.stringify(app.store.get('video-job',a));billing.reconcile(admin,{key:'video-job:'+a,reviewVersion:null,amount:.7,currency:'CNY',evidence:'合成旧账单'});
 let g=billing.list(admin).groups[0];assert.equal(g.legacy.count,1);assert.equal(g.actualAmount,null);const body={key:g.key,fingerprint:g.fingerprint,reviewVersion:g.reviewVersion,amount:1.3,currency:g.currency,evidence:'合成模型整笔账单',...g.period};
 for(const bad of [{amount:-1},{amount:'1'},{amount:Infinity},{currency:'USD'},{evidence:''}])assert.throws(()=>billing.reconcileModel(admin,{...body,...bad}));
 billing.reconcileModel(admin,body);g=billing.list(admin).groups[0];assert.equal(g.actualAmount,1.3);assert.equal(billing.list(admin).totals[1].amounts[0].actual,1.3,'legacy .7 is not added twice');assert.throws(()=>billing.reconcileModel(admin,body),/已被更新/);assert.equal(JSON.stringify(app.store.get('video-job',a)),original);
 const c=video(app,member.id,{seconds:6});assert(billing.list(admin).groups[0].reconciliation?.stale);assert.equal(billing.list(admin).groups[0].actualAmount,null);assert.throws(()=>billing.reconcileModel(admin,{...body,reviewVersion:g.reviewVersion}),/用量或费用/);
 g=billing.list(admin).groups[0];billing.reconcileModel(admin,{...body,fingerprint:g.fingerprint,reviewVersion:g.reviewVersion,amount:0,evidence:'合成全额退款账单'});assert.equal(billing.list(admin).groups[0].actualAmount,0);
 assert.equal(billing.list(admin,{from:'2026-09-25',to:'2026-09-25'}).groups[0].reconciliation,null,'different period totals never inherit/stack overlapping reconciliation');
 const audit=app.store.db.prepare("SELECT detail FROM audit WHERE action='billing.model.verify'").all();assert.equal(audit.length,2);assert.equal(JSON.parse(String(audit[1].detail)).previous.amount,1.3);
 await app.close();app=new Platform({dataDir:f.root});billing=new Billing(app.store,app.catalog);assert.equal(billing.list(admin).groups[0].actualAmount,0);assert.equal(app.store.all('video-job').length,3);
 const url='http://127.0.0.1:'+await app.start(0),r=await fetch(url+'/api/login',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({username:'member',password})}),login=await r.json(),cookie=r.headers.get('set-cookie')!.split(';')[0];
 for(const path of ['/api/admin/billing','/api/admin/billing?details=1'])assert.equal((await fetch(url+path,{headers:{Cookie:cookie}})).status,403);
 assert.equal((await fetch(url+'/api/admin/billing/models/reconcile',{method:'POST',headers:{Cookie:cookie,Origin:url,'Content-Type':'application/json','X-CSRF-Token':login.csrf},body:JSON.stringify(body)})).status,403);
 }finally{await app.close();rmSync(f.root,{recursive:true,force:true});}
});
