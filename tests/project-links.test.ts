import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Readable} from 'node:stream';
import {Platform} from '../server/app.ts';import {ProjectLinks} from '../server/project-links.ts';import {hash,id,type Doc} from '../server/store.ts';import {nativeAttachmentKey} from '../server/native-attachments.ts';import {teamToolDefinitions} from '../native-harness/team-project/index.mjs';
const password='Synthetic-project-links-only-20261020!';
async function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'project-links-'))),app=new Platform({dataDir:root,concurrency:500,videoConcurrency:500}),admin=app.newUser({username:'admin',password},'admin'),users=[0,1].map(n=>app.newUser({username:'成员'+n,password},'member')),ws=app.workspace('shared');
 const publish=(writes:Record<string,string|null>)=>{const c=ws.projects.candidate(admin,ws.projects.current().revision,writes,{});return ws.projects.approve(c,admin,c.digest);};
 const modify=async(shot:Doc,actor=users[0],extra:Doc={})=>ws.links.update(actor,{operation:'upsert',expected_index_sha256:ws.links.read(actor).indexSHA256,shot,...extra},id());
 return {root,app,admin,users,ws,publish,modify,close:async()=>{await app.close();rmSync(root,{recursive:true,force:true});}};
}

test('shot sources and reused assets retain stable identity through unique renames, including frozen legacy links without entity IDs',async()=>{
 const f=await fixture();try{
  const original={'剧本/旧正文.md':'纸风筝从画左经过。','分镜/旧镜头.md':'腰部以上近景。','资产/旧角色.md':'人物名字：林一。'};f.publish(original);
  await f.modify({id:'EP001-001',episode:1,scriptPath:'剧本/旧正文.md',storyboardPath:'分镜/旧镜头.md',assets:[{path:'资产/旧角色.md',role:'character'}]});
  await f.modify({id:'EP002-001',episode:2,assets:[{path:'资产/旧角色.md',role:'character'}]});
  const graph=f.ws.links.read(f.users[0]);assert(graph.shots[0].scriptEntityId&&graph.shots[0].storyboardEntityId&&graph.shots[0].assets[0].entityId);
  const legacy=JSON.parse(f.ws.projects.read(graph.indexPath).toString());for(const shot of legacy.shots){delete shot.scriptEntityId;delete shot.storyboardEntityId;for(const a of shot.assets??[])delete a.entityId;}f.publish({[graph.indexPath]:JSON.stringify(legacy)});
  const before=await f.ws.content.catalogue(f.users[0]),frozen=f.ws.projects.read(graph.indexPath).toString(),indexHash=f.ws.projects.revision().manifest[graph.indexPath],revision=f.ws.projects.current().revision;
  const moves={'剧本/旧正文.md':'资料/改名正文.txt','分镜/旧镜头.md':'资料/改名镜头.txt','资产/旧角色.md':'资料/改名资产.txt'},writes:Record<string,string|null>={};for(const [a,z] of Object.entries(moves)){writes[a]=null;writes[z]=original[a as keyof typeof original];}f.publish(writes);
  const after=await f.ws.content.catalogue(f.users[0]);for(const [a,z] of Object.entries(moves)){const old=before.items.find(v=>v.path===a)!,next=after.items.find(v=>v.path===z)!;assert.equal(next.entityId,old.entityId);assert.equal(next.versionId,old.versionId);assert.deepEqual(next.episodes,old.episodes);assert.equal(next.section,old.section);assert.equal(next.assetType,old.assetType);assert.deepEqual(next.relationships,old.relationships);assert.equal(f.ws.projects.read(a,revision).toString(),original[a as keyof typeof original]);}
  assert.deepEqual(after.items.find(v=>v.path==='资料/改名资产.txt')!.episodes,['EP001','EP002']);assert.equal(f.ws.projects.read(graph.indexPath).toString(),frozen);assert.equal(f.ws.projects.revision().manifest[graph.indexPath],indexHash);assert.equal((await f.ws.content.search(f.users[0],{query:'纸风筝',episode:'EP001',section:'scripts'})).total,1);
 }finally{await f.close();}
});

