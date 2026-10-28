import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,createReadStream,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Platform} from '../server/app.ts';
import {id,hash,type Doc} from '../server/store.ts';
import {freezeGenerationInput,dispatchInputIntent} from '../server/generation-input-provenance.ts';

async function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'assembly-lineage-'))),app=new Platform({dataDir:join(root,'data'),concurrency:500,videoConcurrency:500}),password='Synthetic-Test-Password',user=app.newUser({username:'writer',password},'member'),peer=app.newUser({username:'editor',password},'member'),ws=app.workspace('shared');
 const publish=(writes:Doc)=>ws.projects.publishNative(ws.projects.candidate(user,ws.projects.current().revision,writes,{}, {source:'native-harness',nativeWorkspace:'fixture-lineage'}),user);
 const file=join(root,'original.mp4');execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=24','-t','0.5','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',file],{timeout:30000});
 const media=await ws.pickups.media.ingest(createReadStream(file),user.id,'private','原始镜头.mp4');
 const row={id:'EP001-001',entityId:'shot:'+id(),scriptPath:'剧本.md',outputs:[{mediaId:media.id,sha256:media.sha256}]};publish({'剧本.md':'原版台词','补抽索引.json':JSON.stringify({shots:[row]})});
 ws.assembly.start();
 const assemble=async(actor:Doc,ids:string[],name:string)=>{const j=ws.assembly.submit(actor,'session-'+actor.id,{name,clips:ids.map(media_id=>({media_id}))},name);for(let i=0;i<1500;i++){const current=ws.assembly.get(actor,j.id);if(current.state==='ready')return current;if(current.state==='failed')assert.fail(current.error);await delay(20);}throw Error('assembly timed out');};
 return {root,app,ws,user,peer,media,row,publish,assemble,close:async()=>{await app.close();rmSync(root,{recursive:true,force:true});}};
}

test('upstream project updates reach a three-level edit and each repeated clip path without rewriting any frozen source or output',{timeout:60000},async()=>{
 const f=await fixture();try{
  const a=await f.assemble(f.user,[f.media.id],'初剪'),b=await f.assemble(f.user,[a.mediaId],'二剪'),c=await f.assemble(f.user,[b.mediaId,a.mediaId],'合版');
  assert.equal(c.sourceStatus.state,'current','nested edit must preserve verifiable original lineage');
  const frozen=f.ws.store.all('assembly-job').map(j=>JSON.stringify(j)),hashes=[a,b,c].map(j=>hash(readFileSync(f.ws.pickups.media.path(j.mediaId))));
  f.publish({'无关文件.md':'其他内容'});assert.equal(f.ws.assembly.get(f.user,c.id).sourceStatus.state,'current');
  f.publish({'剧本.md':'修订台词'});
  const status=f.ws.assembly.get(f.user,c.id).sourceStatus;assert.equal(status.state,'changed');
  const scriptChanges=status.changes.filter((v:Doc)=>v.category==='script');assert.deepEqual(scriptChanges.map((v:Doc)=>v.clipPath),[[0,0,0],[1,0]]);
  const page=await f.ws.content.page(f.user,{section:'edits'});assert.equal(page.items.find((v:Doc)=>v.mediaId===c.mediaId)!.assemblySources.state,'changed');
  assert.deepEqual(f.ws.store.all('assembly-job').map(j=>JSON.stringify(j)),frozen);assert.deepEqual([a,b,c].map(j=>hash(readFileSync(f.ws.pickups.media.path(j.mediaId)))),hashes);
  f.publish({'剧本.md':'原版台词'});assert.equal(f.ws.assembly.get(f.user,c.id).sourceStatus.state,'current');
  assert.equal(f.ws.store.all('video-job').length+f.ws.store.all('image-job').length+f.app.store.all('model-call').length,0);assert.equal(f.app.options.concurrency,500);
 }finally{await f.close();}
});

test('assembling an adopted peer result does not copy its private lineage, prompts, session or original IDs',{timeout:60000},async()=>{
 const f=await fixture();try{
  const a=await f.assemble(f.user,[f.media.id],'PRIVATE_EDIT_NAME'),saved=f.ws.store.get('assembly-job',a.id)!;
  const change=f.publish({'补抽索引.json':JSON.stringify({shots:[{...f.row,outputs:[{mediaId:a.mediaId,sha256:a.output.sha256}]}]})});
  f.ws.store.put('pickup',{id:'PRIVATE_PLAN',owner:f.user.id,nativeSession:'PRIVATE_SESSION',prompt:'PRIVATE_PROMPT'});
  f.ws.store.put('video-job',{id:id(),owner:f.user.id,planId:'PRIVATE_PLAN',mediaId:a.mediaId,changeId:change.id,state:'adopted'});
  const b=await f.assemble(f.peer,[a.mediaId],'复用项目成果'),text=JSON.stringify(b);
  assert.equal(b.sourceStatus.state,'unknown','reused original is usable, but another owner private graph cannot be confirmed');
  for(const secret of [f.media.id,a.id,saved.nativeSession,'PRIVATE_PLAN','PRIVATE_SESSION','PRIVATE_PROMPT'])assert(!text.includes(secret),secret);
  f.publish({'剧本.md':'项目公开剧本已变化'});const second=f.ws.assembly.get(f.peer,b.id);assert.equal(second.sourceStatus.state,'changed');assert(second.sourceStatus.hasUnverifiedSources,'public changes must not turn private lineage into verified data');assert(!JSON.stringify(second).includes(f.media.id));
  assert.throws(()=>f.ws.assembly.get(f.peer,a.id),/无权限/);await f.ws.pickups.media.verify(b.mediaId,b.output.sha256);
 }finally{await f.close();}
});

