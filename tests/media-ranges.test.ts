import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {createRequire} from 'node:module';
import {Platform} from '../server/app.ts';
import {hash} from '../server/store.ts';

test('generated and native attachment originals share suffix, seek, HEAD and If-Range semantics without broadening access',async()=>{
 const root=mkdtempSync(join(tmpdir(),'media-ranges-')),app=new Platform({dataDir:root,mediaWorker:false,nativeProjectSurface:true}),password='Synthetic-range-20261021!';
 const a=app.newUser({username:'原件范围成员甲',password},'member'),b=app.newUser({username:'原件范围成员乙',password},'member');
 let runtimeStarts=0;app.native.open=async()=>({startup:{startedAt:1,readyAt:2}} as any);app.native.get=async()=>{runtimeStarts++;throw Error('Original media must not start an agent');};
 const bytes=Buffer.alloc(4096);Buffer.from('ftypisom').copy(bytes,4);for(let i=16;i<bytes.length;i++)bytes[i]=i%251;
 const media=await app.pickups.media.ingest(Readable.from([bytes]),a.id,'private','范围原片.mp4');
 const key=hash(JSON.stringify([a.id,'shared'])).slice(0,24),digest=hash(bytes),ref={attachmentId:'sha256:'+digest,name:'聊天原片.mp4'},file=join(root,'native-harness',key,'state/attachments/v1/files',digest.slice(0,2),digest,ref.name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes);
 app.native.history.read=async(owner,session)=>{assert.equal(owner,key);assert.equal(session,'session-range');return {rows:[{content:[{type:'file',attachment:ref}]}]};};
 const {Connection}=createRequire(import.meta.url)('../desktop/connection.cjs'),connection=new Connection();
 try{
  const base='http://127.0.0.1:'+await app.start(0);await connection.connect(base,app.serverId);await connection.call('/api/login','POST',{username:a.username,password});
  const issued=await connection.call('/api/native/open?project=shared','POST',{}),entry=await fetch(issued.data.url,{redirect:'manual'});assert.equal(entry.status,302);const nativeCookie=entry.headers.get('set-cookie')!.split(';')[0];
  async function login(username:string){const response=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username,password})});assert.equal(response.status,200);return response.headers.get('set-cookie')!.split(';')[0];}
  const cookie=await login(a.username),foreign=await login(b.username);
  const routes=[{path:'/api/media/'+media.id,cookie},{path:'/harness/shared/api/team/media/'+media.id,cookie:nativeCookie},{path:'/api/gallery/attachment?'+new URLSearchParams({project:'shared',owner:a.id,session:'session-range',attachmentId:ref.attachmentId,name:ref.name}),cookie}];
  for(const route of routes){
   const get=(headers:Record<string,string>={},method='GET')=>fetch(base+route.path,{method,headers:{Cookie:route.cookie,...headers}});
   const full=await get();assert.equal(full.status,200);assert.equal(full.headers.get('content-type'),'video/mp4');assert.equal(full.headers.get('x-content-sha256'),digest);assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);const etag=full.headers.get('etag');assert(etag);assert.match(etag,/^"sha256-[a-f0-9]{64}"$/);
   for(const [range,start,end]of [['bytes=-32',bytes.length-32,bytes.length-1],['bytes=-99999',0,bytes.length-1],['bytes=100-',100,bytes.length-1],['bytes=0-1',0,1],['bytes=4090-9999',4090,4095]] as const){
    const response=await get({Range:range});assert.equal(response.status,206,route.path+' '+range);assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${bytes.length}`);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(start,end+1));
   }
   const head=await get({Range:'bytes=-32'},'HEAD');assert.equal(head.status,206);assert.equal(head.headers.get('content-length'),'32');assert.equal((await head.arrayBuffer()).byteLength,0);
   for(const range of ['bytes=-0','bytes=-','bytes=100-99','bytes=4096-','bytes=0-1,4-5','bytes=0-99999999999999999999']){const invalid=await get({Range:range});assert.equal(invalid.status,416,range);assert.equal(invalid.headers.get('content-range'),'bytes */'+bytes.length);await invalid.arrayBuffer();}
   const same=await get({Range:'bytes=0-31','If-Range':etag});assert.equal(same.status,206);assert.deepEqual(Buffer.from(await same.arrayBuffer()),bytes.subarray(0,32));
   for(const validator of ['"old-representation"','W/'+etag]){const stale=await get({Range:'bytes=0-31','If-Range':validator});assert.equal(stale.status,200);assert.deepEqual(Buffer.from(await stale.arrayBuffer()),bytes);}
   const anonymous=await fetch(base+route.path);assert.equal(anonymous.status,401);await anonymous.arrayBuffer();
  }
  const deniedMedia=await fetch(base+'/api/media/'+media.id,{headers:{Cookie:foreign,Range:'bytes=-32'}});assert.equal(deniedMedia.status,404);assert.equal(deniedMedia.headers.get('content-range'),null);await deniedMedia.arrayBuffer();
  const deniedAttachment=await fetch(base+routes[2].path,{headers:{Cookie:foreign,Range:'bytes=-32'}});assert.equal(deniedAttachment.status,403);assert.equal(deniedAttachment.headers.get('content-range'),null);await deniedAttachment.arrayBuffer();
  await Promise.all(Array.from({length:24},async(_,n)=>{const route=routes[n%routes.length],start=n*17,response=await fetch(base+route.path,{headers:{Cookie:route.cookie,Range:`bytes=${start}-${start+31}`}});assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(start,start+32));}));
  app.store.put('user',{...a,active:false});for(const route of routes){const revoked=await fetch(base+route.path,{headers:{Cookie:route.cookie,Range:'bytes=-32'}});assert.equal(revoked.status,401);await revoked.arrayBuffer();}
  assert.equal(runtimeStarts,0);assert.equal(app.store.all('image-job').length+app.store.all('video-job').length,0);
 }finally{connection.disconnect();await app.close();rmSync(root,{recursive:true,force:true});}
});
