import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TrustedRelay} from '../server/trusted-relay.ts';
import {Platform} from '../server/app.ts';
const token='a'.repeat(64),origin='https://work.example.test';
function fixture(){const dataDir=mkdtempSync(join(tmpdir(),'trusted-relay-'));writeFileSync(join(dataDir,'trusted-relay.json'),JSON.stringify({version:1,origin,token}),{mode:0o600});return dataDir;}
const headers={'x-wawu-relay-token':token,'x-wawu-client-ip':'203.0.113.7','x-wawu-public-origin':origin};
test('forwarded identity needs a loopback peer, pinned secret, public origin and one IP',()=>{
 const relay=new TrustedRelay(fixture());const req=(h:any=headers,address='127.0.0.1')=>({headers:h,socket:{remoteAddress:address}} as any);
 assert.deepEqual(relay.context(req()),{clientAddress:'203.0.113.7',origin});
 assert.equal(relay.context(req({'x-forwarded-for':'203.0.113.9'})),undefined);
 for(const r of [req(headers,'192.0.2.5'),req({...headers,'x-wawu-relay-token':'b'.repeat(64)}),req({...headers,'x-wawu-client-ip':'203.0.113.7, 192.0.2.5'}),req({...headers,'x-wawu-public-origin':'https://evil.example'})])assert.throws(()=>relay.context(r));
});
test('public initialization denied, separate clients have separate login windows, direct LAN login stays intact',async()=>{
 const app=new Platform({dataDir:fixture(),mockDelay:1});const base='http://127.0.0.1:'+await app.start(0);
 const user={username:'relay-test',password:'relay-test-password-42'};
 const post=(path:string,body:any,h:any={})=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...h},body:JSON.stringify(body)});
 try{
  assert.equal((await (await fetch(base+'/api/status')).json() as any).transport,'http');
  assert.equal((await (await fetch(base+'/api/status',{headers})).json() as any).transport,'https');
  assert.equal((await post('/api/setup',user,headers)).status,403);
  assert.equal((await post('/api/setup',user)).status,201);
  const forged={...headers,'x-wawu-relay-token':'x'.repeat(64)};
  assert.equal((await post('/api/login',user,forged)).status,403);
  app.loginWindow.set('relay:203.0.113.7',{start:Date.now(),count:30});
  assert.equal((await post('/api/login',user,headers)).status,429);
  const good=await post('/api/login',user,{...headers,'x-wawu-client-ip':'203.0.113.8'});assert.equal(good.status,200);
  const {csrf}=await good.json() as any;const Cookie=good.headers.get('set-cookie')!.split(';')[0];
  app.native.open=async()=>({startup:{startedAt:Date.now()-100,readyAt:Date.now()-10,steps:{}}} as any);
  const auth={Cookie,'X-CSRF-Token':csrf};
  const localOpen=await post('/api/native/open',{},auth);assert.equal(localOpen.status,200);
  assert.equal(new URL((await localOpen.json() as any).url).origin,base);
  const relayOpen=await post('/api/native/open',{}, {...headers,...auth});assert.equal(relayOpen.status,200);
  const publicUrl=new URL((await relayOpen.json() as any).url);assert.equal(publicUrl.origin,origin);assert.equal(publicUrl.pathname,'/harness/shared/');
  assert(publicUrl.searchParams.get('ticket'));
  assert.equal((await post('/api/logout',{}, {...headers,'x-wawu-client-ip':'203.0.113.8',Cookie,'X-CSRF-Token':csrf,Origin:'https://evil.example'})).status,403);
  assert.equal((await post('/api/logout',{}, {...headers,'x-wawu-client-ip':'203.0.113.8',Cookie,'X-CSRF-Token':csrf})).status,200);
  assert.equal((await post('/api/login',user)).status,200);
 }finally{await app.close();}
});
