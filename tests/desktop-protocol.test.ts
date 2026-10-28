import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Platform } from '../server/app.ts';
import { pendingKey, readPending, savePending } from '../web/pending.ts';

test('stable server identity survives restart; request lookup is read-only and owner scoped', async () => {
  const root=mkdtempSync(join(tmpdir(),'team-desktop-protocol-'));let app=new Platform({dataDir:root,mockDelay:1});
  let base='http://127.0.0.1:'+await app.start(0);let cookie='',csrf='';
  const call=async(path:string,method='GET',body?:any,expected=200)=>{
    const res=await fetch(base+'/api'+path,{method,headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await res.json() as any;assert.equal(res.status,expected,JSON.stringify(data));
    if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie')!.split(';')[0];if(data.csrf)csrf=data.csrf;return data;
  };
  try{
    const status=await call('/status');assert.equal(status.protocol.min,1);assert.match(status.serverId,/^[a-f0-9-]{36}$/);
    const credentials={username:'admin',password:'synthetic-desktop-981223'};
    await call('/setup','POST',credentials,201);await call('/login','POST',credentials);
    const s=await call('/sessions','POST',{},201);
    const body={session:s.id,requestId:'lookup-original-task',prompt:'synthetic only',workflow:'chat',paths:[]};
    const task=await call('/tasks','POST',body,202);
    for(let i=0;i<3;i++){const found=await call('/requests/'+body.requestId+'?session='+s.id);assert.equal(found.task.id,task.id);assert.equal(found.found,true);}
    assert.equal((await call('/tasks')).length,1);
    assert.equal((await call('/requests/not-yet-submitted?session='+s.id)).found,false);
    await call('/admin/users','POST',{username:'member',password:credentials.password,role:'member'},201);
    await call('/login','POST',{...credentials,username:'member'});
    await call('/requests/'+body.requestId+'?session='+s.id,'GET',undefined,404);
    await call('/logout','POST',{});await call('/requests/'+body.requestId+'?session='+s.id,'GET',undefined,401);
    await app.close();app=new Platform({dataDir:root,mockDelay:1});base='http://127.0.0.1:'+await app.start(0);
    const restarted=await call('/status');assert.equal(restarted.serverId,status.serverId);assert.notEqual(restarted.serverInstance,status.serverInstance);
    await call('/login','POST',credentials);assert.equal((await call('/requests/'+body.requestId+'?session='+s.id)).task.id,task.id);
  }finally{await app.close();}
});

test('event pagination filters before sending, tolerates gaps, and resets stale cursors',async()=>{
  const app=new Platform({dataDir:mkdtempSync(join(tmpdir(),'team-events-resume-')),mockDelay:1});const base='http://127.0.0.1:'+await app.start(0);
  try{
    const credentials={username:'admin',password:'synthetic-events-34332'};
    await fetch(base+'/api/setup',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(credentials)});
    const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(credentials)});
    const me=await login.json() as any;const headers={Cookie:login.headers.get('set-cookie')!.split(';')[0]};
    for(let i=0;i<451;i++)app.store.event(i%2?'other':me.user.id,'fixture',{marker:i%2?'private-other':'own'});
    const read=async(after:number)=>await(await fetch(base+'/api/events?after='+after,{headers})).json() as any;
    const first=await read(0);assert.equal(first.events.length,200);assert(first.hasMore);assert(first.events.every((e:any)=>e.body.marker==='own'));
    const second=await read(first.cursor);assert.equal(second.events.length,26);assert(!second.hasMore);
    assert.equal((await read(99999)).resetRequired,true);
    app.store.db.prepare('DELETE FROM events WHERE seq<=100').run();assert.equal((await read(20)).resetRequired,true);
    assert.equal((await read(0)).resetRequired,false);
  }finally{await app.close();}
});

test('pending request metadata survives UI reload without storing prompt, token or another owner',()=>{
  const map=new Map<string,string>();const storage={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v);}};
  const key=pendingKey('server-a','user-a');const body={session:'11111111-1111-1111-1111-111111111111',requestId:'saved-request-id',prompt:'PRIVATE',token:'SECRET'};
  savePending(storage,key,body);assert.equal(readPending(storage,key)?.requestId,body.requestId);
  assert.equal(readPending(storage,pendingKey('server-a','user-b')),undefined);
  assert(!map.get(key)!.includes('PRIVATE'));assert(!map.get(key)!.includes('SECRET'));
  map.set(key,'{"requestId":"corrupt"}');assert.equal(readPending(storage,key),undefined);
});

test('closing an unaccepted request fences late arrivals and survives restart without cancelling accepted work',async()=>{
  const {request}=await import('node:http');
  const root=mkdtempSync(join(tmpdir(),'team-request-fence-'));let app=new Platform({dataDir:root,mockDelay:1});
  let base='http://127.0.0.1:'+await app.start(0);let cookie='',csrf='';
  const credentials={username:'admin',password:'synthetic-fence-12345'};
  const call=async(p:string,method='GET',body?:any,expected=200)=>{
    const r=await fetch(base+'/api'+p,{method,headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const d=await r.json() as any;assert.equal(r.status,expected,JSON.stringify(d));if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie')!.split(';')[0];if(d.csrf)csrf=d.csrf;return d;
  };
  try{
    await call('/setup','POST',credentials,201);await call('/login','POST',credentials);
    const s=await call('/sessions','POST',{},201);const body={session:s.id,requestId:'delayed-original',prompt:'synthetic',workflow:'chat',paths:[]};
    const encoded=JSON.stringify(body);
    let late:any;const lateResult=new Promise<number>(resolve=>{
      late=request(base+'/api/tasks',{method:'POST',headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json','Content-Length':Buffer.byteLength(encoded)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});
      late.write(encoded.slice(0,10));
    });
    const closed=await call('/requests/'+body.requestId+'/close','POST',{session:s.id});assert.equal(closed.closed,true);assert.equal(closed.found,false);
    late.end(encoded.slice(10));assert.equal(await lateResult,409);assert.equal((await call('/tasks')).length,0);
    await app.close();app=new Platform({dataDir:root,mockDelay:1});base='http://127.0.0.1:'+await app.start(0);
    await call('/login','POST',credentials);assert.equal((await call('/requests/'+body.requestId+'?session='+s.id)).closed,true);
    await call('/tasks','POST',body,409);
    const accepted=await call('/tasks','POST',{...body,requestId:'separate-new-request'},202);
    const existing=await call('/requests/separate-new-request/close','POST',{session:s.id});assert.equal(existing.task.id,accepted.id);assert.equal(existing.closed,false);
    await call('/admin/users','POST',{username:'member',password:credentials.password,role:'member'},201);await call('/login','POST',{...credentials,username:'member'});
    await call('/requests/'+body.requestId+'/close','POST',{session:s.id},404);
  }finally{await app.close();}
});