test('an explicit original identity does not jump to a recreated old path or a same-byte copy, and edits remain a different pinned version',async()=>{
 const f=await fixture();try{
  const path='资产/原角色.md',moved='资料/原件改名.txt',text='人物名字：林一。';f.publish({[path]:text});await f.modify({id:'EP001-001',episode:1,assets:[{path,id:path,role:'character'}]});const graph=f.ws.links.read(f.users[0]),ref=graph.shots[0].assets[0],originalRevision=f.ws.projects.current().revision;assert(ref.entityId);
  f.publish({[path]:null,[moved]:text});await f.ws.content.catalogue(f.users[0]);f.publish({[path]:text});let items=(await f.ws.content.catalogue(f.users[0])).items,original=items.find(v=>v.path===moved)!,copy=items.find(v=>v.path===path)!;assert.equal(original.entityId,ref.entityId);assert.notEqual(copy.entityId,ref.entityId);assert.deepEqual(original.episodes,['EP001']);assert.deepEqual(copy.episodes,[]);
  f.publish({[moved]:'新版人物资料。'});const next=await f.ws.content.catalogue(f.users[0]);original=next.items.find(v=>v.path===moved)!;copy=next.items.find(v=>v.path===path)!;assert.deepEqual(original.episodes,[]);assert.deepEqual(copy.episodes,[]);assert(next.warnings.some((v:string)=>v.includes('已有版本')));assert.equal(f.ws.links.read(f.users[0]).shots[0].assets[0].sha256,ref.sha256);assert.equal(f.ws.projects.read(path,originalRevision).toString(),text);
  await f.modify({id:'EP001-001',assets:[{entityId:ref.entityId,role:'character'}]});const updated=f.ws.links.read(f.users[0]).shots[0].assets[0];assert.equal(updated.entityId,ref.entityId);assert.equal(updated.path,moved);assert.notEqual(updated.sha256,ref.sha256);assert.deepEqual((await f.ws.content.catalogue(f.users[0])).items.find(v=>v.path===moved)!.episodes,['EP001']);assert.equal(f.app.store.all('image-job').length+f.app.store.all('video-job').length+f.app.store.all('model-call').length,0);
 }finally{await f.close();}
});

test('ambiguous equal-byte moves never merge file identities or guess which old shot reference belongs to which new file',async()=>{
 const f=await fixture();try{
  const text='同样内容的两份独立角色资料。';f.publish({'旧甲.md':text,'旧乙.md':text});await f.modify({id:'EP001-001',episode:1,assets:[{path:'旧甲.md',role:'character'}]});await f.modify({id:'EP002-001',episode:2,assets:[{path:'旧乙.md',role:'character'}]});
  const old=await f.ws.content.catalogue(f.users[0]),graph=f.ws.links.read(f.users[0]),frozen=f.ws.projects.read(graph.indexPath).toString();assert.notEqual(old.items.find(v=>v.path==='旧甲.md')!.entityId,old.items.find(v=>v.path==='旧乙.md')!.entityId);
  f.publish({'旧甲.md':null,'旧乙.md':null,'新甲.md':text,'新乙.md':text});const current=await f.ws.content.catalogue(f.users[0]),files=current.items.filter(v=>['新甲.md','新乙.md'].includes(v.path));assert.equal(files.length,2);assert.notEqual(files[0].entityId,files[1].entityId);assert(files.every(v=>v.episodes.length===0));assert(current.warnings.some((v:string)=>v.includes('已有版本')));assert.equal(f.ws.projects.read(graph.indexPath).toString(),frozen);
 }finally{await f.close();}
});

