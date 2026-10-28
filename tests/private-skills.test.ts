import {readModelJSON} from './helpers/model-json.ts';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync,statSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';import {execFileSync} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
import {Platform} from '../server/app.ts';import {PrivateSkills} from '../server/private-skills.ts';import {hash,id,type Doc} from '../server/store.ts';import {VideoNotSubmitted} from '../server/video-catalog.ts';import {Billing} from '../server/billing.ts';
import {privateSkillRedactor} from '../server/private-skill-content.ts';
const password='Synthetic-private-skills-20261020!';
test('actual host Skill definition versions follow independent native requests without exposing or rewriting old instructions',async()=>{
 const f=await fixture();try{const source=readFileSync(new URL('../video-skills/video-storyboard/SKILL.md',import.meta.url),'utf8'),code=join(f.root,'code'),folder=join(code,'video-skills/video-storyboard');mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'SKILL.md'),source+'\n本机验收版本A。\n');(f.app.native as any).codeRoot=code;const a:any=await f.invoke(0,{},'definition-one'),old=f.app.store.all('video-job').find(j=>j.planId===a.plan.id)!,before=JSON.stringify(old.authorizedInput);assert.equal(a.plan.skill.sha256,old.authorizedInput.skill.sha256);assert.equal(old.authorizedInput.skill.verified,true);assert.equal(old.authorizedInput.skill.sha256,hash(source+'\n本机验收版本A。\n'));writeFileSync(join(folder,'SKILL.md'),source+'\n本机验收版本B。\n');const z:any=await f.invoke(0,{previous_plan_id:a.plan.id,notes:'第二轮修改'},'definition-two'),fresh=f.app.store.all('video-job').find(j=>j.planId===z.plan.id)!;assert.equal(fresh.authorizedInput.skill.sha256,hash(source+'\n本机验收版本B。\n'));assert.notEqual(fresh.authorizedInput.skill.sha256,old.authorizedInput.skill.sha256);assert.equal(JSON.stringify(f.app.store.get('video-job',old.id)!.authorizedInput),before);await f.invoke(0,{},'definition-one');assert.equal(f.requests.length,2);assert.equal(f.app.store.all('video-job').length,2);for(const text of ['本机验收版本A','本机验收版本B','## 分镜与污染清理'])assert(!JSON.stringify([a,z]).includes(text));}finally{await f.close();}
});
async function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'private-skill-test-'))),requests:Doc[]=[];let output:(b:Doc)=>Doc=(b)=>({nodes:[{prompt:'主体：林一\n镜头 1 [0–4秒] 林一近景，腰部以上，愤怒地看向画右。\n禁止出现字幕，禁止生成配乐和音效，只保留同期声。',params:{seconds:4,resolution:'720p'},referenceMediaIds:JSON.parse(b.messages[1].content[0].text).task.referenceIds}],issues:[],needsInput:false}),status=200,creates=0,latency=5,usage:any={prompt_tokens:100,completion_tokens:50,prompt_tokens_details:{cached_tokens:20}};
 const upstream=createServer(async(req,res)=>{const b=await readModelJSON(req);requests.push(b);if(status!==200){res.writeHead(status);return res.end('synthetic rejected');}const value=output(b);await delay(latency);res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify(value)},finish_reason:'stop'}],...(usage===undefined?{}:{usage})})+'\n\ndata: [DONE]\n\n');});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 const app=new Platform({dataDir:join(root,'data'),model:{provider:'ruiyun',model:'fixture-chat',baseURL:'http://127.0.0.1:'+(upstream.address() as any).port,apiKey:'synthetic-only-private-key',configId:'fixture-private',fixture:true,reasoningEffort:'high',metadata:{id:'fixture-chat',name:'fixture',selectable:true,protocol:'chat',efforts:['off','high'],inputModalities:['text','image'],contextWindow:1000000,maxTokens:8192,supportsTools:true}},simulatedVideo:true,videoConcurrency:500,concurrency:500,videoAdapter:{async create(){creates++;return{id:'fixture-'+creates,status:'queued'};},async query(_c,_k,remote){return{id:remote,status:'queued'};},async content(){return new Response('never downloaded');},async upload(){return'https://synthetic.invalid/image.png';}}});
 const admin=app.newUser({username:'admin',password},'admin'),users=Array.from({length:8},(_,n)=>app.newUser({username:'member'+n,password},'member'));
 const saved=app.pickups.catalog.saveChannel(admin,{name:'private skill mock',origin:'https://synthetic.invalid',adapter:'ruiyun',apiKey:'synthetic-video-key',enabled:true,concurrency:500,noRetryEvidence:'test only no provider'}),channel:Doc={...app.store.get('video-channel',saved.id)!,verified:true,adapter:'xiaopei',reachableModels:['wan-3.0-720p','sd2.5-720p']};app.store.put('video-channel',channel);app.store.put('video-channel-version',{...channel,id:channel.revision,channelId:channel.id});
 const model=app.pickups.catalog.saveModel(admin,{name:'Synthetic Wan3.0',aliases:[],channelId:channel.id,remoteModel:'wan-3.0-720p',status:'testing',default:true,params:{resolution:['720p']},defaults:{resolution:'720p'},secondsType:'number',durations:[4,8,10],referenceField:'images',maxReferences:2,capabilityEvidence:'synthetic offline declaration',pricePerSecond:.01,currency:'CNY'});app.store.put('video-model',{...model,status:'published'});
 const instances=users.map(u=>{const r=join(root,'native-'+u.id),i:any={privateSkillCalls:true,key:app.native.key(u,'shared'),owner:u.id,project:'shared',root:r,work:join(r,'workspace'),active:0,closed:false};mkdirSync(i.work,{recursive:true});return i;});
 app.pickups.verifyAssets=async()=>{};
 const invoke=(n:number,args:Doc={},source='member-message')=>app.native.team.tool(instances[n],users[n],{action:'video_generate',sessionId:'session-'+n,callId:id(),sourceMessageId:source,sourceText:'生成本轮视频',chatModelId:'default',args:{model_id:model.id,script:'林一站在门边，愤怒地看向屋内。',notes:'改为人物近景。',params:{seconds:4,resolution:'720p'},...args}});
 return {root,app,admin,users,instances,model,requests,invoke,setUsage:(value:any)=>usage=value,setOutput:(f:typeof output)=>output=f,status:(s:number)=>status=s,latency:(ms:number)=>latency=ms,creates:()=>creates,close:async()=>{await app.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));rmSync(root,{recursive:true,force:true});}};
}

