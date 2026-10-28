import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync,openSync,closeSync,ftruncateSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {Platform} from '../server/app.ts';
import {adaptNativeClient} from '../server/native-page.ts';
import {NativeHarness} from '../server/native-harness.ts';

test('member workspace download streams large files, preserves names and supports resume without a native runtime',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'native-download-'))),app=new Platform({dataDir:join(root,'data'),nativeOnly:true});
 const password='Download-fixture-2026!';
 try {
  const admin=app.newUser({username:'admin',password},'admin'),member=app.newUser({username:'member',password},'member'),other=app.newUser({username:'other',password},'member');
  const work=join(app.store.root,'native-harness',app.native.key(member,'shared'),'workspace');mkdirSync(work,{recursive:true});
  const name="第一版 图片 % '整包.zip",file=join(work,name),size=36*1024*1024+17;
  const fd=openSync(file,'w');ftruncateSync(fd,size);writeSync(fd,Buffer.from('PK\x03\x04'),0,4,0);writeSync(fd,Buffer.from('final-zip-bytes'),0,15,size-15);closeSync(fd);
  writeFileSync(join(root,'outside.txt'),'private');symlinkSync(join(root,'outside.txt'),join(work,'escape.zip'));symlinkSync(root,join(work,'linked'));
  writeFileSync(join(work,'empty.txt'),'');
  app.native.get=async()=>{throw Error('Downloads must not start a native runtime');};
  const base='http://127.0.0.1:'+await app.start(0);
  async function login(username:string){const r=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username,password})});assert.equal(r.status,200);return r.headers.get('set-cookie')!.split(';')[0];}
  const memberCookie=await login('member'),otherCookie=await login('other'),adminCookie=await login('admin');
  const endpoint='/harness/shared/api/team/workspace-download?path='+encodeURIComponent('/workspace/'+name);
  const request=(suffix=endpoint,cookie=memberCookie,headers:Record<string,string>={},method='GET')=>fetch(base+suffix,{method,headers:{Cookie:cookie,...headers}});
  let r=await request();assert.equal(r.status,200);assert.equal(r.headers.get('content-length'),String(size));assert(r.headers.get('content-disposition')!.includes("filename*=UTF-8''"));assert(r.headers.get('content-disposition')!.includes('%E7%AC%AC'));assert(!r.headers.get('content-disposition')!.includes("'整"));
  const expected=createHash('sha256').update(readFileSync(file)).digest('hex'),actual=createHash('sha256');for await(const chunk of r.body as any)actual.update(chunk);assert.equal(actual.digest('hex'),expected);
  r=await request(endpoint,memberCookie,{},'HEAD');assert.equal(r.status,200);assert.equal(r.headers.get('content-length'),String(size));assert.equal((await r.arrayBuffer()).byteLength,0);
  r=await request(endpoint,memberCookie,{Range:'bytes=0-3'});assert.equal(r.status,206);assert.deepEqual(Buffer.from(await r.arrayBuffer()),Buffer.from('PK\x03\x04'));assert.equal(r.headers.get('content-range'),`bytes 0-3/${size}`);
  r=await request(endpoint,memberCookie,{Range:'bytes=-15'});assert.equal(r.status,206);assert.equal(await r.text(),'final-zip-bytes');
  r=await request(endpoint,memberCookie,{Range:'bytes='+size+'-'});assert.equal(r.status,416);assert.equal(r.headers.get('content-range'),'bytes */'+size);await r.text();
  r=await request(endpoint,memberCookie,{Range:'bytes=0-1,4-8'});assert.equal(r.status,416);await r.text();
  r=await request(endpoint,'');assert.equal(r.status,401);await r.text();
  r=await request(endpoint,otherCookie);assert.equal(r.status,404);await r.text();
  const delegated=endpoint.replace('/harness/shared/','/harness/shared~'+member.id+'/');
  r=await request(delegated,otherCookie);assert.equal(r.status,403);await r.text();
  r=await request(delegated,adminCookie,{},'HEAD');assert.equal(r.status,200);
  for(const p of ['/workspace/../outside.txt','/state/credentials.json']){r=await request('/harness/shared/api/team/workspace-download?path='+encodeURIComponent(p));assert([400,403].includes(r.status),p+': '+r.status);await r.text();}
  // Project chat downloads must reject host paths and links outside its workspace.
  for(const p of [join(root,'outside.txt'),'/workspace/escape.zip','/workspace/linked/outside.txt']){r=await request('/harness/shared/api/team/workspace-download?path='+encodeURIComponent(p));assert.equal(r.status,403);await r.text();}
  r=await request('/harness/shared/api/team/workspace-download?path='+encodeURIComponent(join(root,'outside.txt')),otherCookie);assert.equal(r.status,403);await r.text();
  r=await request('/harness/shared/api/team/workspace-download?path='+encodeURIComponent('/workspace/empty.txt'));assert.equal(r.status,200);assert.equal((await r.arrayBuffer()).byteLength,0);
  // Closing a partial browser transfer must not kill the host or retain its file stream.
  const controller=new AbortController();r=await fetch(base+endpoint,{headers:{Cookie:memberCookie},signal:controller.signal});await r.body!.getReader().read();controller.abort();
  r=await request(endpoint,memberCookie,{},'HEAD');assert.equal(r.status,200);
  app.store.put('user',{...member,active:false});r=await request(endpoint);assert.equal(r.status,401);await r.text();
  assert.equal(app.native.instances.size,0);assert.equal(app.store.all('model-call').length,0);
 } finally {await app.close();rmSync(root,{recursive:true,force:true});}
});

