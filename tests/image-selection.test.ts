import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Platform} from '../server/app.ts';
import {id,type Doc} from '../server/store.ts';
import {publicResponse} from '../server/billing.ts';
import {ImageModelUnavailable,modelUnavailable} from '../server/image-selection.ts';
import {XiaopeiImageAdapter} from '../server/image-generation.ts';
import {MediaModelAdmin} from '../server/media-model-admin.ts';
import {MemberModels} from '../server/member-models.ts';

const names=['gpt-image-2特价1k','gpt-image-2特价2k','gpt-image-2.5特价2k','gpt-image-2','gpt-image-2-expensive'];
test('automatic model rejection preserves authorized input while each selected dispatch records its actual model version',async()=>{
 const f=await fixture();try{f.reject();await f.generate();await f.settle();const job=f.app.store.all('image-job')[0];assert.equal(job.state,'ready');assert.equal(job.dispatchInputs.length,2);assert.equal(job.authorizedInput.model.id,f.submitted[0].model.id);assert.deepEqual(job.dispatchInputs.map((d:Doc)=>d.input.model.id),f.submitted.map(p=>p.model.id));assert(job.dispatchInputs.every((d:Doc)=>d.authorizationInputDigest===job.authorizedInput.digest));assert.equal(job.dispatchInputs[0].input.content.promptSHA256,job.dispatchInputs[1].input.content.promptSHA256);assert.notEqual(job.dispatchInputs[0].input.digest,job.dispatchInputs[1].input.digest);assert.equal(f.app.store.all('image-job').length,1);}finally{await f.close();}
});
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'image-selection-'));
  const file=join(root,'image.png');execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=2048x2048','-frames:v','1',file]);const bytes=readFileSync(file);
  const submitted:Doc[]=[];let rejectFirst=false,uncertain=false;
  const adapter={async create(_c:Doc,_key:string,p:Doc){submitted.push(p);if(uncertain)throw Error('timeout after send');if(rejectFirst&&submitted.length===1){prices=[.01,.08,.07,.04,.2];throw new ImageModelUnavailable();}return {data:[{b64_json:bytes.toString('base64')}]};},async download(){throw Error('unexpected download');}};
  const app=new Platform({dataDir:join(root,'data'),simulatedVideo:true,imageAdapter:adapter,mockDelay:1});await app.start(0);
  const admin=app.newUser({username:'admin',password:'Synthetic-Test-Password'},'admin'),member=app.newUser({username:'member',password:'Synthetic-Test-Password'},'member');
  const c0=app.pickups.catalog.saveChannel(admin,{name:'synthetic',origin:'https://synthetic.invalid',adapter:'ruiyun',apiKey:'synthetic-key',enabled:true,concurrency:2,noRetryEvidence:'fixture'});
  const c:Doc={...app.store.get('video-channel',c0.id)!,adapter:'xiaopei',origin:'https://api.aicopy.top',verified:true,reachableModels:names};
  app.store.put('video-channel',c);app.store.put('video-channel-version',{...c,id:c.revision,channelId:c.id});
  const models=names.map((name,n)=>({id:id(),revision:id(),name,remoteModel:name,aliases:[],channelId:c.id,channelRevision:c.revision,status:'available',imageRoute:'multipart-edits',params:{resolution:n===0?['1k']:n===3?['1k','2k','4k']:['2k'],aspect_ratio:['1:1']},defaults:{resolution:n===0||n===3?'1k':'2k',aspect_ratio:'1:1'},maxReferences:4}));
  for(const model of models)app.store.put('image-model',model);
  app.images.selection.enabled=true;app.images.simulated=false;
  let prices=[.01,.03,.05,.06,.2],available=[...names],requests:string[]=[],pricingFails=false;
  const original=globalThis.fetch;
  globalThis.fetch=(async(url,options)=>{const path=new URL(String(url)).pathname;requests.push(path);
    if(path==='/v1/models'){assert.equal((options?.headers as any).Authorization,'Bearer synthetic-key');return Response.json({data:available.map(id=>({id}))});}
    assert.equal((options?.headers as any)?.Authorization,undefined);
    if(path==='/api/pricing')return pricingFails?new Response('unavailable',{status:503}):Response.json({success:true,pricing_version:'fixture',data:names.map((model_name,n)=>({model_name,quota_type:1,model_price:prices[n]}))});
    if(path==='/api/status')return Response.json({data:{quota_display_type:'CNY',usd_exchange_rate:1}});
    throw Error('unexpected network request '+path);
  }) as typeof fetch;
  const i:any={key:'image-selection-fixture',owner:member.id,project:'shared'};
  const request:any={action:'image_generate',sessionId:'image-session',sourceMessageId:'source-1',sourceText:'生成一张图片',callId:'call-1',args:{prompt:'蓝色背景',model:'auto'}};
  async function generate(args:Doc={}){return app.native.team.tool(i,member,{...request,args:{...request.args,...args}});}
  async function settle(){for(let n=0;n<400;n++){if(!app.images.active.size)return;await delay(20);}throw Error('settle timeout');}
  return {app,admin,member,models,c,generate,settle,submitted,requests,request,i,
    reject:()=>{rejectFirst=true;},uncertain:()=>{uncertain=true;},setPrices:(v:number[])=>{prices=v;},remove:(name:string)=>{available=available.filter(v=>v!==name);},failPricing:()=>{pricingFails=true;},
    close:async()=>{await app.close();globalThis.fetch=original;}};
}

