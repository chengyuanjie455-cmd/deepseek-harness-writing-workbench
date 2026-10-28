import vm from 'node:vm';
import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {Readable} from 'node:stream';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {Platform} from '../server/app.ts';import {id,hash} from '../server/store.ts';import {createMediaGallery} from '../native-harness/team-project/media-gallery.mjs';import {adaptNativeClient,nativePageBridge,scopeNativeAsset} from '../server/native-page.ts';
const password='Synthetic-Test-Password';
test('gallery keeps project and member media scoped, pages without omissions, serves native originals and video byte ranges',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gallery-test-')),app=new Platform({dataDir:root,mockDelay:1});const admin=app.newUser({username:'admin',password},'admin'),a=app.newUser({username:'membera',password},'member'),b=app.newUser({username:'memberb',password},'member');const base='http://127.0.0.1:'+await app.start(0),img=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]),vid=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom000000000000000000')]);
 try{
  const shared=await app.pickups.media.ingest(Readable.from([img]),b.id,'project','shared.png'),privateA=await app.pickups.media.ingest(Readable.from([img]),a.id,'private','a.png'),privateB=await app.pickups.media.ingest(Readable.from([img]),b.id,'private','b.png');
  const video=await app.pickups.media.ingest(Readable.from([vid]),a.id,'private','clip.mp4');
  for(let n=0;n<105;n++)app.store.put('media',{...privateA,id:id(),name:'generated-'+n+'.png',generated:true});
  const key=hash(JSON.stringify([a.id,'shared'])).slice(0,24),digest=hash(vid),ref={attachmentId:'sha256:'+digest,name:'原片.mp4',bytes:vid.length},nativeRoot=join(root,'native-harness',key,'state');mkdirSync(join(nativeRoot,'sessions'),{recursive:true});const file=join(nativeRoot,'attachments/v1/files',digest.slice(0,2),digest,ref.name);mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,vid);
  app.native.history.read=async(k,session,_w,purpose)=>{assert.equal(k,key);if(purpose==='gallery')return {items:[{...ref,session:'session-fixture',mime:'video/mp4'}]};return {id:'session-fixture',rows:session==='session-fixture'?[{seq:1,content:[{type:'file',attachment:ref}]}]:[]};};
  async function login(username:string){const r=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username,password})});return r.headers.get('set-cookie')!.split(';')[0];}const ca=await login('membera'),cb=await login('memberb'),cad=await login('admin');
  async function get(cookie:string,path:string){const r=await fetch(base+path,{headers:{Cookie:cookie}});assert.equal(r.status,200);return await r.json() as any;}
  const list=await get(ca,'/api/gallery?kind=image'),next=await get(ca,'/api/gallery?kind=image&page=2');assert.equal(list.items.length,100);assert.equal(list.pagination.total,107);assert.equal(next.items.length,7);assert.equal(new Set([...list.items,...next.items].map(v=>v.id)).size,107);assert(!JSON.stringify(list).includes(privateB.id));assert([...list.items,...next.items].some(v=>v.id==='media:'+shared.id));assert(!JSON.stringify(list).includes(root));
  assert.equal((await fetch(base+'/api/gallery?kind=image&owner='+b.id,{headers:{Cookie:ca}})).status,403);
  const all=await get(cad,'/api/gallery?kind=image&owner='+b.id);assert(all.items.some((v:any)=>v.mediaId===privateB.id));assert(!all.items.some((v:any)=>v.mediaId===privateA.id));assert.equal(all.owners.length,3);
  const clips=await get(ca,'/api/gallery?kind=video'),native=clips.items.find((v:any)=>v.session);assert(native);assert(clips.items.some((v:any)=>v.mediaId===video.id));const response=await fetch(base+native.src,{headers:{Cookie:ca,Range:'bytes=4-11'}});assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),vid.subarray(4,12));assert.equal((await fetch(base+native.src,{headers:{Cookie:cb}})).status,403);
  assert.equal((await fetch(base+native.src.replace('session-fixture','session-foreign'),{headers:{Cookie:ca}})).status,404);
  assert.deepEqual(readFileSync(file),vid);const empty=await get(ca,'/api/gallery?kind=image&q=missing-name');assert.equal(empty.pagination.total,0);
  app.store.put('image-plan',{id:'plan-chat-one',owner:a.id,project:'shared',nativeSession:'session-fixture',assets:[{mediaId:shared.id}]});
  app.store.put('image-job',{id:'job-chat-one',owner:a.id,plan:'plan-chat-one',mediaId:privateA.id});
  app.store.put('pickup',{id:'plan-chat-video',owner:a.id,project:'shared',nativeSession:'session-fixture'});
  app.store.put('video-job',{id:'job-chat-video',owner:a.id,plan:'plan-chat-video',mediaId:video.id});
  const chat=await get(ca,'/api/gallery?kind=all&session=session-fixture');assert.equal(chat.items.length,4);assert(chat.items.some((v:any)=>v.kind==='image'));assert(chat.items.some((v:any)=>v.kind==='video'));assert.equal(chat.items.filter((v:any)=>v.mediaId===privateA.id).length,1);
  assert.equal((await get(ca,'/api/gallery?kind=all&session=session-other')).items.length,0);
  assert.equal((await fetch(base+'/api/gallery?kind=all&session=session-fixture&owner='+a.id,{headers:{Cookie:cb}})).status,403);
  assert.equal((await get(cad,'/api/gallery?kind=all&session=session-fixture&owner='+a.id)).items.length,4);
  app.store.put('user',{...a,active:false});assert.equal((await fetch(base+native.src,{headers:{Cookie:ca}})).status,401);
 }finally{await app.close();}
});
test('500-item galleries mount one video player and a bounded thumbnail strip; empty lists are explicit',()=>{
 const Gallery=createMediaGallery(React);const html=renderToStaticMarkup(React.createElement(Gallery,{items:Array.from({length:500},(_,n)=>({id:String(n),name:'video '+n,kind:'video' as const,src:'/media/'+n})),title:'视频画廊'}));assert.equal((html.match(/<video/g)??[]).length,1);assert.equal((html.match(/media-gallery-video-icon/g)??[]).length,21);assert(html.includes('1 / 500'));assert(html.includes('aria-label="更多缩略图"'));assert(!html.includes('autoplay'));assert(renderToStaticMarkup(React.createElement(Gallery,{items:[]})).includes('暂无图片或视频'));
});
test('native attachment adaptation groups images and videos while preserving file rows and native upload interfaces',()=>{
 const input='function UserStyleBubble({content}) { const compactImages = attachments.length > 1; return attachments.map((attachment, index) => attachment.type === "image" ? render({images: [attachment.image],}) : file(attachment)); }';const out=adaptNativeClient(input);assert(out.includes('attachments.filter(isGalleryMedia)'));assert(out.includes('file(attachment)'));assert(out.includes('{file:a.file}'));const bridge=nativePageBridge('scope',{project:'shared',admin:false});assert(bridge.includes('__TEAM_CREATE_GALLERY__'));assert(bridge.includes('media-gallery-expanded'));assert(!bridge.includes('__name'));const win:any={};win.parent=win;vm.runInNewContext(bridge,{document:{},window:win});assert.equal(typeof win.__TEAM_CREATE_GALLERY__(React),'function');
});
test('both native roles keep gallery functions while only project files has a dedicated sidebar entry',()=>{
 for(const admin of [false,true]){const entries:any[]=[];let plugin:any;const win:any={__TEAM_CONTEXT__:{admin,project:'shared',user:'owner'},__TEAM_CREATE_GALLERY__:createMediaGallery,__ModuleLoader__:{load(v:any){plugin=v.factory(()=>React);}}};
  vm.runInNewContext(readFileSync(new URL('../native-harness/team-project/client.js',import.meta.url),'utf8'),{window:win,location:{pathname:'/harness/shared/'},setTimeout,clearTimeout});
  plugin.apply({effect(){},slots:{inject(_name:string,fn:any){fn();},register(options:any){entries.push(options);}}});
  assert.deepEqual(entries.filter(v=>v.name==='sidebar.panellist').map(v=>v.id),['team-files']);
  for(const id of ['team-files','team-images','team-videos','team-tasks'])assert(entries.some(v=>v.name==='main'&&v.key===id),'existing internal routes remain usable');
  assert(entries.some(v=>v.name==='conversation.session.header.utilities'&&v.id==='team-chat-gallery'));assert(!entries.some(v=>v.name==='conversation.session.header'));assert(entries.some(v=>v.name==='conversation.message.images'));assert(entries.some(v=>v.key==='team_video_generate'));assert(entries.some(v=>v.key==='team_image_generate'));
 }
});

