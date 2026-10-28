import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Readable} from 'node:stream';
import {Platform} from '../server/app.ts';import {ProjectContent} from '../server/project-content.ts';import {documentText} from '../server/document-text.ts';import {hash,id,type Doc} from '../server/store.ts';
const password='Synthetic-content-test-20261020!';
async function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'project-content-'))),app=new Platform({dataDir:join(root,'data'),concurrency:500,videoConcurrency:500}),admin=app.newUser({username:'admin',password},'admin'),users=[0,1].map(n=>app.newUser({username:'member'+n,password},'member'));const ws=app.workspace('shared');
 const publish=(writes:Record<string,string|null>)=>{const c=ws.projects.candidate(admin,ws.projects.current().revision,writes,{});return ws.projects.approve(c,admin,c.digest);};return {root,app,admin,users,ws,publish,close:async()=>{await app.close();rmSync(root,{recursive:true,force:true});}};}

test('project full-text Chinese search returns exact original passages, survives rename/edit/restart, and rebuilds a lost derived index without merging copies',async()=>{
 const f=await fixture();let app=f.app;try{
  const body='开场。'+('普通段落，'.repeat(820))+'窗外最后一盏路灯熄灭，林一把钥匙放在桌上。';f.publish({'剧本/无关文件名.md':body,'角色/同内容甲.md':'一样的资料','角色/同内容乙.md':'一样的资料'});const before=f.ws.projects.current().revision;
  const hit=await f.ws.content.search(f.users[0],{query:'最后一盏路灯',limit:20});assert.equal(hit.items.length,1);const item=hit.items[0];assert.equal(item.path,'剧本/无关文件名.md');assert(item.match.offset>3000);const text=await documentText(f.ws.store.root,item.digest,item.path,item.match.offset,item.match.limit);assert.equal(text.content,item.match.text);assert.equal(item.sha256,hash(body));
  const copies=(await f.ws.content.catalogue(f.users[0])).items.filter(v=>v.name.startsWith('同内容'));assert.equal(new Set(copies.map(v=>v.entityId)).size,2);
  f.publish({'剧本/无关文件名.md':null,'剧本/EP001_重命名.md':body});const renamed=(await f.ws.content.search(f.users[0],{query:'最后一盏路灯'})).items[0];assert.equal(renamed.entityId,item.entityId);assert.equal(renamed.versionId,item.versionId);assert.notEqual(renamed.revision,before);
  f.publish({'剧本/EP001_重命名.md':'林一把紫色雨伞放在窗台。'});assert.equal((await f.ws.content.search(f.users[0],{query:'最后一盏路灯'})).total,0);const edited=(await f.ws.content.search(f.users[0],{query:'紫色雨伞'})).items[0];assert.equal(edited.entityId,item.entityId);assert.notEqual(edited.versionId,item.versionId);assert.equal(f.ws.projects.read('剧本/无关文件名.md',before).toString(),body);
  f.ws.store.db.exec('DELETE FROM project_content_fts');assert.equal((await f.ws.content.search(f.users[0],{query:'紫色雨伞'})).items[0].entityId,item.entityId);
  await app.close();app=new Platform({dataDir:join(f.root,'data')});const restored=await app.workspace('shared').content.search(f.users[0],{query:'紫色雨伞'});assert.equal(restored.items[0].entityId,item.entityId);assert.equal(app.store.all('model-call').length+app.store.all('video-job').length+app.store.all('image-job').length,0);
 }finally{await app.close();rmSync(f.root,{recursive:true,force:true});}
});