test('recorded model and template changes propagate through an existing edit without copying internal text or generating again',{timeout:60000},async()=>{
 const f=await fixture();try{
  const model={id:id(),revision:'model-r1',remoteModel:'wan-3.0-720p',channelId:'synthetic'},channel={id:'synthetic',revision:'channel-r1'},template={id:id(),revision:'template-r1',version:1,body:'PRIVATE_TEMPLATE_ORIGINAL'};
  for(const [kind,value] of [['video-model',model],['video-channel',channel],['video-template',template]] as const)f.ws.store.put(kind,value);
  const shot={source:{id:f.row.id},prompt:'PRIVATE_GENERATION_PROMPT',params:{seconds:4},assets:[]},plan={id:id(),owner:f.user.id,project:'shared',nativeSession:'PRIVATE_GENERATION_SESSION',model,channelRevision:channel.revision,promptTemplate:template,shots:[shot]};
  f.ws.store.put('pickup',plan);const job:Doc={id:id(),owner:f.user.id,project:'shared',sourceId:shot.source.id,planId:plan.id,mediaId:f.media.id,mediaSHA256:f.media.sha256,state:'ready',createAttempts:1,remoteTaskId:'synthetic-existing',authorizedInput:freezeGenerationInput(f.ws.store,'video',plan,shot)};job.dispatchInputs=[dispatchInputIntent(f.ws.store,'video',job,plan,shot)];f.ws.store.put('video-job',job);
  const a=await f.assemble(f.user,[f.media.id],'有生成回执的初剪'),b=await f.assemble(f.user,[a.mediaId],'有回执的合版'),saved=JSON.stringify(f.ws.store.all('assembly-job'));
  assert.equal(b.sourceStatus.state,'current');assert(b.sourceStatus.hasRecordedGenerationInputs);
  f.ws.store.put('video-model',{...model,revision:'model-r2'});f.ws.store.put('video-template',{...template,revision:'template-r2',body:'PRIVATE_TEMPLATE_REVISED'});
  const changed=f.ws.assembly.get(f.user,b.id);for(const category of ['model','template'])assert(changed.sourceStatus.changes.some((v:Doc)=>v.category===category&&JSON.stringify(v.clipPath)==='[0,0]'));
  for(const secret of ['PRIVATE_GENERATION_PROMPT','PRIVATE_TEMPLATE_ORIGINAL','PRIVATE_TEMPLATE_REVISED','PRIVATE_GENERATION_SESSION'])assert(!JSON.stringify(changed.sourceProvenance).includes(secret));
  assert.equal(JSON.stringify(f.ws.store.all('assembly-job')),saved);assert.equal(JSON.stringify(f.ws.store.get('video-job',job.id)),JSON.stringify(job));assert.equal(f.ws.store.all('video-job').length,1);assert.equal(f.app.store.all('model-call').length,0);
 }finally{await f.close();}
});

test('missing, modified and legacy upstream lineage stays unverified without manufacturing a new source baseline',{timeout:60000},async()=>{
 const f=await fixture();try{
  const a=await f.assemble(f.user,[f.media.id],'原版初剪'),b=await f.assemble(f.user,[a.mediaId],'新版合版'),stored=f.ws.store.get('assembly-job',a.id)!,dependent=f.ws.store.get('assembly-job',b.id)!;
  f.ws.store.put('assembly-job',{...stored,sourceProvenance:{...stored.sourceProvenance,revision:'tampered'}});assert.equal(f.ws.assembly.get(f.user,b.id).sourceStatus.state,'unknown');
  f.ws.store.put('assembly-job',stored);const legacy={...dependent,sourceProvenance:{...dependent.sourceProvenance}};delete legacy.sourceProvenance.upstreamAssemblies;f.ws.store.put('assembly-job',legacy);const baseline=JSON.stringify(f.ws.store.get('assembly-job',b.id));
  assert.equal(f.ws.assembly.get(f.user,b.id).sourceStatus.state,'unknown');assert.equal(JSON.stringify(f.ws.store.get('assembly-job',b.id)),baseline);
  f.ws.store.put('assembly-job',dependent);const media=f.ws.store.get('media',a.mediaId)!;f.ws.store.put('media',{...media,sha256:hash('registry changed')});assert.equal(f.ws.assembly.get(f.user,b.id).sourceStatus.state,'unknown');f.ws.store.put('media',media);
  assert.equal(f.ws.assembly.get(f.user,b.id).sourceStatus.state,'current');assert.equal(f.ws.store.all('assembly-job').length,2);
 }finally{await f.close();}
});
