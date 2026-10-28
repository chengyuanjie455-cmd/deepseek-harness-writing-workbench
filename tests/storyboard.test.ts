import {readModelJSON} from './helpers/model-json.ts';
import {closeNativeFixture} from './helpers/close-native-fixture.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Platform} from '../server/app.ts';
import {hash,id,type Doc} from '../server/store.ts';
import {videoFamily} from '../server/video-storyboard.ts';
import {VideoNotSubmitted} from '../server/video-catalog.ts';
import {createServer} from 'node:http';
const models=['wan-3.0-720p','【官方稳定版】sd2.0-720p-mini'].map(remoteModel=>({id:remoteModel,remoteModel,durations:Array.from({length:27},(_,i)=>i+4),params:{audio:[true],aspect_ratio:['16:9']},defaults:{audio:true,aspect_ratio:'16:9'},maxReferences:3,referenceField:'images',referenceMode:'reference'}));
test('supplier family routing uses remote IDs and rejects misleading display aliases',()=>{
 for(const remote of ['wan-3.0-720p','官方wang3.0-480p','【超分版】wan-3.0-1080p'])assert.equal(videoFamily({remoteModel:remote}),'wan3');
 for(const remote of ['seedance-1.0-pro','sd2.0-720mini（特惠）','sd-2.5-720p不卡脸(按秒)','sd-720fast-933（稳定）'])assert.equal(videoFamily({remoteModel:remote}),'seedance');
 for(const remote of ['官方h3-720p','wan-2.6','sora-2','【官方稳定版】2.5-720p'])assert.equal(videoFamily({remoteModel:remote,name:'wan3.0',aliases:['seedance']}),undefined);
});

async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'agent-storyboard-'));const pic=join(root,'陈山.png'),video=join(root,'result.mp4');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=160x90','-frames:v','1',pic]);execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=12','-f','lavfi','-i','anullsrc=r=44100:cl=mono','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',video]);
 let creates=0,attempts=0,peak=0,active=0;const payloads:Doc[]=[];
 const app=new Platform({dataDir:join(root,'data'),simulatedVideo:true,videoConcurrency:500,mockDelay:1,videoAdapter:{async upload(){return 'https://synthetic.invalid/reference.png';},async create(_c,_k,p){attempts++;if(attempts===1)throw new VideoNotSubmitted('synthetic pre-send',true);creates++;active++;peak=Math.max(peak,active);payloads.push(p);return {id:'vid-'+creates,status:'queued'};},async query(_c,_k,id){active--;return {id,status:'completed'};},async content(){return new Response(readFileSync(video));}}});
 app.pickups.verifyAssets=async assets=>{for(const a of assets)assert.equal(hash(readFileSync(app.pickups.media.path(a.mediaId))),a.sha256);};
 const originalFrozen=app.native.frozen.bind(app.native);app.native.frozen=async(_i,fn)=>fn();
 const admin=app.newUser({username:'admin',password:'Synthetic-Story-123!'},'admin');const channel=app.pickups.catalog.saveChannel(admin,{name:'合成接口',origin:'https://synthetic.invalid',adapter:'ruiyun',apiKey:'synthetic-key',enabled:true,concurrency:500,noRetryEvidence:'local fixture'});const c:Doc={...app.store.get('video-channel',channel.id)!,adapter:'xiaopei',verified:true,reachableModels:models.map(m=>m.remoteModel).concat('h3')};app.store.put('video-channel',c);app.store.put('video-channel-version',{...c,id:c.revision});
 const rows=models.map((m,index)=>{const saved=app.pickups.catalog.saveModel(admin,{name:m.remoteModel,aliases:[],channelId:c.id,remoteModel:m.remoteModel,status:'testing',default:index===0,params:m.params,defaults:m.defaults,secondsType:'number',durations:[4,8,12,20,30],referenceField:'images',maxReferences:3,capabilityEvidence:'local fixture only',pricePerSecond:1,currency:'CNY'});app.store.put('video-model',{...saved,status:'published'});return saved;});
 app.store.put('runtime-concurrency',{id:'active',testedVideo:8,testedChannels:{[c.id]:{limit:8,revision:c.revision}}});app.store.put('video-storyboard-policy',{id:'active',enabled:true});
 const users=Array.from({length:8},(_,i)=>app.newUser({username:'member'+i,password:'Synthetic-Story-123!'},'member'));
 const imported=await Promise.all(users.map(async u=>{const {Readable}=await import('node:stream');return app.pickups.media.ingest(Readable.from(readFileSync(pic)),u.id,'private','陈山.png');}));
 const instances=users.map((u,n)=>({key:app.native.key(u,'shared'),owner:u.id,project:'shared',root:join(root,'native-'+n),work:join(root,'native-'+n,'workspace'),active:0,closed:false} as any));instances.forEach(i=>mkdirSync(i.work,{recursive:true}));
 async function settled(count:number){for(let n=0;n<300;n++){const jobs=app.store.all('video-job');if(jobs.length===count&&jobs.every(j=>j.state==='ready'))return;await delay(100);app.pickups.pump();}throw Error('jobs not ready '+JSON.stringify(app.store.all('video-job').map(j=>({state:j.state,error:j.error}))));}
 return {app,originalFrozen,root,pic,users,rows,instances,imported,payloads,settled,counts:()=>({creates,attempts,peak}),async close(){await closeNativeFixture(app);rmSync(root,{recursive:true,force:true});}};
}