test('eight members automatically call the host Skill, keep full input context and return derived prompts only; duplicate submissions do not create jobs twice',async()=>{
 const f=await fixture();try{
  const results=await Promise.all(f.users.map((_,n)=>f.invoke(n,{context:'ONLY-MEMBER-'+n})));assert.equal(results.length,8);assert.equal(f.requests.length,8);assert.equal(f.app.store.all('video-job').length,8);assert.equal(f.app.store.all('private-skill-run').length,8);
  for(let n=0;n<8;n++){const r=results[n];assert.equal(r.kind,'video');assert.equal(r.plan.promptOrigin,'host-private-skill');assert.equal(r.plan.shots[0].params.seconds,4);assert(r.plan.shots[0].prompt.startsWith('主体：林一'));assert.equal(r.plan.skill.sha256,hash(readFileSync(new URL('../video-skills/video-storyboard/SKILL.md',import.meta.url))));
   const request=f.requests.find(b=>JSON.parse(b.messages[1].content[0].text).task.context==='ONLY-MEMBER-'+n)!;assert(request);for(let other=0;other<8;other++)if(other!==n)assert(!JSON.stringify(request).includes('ONLY-MEMBER-'+other));
   const text=JSON.stringify(r);assert(!text.includes('## 分镜与污染清理'));assert(!text.includes('无需创建额外表单'));assert(!text.includes('private-skill>'));assert(!text.includes('synthetic-only-private-key'));
  }
  const repeated=await Promise.all(Array.from({length:8},()=>f.invoke(0,{context:'ONLY-MEMBER-0'})));assert(repeated.every(r=>r.plan.id===results[0].plan.id));assert.equal(f.app.store.all('video-job').length,8);assert.equal(f.requests.length,8);
  const calls=f.app.store.all('model-call');assert.equal(calls.length,8);assert(calls.every(c=>c.state==='usage_recorded'&&c.nativePurpose==='private-skill'));assert(calls.every(c=>c.usage.inputTokens===80&&c.usage.cacheReadTokens===20));assert(!JSON.stringify(calls).includes('## 分镜与污染清理'));
  const root=join(f.app.store.root,'private-skills');assert.equal(statSync(root).mode&0o777,0o700);for(const name of readdirSync(root))assert.equal(statSync(join(root,name)).mode&0o777,0o600);
  assert.throws(()=>f.app.native.team.skillService().public(f.instances[1],results[0].plan.skillExecution.id),/不存在/);assert.throws(()=>f.app.native.team.skillService().public({...f.instances[0],project:'another-project'},results[0].plan.skillExecution.id),/不存在/);
  const billing=new Billing(f.app.store,f.app.catalog).list(f.admin);assert(billing.groups.some(g=>g.kind==='text'&&g.model==='fixture-chat'));
  assert.equal(f.app.options.concurrency,500);assert.equal(f.app.options.videoConcurrency,500);
 }finally{await f.close();}
});