test('native proxy scopes generated originals, reference images, posters and downloads exactly once',()=>{
 for(const prefix of ['/harness/shared','/harness/project-id'])for(const kind of ['video']){
  const entries:any[]=[],links:any[]=[];let plugin:any;const react={...React,createElement:(type:any,props:any,...children:any[])=>{if(type?.name==='ChatGalleryLink')links.push(...props.items);return React.createElement(type,props,...children);}};
  const win:any={__TEAM_CONTEXT__:{admin:true,project:'shared',user:'member'},__TEAM_CREATE_GALLERY__:createMediaGallery,__ModuleLoader__:{load(v:any){plugin=v.factory(()=>react);}}};
  vm.runInNewContext(scopeNativeAsset(readFileSync(new URL('../native-harness/team-project/client.js',import.meta.url),'utf8'),prefix),{window:win,location:{pathname:prefix+'/'},setTimeout,clearTimeout});
  plugin.apply({effect(){},slots:{inject(_name:string,fn:any){fn();},register(options:any,view:any){entries.push({...options,view});}}});
  const View=entries.find(v=>v.key==='team_'+kind+'_generate').view;
  const plan={id:'plan-one',state:'ready',model:{name:'fixture'},shots:[{prompt:'画面',assets:[{mediaId:'reference'}]}],jobs:[{id:'job-one',mediaId:'original',state:'ready',technicalQA:{frames:[{mediaId:'poster'}]}}]};
  const html=renderToStaticMarkup(React.createElement(View,{block:{content:[{type:'text',text:JSON.stringify({kind,plan})}]}}));
  for(const id of ['reference','original']){assert(links.some(v=>v.src===prefix+'/api/team/media/'+id));assert(links.some(v=>v.download===prefix+'/api/team/media/'+id+'?download=1'));}
  assert(html.includes(prefix+'/api/team/'+kind+'/plan-one/bundle'));assert(!html.includes(prefix+prefix));
  assert(!html.includes('class="media-gallery'));assert(links.some(v=>v.poster===prefix+'/api/team/media/poster'));assert(html.includes('查看生成'));
 }
});

test('unified chat gallery keeps desktop media requests inside the authenticated project path',()=>{
 const context:any={window:{__ModuleLoader__:{load(){}}}};vm.runInNewContext(readFileSync(new URL('../native-harness/team-project/client.js',import.meta.url),'utf8'),context);
 for(const prefix of ['/harness/shared','/harness/project~member']){
  const [item]=context.scopeChatGalleryItems([{id:'original',src:'/api/media/original',download:'/api/media/original?download=1',poster:'/api/media/poster'}],prefix);
  assert.equal(item.src,prefix+'/team-settings/api/media/original');assert.equal(item.download,prefix+'/team-settings/api/media/original?download=1');assert.equal(item.poster,prefix+'/team-settings/api/media/poster');assert.equal(context.scopeChatGalleryItems([item],prefix)[0].src,item.src);
 }
});