test('search never mixes projects or member private generation input, excludes internal QA frames and treats query operators literally',async()=>{
 const f=await fixture();try{
  f.publish({'剧本/本项目.md':'同名线索 只有本项目的雨伞','补抽索引.json':JSON.stringify({shots:[{id:'EP001-001',episode:1,scriptPath:'剧本/本项目.md',storyboardPath:'分镜/第一集.md',assets:[{path:'资产/人物A.md',role:'character'}]}]}),'资产/人物A.md':'人物名称 A','分镜/第一集.md':'画左，腰部以上近景。'});
  const folder=join(f.root,'other');mkdirSync(folder);writeFileSync(join(folder,'同名.md'),'同名线索 OTHER_PROJECT_PRIVATE');const preview=f.ws.projects.previewNew(f.admin,folder,'另一项目'),project=await f.app.createProject(f.admin,{previewId:preview.id,digest:preview.digest});
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=','base64'),m=await f.ws.pickups.media.ingest(Readable.from(image),f.users[1].id,'private','生成资产.png'),frame=await f.ws.pickups.media.ingest(Readable.from(image),f.users[0].id,'private','内部质检帧.png');
  f.ws.store.put('image-plan',{id:'private-plan',owner:f.users[1].id,project:'shared',prompt:'私有台词 SECRET_MEMBER_ONE',notes:'不对其他成员公开'});f.ws.store.put('image-job',{id:'private-job',planId:'private-plan',owner:f.users[1].id,project:'shared',mediaId:m.id,state:'ready',round:1});f.ws.store.put('media-check',{id:'qa-fixture',project:'shared',result:{frames:[{mediaId:frame.id}]}});
  const own=await f.ws.content.search(f.users[0],{query:'同名线索'});assert.equal(own.total,1);assert(!JSON.stringify(own).includes('OTHER_PROJECT_PRIVATE'));assert.equal((await f.app.workspace(project.id).content.search(f.users[0],{query:'同名线索'})).items[0].path,'同名.md');
  assert.equal((await f.ws.content.search(f.users[0],{query:'SECRET_MEMBER_ONE'})).total,0);assert.equal((await f.ws.content.search(f.users[1],{query:'SECRET_MEMBER_ONE'})).total,1);assert.equal((await f.ws.content.search(f.admin,{query:'SECRET_MEMBER_ONE'})).total,1);assert.equal((await f.ws.content.search(f.users[0],{query:'内部质检帧'})).total,0);
  assert.equal((await f.ws.content.search(f.users[0],{query:'" OR 1=1 --'})).total,0);assert.equal((await f.ws.content.search(f.users[0],{query:'雨伞'})).total,1);assert.equal((await f.ws.content.search(f.users[0],{query:'雨'})).total,1);
  f.ws.store.put('pickup',{id:'private-usage-plan',owner:f.users[1].id,project:'shared',shots:[{source:{id:'EP099-PRIVATE',episode:'第99集',scriptPath:'剧本/本项目.md'},prompt:'私有创意',assets:[{path:'资产/人物A.md',role:'prop'}]}]});
  const publicCatalogue=await f.ws.content.catalogue(f.users[0]);assert(!JSON.stringify(publicCatalogue.items.filter(v=>v.path)).includes('EP099'),'another member private usage must not change public project metadata');
  const script=publicCatalogue.items.find(v=>v.path==='剧本/本项目.md')!;assert.deepEqual(script.episodes,['EP001']);assert.equal(script.episodeEvidence,'explicit');assert.equal(script.relationships[0].sourceId,'EP001-001');assert.equal(script.relationships[0].entityId.startsWith('shot:'),true);
  f.app.store.put('user',{...f.users[0],active:false});await assert.rejects(f.ws.content.search(f.users[0],{query:'雨伞'}),/身份/);
 }finally{await f.close();}
});