test('private Skill output cannot return raw instructions, encoded instructions or undeclared fields; no video is created on rejection',async()=>{
 const source=readFileSync(new URL('../video-skills/video-storyboard/SKILL.md',import.meta.url),'utf8'),line=source.split('\n').find(s=>s.length>80)!;
 for(const kind of ['raw','base64','extra','foreign-asset','changed-spec']){const f=await fixture();try{
  f.setOutput(()=>({nodes:[{prompt:kind==='raw'?line:kind==='base64'?Buffer.from(line).toString('base64'):'林一近景，腰部以上，看向画右。',params:{seconds:4,resolution:kind==='changed-spec'?'1080p':'720p'},referenceMediaIds:kind==='foreign-asset'?[id()]:[]}],issues:[],needsInput:false,...(kind==='extra'?{skillSource:source}:{})}));
  await assert.rejects(f.invoke(0),/技能|内部|资产|规格/);assert.equal(f.app.store.all('video-job').length,0);assert.equal(f.app.store.all('pickup').length,0);assert.equal(f.app.store.all('private-skill-run')[0].state,'failed');assert(!JSON.stringify(f.app.store.all('private-skill-run')).includes(line));
 }finally{await f.close();}}
});

test('reference originals are verified, previewed only for understanding and never replaced; missing assets and provider failures do not create jobs',async()=>{
 const f=await fixture();try{
  const image=join(f.root,'synthetic.png');execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=1200x900','-frames:v','1',image]);const imported=await f.app.pickups.media.importOriginal(image,f.admin),original=readFileSync(f.app.pickups.media.path(imported.id));
  const result=await f.invoke(0,{reference_media_ids:[imported.id],asset_bindings:[{media_id:imported.id,name:'林一'}]});assert.equal(result.plan.shots[0].assets[0].sha256,hash(original));assert.deepEqual(readFileSync(f.app.pickups.media.path(imported.id)),original);const b=f.requests[0];assert(b.messages[1].content.some((p:Doc)=>p.type==='image_url'&&p.image_url.url.startsWith('data:image/jpeg;base64,')));
  f.setOutput(()=>({nodes:[],issues:['请补充林一的已核对角色对应。'],needsInput:true}));const missing=await f.invoke(1,{},'needs-input');assert.equal(missing.kind,'private-skill');assert.equal(missing.needsInput,true);assert.equal(f.app.store.all('video-job').length,1);
  f.status(503);await assert.rejects(f.invoke(2,{},'provider-failed'),/模型调用失败/);assert.equal(f.app.store.all('video-job').length,1);assert.equal(f.app.store.all('model-call').at(-1)!.state,'unconfirmed');assert.equal(f.app.store.all('model-call').at(-1)!.providerStatus,503);
 }finally{await f.close();}
});