test('native ZIP card adds an independent download action even when the host has no desktop',async()=>{
 const source=readFileSync(new URL('./fixtures/native-deliverables-0.1.5-rc.2.js',import.meta.url),'utf8'),adapted=adaptNativeClient(source);
 const begin=adapted.indexOf('function PresentedFileCard('),end=adapted.indexOf('//#endregion',begin),code=adapted.slice(begin,end);
 const jsx=(type:any,props:any)=>({type,props}),primitives=new Proxy({},{get:(_t,key)=>String(key)});
 const scope:any={react:{useState:()=>[false,()=>{}],useRef:()=>({current:null})},react_jsx_runtime:{jsx,jsxs:jsx},_deepseek_ai_dsh_client_ui_primitives:primitives,Deliverables_module_css_default:new Proxy({},{get:(_t,key)=>String(key)}),basename:(p:string)=>p.split('/').at(-1),cardDescription:(d:string)=>d,resolveWorkspacePath:(cwd:string,p:string)=>p.startsWith('/')?p:cwd+'/'+p,window:{__TEAM_WORKSPACE_DOWNLOAD_URL__:(p:string)=>'/harness/shared/api/team/workspace-download?path='+encodeURIComponent(p)},file:{path:'/workspace/第一版.zip',description:'原始整包'}};
 (primitives as any).fileExtension=undefined;
 // Helpers are plain functions, while JSX component types can remain symbolic.
 scope._deepseek_ai_dsh_client_ui_primitives={...Object.fromEntries(['FileTypeIcon','Menu','MenuItem','IconChevronDownOutline14','IconFolderOutline16','IconOpenInNewOutline16'].map(k=>[k,k])),fileExtension:()=> 'zip'};
 const tree=runInNewContext(code+';PresentedFileCard({file,cwd:"/workspace",host:{available:false},t:x=>x,onPreview:()=>{},onAction:()=>{}})',scope);
 const nodes:any[]=[];const walk=(x:any)=>{if(Array.isArray(x))x.forEach(walk);else if(x&&typeof x==='object'){nodes.push(x);walk(x.props?.children);}};walk(tree);
 const link=nodes.find(x=>x.type==='a'&&x.props.children==='下载');assert(link);assert.equal(link.props.download,'第一版.zip');assert.equal(link.props.href,'/harness/shared/api/team/workspace-download?path='+encodeURIComponent('/workspace/第一版.zip'));assert.equal(link.props.disabled,undefined);
 assert(nodes.some(x=>x.type==='button'&&x.props.children==='presented.action'),'native preview action remains');
});

test('download URL uses the exact current member/project prefix',async()=>{
 const n=new NativeHarness({} as any,{} as any,()=>({} as any));
 try {const window:any={fetch:()=>{},Worker:class{},WebSocket:class{},EventSource:class{}};const prefix='/harness/shared~00000000-0000-0000-0000-000000000001';runInNewContext(n.bootstrap(prefix,'csrf'),{window,URL,Headers,Request,encodeURIComponent,location:new URL('http://localhost:4325'+prefix+'/')});assert.equal(window.__TEAM_WORKSPACE_DOWNLOAD_URL__('/workspace/a b.zip'),prefix+'/api/team/workspace-download?path=%2Fworkspace%2Fa%20b.zip');}
 finally {await n.close();}
});