test('2K precedes cheaper 1K, then sorts by verified price; cap and member scope apply',async()=>{
  const f=await fixture();try{
    const rows=await f.app.images.refreshModels(f.member);assert.deepEqual(rows.map(m=>m.name),[names[1],names[2],names[3],names[0]]);
    assert.deepEqual(new MediaModelAdmin(f.app.store,f.app.pickups.catalog).list(f.admin).slice(0,3).map(m=>m.name),[names[1],names[2],names[3]]);
    assert.deepEqual(new MemberModels(f.app.store,f.app.images.selection).list(f.admin).models.slice(0,3).map(m=>m.name),[names[1],names[2],names[3]]);
    assert.equal(rows.find(m=>m.name===names[3])!.defaults.resolution,'2k');
    f.app.store.put('member-model-policy',{id:'shared',image:[f.models[2].id],video:[]});assert.deepEqual(f.app.images.models(f.member).map(m=>m.name),[names[2]]);
    assert.equal(f.app.images.selection.pick(rows,'auto',{resolution:'1k'}).model.name,names[0]);
    assert.throws(()=>f.app.images.selection.pick(rows,'auto',{aspect_ratio:'16:9'}));
    assert.throws(()=>f.app.images.selection.pick(rows,'auto',{},5));
    const publicRows=JSON.stringify(rows,publicResponse);assert(!publicRows.includes('pricePerImage'));assert(!publicRows.includes('currency'));
  }finally{await f.close();}
});
test('native default selects cheap 2K and reconnect does not reselect or submit twice',async()=>{
  const f=await fixture();try{
    const result=await f.generate();await f.settle();assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].model.name,names[1]);assert.equal(f.submitted[0].params.resolution,'2k');
    assert.equal(f.app.images.get(result!.plan.id,f.member).jobs[0].state,'ready');
    const calls=f.requests.length;const again=await f.generate();assert.equal(again!.plan.id,result!.plan.id);assert.equal(f.submitted.length,1);assert.equal(f.requests.length,calls);
  }finally{await f.close();}
});
test('explicit model and parameters are retained while available',async()=>{
  const f=await fixture();try{
    const result=await f.app.native.team.tool(f.i,f.member,{...f.request,action:'image_prepare',args:{prompt:'蓝色背景',model:names[3],params:{resolution:'4k'}}});
    assert.equal(result!.plan.model.name,names[3]);assert.equal(result!.plan.params.resolution,'4k');assert.equal(f.submitted.length,0);
  }finally{await f.close();}
});
test('removed requested model refreshes directory and selects current cheapest compatible 2K',async()=>{
  const f=await fixture();try{
    f.remove(names[1]);await f.generate({model:names[1]});await f.settle();assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].model.name,names[2]);
    assert(f.requests.filter(p=>p==='/api/pricing').length>=2);
  }finally{await f.close();}
});
test('explicit rejection refreshes changed prices and switches within the same task',async()=>{
  const f=await fixture();try{
    f.reject();const result=await f.generate();await f.settle();assert.deepEqual(f.submitted.map(p=>p.model.name),[names[1],names[3]]);
    const plan=f.app.images.get(result!.plan.id,f.member);assert.equal(plan.jobs.length,1);assert.equal(plan.jobs[0].state,'ready');assert.equal(plan.jobs[0].createAttempts,2);
    assert.equal(plan.model.name,names[3]);assert.equal(plan.modelSelections.length,1);assert.equal(plan.jobs[0].modelName,names[3]);assert.equal(plan.jobs[0].modelRejections.length,1);
    assert.equal(f.requests.filter(p=>p==='/api/pricing').length,2);
  }finally{await f.close();}
});
test('uncertain submission never triggers model switching or a second create',async()=>{
  const f=await fixture();try{
    f.uncertain();const result=await f.generate();await f.settle();assert.equal(f.submitted.length,1);assert.equal(f.app.images.get(result!.plan.id,f.member).jobs[0].state,'submission_unknown');
    assert.equal(f.requests.filter(p=>p==='/api/pricing').length,1);
  }finally{await f.close();}
});
test('price refresh failure and exhausted cap never submit',async()=>{
  const f=await fixture();try{
    f.setPrices([.11,.11,.11,.11,.2]);await assert.rejects(f.generate(),/可用生图型号/);assert.equal(f.submitted.length,0);
    f.failPricing();await assert.rejects(f.app.images.refreshModels(f.member,true));assert.equal(f.submitted.length,0);
  }finally{await f.close();}
});
test('concurrent directory refreshes share one provider read',async()=>{
  const f=await fixture();try{await Promise.all(Array.from({length:24},()=>f.app.images.refreshModels(f.member,true)));assert.equal(f.requests.length,3);}finally{await f.close();}
});
test('restocked configured models do not depend on an old manually synced channel list',async()=>{
  const f=await fixture();try{
    f.app.store.put('video-channel',{...f.c,reachableModels:[names[0]]});
    await f.generate();await f.settle();assert.equal(f.submitted[0].model.name,names[1]);assert.equal(f.submitted[0].params.resolution,'2k');
  }finally{await f.close();}
});
test('concurrent reconnect calls share one durable plan and one create',async()=>{
  const f=await fixture();try{
    const results=await Promise.all(Array.from({length:8},()=>f.generate()));await f.settle();assert.equal(new Set(results.map(r=>r!.plan.id)).size,1);assert.equal(f.submitted.length,1);
  }finally{await f.close();}
});
test('price refresh failure only hides image catalogue and leaves video catalogue available',async()=>{
  const f=await fixture();try{
    f.failPricing();const result:any=await f.app.native.team.tool(f.i,f.member,{...f.request,action:'catalog',args:{}});assert(Array.isArray(result.videoModels));assert.deepEqual(result.imageModels,[]);assert.notEqual(result.imageModelStatus,'ready');assert.equal(f.submitted.length,0);
  }finally{await f.close();}
});
test('only structured model rejection is safe to retry; adapter preserves other uncertainty',async()=>{
  assert(modelUnavailable(404,{error:{code:'model_not_found'}}));assert(modelUnavailable(503,{error:{code:'no_available_channels'}}));
  for(const [status,body] of [[500,{error:{code:'model_not_found'}}],[404,{error:{message:'not found'}}],[404,{id:'receipt',error:{code:'model_not_found'}}],[404,{data:[],error:{code:'model_not_found'}}]] as const)assert(!modelUnavailable(status,body));
  const original=globalThis.fetch;
  try{globalThis.fetch=(async()=>Response.json({error:{code:'model_not_found'}},{status:404})) as typeof fetch;
    const p={model:{remoteModel:names[1],imageRoute:'multipart-edits'},prompt:'fixture',params:{resolution:'2k',aspect_ratio:'1:1'},assets:[]};
    await assert.rejects(new XiaopeiImageAdapter().create({adapter:'xiaopei',origin:'https://api.aicopy.top'},'synthetic',p,{} as any,[],new AbortController().signal),ImageModelUnavailable);
  }finally{globalThis.fetch=original;}
});