test('eight concurrent searches coalesce a cold build, publication during extraction returns the new revision, and shutdown never writes after close',async()=>{
 const f=await fixture();try{
  f.publish({'剧本/并发.md':'旧版剧情。'});let entered!:()=>void,release!:()=>void,seen=0;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);const content=new ProjectContent(f.ws.store,f.ws.projects,async(...args)=>{if(args[2]==='剧本/并发.md'){seen++;if(seen===1){entered();await gate;}}return documentText(...args);});
  const searches=Array.from({length:8},()=>content.search(f.users[0],{query:'新版剧情'}));await started;f.publish({'剧本/并发.md':'新版剧情。'});release();const all=await Promise.all(searches);assert(all.every(r=>r.total===1&&r.revision===f.ws.projects.current().revision));assert.equal(seen,2,'one old extraction and one new extraction, not eight copies');await content.close();
  f.publish({'剧本/并发.md':'将会停止的正文索引。'});let begun!:()=>void,finish!:()=>void;const waiting=new Promise<void>(r=>finish=r),begin=new Promise<void>(r=>begun=r);const stopping=new ProjectContent(f.ws.store,f.ws.projects,async(...args)=>{if(args[2]==='剧本/并发.md'){begun();await waiting;}return documentText(...args);});const request=stopping.search(f.users[0],{query:'停止'}),rejected=assert.rejects(request,/关闭/);await begin;const closed=stopping.close();finish();await Promise.all([closed,rejected]);assert.equal(f.ws.projects.read('剧本/并发.md').toString(),'将会停止的正文索引。');
 }finally{await f.close();}
});

test('authenticated HTTP search finds late Office text beyond the old million-character cutoff, keeps pagination and never rewrites originals',async()=>{
 const f=await fixture();try{
  const {execFileSync}=await import('node:child_process'),{storeFile}=await import('../server/file-objects.ts'),doc=join(f.root,'剧本.docx');execFileSync('python3',['-c',`import sys,zipfile,xml.etree.ElementTree as E; text='普通剧情。'*200002+'最后的纸风筝飞出了院子'; r=E.Element('{urn:w}document'); p=E.SubElement(E.SubElement(r,'{urn:w}body'),'{urn:w}p'); E.SubElement(E.SubElement(p,'{urn:w}r'),'{urn:w}t').text=text; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); z.writestr('word/document.xml', E.tostring(r,encoding='utf-8')); z.close()`,doc]);const original=hash(readFileSync(doc)),digest=storeFile(f.ws.store.root,doc),c=f.ws.projects.candidateObjects(f.admin,f.ws.projects.current().revision,{'剧本/分集正文.docx':digest},{});f.ws.projects.approve(c,f.admin,c.digest);
  f.publish(Object.fromEntries(Array.from({length:5},(_,n)=>['资料/条目'+n+'.md','同一场景中要寻找纸风筝。'])));const base='http://127.0.0.1:'+await f.app.start(0);const auth=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:f.users[0].username,password})}),cookie=auth.headers.get('set-cookie')!.split(';')[0];
  const request=(query:string,offset=0)=>fetch(base+'/api/project-content/search?'+new URLSearchParams({project:'shared',query,limit:'2',offset:String(offset)}),{headers:{Cookie:cookie}});
  const cold=await Promise.all(Array.from({length:8},async()=>{const r=await request('最后的纸风筝');assert.equal(r.status,200);return r.json() as Promise<Doc>;}));assert(cold.every(r=>r.total===1&&r.items[0].path==='剧本/分集正文.docx'&&r.items[0].match.offset+r.items[0].match.text.indexOf('最后的纸风筝')>1000000));assert.equal(cold[0].items[0].extraction,'office_text');const snippet=cold[0].items[0].match;assert.equal((await documentText(f.ws.store.root,digest,'剧本/分集正文.docx',snippet.offset,snippet.limit)).content,snippet.text);
  const first=await(await request('同一场景')).json() as Doc,second=await(await request('同一场景',first.nextOffset)).json() as Doc;assert.equal(first.total,5);assert.equal(first.items.length,2);assert.equal(new Set([...first.items,...second.items].map(v=>v.entityId)).size,4);assert.equal(hash(readFileSync(doc)),original);assert.equal((await fetch(base+'/api/project-content/search?query=test')).status,401);assert.equal(f.app.store.all('model-call').length+f.app.store.all('video-job').length+f.app.store.all('image-job').length,0);
 }finally{await f.close();}
});