test('one Skill can return multiple independent nodes; retries reuse each plan while revisions run without waiting for the original',async()=>{
 const f=await fixture();try{
  f.setOutput(()=>({nodes:[1,2].map(n=>({prompt:'主体：林一\n镜头 '+n+' [0–4秒] 林一近景，腰部以上，看向画右。',params:{seconds:4,resolution:'720p'},referenceMediaIds:[]})),issues:[],needsInput:false}));
  const batch=await f.invoke(0);assert.equal(batch.kind,'plans');assert.equal(batch.items.length,2);assert.equal(new Set(batch.items.map((r:Doc)=>r.plan.id)).size,2);assert.equal(f.app.store.all('video-job').length,2);
  const repeat=await f.invoke(0);assert.deepEqual(repeat.items.map((r:Doc)=>r.plan.id),batch.items.map((r:Doc)=>r.plan.id));assert.equal(f.requests.length,1);assert.equal(f.app.store.all('video-job').length,2);
  f.setOutput(()=>({nodes:[{prompt:'主体：林一\n镜头 1 [0–4秒] 林一近景，腰部以上，缓慢看向画右。',params:{seconds:4,resolution:'720p'},referenceMediaIds:[]}],issues:[],needsInput:false}));
  const revised=await f.invoke(0,{previous_plan_id:batch.items[0].plan.id,notes:'再慢一点。'},'revision-message');assert.equal(revised.plan.previousPlanId,batch.items[0].plan.id);assert.equal(f.app.store.all('video-job').length,3);assert.notEqual(revised.plan.id,batch.items[0].plan.id);assert(f.app.store.all('video-job').every(j=>j.state!=='cancelled'));
 }finally{await f.close();}
});

test('replaying a multi-node submission after a Skill update preserves the original batch without another model call or extra generation',async()=>{
 const f=await fixture();try{
  const source=readFileSync(new URL('../video-skills/video-storyboard/SKILL.md',import.meta.url),'utf8'),code=join(f.root,'replay-code'),folder=join(code,'video-skills/video-storyboard');mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'SKILL.md'),source+'\n批量回放定义A。\n');(f.app.native as any).codeRoot=code;
  const output=(count:number)=>({nodes:Array.from({length:count},(_,n)=>({prompt:'主体：林一\n镜头 '+n+' [0–4秒] 林一腰部以上近景，望向画右。',params:{seconds:4,resolution:'720p'},referenceMediaIds:[]})),issues:[],needsInput:false});
  f.setOutput(()=>output(2));const first=await f.invoke(0,{},'stable-batch-message');assert.equal(first.items.length,2);assert.equal(f.requests.length,1);
  writeFileSync(join(folder,'SKILL.md'),source+'\n批量回放定义B。\n');f.setOutput(()=>output(3));
  const replay=await f.invoke(0,{},'stable-batch-message');
  console.log(JSON.stringify({scenario:'multi_node_replay_after_skill_update',modelCalls:f.requests.length,videoJobs:f.app.store.all('video-job').length,returnedNodes:replay.items?.length??1}));
  assert.equal(f.requests.length,1,'a transport replay must not invoke the changed Skill');assert.equal(f.app.store.all('video-job').length,2,'a replay must not authorize extra nodes');assert.deepEqual(replay.items.map((r:Doc)=>r.plan.id),first.items.map((r:Doc)=>r.plan.id));
  const next=await f.invoke(0,{},'new-member-batch-message');assert.equal(f.requests.length,2,'a new explicit submission still uses the current Skill');assert.equal(next.items.length,3);assert.equal(f.app.store.all('video-job').length,5);assert(!next.items.some((r:Doc)=>first.items.some((old:Doc)=>old.plan.id===r.plan.id)));
 }finally{await f.close();}
});

test('concurrent batch replays share the first Skill result even when its definition changes while the model is running',async()=>{
 const f=await fixture();try{
  const source=readFileSync(new URL('../video-skills/video-storyboard/SKILL.md',import.meta.url),'utf8'),code=join(f.root,'concurrent-code'),folder=join(code,'video-skills/video-storyboard');mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'SKILL.md'),source+'\n并发定义A。\n');(f.app.native as any).codeRoot=code;f.latency(100);
  f.setOutput(()=>({nodes:[1,2].map(n=>({prompt:'林一腰部以上近景，望向画右。镜头'+n,params:{seconds:4,resolution:'720p'},referenceMediaIds:[]})),issues:[],needsInput:false}));
  const first=f.invoke(0,{},'concurrent-batch');for(let n=0;n<100&&!f.requests.length;n++)await delay(5);assert.equal(f.requests.length,1);writeFileSync(join(folder,'SKILL.md'),source+'\n并发定义B。\n');
  const [a,b]=await Promise.all([first,f.invoke(0,{},'concurrent-batch')]);assert.equal(f.requests.length,1);assert.equal(f.app.store.all('video-job').length,2);assert.deepEqual(a.items.map((r:Doc)=>r.plan.id),b.items.map((r:Doc)=>r.plan.id));
 }finally{await f.close();}
});