test('members edit optional existing index metadata through the native publish transaction while originals and unrelated metadata remain unchanged',async()=>{
 const f=await fixture();try{
  const empty=f.ws.links.read(f.users[0]);assert.equal(empty.indexSHA256,null);assert.equal(empty.total,0);assert(!f.ws.projects.files().some(v=>v.path.endsWith('补抽索引.json')));
  f.publish({'剧本/正文.md':'林一望向画右，把钥匙放在桌上。','分镜/镜头表.md':'近景，人物腰部以上。','资产/角色资料.md':'人物名字：林一','资料/补抽索引.json':JSON.stringify({version:1,extraRoot:{retained:true},shots:[{id:'旧镜头',episode:'EP009',unknown:'preserved',assets:[]}]})});const original=f.ws.projects.current().revision,oldHashes=f.ws.projects.revision().manifest;
  const result=await f.modify({id:'EP001-001',episode:'第1集',scriptPath:'剧本/正文.md',scriptQuote:'林一望向画右',storyboardPath:'分镜/镜头表.md',storyboardQuote:'近景',assets:[{path:'资产/角色资料.md',role:'character'}]});assert.equal(result.state,'committed');const graph=f.ws.links.read(f.users[0]);assert.equal(graph.total,2);assert.equal(graph.shots[1].episode,'EP001');assert.equal(graph.shots[1].scriptSHA256,oldHashes['剧本/正文.md']);assert.equal(graph.shots[1].scriptRevision,original);assert.equal(graph.shots[0].unknown,'preserved');assert(JSON.parse(f.ws.projects.read(graph.indexPath).toString()).extraRoot.retained);
  const indexed=await f.ws.content.catalogue(f.users[0]);assert.deepEqual(indexed.items.find(v=>v.path==='资产/角色资料.md')!.episodes,['EP001']);assert(indexed.items.find(v=>v.path==='剧本/正文.md')!.relationships.some((v:Doc)=>v.sourceId==='EP001-001'));for(const path of ['剧本/正文.md','分镜/镜头表.md','资产/角色资料.md'])assert.equal(f.ws.projects.revision().manifest[path],oldHashes[path]);
  await f.modify({id:'EP001-001',name:'只改镜头名称'});const changed=f.ws.links.read(f.users[0],{shot_id:'EP001-001'}).shots[0];assert.equal(changed.assets.length,1);assert.equal(changed.scriptQuote,'林一望向画右');assert.equal(changed.name,'只改镜头名称');
  const prior=f.ws.links.read(f.users[0]);await f.ws.links.update(f.users[0],{operation:'remove',shot_id:'EP001-001',expected_index_sha256:prior.indexSHA256},id());assert.equal(f.ws.links.read(f.users[0]).total,1);for(const path of ['剧本/正文.md','分镜/镜头表.md','资产/角色资料.md'])assert.equal(f.ws.projects.revision().manifest[path],oldHashes[path]);assert.equal(f.app.store.all('image-job').length+f.app.store.all('video-job').length,0);
 }finally{await f.close();}
});

test('concurrent duplicate requests return one durable change; stale writers cannot overwrite another member, and independent projects remain independent',async()=>{
 const f=await fixture();try{
  f.publish({'剧本/第一集.md':'纸风筝飞过院子。'});const args={operation:'upsert',expected_index_sha256:null,shot:{id:'EP001-001',episode:1,scriptPath:'剧本/第一集.md'}},request=id();const results=await Promise.all(Array.from({length:8},()=>f.ws.links.update(f.users[0],args,request)));assert.equal(new Set(results.map(v=>v.changeId)).size,1);assert.equal(f.ws.store.all('change').filter(c=>c.source==='project-links').length,1);await assert.rejects(f.ws.links.update(f.users[0],{...args,shot:{...args.shot,episode:2}},request),/同一次/);
  const old=f.ws.links.read(f.users[0]);await f.modify({id:'EP001-002',episode:1},f.users[1]);await assert.rejects(f.ws.links.update(f.users[0],{operation:'upsert',expected_index_sha256:old.indexSHA256,shot:{id:'EP001-003',episode:1}},id()),/已变化/);assert.equal(f.ws.links.read(f.users[0]).total,2);
  const project=await f.app.createManagedProject(f.users[0],{name:'独立项目',requestId:id()}),other=f.app.workspace(project.id);assert.equal(other.links.read(f.users[0]).total,0);await other.links.update(f.users[0],{operation:'upsert',expected_index_sha256:null,shot:{id:'EP001-001',episode:2}},id());assert.equal(other.links.read(f.users[0]).shots[0].episode,'EP002');assert.equal(f.ws.links.read(f.users[0]).shots[0].episode,'EP001');
 }finally{await f.close();}
});