test('native project search is advertised only by compatible hosts; old hosts keep their original file tool',async()=>{
 const {teamToolDefinitions}=await import('../native-harness/team-project/index.mjs');const old=teamToolDefinitions({}).find(v=>v[2]==='project_files')!,current=teamToolDefinitions({projectContentSearch:true}).find(v=>v[2]==='project_files')!;
 assert.deepEqual((old[3].operation as Doc).enum,['list','read','attach']);assert(!old[3].revision);assert((current[3].operation as Doc).enum.includes('search'));assert(current[3].revision);
});

test('QA metadata invalidates the read index; explicit file/media aliases display once while independent same-byte copies stay distinct',async()=>{
 const f=await fixture();try{
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=','base64'),frame=await f.ws.pickups.media.ingest(Readable.from(bytes),f.users[0].id,'private','逐秒质检图.png');
  assert.equal((await f.ws.content.search(f.users[0],{query:'逐秒质检图'})).total,1);f.ws.store.put('media-check',{id:'later-qa',project:'shared',result:{frames:[{mediaId:frame.id}]}});assert.equal((await f.ws.content.search(f.users[0],{query:'逐秒质检图'})).total,0);assert.equal(hash(readFileSync(f.ws.pickups.media.path(frame.id))),frame.sha256);
  f.ws.store.put('image-plan',{id:'explicit-reference',owner:f.users[0].id,project:'shared',assets:[{mediaId:frame.id}]});assert.equal((await f.ws.content.search(f.users[0],{query:'逐秒质检图'})).total,1,'an explicit creative reference may reuse its owner\'s frame');
  const m=await f.ws.pickups.media.ingest(Readable.from(bytes),f.users[0].id,'project','人物.png'),digest=f.ws.projects.blob(bytes),c=f.ws.projects.candidateObjects(f.admin,f.ws.projects.current().revision,{'资产/人物.png':digest,'资产/同内容副本.png':digest},{});f.ws.projects.approve(c,f.admin,c.digest);f.ws.store.put('media',{...m,attachmentPath:'资产/人物.png'});const items=(await f.ws.content.catalogue(f.users[0])).items.filter(v=>v.path?.startsWith('资产/'));
  assert.equal(items.length,2);assert.equal(new Set(items.map(v=>v.entityId)).size,2);assert.equal(items.filter(v=>v.mediaId===m.id).length,1);assert.equal(f.app.store.all('image-job').length+f.app.store.all('video-job').length+f.app.store.all('model-call').length,0);
 }finally{await f.close();}
});

test('metadata-only member display changes refresh search without changing original media or content identities',async()=>{
 const f=await fixture();try{
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=','base64'),m=await f.ws.pickups.media.ingest(Readable.from(bytes),f.users[0].id,'private','角色原图.png'),before=(await f.ws.content.catalogue(f.users[0])).items.find(v=>v.mediaId===m.id)!;
  f.app.store.put('user',{...f.users[0],name:'更名后的成员'});const result=await f.ws.content.search(f.users[0],{query:'更名后的成员'});assert.equal(result.total,1);assert.equal(result.items[0].entityId,before.entityId);assert.equal(result.items[0].versionId,before.versionId);assert.equal(result.items[0].ownerName,'更名后的成员');assert.equal(hash(readFileSync(f.ws.pickups.media.path(m.id))),m.sha256);
  const oldStamp=f.ws.store.get('project-content-index','shared')!.stamp;f.app.store.put('project',{...f.app.projects.current(),name:'已改名的项目'});await f.ws.content.catalogue(f.users[0]);assert.notEqual(f.ws.store.get('project-content-index','shared')!.stamp,oldStamp);assert.equal(f.app.store.all('model-call').length,0);
 }finally{await f.close();}
});