const finalPrompt=(n=0)=>`风格：写实。\n主体定义：陈山\n图1 → 陈山\n镜头1 [0–4秒]：陈山位于画左，腰部以上近景，愤怒地缓慢转头，抬起手掌。\n陈山：“我不要走！第${n}次。”\n禁止出现字幕，禁止生成配乐和音效，只保留同期声。`;

test('agent-prepared prompts: 8 members × 3 chats, exact supplier input, original assets, retry and revision',{timeout:180000},async()=>{
 const f=await fixture();try{
 const requests=Array.from({length:24},(_,n)=>{const member=n%8;return {member,body:{action:'video_generate',sessionId:'session-'+n,callId:'call-'+n,sourceMessageId:'msg-'+n,sourceText:'按参考图生成陈山转头的片段',args:{script:'源剧本，不直接拼进提示词。',notes:'修改意见，不直接拼进提示词。',final_prompt:finalPrompt(n),model_id:f.rows[n%2].id,params:{seconds:4},reference_media_ids:[f.imported[member].id]}}};});
 const result=await Promise.all(requests.map(r=>f.app.native.team.tool(f.instances[r.member],f.users[r.member],r.body)));
 await Promise.all([0,1,2].map(()=>f.app.native.team.tool(f.instances[0],f.users[0],requests[0].body)));await f.settled(24);
 assert.equal(f.counts().creates,24);assert.equal(f.counts().attempts,25);assert.equal(f.counts().peak,8);
 for(let n=0;n<result.length;n++){const p=result[n]!.plan;assert.equal(p.shots[0].prompt,finalPrompt(n));assert.equal(p.skill.id,'video-storyboard');const j=f.app.pickups.get(p.id,f.users[n%8]).jobs[0];assert.equal(hash(readFileSync(f.app.pickups.media.path(j.mediaId))),j.mediaSHA256);assert.equal(f.app.store.get('video-job',j.id)!.payload.prompt,finalPrompt(n));assert.equal(p.shots[0].assets[0].mediaId,f.imported[n%8].id);}
 const revised=await f.app.native.team.tool(f.instances[0],f.users[0],{...requests[0].body,sourceMessageId:'revision',args:{notes:'改为更慢的转头',final_prompt:finalPrompt(25),model_id:f.rows[0].id,previous_plan_id:result[0]!.plan.id}});await f.settled(25);assert.equal(revised!.plan.previousPlanId,result[0]!.plan.id);assert.equal(revised!.plan.shots[0].source.id,result[0]!.plan.shots[0].source.id);assert.equal(f.app.pickups.get(revised!.plan.id,f.users[0]).jobs[0].round,2);assert.equal(revised!.plan.shots[0].assets[0].sha256,f.imported[0].sha256);
 assert.equal(f.app.store.all('model-call').length,0,'host must not start backstage planner/reviewer model calls');
 console.log(JSON.stringify({agentSkill:true,members:8,sessions:24,...f.counts(),paidCalls:0,provider:'local_fixture',exactPrompts:true,originalDownloads:true}));
 }finally{await f.close();}
});

