import {createServer} from 'node:http';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,readFileSync,rmSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable,Writable} from 'node:stream';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Platform} from '../server/app.ts';
import {id,hash} from '../server/store.ts';
import {serveFileBundle,bundleName,validateBundle} from '../server/media-bundle.ts';
import {createMediaGallery} from '../native-harness/team-project/media-gallery.mjs';
const password='Gallery-bundle-fixture-123!';
const img=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]),vid=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom000000000000000000')]);
function inspectZip(path:string){return JSON.parse(execFileSync('python3',['-c',"import zipfile,sys,json,hashlib;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps([{'name':i.filename,'sha':hashlib.sha256(z.read(i)).hexdigest(),'bytes':i.file_size} for i in z.infolist()]))",path],{encoding:'utf8'}));}

test('gallery ZIP downloads all 505 originals beyond paging, filters, mixed chat attachments and project files with account isolation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gallery-bundle-')),app=new Platform({dataDir:root,mockDelay:1});
 const admin=app.newUser({username:'admin',password},'admin'),a=app.newUser({username:'membera',password},'member'),b=app.newUser({username:'memberb',password},'member');
 const base='http://127.0.0.1:'+await app.start(0);
 try{
  const media=app.pickups.media,first=await media.ingest(Readable.from([img]),a.id,'private','生成图.png');
  app.store.put('media',{...first,generated:true});
  for(let i=1;i<505;i++){const mid=id();copyFileSync(media.path(first.id),media.path(mid));app.store.put('media',{...first,id:mid,generated:true});}
  const other=await media.ingest(Readable.from([img]),b.id,'private','其他成员.png'),video=await media.ingest(Readable.from([vid]),a.id,'private','生成视频.mp4');
  app.store.put('image-plan',{id:'plan-image',owner:a.id,project:'shared',nativeSession:'session-bundle'});
  app.store.put('image-job',{id:'job-image',owner:a.id,plan:'plan-image',mediaId:first.id,state:'ready'});
  app.store.put('pickup',{id:'plan-video',owner:a.id,project:'shared',nativeSession:'session-bundle'});
  app.store.put('video-job',{id:'job-video',owner:a.id,plan:'plan-video',mediaId:video.id,state:'ready'});
  const digest=app.projects.blob(img),change=app.projects.addAttachment(a,'资料/项目参考.png',digest,'bundle-project-file');assert(change.revision);
  const key=hash(JSON.stringify([a.id,'shared'])).slice(0,24),nativeRoot=join(root,'native-harness',key,'state'),file=join(nativeRoot,'attachments/v1/files',hash(vid).slice(0,2),hash(vid),'聊天视频.mp4');
  mkdirSync(join(nativeRoot,'sessions'),{recursive:true});mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,vid);
  const ref={attachmentId:'sha256:'+hash(vid),name:'聊天视频.mp4',bytes:vid.length};let warning=false,reads=0;
  app.native.history.read=async(k,session,_w,purpose)=>{assert.equal(k,key);if(purpose==='gallery')return {items:[{...ref,mime:'video/mp4',session:'session-bundle'}],errors:warning?['bad-session']:[]};reads++;return {rows:[{content:[{type:'file',attachment:ref}]}]};};
  const csrfTokens=new Map<string,string>();
  async function login(username:string){const r=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username,password})});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie')!.split(';')[0];csrfTokens.set(cookie,(await r.json()).csrf);return cookie;}
  const ca=await login('membera'),cb=await login('memberb'),cad=await login('admin');
  const get=(cookie:string,query:string,method='GET')=>fetch(base+'/api/gallery/bundle?'+query,{method,headers:{Cookie:cookie}});
  async function zip(cookie:string,query:string){const r=await get(cookie,query);assert.equal(r.status,200);assert.match(r.headers.get('content-type')!,/application\/zip/);assert.match(r.headers.get('content-disposition')!,/filename\*=UTF-8''/);const file=join(root,id()+'.zip');writeFileSync(file,Buffer.from(await r.arrayBuffer()));return inspectZip(file);}
  const head=await get(ca,'kind=image&q=生成图&page=2','HEAD');assert.equal(head.status,200);assert.equal(head.headers.get('x-gallery-count'),'505');assert.equal((await head.arrayBuffer()).byteLength,0);
  const images=await zip(ca,'kind=image&q=生成图&page=2');assert.equal(images.length,505);assert.equal(new Set(images.map((i:any)=>i.name)).size,505);assert(images.every((i:any)=>i.sha===hash(img)&&i.name.startsWith('图片/')&&i.name.endsWith('.png')));
  const chat=await zip(ca,'kind=all&session=session-bundle');assert.equal(chat.length,3);assert.equal(chat.filter((i:any)=>i.name.startsWith('视频/')).length,2);assert(chat.some((i:any)=>i.name.endsWith('聊天视频.mp4')));assert(chat.every((i:any)=>[hash(img),hash(vid)].includes(i.sha)));assert.equal(reads,1);
  assert.equal((await zip(cad,'kind=all&session=session-bundle&owner='+a.id)).length,3);
  const projectFiles=await zip(ca,'kind=image&q=项目参考');assert.equal(projectFiles.length,1);assert.equal(projectFiles[0].sha,hash(img));
  assert.equal((await get(ca,'kind=all&owner='+b.id)).status,403);
  assert.equal((await zip(cb,'kind=image&q=其他成员')).length,1);
  assert.equal((await get(ca,'kind=image&q=其他成员')).status,422);
  assert.equal((await get(ca,'kind=image&project='+id())).status,404);
  assert.equal((await fetch(base+'/api/gallery/bundle?kind=all')).status,401);
  // Native member and delegated administrator paths retain server-side project scoping.
  const token=id(),auth=app.store.db.prepare('SELECT * FROM auth WHERE token=?').get(hash(cad.split('=')[1])) as any;
  app.nativeTickets.set(token,{user:admin.id,csrf:auth.csrf,auth:auth.token,project:'shared',member:a.id,expires:Date.now()+60000});
  const native=await fetch(base+'/harness/shared~'+a.id+'/team-settings/api/gallery/bundle?kind=all&session=session-bundle&owner='+a.id,{method:'HEAD',headers:{Cookie:'team_native='+token}});
  assert.equal(native.status,200);assert.equal(native.headers.get('x-gallery-count'),'3');
  // Selections use stable catalogue IDs, survive paging, and never widen the scope.
  const catalogue=await (await fetch(base+'/api/gallery?kind=all&session=session-bundle',{headers:{Cookie:ca}})).json();
  const chosenIds=[catalogue.items.find((v:any)=>v.kind==='image').id,catalogue.items.find((v:any)=>v.kind==='video').id];
  const prepare=(cookie:string,query:string,mode:string,ids:string[])=>fetch(base+'/api/gallery/bundle?'+query,{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrfTokens.get(cookie)!},body:JSON.stringify({mode,ids})});
  const query='kind=all&session=session-bundle';
  const prepared=await prepare(ca,query,'include',chosenIds);assert.equal(prepared.status,200);const receipt=await prepared.json();assert.equal(receipt.count,2);
  const selected=await zip(ca,query+'&selection='+receipt.token);assert.equal(selected.length,2);assert.equal(selected.filter((v:any)=>v.name.startsWith('图片/')).length,1);assert.equal(selected.filter((v:any)=>v.name.startsWith('视频/')).length,1);
  assert.equal((await get(cb,query+'&selection='+receipt.token)).status,410);
  assert.equal((await get(ca,'kind=all&selection='+receipt.token)).status,410);
  assert.equal((await prepare(ca,query,'include',[])).status,422);
  assert.equal((await prepare(ca,query,'include',['media:'+other.id])).status,422);
  assert.equal((await prepare(ca,query,'invalid',chosenIds)).status,400);
  const imageQuery='kind=image&q=生成图',imageReceipt=await (await prepare(ca,imageQuery,'exclude',['media:'+first.id])).json();assert.equal(imageReceipt.count,504);
  assert.equal((await zip(ca,imageQuery+'&selection='+imageReceipt.token)).length,504);
  const allReceipt=await (await prepare(ca,imageQuery,'exclude',[])).json();assert.equal(allReceipt.count,505);
  const page2=await (await fetch(base+'/api/gallery?'+imageQuery+'&page=2',{headers:{Cookie:ca}})).json();
  const acrossPages=await (await prepare(ca,imageQuery,'include',['media:'+first.id,page2.items[0].id])).json();assert.equal((await zip(ca,imageQuery+'&selection='+acrossPages.token)).length,2);
  const nativePrepared=await fetch(base+'/harness/shared~'+a.id+'/team-settings/api/gallery/bundle?'+query+'&owner='+a.id,{method:'POST',headers:{Cookie:'team_native='+token,Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrfTokens.get(cad)!},body:JSON.stringify({mode:'include',ids:chosenIds})});assert.equal(nativePrepared.status,200);const nativeReceipt=await nativePrepared.json();assert.equal(nativeReceipt.count,2);
  const nativeSelected=await fetch(base+'/harness/shared~'+a.id+'/team-settings/api/gallery/bundle?'+query+'&owner='+a.id+'&selection='+nativeReceipt.token,{method:'HEAD',headers:{Cookie:'team_native='+token}});assert.equal(nativeSelected.headers.get('x-gallery-count'),'2');
  // Files arriving after preparation are not silently added to an all-selection download.
  const later=id();copyFileSync(media.path(first.id),media.path(later));app.store.put('media',{...first,id:later,generated:true});
  assert.equal((await get(ca,imageQuery+'&selection='+allReceipt.token,'HEAD')).headers.get('x-gallery-count'),'505');
  const realNow=Date.now;Date.now=()=>realNow()+6*60000;try{assert.equal((await get(ca,query+'&selection='+receipt.token)).status,410);}finally{Date.now=realNow;}
  // Incomplete history must not silently return a partial successful ZIP.
  warning=true;(app.native.history as any).galleryCache.clear();
  const unavailable=await get(ca,'kind=all','HEAD');assert.equal(unavailable.status,503);assert.match(decodeURIComponent(unavailable.headers.get('x-gallery-error')!),/暂未读取/);
  warning=false;(app.native.history as any).galleryCache.clear();
  // Original corruption fails the stream, even when the byte count is unchanged.
  writeFileSync(media.path(first.id),Buffer.alloc(img.length,1));
  await assert.rejects(async()=>{const r=await get(ca,'kind=all&session=session-bundle');await r.arrayBuffer();});
  app.store.put('user',{...a,active:false});assert.equal((await get(ca,'kind=image')).status,401);
  assert(app.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='gallery.download'").get()!.n as number>=5);
  assert(readFileSync(media.path(other.id)).equals(img));
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('ZIP64 accepts 4 GiB metadata without reading on HEAD and stops on cancellation and permission revocation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gallery-stream-')),path=join(root,'file'),original=Buffer.alloc(2*1024*1024,7);writeFileSync(path,original);
 const file={path,name:'视频/000001_原片.mp4',bytes:original.length,sha256:hash(original)};
 try{
  const chunks:Buffer[]=[];let count=0;const res:any=new Writable({write(c,_e,cb){chunks.push(Buffer.from(c));if(++count===5)this.destroy(Error('cancelled'));cb();}});res.writeHead=()=>{};
  await assert.rejects(serveFileBundle([file],res),/cancelled|abort|premature/i);assert(Buffer.concat(chunks).length<original.length);assert(!Buffer.concat(chunks).includes(Buffer.from([0x50,0x4b,0x05,0x06])));
  let authorized=0;const revoked:any=new Writable({write(_c,_e,cb){cb();}});revoked.writeHead=()=>{};
  await assert.rejects(serveFileBundle([file],revoked,'media.zip',{authorize(){if(++authorized===4)throw Error('login revoked');}}),/revoked/);assert(revoked.destroyed);
  // Sparse file exercises >4 GiB metadata without consuming disk space or buffering it.
  execFileSync('python3',['-c','import sys;f=open(sys.argv[1],"r+b");f.truncate(4294967297);f.close()',path]);
  let headers:any;const head:any=new Writable({write(_c,_e,cb){cb();}});head.writeHead=(_s:number,h:any)=>{headers=h;};await serveFileBundle([{...file,bytes:4294967297}],head,'media.zip',{head:true});assert.equal(headers['X-Gallery-Count'],'1');
  unlinkSync(path);symlinkSync('/etc/hosts',path);assert.throws(()=>validateBundle([{...file,bytes:10}]),/变更/);
  assert(!bundleName('../非法:文件?.png').includes('/'));const long=bundleName('图'.repeat(160)+'.png');assert(Buffer.byteLength(long)<=180);assert(long.endsWith('.png'));assert.throws(()=>validateBundle([{...file,name:'../escape.mp4'}]),/文件名/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('shared gallery exposes one-click ZIP control and disables empty archives in native bridge',()=>{
 const Gallery=createMediaGallery(React),item={id:'1',name:'原图.png',kind:'image' as const,src:'/image',download:'/image?download=1'};
 const html=renderToStaticMarkup(React.createElement(Gallery,{items:[item],bundleUrl:'/api/gallery/bundle?kind=all',bundleCount:505}));assert(html.includes('一键打包下载'));assert(html.includes('所有分页'));assert(html.includes('下载原件'));
 const empty=renderToStaticMarkup(React.createElement(Gallery,{items:[],bundleUrl:'/api/gallery/bundle',bundleCount:0}));assert.match(empty,/class="media-gallery-bundle" disabled=""/);
 const client=readFileSync(new URL('../native-harness/team-project/client.js',import.meta.url),'utf8');let plugin:any;const entries:any[]=[];
 const fake={...React,useState:(v:any)=>[v,()=>{}],useEffect:()=>{},useCallback:(v:any)=>v};
 const w:any={__TEAM_CONTEXT__:{admin:false,project:'shared',user:'member'},__TEAM_CREATE_GALLERY__:createMediaGallery,__ModuleLoader__:{load(v:any){plugin=v.factory(()=>fake);}}};
 vm.runInNewContext(client,{window:w,location:{pathname:'/harness/shared/'},URLSearchParams,setTimeout,clearTimeout});
 plugin.apply({effect(){},slots:{inject(_s:string,fn:any){fn();},register(o:any,view:any){entries.push({...o,view});}}});assert(entries.some(e=>e.id==='team-chat-gallery'));
});


test('HTTP clients cancelling immediately after ZIP headers cannot crash the host',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gallery-http-cancel-')),path=join(root,'original'),bytes=Buffer.alloc(256*1024,9);writeFileSync(path,bytes);
 const files=Array.from({length:30},(_,i)=>({path,name:`图片/${i}.png`,bytes:bytes.length,sha256:hash(bytes)}));let failures=0;
 const server=createServer((req,res)=>{if(req.url==='/health'){res.end('ok');return;}void serveFileBundle(files,res).catch(()=>{failures++;res.destroy();});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(server.address() as any).port;
 try{for(let i=0;i<12;i++){const controller=new AbortController(),response=await fetch(base+'/zip',{signal:controller.signal});assert.equal(response.status,200);controller.abort();await response.body?.cancel().catch(()=>{});assert.equal(await (await fetch(base+'/health')).text(),'ok');}assert(failures>0);}
 finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
});
