import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Platform} from '../server/app.ts';
import {concurrencyValue} from '../server/concurrency.ts';
test('concurrency accepts 500, rejects invalid limits and requires administrator; persists across restart',async()=>{
 const dataDir=mkdtempSync(join(tmpdir(),'capacity-'));let app=new Platform({dataDir});
 try{const admin=app.newUser({username:'admin',password:'Synthetic-Test-Password'},'admin'),member=app.newUser({username:'member',password:'Synthetic-Test-Password'},'member');
 const base=`http://127.0.0.1:${await app.start(0)}`;
 async function login(username:string){const r=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username,password:'Synthetic-Test-Password'})});return {cookie:r.headers.get('set-cookie')!.split(';')[0],csrf:(await r.json()).csrf};}
 async function call(auth:any,body:any){return fetch(base+'/api/admin/concurrency',{method:'POST',headers:{Origin:base,Cookie:auth.cookie,'X-CSRF-Token':auth.csrf,'Content-Type':'application/json'},body:JSON.stringify(body)});}
 const a=await login(admin.username),m=await login(member.username);assert.equal((await call(m,{text:500,video:500})).status,403);
 const body={name:'test',origin:'https://synthetic.invalid',adapter:'ruiyun',enabled:true,concurrency:2,noRetryEvidence:'offline only',apiKey:'synthetic-only'};
 const channel=app.pickups.catalog.saveChannel(admin,body);app.store.put('video-channel',{...app.store.get('video-channel',channel.id)!,verified:true,reachableModels:['test']});
 const changed=app.pickups.catalog.saveChannel(admin,{...body,id:channel.id,apiKey:'',concurrency:500});assert.equal(changed.revision,channel.revision);assert.equal(changed.verified,true);assert.equal(changed.concurrency,500);assert.equal(app.store.get('video-channel-version',channel.revision)!.concurrency,2);
 for(const value of [0,501,1.5,'500',null])assert.equal((await call(a,{text:value,video:500})).status,400);
 const r=await call(a,{text:500,video:500});assert.equal(r.status,200);assert.equal((await r.json()).max,500);assert.equal(app.pickups.maxConcurrency,500);assert.equal(app.pickups.catalog.maxConcurrency,500);
 await app.close();app=new Platform({dataDir});assert.equal(app.options.concurrency,500);assert.equal(app.pickups.maxConcurrency,500);
 assert.equal(concurrencyValue(500),500);
 }finally{await app.close();}
});