test('a batch interrupted after its first accepted node resumes only the remaining frozen node after a service recreation',async()=>{
 const f=await fixture(),controller=new AbortController();try{
  const source=readFileSync(new URL('../video-skills/video-storyboard/SKILL.md',import.meta.url),'utf8'),code=join(f.root,'partial-code'),folder=join(code,'video-skills/video-storyboard');mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'SKILL.md'),source+'\n部分恢复定义A。\n');(f.app.native as any).codeRoot=code;
  f.setOutput(()=>({nodes:[1,2].map(n=>({prompt:'林一腰部以上近景，望向画右。镜头'+n,params:{seconds:4,resolution:'720p'},referenceMediaIds:[]})),issues:[],needsInput:false}));
  const body={action:'video_generate',sessionId:'session-0',sourceMessageId:'partial-message',sourceText:'生成本轮视频',callId:'partial-call',chatModelId:'default',args:{model_id:f.model.id,script:'林一站在门边，愤怒地看向屋内。',notes:'改为人物近景。',params:{seconds:4,resolution:'720p'}}},team=f.app.native.team,original=team.tool.bind(team);
  team.tool=async(...args:Parameters<typeof team.tool>)=>{const result=await original(...args);if(args[4]?.private_skill_node===0)controller.abort();return result;};
  await assert.rejects(team.tool(f.instances[0],f.users[0],body,controller.signal),/abort/i);assert.equal(f.app.store.all('video-job').length,1);const accepted=f.app.store.all('pickup')[0],frozen=JSON.stringify(accepted);team.tool=original;
  writeFileSync(join(folder,'SKILL.md'),source+'\n部分恢复定义B。\n');f.setOutput(()=>{throw Error('a resumed batch must not recompile');});team.skills=new PrivateSkills(f.app.native);
  const resumed=await team.tool(f.instances[0],f.users[0],body);assert.equal(resumed.items.length,2);assert.equal(f.requests.length,1);assert.equal(f.app.store.all('video-job').length,2);assert.equal(resumed.items[0].plan.id,accepted.id);assert.equal(JSON.stringify(f.app.store.get('pickup',accepted.id)),frozen);assert(f.app.store.all('video-job').every(j=>j.state!=='cancelled'));
 }finally{await f.close();}
});

test('pre-binding multi-node plans recover their original Skill receipt after an upgrade without rewriting or expanding the batch',async()=>{
 const f=await fixture();try{
  const source=readFileSync(new URL('../video-skills/video-storyboard/SKILL.md',import.meta.url),'utf8'),code=join(f.root,'legacy-code'),folder=join(code,'video-skills/video-storyboard');mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'SKILL.md'),source+'\n旧批量定义A。\n');(f.app.native as any).codeRoot=code;
  f.setOutput(()=>({nodes:[1,2].map(n=>({prompt:'林一腰部以上近景，望向画右。镜头'+n,params:{seconds:4,resolution:'720p'},referenceMediaIds:[]})),issues:[],needsInput:false}));
  const body={action:'video_generate',sessionId:'session-0',sourceMessageId:'legacy-batch',sourceText:'生成本轮视频',callId:'legacy-call',chatModelId:'default',args:{model_id:f.model.id,script:'林一站在门边，愤怒地看向屋内。',notes:'改为人物近景。',params:{seconds:4,resolution:'720p'}}},team=f.app.native.team;
  // Seed the prior release's persisted shape through its original public
  // compiler API and node identities, rather than fabricating provider jobs.
  const compiled=await team.skillService().execute(f.instances[0],f.users[0],body);
  const original=[];for(const [n,node] of compiled.nodes.entries())original.push(await team.tool(f.instances[0],f.users[0],{...body,args:{...body.args,final_prompt:node.prompt,params:node.params,reference_media_ids:node.referenceMediaIds,reference_video_ids:node.referenceVideoIds,reference_audio_ids:node.referenceAudioIds,skill_run_id:compiled.id,skill_node:n}},undefined,{...body.args,private_skill_node:n}));
  const before=JSON.stringify(f.app.store.all('pickup'));
  writeFileSync(join(folder,'SKILL.md'),source+'\n旧批量定义B。\n');f.setOutput(()=>{throw Error('legacy replay must not recompile');});team.skills=new PrivateSkills(f.app.native);
  const replay=await f.invoke(0,{},'legacy-batch');assert.equal(f.requests.length,1);assert.equal(f.app.store.all('video-job').length,2);assert.deepEqual(replay.items.map((r:Doc)=>r.plan.id),original.map((r:Doc)=>r.plan.id));assert.equal(JSON.stringify(f.app.store.all('pickup')),before);
 }finally{await f.close();}
});

