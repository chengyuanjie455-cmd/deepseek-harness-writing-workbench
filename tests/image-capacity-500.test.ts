import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {setTimeout as delay} from 'node:timers/promises';
import {Platform} from '../server/app.ts';import {Store,id} from '../server/store.ts';import {imageCapacity,migrateImageCapacity} from '../server/concurrency.ts';
test('upgrade changes saved image capacity to 500 once, preserves other settings and subsequent admin values',()=>{
 const store=new Store(mkdtempSync(join(tmpdir(),'image-capacity-')));try{store.put('runtime-concurrency',{id:'active',image:2,video:8,text:96,testedChannels:{example:{limit:8,revision:'v1'}}});migrateImageCapacity(store);assert.equal(imageCapacity(store),500);assert.equal(store.get('runtime-concurrency','active')?.video,8);assert.equal(store.get('runtime-concurrency','active')?.testedChannels.example.limit,8);store.put('runtime-concurrency',{...store.get('runtime-concurrency','active'),id:'active',image:123});migrateImageCapacity(store);assert.equal(imageCapacity(store),123);}finally{store.close();}
});
test('8 members x 3 chats, 504 synthetic image jobs: exactly 500 execute globally, overflow queues then drains without duplicate execution',async()=>{
 const app=new Platform({dataDir:mkdtempSync(join(tmpdir(),'image-500-')),mockDelay:1});await app.start(0);let active=0,peak=0;const seen=new Set<string>(),release=new Map<string,()=>void>();const client=app.images;
 client.drive=async(jobId,signal)=>{assert(!seen.has(jobId));seen.add(jobId);peak=Math.max(peak,++active);client.update({id:jobId},{state:'submitting'});await new Promise<void>(r=>{release.set(jobId,r);signal.addEventListener('abort',()=>r(),{once:true});});client.update({id:jobId},{state:'ready'});active--;};
 try{for(let n=0;n<504;n++)app.store.put('image-job',{id:id(),owner:'member-'+n%8,session:'chat-'+n%3,state:'queued',channelId:'video-channel-with-one-tested-slot'});client.pump();assert.equal(client.active.size,500);assert.equal(peak,500);assert.equal(app.store.all('image-job').filter(j=>j.state==='queued').length,4);
  // A lower administrator setting does not interrupt already running tasks.
  app.store.put('runtime-concurrency',{...app.store.get('runtime-concurrency','active'),id:'active',image:499});client.pump();assert.equal(client.active.size,500);
  for(const r of release.values())r();for(let n=0;n<100;n++){for(const r of release.values())r();if(seen.size===504&&!client.active.size)break;await delay(10);}assert.equal(seen.size,504);assert.equal(peak,500);assert.equal(app.store.all('image-job').filter(j=>j.state==='ready').length,504);assert.equal(client.active.size,0);
 }finally{for(const r of release.values())r();await app.close();}
});