test('source and asset revisions remain pinned, several episodes reuse one original, and a newer file is not mislabeled as the old binding',async()=>{
 const f=await fixture();try{
  f.publish({'无关文件.md':'旧版：紫色雨伞。','公共资料.md':'同一份人物资料'});const old=f.ws.projects.current().revision,digest=f.ws.projects.revision().manifest['无关文件.md'];await f.modify({id:'EP001-001',episode:1,scriptPath:'无关文件.md',scriptQuote:'紫色雨伞',assets:[{path:'公共资料.md',role:'character'}]});await f.modify({id:'EP002-001',episode:2,assets:[{path:'公共资料.md',role:'character'}]});let catalog=await f.ws.content.catalogue(f.users[0]);assert.deepEqual(catalog.items.find(v=>v.path==='公共资料.md')!.episodes,['EP001','EP002']);
  f.publish({'无关文件.md':'新版：金色钥匙。'});catalog=await f.ws.content.catalogue(f.users[0]);assert.deepEqual(catalog.items.find(v=>v.path==='无关文件.md')!.episodes,[]);assert(catalog.warnings.some((v:string)=>v.includes('已有版本')));const shot=f.ws.links.read(f.users[0],{shot_id:'EP001-001'}).shots[0];assert.equal(shot.scriptSHA256,digest);assert.equal(f.ws.projects.read(shot.scriptPath,shot.scriptRevision).toString(),'旧版：紫色雨伞。');
  await f.modify({id:'EP001-001',scriptRevision:old,scriptQuote:'紫色雨伞'});await assert.rejects(f.modify({id:'EP001-001',scriptPath:'无关文件.md',scriptQuote:'紫色雨伞'}),/摘录不在/);await f.modify({id:'EP001-001',scriptPath:'无关文件.md',scriptQuote:'金色钥匙'});assert.equal((await f.ws.content.catalogue(f.users[0])).items.find(v=>v.path==='无关文件.md')!.episodeEvidence,'explicit');
 }finally{await f.close();}
});