test('private Skill preserves video/audio references and describes inspection honestly without changing originals',async()=>{
 const f=await fixture();try{
  const video=join(f.root,'reference.mp4'),audio=join(f.root,'reference.wav');execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=red:s=160x90:r=12','-t','4','-c:v','libx264','-pix_fmt','yuv420p',video]);execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t','1',audio]);
  const v=await f.app.pickups.media.importOriginal(video,f.admin),a=await f.app.pickups.media.importOriginal(audio,f.admin),beforeV=hash(readFileSync(f.app.pickups.media.path(v.id))),beforeA=hash(readFileSync(f.app.pickups.media.path(a.id)));
  const result=await f.app.native.team.tool(f.instances[0],f.users[0],{action:'private_skill_execute',sessionId:'session-media',callId:'media',chatModelId:'default',args:{skill_id:'video-storyboard',model_id:f.model.id,script:'林一看向门口。',notes:'参考视频首帧的构图，保留给出的音频作为生成参考。',reference_video_ids:[v.id],reference_audio_ids:[a.id],params:{seconds:4,resolution:'720p'}}});
  assert.deepEqual(result.nodes[0].referenceVideoIds,[v.id]);assert.deepEqual(result.nodes[0].referenceAudioIds,[a.id]);const input=JSON.parse(f.requests[0].messages[1].content[0].text);assert(input.references.some((r:Doc)=>r.mediaId===v.id&&r.inspectionLimit.includes('仅首帧')));assert(input.references.some((r:Doc)=>r.mediaId===a.id&&r.inspectionLimit.includes('未声称已经听取')));assert.equal(hash(readFileSync(f.app.pickups.media.path(v.id))),beforeV);assert.equal(hash(readFileSync(f.app.pickups.media.path(a.id))),beforeA);assert.equal(f.app.store.all('video-job').length,0);
  f.app.store.put('media',{...v,scope:'private',owner:f.users[1].id});
  const request={action:'private_skill_execute',sessionId:'session-shared-reference',chatModelId:'default',args:{skill_id:'video-storyboard',model_id:f.model.id,script:'林一看向门口。',notes:'使用已采用的项目视频作为参考。',reference_video_ids:[v.id],params:{seconds:4,resolution:'720p'}}};
  await assert.rejects(f.app.native.team.tool(f.instances[0],f.users[0],{...request,callId:'unshared'}),/不属于/);assert.equal(f.requests.length,1);
  f.app.store.put('change',{id:'shared-video-change',state:'committed'});f.app.store.put('video-job',{id:'shared-video-job',owner:f.users[1].id,mediaId:v.id,changeId:'shared-video-change',state:'adopted'});
  const shared=await f.app.native.team.tool(f.instances[0],f.users[0],{...request,callId:'adopted'});assert.deepEqual(shared.nodes[0].referenceVideoIds,[v.id]);assert.equal(f.requests.length,2);assert.equal(f.creates(),0);assert.equal(hash(readFileSync(f.app.pickups.media.path(v.id))),beforeV);
 }finally{await f.close();}
});

test('cancelling a host Skill stops later video creation, records the sent model attempt and releases the shared queue',async()=>{
 const f=await fixture(),controller=new AbortController();try{
  f.latency(500);const promise=f.app.native.team.tool(f.instances[0],f.users[0],{action:'video_generate',sessionId:'session-cancel',sourceMessageId:'cancel-message',sourceText:'生成视频',chatModelId:'default',callId:'cancel',args:{model_id:f.model.id,script:'林一看向门口。',notes:'近景。',params:{seconds:4,resolution:'720p'}}},controller.signal),checked=assert.rejects(promise,/停止|未完成/);
  for(let n=0;n<100&&f.requests.length===0;n++)await delay(5);assert.equal(f.requests.length,1);controller.abort();await checked;assert.equal(f.app.store.all('video-job').length,0);assert.equal(f.app.store.all('private-skill-run')[0].state,'cancelled');assert.equal(f.app.store.all('model-call')[0].state,'unconfirmed');assert.equal(f.app.textQueue.active,0);
 }finally{await f.close();}
});

