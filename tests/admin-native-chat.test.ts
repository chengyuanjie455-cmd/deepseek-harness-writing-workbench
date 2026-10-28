import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {once} from 'node:events';import {WebSocket,WebSocketServer} from 'ws';
import {Platform} from '../server/app.ts';
const password='Synthetic-admin-chat-2026!';
test('administrator and member use the same native conversation, uploads, prompts and live stream without changing the owner',async()=>{
 const root=mkdtempSync(join(tmpdir(),'admin-native-chat-')),app=new Platform({dataDir:root,mockDelay:1});
 const histories=new Map<string,any[]>(),dedup=new Set<string>(),uploads=new Map<string,Buffer>();
 const upstream=createServer(async(req,res)=>{const owner=req.headers.cookie!;const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks);res.setHeader('Content-Type','application/json');
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<html><head></head><body><div data-composer-input="true" contenteditable="true"></div><button>发送</button></body></html>');return;}
  if(req.url?.startsWith('/api/session/uploadFileBinary'))uploads.set(owner,bytes);
  if(req.url==='/api/session/prompt'){const r=JSON.parse(bytes.toString()).payload.args.request,key=owner+':'+r.requestId;if(!dedup.has(key)){dedup.add(key);histories.set(owner,[...(histories.get(owner)??[]),r]);}}
  res.end(JSON.stringify({owner,history:histories.get(owner)??[],uploaded:uploads.get(owner)?.toString('hex')}));
 });await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));const ws=new WebSocketServer({server:upstream});ws.on('connection',(s,req)=>s.on('message',data=>s.send(JSON.stringify({owner:req.headers.cookie,text:data.toString()}))));
 const admin=app.newUser({username:'admin',password},'admin'),member=app.newUser({username:'member',password},'member'),other=app.newUser({username:'other',password},'member');
 histories.set(member.id,[{sessionId:'session-same',text:'已有剧本和上下文'}]);histories.set(other.id,[{sessionId:'session-same',text:'其他成员自己的上下文'}]);
 app.native.start=async(i,u)=>{i.port=(upstream.address() as any).port;i.cookie=u!.id;app.native.phase(i,'ready');};app.native.runtimeHealth=async()=>({healthy:true,running:true});
 const base='http://127.0.0.1:'+await app.start(0),clients:WebSocket[]=[];
 const login=async(username:string)=>{const r=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username,password})}),d:any=await r.json();return {Cookie:r.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':d.csrf,Origin:base,'Content-Type':'application/json'};};
 try{
  const a=await login('admin'),m=await login('member');
  const start=async(headers:any,owner?:string)=>{const r=await fetch(base+'/api/native/open'+(owner?'?member='+owner:''),{method:'POST',headers,body:'{}'});assert.equal(r.status,200);return r.json() as Promise<any>;};
  const memberOpen=await start(m),adminOpen=await start(a,member.id);assert.equal(app.native.instances.size,1,'both accounts share the same original runtime');assert.equal(adminOpen.generation,memberOpen.generation);assert.notEqual(adminOpen.scope,memberOpen.scope,'browser drafts are per viewer');
  const ticket=new URL(adminOpen.url),prefix='/harness/shared~'+member.id;
  const wrong=await fetch(base+'/harness/shared~'+other.id+'/?'+ticket.searchParams,{redirect:'manual'});assert.equal(wrong.status,403,'ticket cannot select a different member');
  const exchanged=await fetch(adminOpen.url,{redirect:'manual'});assert.equal(exchanged.status,302);assert(exchanged.headers.get('set-cookie')!.includes('Path='+prefix+'/'));const delegated={...a,Cookie:exchanged.headers.get('set-cookie')!.split(';')[0]};
  const html=await(await fetch(base+prefix+'/',{headers:delegated})).text();assert(html.includes('data-composer-input'));assert(html.includes('"user":"'+member.id+'"'));assert(html.includes('"viewer":"'+admin.id+'"'));assert(html.includes('"admin":true'));
  const snapshot=await(await fetch(base+prefix+'/api/session/read',{headers:delegated})).json() as any;assert.equal(snapshot.owner,member.id);assert.equal(snapshot.history[0].text,'已有剧本和上下文');
  const body=(id:string,text:string)=>JSON.stringify({method:'session/prompt',payload:{args:{request:{sessionId:'session-same',requestId:id,prompt:text}}}});
  await Promise.all([fetch(base+prefix+'/api/session/prompt',{method:'POST',headers:delegated,body:body('admin-request','管理员补充提示词')}),fetch(base+'/harness/shared/api/session/prompt',{method:'POST',headers:m,body:body('member-request','成员继续修改')})]);
  await fetch(base+prefix+'/api/session/prompt',{method:'POST',headers:delegated,body:body('admin-request','重复回执恢复')});assert.equal(histories.get(member.id)?.length,3);assert.equal(histories.get(other.id)?.length,1);assert(!histories.has(admin.id),'no copy into administrator history');
  const bytes=Buffer.from([0,1,2,255]);await fetch(base+prefix+'/api/session/uploadFileBinary?name=asset.png',{method:'POST',headers:{...delegated,'Content-Type':'application/octet-stream'},body:bytes});assert.deepEqual(uploads.get(member.id),bytes);
  const readAsMember:any=await(await fetch(base+'/harness/shared/api/session/read',{headers:m})).json();assert.equal(readAsMember.history.length,3);assert.equal(readAsMember.uploaded,bytes.toString('hex'));
  let toolOwner='';app.native.team.route=async(_i,u,_req,res)=>{toolOwner=u.id;res.end('{}');};await fetch(base+prefix+'/api/team/status',{headers:delegated});assert.equal(toolOwner,member.id,'generation and returned media remain in the member context');
  const me:any=await(await fetch(base+prefix+'/team-settings/api/me',{headers:delegated})).json();assert.equal(me.user.id,admin.id,'administrative settings still use the authenticated administrator');
  const status:any=await(await fetch(base+'/api/native/status?connection=1&member='+member.id,{headers:a})).json();assert.equal(status.state,'ready');
  for(const path of ['/api/native/status?connection=1&member='+other.id,prefix+'/api/session/read'])assert.equal((await fetch(base+path,{headers:m})).status,403);
  assert.equal((await fetch(base+'/api/native/open?member='+other.id,{method:'POST',headers:m,body:'{}'})).status,403);
  assert.equal((await fetch(base+'/harness/shared/api/session/read',{headers:delegated})).status,403,'delegated cookie cannot silently change owner');
  assert.equal((await fetch(base+prefix+'/api/session/prompt',{method:'POST',headers:{...delegated,'X-CSRF-Token':'wrong'},body:body('bad','bad')})).status,403);
  const audits=app.store.db.prepare("select actor,target,detail from audit where action='admin.native_chat.forward'").all() as any[];assert(audits.some(v=>v.actor===admin.id&&v.target===member.id&&JSON.parse(v.detail).session==='session-same'));
  const stream=new WebSocket(base.replace('http:','ws:')+prefix+'/api/remote.mux',{headers:{Origin:base,Cookie:delegated.Cookie}});clients.push(stream);await once(stream,'open');const received=once(stream,'message');stream.send('live-context');const [data]=await received;assert.equal(JSON.parse(String(data)).owner,member.id);
  app.store.put('user',{...admin,role:'member'});assert.equal((await fetch(base+prefix+'/api/session/read',{headers:delegated})).status,403);const closed=once(stream,'close');await closed;assert.notEqual(stream.readyState,WebSocket.OPEN);
  assert.equal((await fetch(base+'/harness/shared/api/session/read',{headers:m})).status,200,'member stays connected after admin access is revoked');
 }finally{for(const client of clients)client.terminate();for(const s of ws.clients)s.terminate();app.native.instances.clear();await app.close();await new Promise<void>(r=>ws.close(()=>r()));await new Promise<void>(r=>upstream.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});

test('member names in the native page bootstrap cannot end the script element',async()=>{
 const {nativePageBridge}=await import('../server/native-page.ts');const text=nativePageBridge('admin:project:owner',{admin:true,project:'shared',user:'owner',ownerName:'</script><script>injected()</script>'});assert(!text.includes('</script>'));assert(text.includes('\\u003c/script>'));
});