test('own private media and native uploads can be linked without publishing or copying their bodies, and another member cannot borrow their authority',async()=>{
 const f=await fixture();try{
  const image=await f.ws.pickups.media.ingest(Readable.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=','base64')),f.users[0].id,'private','人物.png'),session='session-private-link',body=Buffer.from('本人上传的剧情，只保留在原聊天。'),digest=hash(body),key=hash(JSON.stringify([f.users[0].id,'shared'])).slice(0,24),base=join(f.root,'native-harness',key,'state'),path=join(base,'attachments/v1/files',digest.slice(0,2),digest,'原剧本.txt'),attachmentKey=nativeAttachmentKey('shared',f.users[0].id,session,'sha256:'+digest,'原剧本.txt');mkdirSync(join(base,'sessions'),{recursive:true});mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,body);
  f.app.native.history.read=async(k,s,_window,purpose)=>k!==key?{items:[],rows:[]}:(purpose==='attachments'?{items:[{session,name:'原剧本.txt',attachmentId:'sha256:'+digest,blockType:'file'}],errors:[]}:{rows:[{content:[{type:'file',attachment:{name:'原剧本.txt',attachmentId:'sha256:'+digest}}]}]});await f.ws.content.catalogue(f.users[0]);
  await f.modify({id:'EP003-001',episode:3,scriptAttachment:attachmentKey,assets:[{mediaId:image.id,role:'character'}]});const indexText=f.ws.projects.read(f.ws.links.read(f.users[0]).indexPath).toString();assert(!indexText.includes(body.toString()));assert.equal(f.ws.store.get('media',image.id)!.scope,'private');assert.equal(hash(readFileSync(path)),digest);const own=(await f.ws.content.catalogue(f.users[0])).items;assert.deepEqual(own.find(v=>v.mediaId===image.id)!.episodes,['EP003']);assert.deepEqual(own.find(v=>v.nativeAttachmentKey===attachmentKey)!.episodes,['EP003']);assert.equal((await f.ws.content.search(f.users[0],{query:'本人上传',episode:'EP003'})).total,1);assert(!(await f.ws.content.catalogue(f.users[1])).items.some(v=>v.mediaId===image.id||v.nativeAttachmentKey===attachmentKey));
  await assert.rejects(f.modify({id:'EP003-002',episode:3,assets:[{mediaId:image.id}]},f.users[1]),/无权关联/);await assert.rejects(f.modify({id:'EP003-002',episode:3,scriptAttachment:attachmentKey},f.users[1]),/无权限/);
 }finally{await f.close();}
});

test('two members can retain an unchanged private reference on the same shot while appending their own result after a conflict',async()=>{
 const f=await fixture();try{
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=','base64');
  const a=await f.ws.pickups.media.ingest(Readable.from(bytes),f.users[0].id,'private','甲原图.png'),b=await f.ws.pickups.media.ingest(Readable.from(bytes),f.users[1].id,'private','乙原图.png');
  await f.modify({id:'EP001-001',episode:1,outputs:[]});const baseline=f.ws.links.read(f.users[0]);
  const results=await Promise.allSettled([a,b].map((m,n)=>f.ws.links.update(f.users[n],{operation:'upsert',expected_index_sha256:baseline.indexSHA256,shot:{id:'EP001-001',outputs:[{mediaId:m.id}]}},id())));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const loser=results.findIndex(r=>r.status==='rejected'),winner=1-loser,media=[a,b],fresh=f.ws.links.read(f.users[loser]);
  assert.equal(fresh.shots[0].outputs[0].mediaId,media[winner].id);
  await f.ws.links.update(f.users[loser],{operation:'upsert',expected_index_sha256:fresh.indexSHA256,shot:{id:'EP001-001',outputs:[...fresh.shots[0].outputs,{mediaId:media[loser].id}]}},id());
  const final=f.ws.links.read(f.users[0]);assert.deepEqual(new Set(final.shots[0].outputs.map((m:Doc)=>m.mediaId)),new Set([a.id,b.id]));
  assert.equal(f.ws.pickups.media.canRead(media[winner],f.users[loser]),false);assert.equal(f.ws.store.get('media',media[winner].id)!.scope,'private');
  await assert.rejects(f.modify({id:'EP001-002',outputs:[fresh.shots[0].outputs[0]]},f.users[loser]),/无权关联/);
  await assert.rejects(f.modify({id:'EP001-001',outputs:[{...fresh.shots[0].outputs[0],name:'擅改他人引用'}]},f.users[loser]),/无权关联/);
  await assert.rejects(f.modify({id:'EP001-001',assets:[fresh.shots[0].outputs[0]]},f.users[loser]),/无权关联/);
  const stableRevision=f.ws.projects.current().revision,originalPath=f.ws.pickups.media.path(media[winner].id);
  writeFileSync(originalPath,Buffer.from('changed-original'));
  await assert.rejects(f.modify({id:'EP001-001',outputs:final.shots[0].outputs},f.users[loser]));
  assert.equal(f.ws.projects.current().revision,stableRevision);writeFileSync(originalPath,bytes);
  assert.equal(f.app.store.all('image-job').length+f.app.store.all('video-job').length,0);assert.equal(hash(readFileSync(f.ws.pickups.media.path(a.id))),a.sha256);assert.equal(hash(readFileSync(f.ws.pickups.media.path(b.id))),b.sha256);
 }finally{await f.close();}
});

test('invalid source paths, guessed excerpts, corrupt and duplicate existing indices are rejected without discarding unrelated originals',async()=>{
 const f=await fixture();try{
  f.publish({'剧本.md':'实际正文。','资料/补抽索引.json':'not valid json'});let before=f.ws.projects.current().revision;assert.throws(()=>f.ws.links.read(f.users[0]),/有效 JSON/);await assert.rejects(f.ws.links.update(f.users[0],{operation:'upsert',shot:{id:'A'},expected_index_sha256:null},id()),/有效 JSON/);assert.equal(f.ws.projects.current().revision,before);
  f.publish({'资料/补抽索引.json':JSON.stringify({version:1,shots:[{id:'A',untouched:1},{id:'A',untouched:2}]})});before=f.ws.projects.current().revision;await assert.rejects(f.modify({id:'A',episode:1}),/重复/);await assert.rejects(f.modify({id:'B',scriptPath:'../外部.md'}),/路径/);await assert.rejects(f.modify({id:'B',scriptPath:'剧本.md',scriptQuote:'不存在的台词'}),/摘录不在/);assert.equal(f.ws.projects.current().revision,before);assert.equal(f.ws.projects.read('剧本.md').toString(),'实际正文。');
  f.app.store.put('user',{...f.users[0],active:false});assert.throws(()=>f.ws.links.read(f.users[0]),/身份/);await assert.rejects(f.modify({id:'B',episode:2}),/身份/);
 }finally{await f.close();}
});

test('lost replies and interrupted project publication resume the same stored change rather than creating a second edit',async()=>{
 const f=await fixture();try{
  const original=f.ws.projects.publishNative.bind(f.ws.projects);let once=true;f.ws.projects.publishNative=(...args)=>{if(once){once=false;throw Error('injected before publish');}return original(...args);};const args={operation:'upsert',expected_index_sha256:null,shot:{id:'EP001-001',episode:1}},request=id();await assert.rejects(f.ws.links.update(f.users[0],args,request),/injected/);assert.equal(f.ws.store.all('change').filter(c=>c.source==='project-links').length,1);const result=await f.ws.links.update(f.users[0],args,request);assert.equal(result.state,'committed');const again=await new ProjectLinks(f.ws.store,f.ws.projects,f.ws.content,f.ws.pickups.media).update(f.users[0],args,request);assert.equal(again.changeId,result.changeId);assert.equal(again.revision,result.revision);
  const finish=f.ws.projects.finish.bind(f.ws.projects);once=true;f.ws.projects.finish=intent=>{if(once){once=false;throw Error('injected after intent');}return finish(intent);};const next={operation:'upsert',expected_index_sha256:result.indexSHA256,shot:{id:'EP001-002',episode:1}},second=id();await assert.rejects(f.ws.links.update(f.users[0],next,second),/injected/);const resumed=await f.ws.links.update(f.users[0],next,second);assert.equal(resumed.state,'committed');assert.equal(f.ws.links.read(f.users[0]).total,2);assert.equal(f.ws.store.all('change').filter(c=>c.source==='project-links').length,2);
 }finally{await f.close();}
});

test('HTTP and native chat expose the same optional editor, retain existing account protection and never introduce generation or legacy-host tools',async()=>{
 const f=await fixture();try{
  const base='http://127.0.0.1:'+await f.app.start(0),response=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:f.users[0].username,password})}),v=await response.json() as Doc,cookie=response.headers.get('set-cookie')!.split(';')[0];const args={operation:'upsert',expected_index_sha256:null,shot:{id:'EP004-001',episode:4}};const post=await fetch(base+'/api/project-links',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':v.csrf},body:JSON.stringify({...args,requestId:id()})});assert.equal(post.status,200);const receipt=await post.json() as Doc;const i:any={owner:f.users[0].id,key:'synthetic-native-owner',project:'shared'},read=await f.app.native.team.tool(i,f.users[0],{action:'project_links',sessionId:'session-links',callId:id(),args:{operation:'read'}});assert.equal(read.shots[0].id,'EP004-001');const updated=await f.app.native.team.tool(i,f.users[0],{action:'project_links',sessionId:'session-links',callId:'unique-update',args:{operation:'upsert',expected_index_sha256:receipt.indexSHA256,shot:{id:'EP004-001',name:'原生聊天修改'}}});assert.equal(updated.state,'committed');assert.equal(f.ws.links.read(f.users[0]).shots[0].name,'原生聊天修改');
  const noCsrf=await fetch(base+'/api/project-links',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({...args,requestId:id()})});assert.equal(noCsrf.status,403);await noCsrf.text();assert(!teamToolDefinitions({}).some((d:any)=>d[2]==='project_links'));assert(teamToolDefinitions({projectLinks:true}).some((d:any)=>d[2]==='project_links'));assert.equal(f.app.store.all('image-job').length+f.app.store.all('video-job').length,0);
 }finally{await f.close();}
});