test('legacy host conversations project a redacted Skill block while preserving the original host record and ordinary chat text',async()=>{
 const f=await fixture();try{
  const {Session,SessionId}=await import('@deepseek-ai/dsh-session'),{createUserMessage}=await import('@deepseek-ai/dsh-llm');const s=Session.create(SessionId('legacy-private-skill'));s.append('user/message',createUserMessage({content:[{type:'text',text:'当前短剧目标：林一在庭院回头。'}],source:{kind:'user'}}),{surfaceOp:'append'});const source=readFileSync(new URL('../video-skills/video-storyboard/SKILL.md',import.meta.url),'utf8');s.append('user/message',createUserMessage({content:[{type:'text',text:source}],source:{kind:'user'}}),{surfaceOp:'append'});
  const raw={id:s.id,header:s.header,events:s.snapshotEvents()};f.app.store.put('session',{id:s.id,owner:f.users[0].id,project:'shared',title:'原有聊天',created:new Date().toISOString()});f.app.store.put('harness',raw,f.users[0].id);mkdirSync(join(f.instances[0].root,'control'),{recursive:true});
  f.app.native.legacySessions(f.instances[0]);const copied=readFileSync(join(f.instances[0].root,'control/legacy-sessions.json'),'utf8');assert(!copied.includes('## 分镜与污染清理'));assert(copied.includes('当前短剧目标'));assert(copied.includes('主机私有存储'));
  const visible=f.app.native.history.legacy(f.users[0].id,'shared');assert(!JSON.stringify(visible).includes('## 分镜与污染清理'));assert(JSON.stringify(visible).includes('当前短剧目标'));assert.deepEqual(f.app.store.get('harness',s.id),raw);
 }finally{await f.close();}
});

test('redacting a complete private block preserves ordinary story text in the same message and never changes input records',async()=>{
 const f=await fixture();try{
  const body=readFileSync(new URL('../video-skills/video-storyboard/SKILL.md',import.meta.url),'utf8'),input={text:'已有剧情：林一在庭院回头。\n'+body+'\n新意见：画右侧近景。',encoded:'保留首段 '+Buffer.from(body).toString('base64')+' 保留尾段'},copy=structuredClone(input);
  const output=privateSkillRedactor(f.app.native.codeRoot,f.app.store.root).redact(input);assert.equal(output.redactedStrings,2);assert(output.value.text.includes('已有剧情：林一在庭院回头。'));assert(output.value.text.includes('新意见：画右侧近景。'));assert(!output.value.text.includes('## 分镜与污染清理'));assert(output.value.encoded.startsWith('保留首段 '));assert(output.value.encoded.endsWith(' 保留尾段'));assert.deepEqual(input,copy);
 }finally{await f.close();}
});


test('private Skill accounting remains unknown for placeholder/absent usage without blocking output or repeating generation',async()=>{
 const f=await fixture();try{
  for(const [n,wire] of [{prompt_tokens:0,completion_tokens:0},undefined].entries()){
   f.setUsage(wire);const result:any=await f.invoke(n,{},'unknown-usage-'+n);assert(result.plan);const old=result.plan.id;
   const replay:any=await f.invoke(n,{},'unknown-usage-'+n);assert.equal(replay.plan.id,old);
   assert.equal(f.requests.length,n+1);const call=f.app.store.all('model-call').at(-1)!;assert.equal(call.completed,true);assert.equal(call.state,'unconfirmed');assert.equal(call.usage,undefined);assert.equal(call.estimatedUsd,undefined);
  }
  assert.equal(f.app.store.all('video-job').length,2);const group=new Billing(f.app.store,f.app.catalog).list(f.admin).groups.find(g=>g.kind==='text')!;assert.equal(group.usage.unknownCalls,2);
 }finally{await f.close();}
});
