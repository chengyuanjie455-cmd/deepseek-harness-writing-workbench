import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverModels} from '../server/model-directory.ts';
import {adaptChatRequest} from '../server/chat-wire.ts';
import {apiEndpoint,apiOrigin,videoPayload,VideoCatalog} from '../server/video-catalog.ts';
import {XiaopeiImageAdapter,imagePayload} from '../server/image-generation.ts';
import {ChatCatalog} from '../server/chat-catalog.ts';
import {Store} from '../server/store.ts';
import {modelPricing} from '../server/model.ts';
import {chatProvider} from '../shared/chat-providers.ts';
import {ruiyunKind} from '../server/ruiyun-directory.ts';
import {XiaopeiDirectory} from '../server/xiaopei-directory.ts';
import {ImageSelection} from '../server/image-selection.ts';
import {Platform} from '../server/app.ts';
import {Readable} from 'node:stream';

const origin='https://154.64.253.71/ruiyun',secret='fixture-ruiyun-key';
const rows=[{model_name:'gpt-6-luna',tags:'LLM,按Token计费',supported_endpoint_types:['openai']},{model_name:'GPT本地版',tags:'LLM,按Token计费',supported_endpoint_types:['openai']},{model_name:'gpt-image-1k-16x9',tags:'图片生成',quota_type:1,model_price:.2,supported_endpoint_types:['image-generation']},{model_name:'wan-3.0-720p（特惠）',tags:'视频生成',supported_endpoint_types:['openai','openai-video']}];
const stub:typeof fetch=async(url,options)=>{
 const path=new URL(String(url)).pathname;
 if(path.endsWith('/v1/models')){assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer '+secret);return Response.json({data:rows.map(m=>({id:m.model_name,supported_endpoint_types:m.supported_endpoint_types}))});}
 if(path.endsWith('/api/pricing')){assert.equal(new Headers(options?.headers).get('Authorization'),null);return Response.json({success:true,data:rows});}
 if(path.endsWith('/api/status'))return Response.json({data:{quota_display_type:'CNY',usd_exchange_rate:1}});
 throw Error('unexpected route '+path);
};
test('Ruiyun authenticated chat catalogue separates media and accepts exact Chinese model IDs',async()=>{
 const result=await discoverModels('ruiyun',secret,stub);
 assert.deepEqual(result.models.map(m=>m.id),['gpt-6-luna','GPT本地版']);
 assert(result.models.every(m=>m.protocol==='chat'));
 let calls=0;await assert.rejects(discoverModels('ruiyun',secret,async()=>{calls++;return Response.json({},{status:401});}),/401/);assert.equal(calls,1,'auth failure cannot fall back to public pricing');
 assert.equal(ruiyunKind(rows[3]),'video');
});
test('prefix routing preserves TLS and rejects escaping API paths and unsafe HTTP',()=>{
 assert.equal(apiEndpoint(origin,'/v1/videos/task-a').href,origin+'/v1/videos/task-a');
 assert.throws(()=>apiEndpoint(origin,'/v1/../../admin'));
 assert.throws(()=>apiOrigin('http://114.66.27.232:3000',true,true));
 assert.equal(apiOrigin(origin,false,true).pathname,'/ruiyun');
 assert.throws(()=>apiOrigin(origin));
});
test('Ruiyun body preserves native messages and tools without provider-only thinking fields',()=>{
 const c:any={provider:'ruiyun',model:'gpt-6-luna',reasoningEffort:'high'},messages=[{role:'user',content:'retain context'}],tools=[{type:'function',function:{name:'team_image_generate'}}];
 const b:any={messages,tools,stream:true,reasoning_effort:'max',thinking:{type:'enabled'},dsh_session_log:{},tool_stream:true};
 adaptChatRequest(c,b);assert.equal(b.messages,messages);assert.equal(b.tools,tools);assert.equal(b.reasoning_effort,undefined);assert.equal(b.thinking,undefined);
 assert.equal(modelPricing({...c,baseURL:origin}).inputPerMillion,null,'Ruiyun must not be priced as DeepSeek official');
});
test('Ruiyun video uses documented seconds/extra references while old frozen channels retain their body',()=>{
 const p={model:'wan-3.0-720p（特惠）',prompt:'画面',seconds:10,resolution:'720p',aspect_ratio:'16:9',images:['https://assets.example/ref.png'],referenceMode:'reference'};
 const out=videoPayload({adapter:'ruiyun'},p);assert.equal(out.seconds,'10');assert.deepEqual(out.extra.reference_images,[{url:p.images[0],role:'reference_image'}]);assert.equal(out.images,undefined);
 assert.equal(videoPayload({adapter:'xiaopei'},p).seconds,10);assert.equal(p.seconds,10);
});
test('Ruiyun image edit sends original multipart bytes through the prefix exactly once',async()=>{
 const original=globalThis.fetch;let count=0;
 try{
  globalThis.fetch=async(url,options)=>{count++;assert.equal(String(url),origin+'/v1/images/edits');assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer '+secret);assert(options?.body instanceof FormData);const file=options.body.get('image')as Blob;assert.equal(await file.text(),'original-reference');return Response.json({data:[{b64_json:'fixture'}]});};
  const root=mkdtempSync(join(tmpdir(),'ruiyun-edit-')),file=join(root,'original.png');writeFileSync(file,'original-reference');
  try{const p:any={model:{remoteModel:'gpt-image-1k-16x9',imageRoute:'multipart-edits'},prompt:'场景',params:{resolution:'1k',aspect_ratio:'16:9'},assets:[{mediaId:'a'}]};
   await new XiaopeiImageAdapter().create({adapter:'ruiyun',origin},secret,p,{get:()=>({mime:'image/png'}),path:()=>file}as any,[],AbortSignal.timeout(2000));assert.equal(count,1);
   assert.deepEqual(imagePayload({remoteModel:'gpt-image-2-low',providerDefaults:true},'画面',{resolution:'默认',aspect_ratio:'默认'}),{model:'gpt-image-2-low',prompt:'画面',n:1});
  }finally{rmSync(root,{recursive:true,force:true});}
 }finally{globalThis.fetch=original;}
});
test('Ruiyun media directory uses current authorization and price without Xiaopei cap',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ruiyun-media-')),store=new Store(root),old=globalThis.fetch;
 try{
  const user:any={id:'admin',role:'admin',active:true};store.put('user',user);const catalog=new VideoCatalog(store,500);
  const c=catalog.saveChannel(user,{name:'瑞云',origin,adapter:'ruiyun',apiKey:secret,enabled:true,concurrency:500,noRetryEvidence:'single request'});
  globalThis.fetch=stub;const receipt=await new XiaopeiDirectory(store,catalog).sync(user,c.id);assert.equal(receipt.callableImage,1);assert.equal(receipt.callableVideo,1);
  const models=new XiaopeiDirectory(store,catalog).images(),selection=new ImageSelection(store,catalog);await selection.refresh(models);
  assert.equal(selection.pick(models,'gpt-image-1k-16x9').model.remoteModel,'gpt-image-1k-16x9');
  assert.throws(()=>selection.pick(models,'unavailable'),/本轮未提交/);
  assert.equal(store.get('video-model',store.all('video-model')[0].id)?.secondsType,'string');
 }finally{globalThis.fetch=old;store.close();rmSync(root,{recursive:true,force:true});}
});
test('old native model IDs resolve only through explicit migration aliases; disabled credentials remain hidden',()=>{
 const root=mkdtempSync(join(tmpdir(),'ruiyun-alias-')),store=new Store(root);
 try{
  const initial:any={provider:'ruiyun',model:'gpt-6-luna',apiKey:secret,baseURL:chatProvider('ruiyun')!.baseURL,reasoningEffort:'high',configId:'current'};
  writeFileSync(join(root,'chat-model-route-aliases.json'),JSON.stringify({'old-glm':'default'}),{mode:0o600});
  const catalog=new ChatCatalog(store,initial);assert.equal(catalog.select({}as any,'shared','old-glm').modelId,'default');assert.equal(catalog.publicModels().length,1);assert.throws(()=>catalog.select({}as any,'shared','unknown'));
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('reference grant serves the exact original across projects and rejects expired or changed originals',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ruiyun-reference-')),app=new Platform({dataDir:root,mockDelay:1});
 try{
  const port=await app.start(0),origin='http://127.0.0.1:'+port;
  const admin=app.newUser({username:'reference-admin',password:'synthetic-reference-only'},'admin');
  const project='fixture-another-project',scoped=app.store.scoped(project);
  const {MediaStore}=await import('../server/media.ts'),{ProviderReferences}=await import('../server/provider-references.ts'),{hash}=await import('../server/store.ts');
  const media=new MediaStore(scoped),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP90AAAAASUVORK5CYII=','base64');
  const m=await media.ingest(Readable.from(bytes),admin.id);
  const link=await new ProviderReferences(scoped,media).prepare({mediaId:m.id,sha256:m.sha256},{origin:'https://fixture.example',revision:'test'},AbortSignal.timeout(3000));
  const path=new URL(link).pathname,r=await fetch(origin+path);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);
  const range=await fetch(origin+path,{headers:{Range:'bytes=0-7'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(0,8));
  const token=path.split('/').at(-1)!,grant=app.store.get('provider-reference',hash(token))!;app.store.put('provider-reference',{...grant,expires:1});assert.equal((await fetch(origin+path)).status,404);
  app.store.put('provider-reference',grant);writeFileSync(media.path(m.id),Buffer.concat([bytes,Buffer.from('drift')]));assert.equal((await fetch(origin+path)).status,409);
  assert.equal((await fetch(origin+'/api/provider-reference/'+'0'.repeat(48))).status,404);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