test('eight members keep all edits by rereading explicit conflicts; no last writer silently discards another shot',async()=>{
 const f=await fixture();try{
  const members=[...f.users,...Array.from({length:6},(_,n)=>f.app.newUser({username:'并发编剧'+n,password},'member'))],all=await Promise.allSettled(members.map((u,n)=>f.ws.links.update(u,{operation:'upsert',expected_index_sha256:null,shot:{id:'EP001-'+n,episode:1}},id())));assert.equal(all.filter(v=>v.status==='fulfilled').length,1);assert.equal(all.filter(v=>v.status==='rejected').length,7);
  for(let n=0;n<members.length;n++)if(all[n].status==='rejected')await f.modify({id:'EP001-'+n,episode:1},members[n]);assert.equal(f.ws.links.read(f.admin).total,8);assert.equal(f.ws.store.all('change').filter(c=>c.source==='project-links'&&c.state==='committed').length,8);assert.equal(f.app.options.videoConcurrency,500);
 }finally{await f.close();}
});

test('output associations preserve immutable generation inputs, corrupted media cannot bind, and revocation during verification prevents publication',async()=>{
 const f=await fixture();try{
  const clip=await f.ws.pickups.media.ingest(Readable.from(Buffer.from('0000ftypisom000000000000000000')),f.users[0].id,'private','原视频.mp4'),plan={id:id(),owner:f.users[0].id,nativeSession:'session-output',shots:[{source:{id:'EP009-001',episode:'EP009'},prompt:'保留原始提示词',assets:[]}]},job={id:id(),owner:f.users[0].id,planId:plan.id,sourceId:'EP009-001',mediaId:clip.id,state:'ready',prompt:'保留实际提交提示词',createAttempts:1};f.ws.store.put('pickup',plan);f.ws.store.put('video-job',job);await f.modify({id:'EP003-001',episode:3,outputs:[{mediaId:clip.id}]});const output=(await f.ws.content.catalogue(f.users[0])).items.find(v=>v.mediaId===clip.id)!;assert.deepEqual(output.episodes,['EP003']);assert.equal(output.sourceId,'EP009-001');assert.deepEqual(f.ws.store.get('pickup',plan.id),plan);assert.deepEqual(f.ws.store.get('video-job',job.id),job);const revision=f.ws.projects.current().revision;
  writeFileSync(f.ws.pickups.media.path(clip.id),'corrupt fixture');await assert.rejects(f.modify({id:'EP003-002',episode:3,outputs:[{mediaId:clip.id}]}),/完整性/);assert.equal(f.ws.projects.current().revision,revision);writeFileSync(f.ws.pickups.media.path(clip.id),'0000ftypisom000000000000000000');
  let entered!:()=>void,release!:()=>void;const began=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),verify=f.ws.pickups.media.verify.bind(f.ws.pickups.media);f.ws.pickups.media.verify=async(...args)=>{entered();await gate;return verify(...args);};const pending=f.modify({id:'EP003-002',episode:3,outputs:[{mediaId:clip.id}]}),rejected=assert.rejects(pending,/身份/);await began;f.app.store.put('user',{...f.users[0],active:false});release();await rejected;assert.equal(f.ws.projects.current().revision,revision);
 }finally{await f.close();}
});
