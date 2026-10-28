import {readModelJSON} from './model-json.ts';
import {closeNativeFixture} from './close-native-fixture.ts';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {Platform} from '../../server/app.ts';
import {id,hash,type Doc} from '../../server/store.ts';
import {Session,SessionId} from '@deepseek-ai/dsh-session';
import {createUserMessage,createSystemMessage} from '@deepseek-ai/dsh-llm';
import {VideoNotSubmitted} from '../../server/video-catalog.ts';
export const password='Synthetic-native-team-123!';
export async function until(fn:()=>boolean,seconds=45){const end=Date.now()+seconds*1000;while(Date.now()<end){if(fn())return;await delay(100);}throw Error('Timed out waiting for native project workflow');}

export async function fixture(native=false,options:{root?:string;keepData?:boolean;maxTextRequests?:number;afterTextFrame?:(body:Doc)=>Promise<void>}={}){
 const root=options.root??mkdtempSync(join(tmpdir(),'native-team-'));
 if(options.root)mkdirSync(root,{mode:0o700});
 const video=join(root,'fixture.mp4'),pic=join(root,'fixture.png');
 execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=12','-t','4','-c:v','libx264','-pix_fmt','yuv420p',video]);
 execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=red:s=160x90','-frames:v','1',pic]);
 let creates=0,attempts=0,retried=false,peak=0,active=0,holdFirstRound=false;const payloads:Doc[]=[],prompts=new Map<string,Doc>(),textRequests:Doc[]=[];
 const llm=createServer(async(req,res)=>{const b=await readModelJSON(req);textRequests.push(b);if(options.maxTextRequests&&textRequests.length>options.maxTextRequests)textRequests.splice(0,textRequests.length-options.maxTextRequests);let marker='';for(const m of b.messages)if(m.role==='user'){const hit=JSON.stringify(m.content).match(/NATIVE_TEAM_([a-z0-9-]+)/);if(hit)marker=hit[1];}
  const args=prompts.get(marker),already=b.messages.some((m:Doc)=>m.role==='tool'&&String(m.content).includes('"nativeSession"')&&String(m.content).includes(args?.notes));
  const call=args&&!already;res.writeHead(200,{'Content-Type':'text/event-stream'});
  const delta=call?{role:'assistant',tool_calls:[{index:0,id:'team-'+marker,type:'function',function:{name:'team_video_generate',arguments:JSON.stringify(args)}}]}:{role:'assistant',content:'生成已进入主机队列，原片会自动返回当前聊天。'};
  const frames=[{choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}]},{choices:[],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}];
  // Hold only after the content frame has been written. The receiver also
  // verifies a real assistant chunk before dropping its connection.
  for(const [index,row] of frames.entries()){res.write('data: '+JSON.stringify({id:'fixture',...row})+'\n\n');if(index===0&&options.afterTextFrame)await options.afterTextFrame(b);}res.end('data: [DONE]\n\n');
 });await new Promise<void>(r=>llm.listen(0,'127.0.0.1',r));
 const modelOrigin='http://127.0.0.1:'+(llm.address() as any).port;
 let ownedApp:Platform|undefined,platformOrigin:string|undefined;
 async function closeServices(app?:Platform){
  const errors:unknown[]=[];
  try{if(app)await closeNativeFixture(app);}catch(error){errors.push(error);}
  finally{llm.closeAllConnections();if(llm.listening)await new Promise<void>(resolve=>llm.close(()=>resolve()));}
  if(errors.length)throw new AggregateError(errors,'Native fixture cleanup failed');
 }
 try{
 const app=new Platform({dataDir:join(root,'data'),simulatedVideo:true,concurrency:500,videoConcurrency:500,mockDelay:1,staticDir:join(process.cwd(),'dist'),...(native?{nativeProjectSurface:true,model:{provider:'deepseek-official' as const,model:'deepseek-flash',apiKey:'fixture-secret-native-only',baseURL:'http://127.0.0.1:'+(llm.address() as any).port,configId:'fixture',reasoningEffort:'high' as const,fixture:true}}:{}),videoAdapter:{
  async create(_c,_key,p){attempts++;if(p.prompt.includes('意见-0')&&!retried){retried=true;throw new VideoNotSubmitted('模拟发送前连接失败',true);}creates++;payloads.push(p);active++;peak=Math.max(peak,active);return {id:'fixture-'+creates,status:'queued'};},
  // Retain all first-round jobs until all eight agents have reached the host.
  // Fast synthetic completion otherwise makes peak depend on CPU scheduling,
  // rather than proving that peers can proceed while the first safely retries.
  async query(_c,_key,id){if(holdFirstRound&&creates<8)return {id,status:'running'};active=Math.max(0,active-1);return {id,status:'completed'};},async content(){return new Response(readFileSync(video));},async upload(){return 'https://synthetic.invalid/original.png';}
 }});
 ownedApp=app;
 // No network in fixture reference upload; compare the source bytes on import and
 // frozen hash below. Real provider delivery was validated separately.
 app.pickups.verifyAssets=async()=>{};
 const port=await app.start(0),base='http://127.0.0.1:'+port;platformOrigin=base;
 const admin=app.newUser({username:'admin',password},'admin');
 const channel=app.pickups.catalog.saveChannel(admin,{name:'合成并发接口',origin:'https://synthetic.invalid',adapter:'ruiyun',apiKey:'fixture-secret-only',enabled:true,concurrency:500,noRetryEvidence:'offline fixture, never a provider request'});
 const c:Doc={...app.store.get('video-channel',channel.id)!,verified:true,reachableModels:['fixture-a','fixture-b','fixture-c','fixture-d'],adapter:'xiaopei'};app.store.put('video-channel',c);app.store.put('video-channel-version',{...c,id:c.revision,channelId:c.id});
  // Explicit isolated test capacity; never evidence for a real provider.
  app.store.put('runtime-concurrency',{...app.store.get('runtime-concurrency','active'),id:'active',testedVideo:8,testedChannels:{[c.id]:{limit:8,revision:c.revision}}});
 const models=['a','b','c','d'].map((letter,index)=>{const m=app.pickups.catalog.saveModel(admin,{name:'合成模型-'+letter,aliases:[],channelId:c.id,remoteModel:'fixture-'+letter,status:'testing',default:index===0,params:{resolution:['90p'],aspect_ratio:['16:9'],audio:[false]},defaults:{resolution:'90p',aspect_ratio:'16:9',audio:false},secondsType:'number',durations:[4],referenceField:'images',maxReferences:1,capabilityEvidence:'synthetic schema, no live capability claim',pricePerSecond:1,currency:'CNY'});app.store.put('video-model',{...m,status:'published'});return m;});
 const users=Array.from({length:8},(_,i)=>app.newUser({username:'member'+i,password},'member'));
 const history=Session.create(SessionId('legacy-history-member0'));history.append('turn/start',{turn:1});history.append('step/start',{turn:1,step:1});history.append('system/message',{turn:1,step:1,message:createSystemMessage('Synthetic historical system head')},{surfaceOp:'append'});history.append('user/message',createUserMessage({content:[{type:'text',text:'持续上下文约定：主角叫陈山，穿深蓝旧夹克。'}],source:{kind:'user'}}),{surfaceOp:'append'});history.append('step/end',{turn:1,step:1});history.append('turn/end',{turn:1,reason:{kind:'completed'}});
 app.store.put('session',{id:history.id,owner:users[0].id,title:'成员原有长期聊天',created:new Date().toISOString()});app.store.put('harness',{id:history.id,header:history.header,events:history.snapshotEvents()},users[0].id);
 const instances:any[]=[],clients:any[]=[];
 async function newClient(index:number){const u=users[index],r=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:u.username,password})});assert.equal(r.status,200);const auth=await r.json() as any,cookie=r.headers.get('set-cookie')!.split(';')[0];const open=await fetch(base+'/api/native/open',{method:'POST',headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':auth.csrf},body:'{}'});assert.equal(open.status,200);const link=await open.json() as any,ticket=await fetch(link.url,{redirect:'manual'});assert.equal(ticket.status,302);const nativeCookie=ticket.headers.get('set-cookie')!.split(';')[0];
  const client:any=async(path:string,method='GET',body?:Doc,status=200,raw=false)=>{const response=await fetch(base+'/harness/shared'+path,{method,headers:{Origin:base,Cookie:nativeCookie,'X-CSRF-Token':auth.csrf,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=raw?Buffer.from(await response.arrayBuffer()):await response.json();assert.equal(response.status,status,raw?'media request':JSON.stringify(value));assert(!JSON.stringify(value).includes('pricePerSecond'));return value;};
  client.cookie=nativeCookie;client.logout=async()=>{const response=await fetch(base+'/api/logout',{method:'POST',headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':auth.csrf}});assert.equal(response.status,200);await response.arrayBuffer();};return client;}
 async function login(index:number){clients[index]=await newClient(index);}
 if(!native){app.native.get=async(user:Doc)=>instances.find(i=>i.owner===user.id);for(let index=0;index<8;index++){const i={key:app.native.key(users[index],'shared'),owner:users[index].id,project:'shared',root:join(root,'native-'+index),work:join(root,'native-'+index,'workspace'),active:0,closed:false};mkdirSync(i.work,{recursive:true});instances.push(i);await login(index);}}
 async function close(){await closeServices(app);if(!options.keepData&&!process.env.NATIVE_TEAM_KEEP)rmSync(root,{recursive:true,force:true});}
 return {app,root,base,modelOrigin,users,models,instances,clients,newClient,login,close,prompts,textRequests,payloads,pic,holdFirstRound:()=>{holdFirstRound=true;},creates:()=>creates,attempts:()=>attempts,peak:()=>peak};
 }catch(error){
  let cleanupError:unknown;
  try{await closeServices(ownedApp);}catch(cause){cleanupError=cause;}
  writeFileSync(join(root,'setup-failure.json'),JSON.stringify({
   modelOrigin,platformOrigin,modelServerClosed:!llm.listening,platformCleanupCompleted:!cleanupError,
   writerLockReleased:ownedApp?!existsSync(ownedApp.store.lock):null,errorType:error instanceof Error?error.name:typeof error,
   paidCalls:0
  },null,2),{mode:0o600});
  if(cleanupError)throw new AggregateError([error,cleanupError],'Native fixture setup and cleanup failed');
  throw error;
 }
}
export async function exercise(f:Awaited<ReturnType<typeof fixture>>,native:boolean){
 f.holdFirstRound();
 const plans:any[]=[],sessions:string[]=[],args:any[]=[];
 for(let n=0;n<8;n++){
  const i=f.instances[n],sessionId=native?(n===0?'session-team-legacy-history-member0':(await f.app.native.rpc(i,'session/create',{cwd:'/workspace'})).sessionId):'native-session-'+n;sessions.push(sessionId);
  const refs=[];if(n%2===0){writeFileSync(join(i.work,'修正原图.png'),readFileSync(f.pic));const imported=await f.app.native.team.tool(i,f.users[n],{action:'reference_import',sessionId,callId:'import-'+n,args:{paths:['/workspace/修正原图.png']}});refs.push(imported!.originals[0].id);assert.equal(imported!.originals[0].sha256,hash(readFileSync(f.pic)));}
  args.push({script:`成员${n}：夜间在庭院推开房门并回望。`,notes:`意见-${n}：调整视线及人物站位，保持衣服原色。`,storyboard:`成员${n}独立的连续动作镜头。`,model_id:f.models[n%4].id,params:{seconds:4,resolution:'90p',aspect_ratio:'16:9',audio:false},reference_media_ids:refs});f.prompts.set('m'+n,args[n]);
 }
 if(native){await Promise.all(sessions.map((sessionId,n)=>f.clients[n]('/api/session/prompt','POST',{type:'client-request',rpcId:id(),method:'session/prompt',payload:{args:{request:{sessionId,requestId:id(),mode:'queue',content:[{type:'text',text:'NATIVE_TEAM_m'+n}]}}}})));await until(()=>f.app.store.all('pickup').length===8,75);for(let n=0;n<8;n++)plans.push(f.app.store.all('pickup',f.users[n].id)[0]);}
 else {const values=await Promise.all(args.map((args,n)=>f.app.native.team.tool(f.instances[n],f.users[n],{action:'video_generate',sessionId:sessions[n],sourceMessageId:'user-'+n,sourceText:'生成视频 '+n,callId:'generate-'+n,args})));plans.push(...values.map((v:any)=>v.plan));}
 assert.equal(f.app.store.all('video-job').length,8,'member generation starts without confirmation');for(let n=0;n<8;n++){assert.equal(plans[n].model.id,f.models[n%4].id);assert.equal(plans[n].shots[0].assets.length,n%2===0?1:0);assert.equal(plans[n].state,'confirmed');}
 await f.clients[1]('/api/team/video/'+plans[0].id,'GET',undefined,404);

 await until(()=>f.app.store.all('video-job').length===8&&f.app.store.all('video-job').every(j=>j.state==='ready'),70);
 assert.equal(f.creates(),8);assert.equal(f.attempts(),9);assert(f.peak()>=7,'seven peers proceed while one retries');
 for(let n=0;n<8;n++){const current=await f.clients[n]('/api/team/video/'+plans[n].id);const job=current.plan.jobs[0];const video=await f.clients[n]('/api/team/media/'+job.mediaId,'GET',undefined,200,true);assert.equal(hash(video),job.mediaSHA256);await f.clients[(n+1)%8]('/api/team/media/'+job.mediaId,'GET',undefined,404);}
 const original=f.app.pickups.get(plans[0].id,f.users[0]);assert.equal(original.jobs[0].safeRetryCount,1);
 // Idempotent confirmation and durable round 2 in the very same native session.
 await f.clients[0]('/api/team/video/'+plans[0].id+'/confirm','POST',{digest:plans[0].digest});assert.equal(f.creates(),8);
 const revision={notes:'二次修正：转头再慢一点，镜头保持近景。',model_id:f.models[1].id,params:{seconds:4},previous_plan_id:plans[0].id};
 let next:any;
 if(native){f.prompts.set('revise',revision);await f.clients[0]('/api/session/prompt','POST',{type:'client-request',rpcId:id(),method:'session/prompt',payload:{args:{request:{sessionId:sessions[0],requestId:id(),mode:'queue',content:[{type:'text',text:'NATIVE_TEAM_revise'}]}}}});await until(()=>f.app.store.all('pickup',f.users[0].id).length===2);next=f.app.store.all('pickup',f.users[0].id).find(p=>p.id!==plans[0].id);}
 else next=(await f.app.native.team.tool(f.instances[0],f.users[0],{action:'video_generate',sessionId:sessions[0],callId:'revision',sourceMessageId:'user-revise',sourceText:'按意见重新生成',args:revision}))!.plan;
 assert.equal(next.shots[0].source.id,plans[0].shots[0].source.id);assert.equal(next.shots[0].assets[0].sha256,plans[0].shots[0].assets[0].sha256);assert.equal(next.nativeSession,sessions[0]);
 await until(()=>f.app.pickups.get(next.id,f.users[0]).jobs[0]?.state==='ready');assert.equal(f.creates(),9);const revised=f.app.pickups.get(next.id,f.users[0]);assert.equal(revised.jobs[0].round,2);
 await f.clients[0]('/api/team/video/'+next.id+'/adopt','POST',{digest:next.digest,jobId:revised.jobs[0].id,humanAccepted:true});assert.equal(f.app.pickups.get(next.id,f.users[0]).jobs[0].state,'adopted');
 // The native permission menu retains both existing execution presets. The
 // legacy HTTP chat policy is separate; do not make this fixture narrow it.
 await f.clients[0]('/api/commands/execute','POST',{type:'client-request',rpcId:id(),method:'commands/execute',payload:{args:{agentId:sessions[0],line:'/permission read-only'}}},403);
 for(const mode of ['workspace-write','danger-full-access'])await f.app.native.checkRoute(f.users[0],f.instances[0],'/api/commands/execute',Buffer.from(JSON.stringify({payload:{args:{agentId:sessions[0],line:'/permission '+mode}}})));
 assert.deepEqual(f.app.native.policy('shared').permissions,['workspace-write','danger-full-access']);assert.deepEqual(f.app.catalog.options(f.users[0],'shared').permissions,['workspace-write']);
 console.log(JSON.stringify({native,automatic:true,eightMembers:8,models:4,withReferences:4,withoutReferences:4,creates:f.creates(),preSendRetries:1,revisions:1,peak:f.peak(),allOriginalsDownloaded:true,round2Adopted:true,permission:'workspace-write',supplierCalls:0,root:process.env.NATIVE_TEAM_KEEP?f.root:undefined}));
}
