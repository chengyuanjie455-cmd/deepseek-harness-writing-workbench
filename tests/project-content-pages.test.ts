import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,realpathSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Readable} from 'node:stream';import {createRequire} from 'node:module';
import {Platform} from '../server/app.ts';import {hash,type Doc} from '../server/store.ts';
const password='Synthetic-catalogue-page-20261021!',png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=','base64');
async function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'catalogue-pages-'))),app=new Platform({dataDir:join(root,'data'),nativeOnly:true,mediaWorker:false,concurrency:500,videoConcurrency:500}),admin=app.newUser({username:'分页管理员',password},'admin'),users=[0,1].map(n=>app.newUser({username:'分页成员'+n,password},'member')),ws=app.workspace('shared');
 const digest=ws.projects.blob(png);for(let start=0;start<130;start+=30){const writes=Object.fromEntries(Array.from({length:Math.min(30,130-start)},(_,i)=>{const n=start+i;return ['资产/'+(n<65?'EP001-角色':'EP002-场景')+String(n).padStart(3,'0')+'.png',digest];})),c=ws.projects.candidateObjects(admin,ws.projects.current().revision,writes,{});ws.projects.approve(c,admin,c.digest);}
 return {root,app,admin,users,ws,close:async()=>{await app.close();rmSync(root,{recursive:true,force:true});}};
}
test('server catalogue pages include every authorized original once, retain facets across pages and filter before slicing',async()=>{
 const f=await fixture();try{
  const all=(await f.ws.content.catalogue(f.users[0])).items.filter(v=>v.section==='assets'),pages=[];
  for(let page=1;page<=3;page++){const result=await f.ws.content.page(f.users[0],{section:'assets',page});assert.equal(result.pagination.total,130);assert.equal(result.summary.sections.assets,130);assert.deepEqual(result.summary.episodes,['EP001','EP002']);assert(result.items.length<=48);pages.push(...result.items);}
  assert.equal(pages.length,130);assert.equal(new Set(pages.map(v=>v.entityId)).size,130);assert.deepEqual(new Set(pages.map(v=>v.entityId)),new Set(all.map(v=>v.entityId)));
  for(const item of pages){assert.equal(item.sha256,hash(png));assert.equal(hash(readFileSync(join(f.root,'data/project',item.path))),item.sha256);}
  const filtered=await f.ws.content.page(f.users[0],{section:'assets',episode:'EP002',assetType:'scene',page:999});assert.equal(filtered.pagination.page,2);assert.equal(filtered.pagination.total,65);assert.equal(filtered.items.length,17);assert(filtered.items.every(v=>v.episodes.includes('EP002')&&v.assetType==='scene'));
  const hit=await f.ws.content.page(f.users[0],{query:'场景129',section:'all',page:99});assert.equal(hit.items.length,1);assert.equal(hit.pagination.page,1);assert.equal(hit.items[0].entityId,pages.find(v=>v.name.includes('场景129'))!.entityId);
  const empty=await f.ws.content.page(f.users[0],{section:'videos',page:5});assert.equal(empty.pagination.from,0);assert.equal(empty.pagination.page,1);assert.equal(empty.pagination.total,0);
  for(const args of [{page:0},{page:1.5},{limit:101},{section:'private'},{assetType:'invalid'}])await assert.rejects(f.ws.content.page(f.users[0],args));
  await assert.rejects(f.ws.content.page(f.users[0],{revision:'old-revision'}),/版本已变化/);
 }finally{await f.close();}
});
test('paged card counts, episodes and shared projections never disclose another member private generation inputs',async()=>{
 const f=await fixture();try{
  const m=await f.ws.pickups.media.ingest(Readable.from(png),f.users[1].id,'private','内部人物.png');f.ws.store.put('media',{...m,episode:'EP099'});
  f.ws.store.put('pickup',{id:'private-plan',owner:f.users[1].id,prompt:'SECRET_PRIVATE_PROMPT',notes:'SECRET_PRIVATE_NOTES'});f.ws.store.put('video-job',{id:'private-result',owner:f.users[1].id,planId:'private-plan',mediaId:m.id,state:'ready'});
  const peer=await f.ws.content.page(f.users[0],{section:'assets'}),owner=await f.ws.content.page(f.users[1],{section:'assets'});assert.equal(peer.pagination.total,130);assert.equal(owner.pagination.total,131);assert(!peer.summary.episodes.includes('EP099'));assert(owner.summary.episodes.includes('EP099'));assert(!JSON.stringify(peer).includes('SECRET_PRIVATE'));
  f.ws.store.put('change',{id:'adoption',state:'committed'});f.ws.store.put('video-job',{...f.ws.store.get('video-job','private-result'),changeId:'adoption'});
  const published=await f.ws.content.page(f.users[0],{query:'内部人物'});assert.equal(published.items.length,1);assert.equal(published.items[0].sharedProjection,true);assert(!JSON.stringify(published).includes('SECRET_PRIVATE'));assert(!published.summary.episodes.includes('EP099'));
  const own=await f.ws.content.page(f.users[1],{query:'内部人物'});assert.equal(own.items.length,1);assert.equal(own.items[0].prompt,'SECRET_PRIVATE_PROMPT');
  f.app.store.put('user',{...f.users[0],active:false});await assert.rejects(f.ws.content.page(f.users[0]),/身份已变更/);
 }finally{await f.close();}
});
test('desktop HTTP transport reads bounded pages and a lean project summary while the full project API remains intact',async()=>{
 const f=await fixture(),{Connection,validOperation}=createRequire(import.meta.url)('../desktop/connection.cjs'),c=new Connection();try{
  const port=await f.app.start(0);await c.connect('http://127.0.0.1:'+port);assert.equal((await c.call('/api/login','POST',{username:f.admin.username,password})).status,200);
  const status=(await c.call('/api/status')).data;assert(status.capabilities.includes('project-content-pages'));
  const full=(await c.call('/api/project')).data,summary=(await c.call('/api/project?view=studio')).data;assert.equal(full.files.length,132);assert(full.filesLoaded);assert.equal(summary.files.length,0);assert.equal(summary.filesLoaded,false);assert.equal(summary.fileCount,132);assert.equal(summary.revision,full.revision);assert.deepEqual(summary.chat,full.chat);
  const result=await c.call('/api/project-content/page?section=assets&page=2&limit=48&revision='+full.revision);assert.equal(result.status,200);assert.equal(result.data.items.length,48);assert.equal(result.data.pagination.from,49);assert.equal(result.data.pagination.to,96);assert.equal(result.data.pagination.total,130);
  assert.equal((await c.call('/api/project-content/search?query=场景129')).data.items.length,1);assert((await c.call('/api/project-content')).data.items.length>=132);
  for(const path of ['/api/project-content','/api/project-content/page','/api/project-content/search']){assert(validOperation(path,'GET'));assert(!validOperation(path,'POST'));assert(!validOperation(path+'/arbitrary','GET'));}
  assert.equal(f.app.store.all('model-call').length+f.app.store.all('image-job').length+f.app.store.all('video-job').length,0);await c.call('/api/logout','POST',{});
 }finally{c.disconnect();await f.close();}
});