test('existing media can be opened with native read_image; ownership and hash stay enforced',{timeout:60000},async()=>{
 const f=await fixture();try{
 const open=(n:number,mediaId:string)=>f.app.native.team.tool(f.instances[n],f.users[n],{action:'reference_open',sessionId:'assets',args:{media_ids:[mediaId]}});
 const result=await open(0,f.imported[0].id),file=result!.files[0];assert.equal(file.mediaId,f.imported[0].id);assert.equal(hash(readFileSync(join(f.instances[0].work,file.path.replace('/workspace/','')))),f.imported[0].sha256);
 await assert.rejects(open(1,f.imported[0].id),/不属于/);writeFileSync(f.app.pickups.media.path(f.imported[0].id),'changed');await assert.rejects(open(0,f.imported[0].id),/发生改变/);
 await assert.rejects(f.app.native.team.tool(f.instances[0],f.users[0],{action:'video_generate',sessionId:'missing-final',sourceMessageId:'m',sourceText:'生成',args:{script:'转头',notes:'转头',model_id:f.rows[0].id}}),/final_prompt/);
 assert.equal(f.app.store.all('video-job').length,0);
 }finally{await f.close();}
});

test('native agent calls a host-private skill, sees an actual image and submits Wan and Seedance nodes in one turn',{skip:process.env.NATIVE_STORYBOARD_TEST!=='1',timeout:120000},async()=>{
 const f=await fixture(),requests:any[]=[];let steps:any[]=[];const usageLess=process.env.NATIVE_USAGELESS_FIXTURE==='1',preset=process.env.NATIVE_STORYBOARD_PRESET??'standard';assert(['standard','cordis','ptc'].includes(preset));
 const llm=createServer(async(req,res)=>{const b=await readModelJSON(req);requests.push(b);const privateCall=b.messages.some((m:any)=>typeof m.content==='string'&&m.content.includes('<private-skill>'));if(privateCall){const input=JSON.parse(b.messages[1].content[0].text);res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify({nodes:[{prompt:input.task.priorPrompt,params:input.task.params,referenceMediaIds:input.task.referenceIds}],issues:[],needsInput:false})},finish_reason:'stop'}],...(usageLess?{}:{usage:{prompt_tokens:100,completion_tokens:30}})})+'\n\ndata: [DONE]\n\n');return;}const n=b.messages.filter((m:any)=>m.role==='tool').length,step=steps[n];
  const call=step&&preset==='ptc'?{name:'run_code',args:{description:'Run native storyboard tools through the generated SDK',code:'return await tools['+JSON.stringify(step.name)+']('+JSON.stringify(step.args)+');'}}:step;
  res.writeHead(200,{'Content-Type':'text/event-stream'});const delta=call?{role:'assistant',tool_calls:[{index:0,id:'skill-step-'+n,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}:{role:'assistant',content:'两个节点已提交，结果在当前聊天持续返回。'};
  for(const row of [{choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:step?'tool_calls':'stop'}]},...(usageLess?[]:[{choices:[],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}])])res.write('data: '+JSON.stringify({id:'fixture',...row})+'\n\n');res.end('data: [DONE]\n\n');
 });await new Promise<void>(r=>llm.listen(0,'127.0.0.1',r));
 try{
 const admin=f.app.store.all('user').find(u=>u.role==='admin')!;
 const m=f.app.catalog.saveModel(admin,{name:'Native vision fixture',provider:'deepseek-official',model:'deepseek-flash',baseURL:'https://api.deepseek.com',apiKey:'fixture-only',reasoningEffort:'high',enabled:true,roles:['admin','member']});
 // Local supplier address is allowed only for this explicitly synthetic connection.
 assert(m);const record=f.app.catalog.all().find(r=>r.id===m.id)!;Object.assign(record.connection!,{fixture:true,baseURL:'http://127.0.0.1:'+(llm.address() as any).port,metadata:{inputModalities:['text','image']}});f.app.catalog.savePolicy(admin,'shared',{modelIds:[m.id],permissions:['workspace-write'],multipleSessions:true});
 f.app.native.frozen=f.originalFrozen;f.app.native.projectSurface=true;const i=await f.app.native.get(f.users[0],'shared'),rpc=(method:string,args:any={})=>f.app.native.rpc(i,method,args,true),session=await rpc('session/create',{request:{cwd:'/workspace'}});await rpc('agentPresets/select',{agentId:session.sessionId,agentPreset:preset});await rpc('session/selectModel',{request:{sessionId:session.sessionId,provider:'deepseek-official',model:m.id,reasoningEffort:'high'}});
 steps=[{name:'skill',args:{name:'video-storyboard'}},{name:'team_reference_open',args:{media_ids:[f.imported[0].id]}},{name:'read_image',args:{file_path:'/workspace/参考原图/'+hash(f.imported[0].id)+'.png'}},...[0,1].map(n=>({name:'team_video_generate',args:{script:'陈山转头',notes:'两条不同反应',final_prompt:finalPrompt(n),model_id:f.rows[n].id,params:{seconds:4},reference_media_ids:[f.imported[0].id]}}))];
 await rpc('session/prompt',{request:{sessionId:session.sessionId,requestId:id(),mode:'queue',content:[{type:'text',text:'参考陈山的原图，分别用 Wan3.0 和 Seedance 生成两条近景反应。'}]}});
 await f.settled(2);for(let n=0;n<200&&requests.length<6;n++)await delay(100);
 const turns=requests.filter(r=>r.tools?.some((t:any)=>t.function.name===(preset==='ptc'?'run_code':'team_video_generate')));assert.equal(turns.length,6,'five native tools and a final response, without a forced first-node stop');
 const second=JSON.stringify(turns[1].messages);assert(second.includes('调用主机分镜技能'));assert(!turns.some(r=>JSON.stringify(r.messages).includes('## 分镜与污染清理')));assert.equal(requests.filter(r=>r.messages.some((m:any)=>typeof m.content==='string'&&m.content.includes('<private-skill>'))).length,2);assert.equal(f.app.store.all('private-skill-run').length,2);
 assert(turns[3].messages.some((m:any)=>Array.isArray(m.content)&&m.content.some((c:any)=>c.type==='image_url')),'native read_image must deliver image input to the active model');
 assert(turns[0].tools.some((t:any)=>t.function.name===(preset==='ptc'?'run_code':'skill')));assert(!turns[0].tools.some((t:any)=>t.function.name==='team_video_skill'));
 assert.equal(f.app.store.all('pickup').length,2);assert(f.app.store.all('pickup').every(p=>p.nativeSession===session.sessionId));
 const jobs=f.app.store.all('video-job');assert.equal(jobs.length,2);
 for(const job of jobs){const plan=f.app.pickups.get(job.planId,f.users[0]);assert.equal(plan.shots[0].assets[0].mediaId,f.imported[0].id);assert.equal(plan.shots[0].assets[0].sha256,f.imported[0].sha256);assert.equal(job.payload.prompt,plan.shots[0].prompt);assert.equal(hash(readFileSync(f.app.pickups.media.path(job.mediaId))),job.mediaSHA256);}
 assert.deepEqual(jobs.map(job=>job.payload.model).sort(),f.rows.map(row=>row.remoteModel).sort());
 const base='http://127.0.0.1:'+await f.app.start(0),login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:f.users[0].username,password:'Synthetic-Story-123!'})});assert.equal(login.status,200);const loginBody:any=await login.json(),portalCookie=login.headers.get('set-cookie')!.split(';')[0];
 const open=await fetch(base+'/api/native/open?project=shared',{method:'POST',headers:{Origin:base,Cookie:portalCookie,'X-CSRF-Token':loginBody.csrf},body:'{}'});assert.equal(open.status,200);const entry:any=await open.json(),ticket=await fetch(entry.url,{redirect:'manual'});assert.equal(ticket.status,302);const nativeCookie=ticket.headers.get('set-cookie')!.split(';')[0];
 for(const job of jobs){const original=await fetch(base+'/harness/shared/api/team/media/'+job.mediaId+'?download=1',{headers:{Cookie:nativeCookie}});assert.equal(original.status,200);assert.equal(hash(Buffer.from(await original.arrayBuffer())),job.mediaSHA256);const partial=await fetch(base+'/harness/shared/api/team/media/'+job.mediaId,{headers:{Cookie:nativeCookie,Range:'bytes=0-1023'}});assert.equal(partial.status,206);assert.equal((await partial.arrayBuffer()).byteLength,1024);}
 const query=new URLSearchParams({project:'shared',owner:f.users[0].id,session:session.sessionId,kind:'all',page:'1'}),gallery=await fetch(base+'/harness/shared/team-settings/api/gallery?'+query,{headers:{Cookie:nativeCookie}});assert.equal(gallery.status,200);const contents:any=await gallery.json();assert(jobs.every(job=>contents.items.some((item:any)=>item.mediaId===job.mediaId)),'both originals must appear in the original session gallery');
 const overlay=JSON.parse(readFileSync(join(i.root,'control/overlay.yml'),'utf8'));assert.deepEqual(overlay.find((p:any)=>p.id==='llm-pi-ai').config.providers['deepseek-official'].models.find((row:any)=>row.id===m.id).input,['text','image']);
 if(usageLess){for(let n=0;n<200&&(i.active||f.app.native.activity(i)?.agents);n++)await delay(100);const calls=f.app.store.all('model-call');assert(calls.length>=8);assert(calls.every(c=>c.state==='unconfirmed'&&c.completed));assert(calls.every(c=>c.usage===undefined&&c.estimatedUsd===undefined));assert.equal(f.app.store.all('video-job').length,2);assert(f.app.store.all('video-job').every(j=>j.state==='ready'));}
 console.log(JSON.stringify({hostPrivateSkillCalls:2,publicSkillStub:true,nativeImageInput:true,sameTurnNodes:2,preset,usageLess,unconfirmedCalls:usageLess?f.app.store.all('model-call').length:undefined,originalsReady:f.app.store.all('video-job').filter(j=>j.state==='ready').length,memberDownloadsVerified:2,memberRangeRequestsVerified:2,originalSessionGalleryVerified:true,assetAndPayloadBindingsVerified:true,paidCalls:0}));
 }finally{if(process.env.NATIVE_STORYBOARD_EVIDENCE)writeFileSync(process.env.NATIVE_STORYBOARD_EVIDENCE,JSON.stringify({preset,main:requests.filter(r=>r.tools?.length).map(r=>({tools:r.tools.map((t:any)=>t.function.name),toolResults:r.messages.filter((m:any)=>m.role==='tool').map((m:any)=>({sha256:hash(String(m.content)),isError:/^(?:Error:|ToolCallError:)/.test(String(m.content))})),hasImage:r.messages.some((m:any)=>Array.isArray(m.content)&&m.content.some((c:any)=>c.type==='image_url')),publicSkillStubSeen:JSON.stringify(r.messages).includes('调用主机分镜技能'),privateSkillBodySeen:JSON.stringify(r.messages).includes('## 分镜与污染清理')})),privateSkillCalls:requests.filter(r=>r.messages.some((m:any)=>typeof m.content==='string'&&m.content.includes('<private-skill>'))).length,jobs:f.app.store.all('video-job').map(j=>({state:j.state,createAttempts:j.createAttempts}))},null,2),{mode:0o600});await f.close();llm.closeAllConnections();await new Promise<void>(r=>llm.close(()=>r()));}
});
