import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Platform} from '../server/app.ts';import {type Doc} from '../server/store.ts';
import {WorkbenchRefresh,projectContentChanged,type WorkbenchEventBatch} from '../web/workbench-refresh.ts';

test('conversation generation events invalidate only the matching project content, without changing chat or submitting work',()=>{
 for(const type of ['project.updated','image.updated','pickup.confirmed','pickup.updated','assembly.updated']){
  const batch={cursor:3,events:[{type,body:{project:'project-a',id:'synthetic-result',state:'ready'}}]};
  assert(projectContentChanged(batch,'project-a'));assert(!projectContentChanged(batch,'project-b'));
 }
 assert(projectContentChanged({cursor:0,resetRequired:true,events:[]},'project-a'));
 assert(projectContentChanged({cursor:1,events:[{type:'project.updated'}]},'shared'));
 assert(!projectContentChanged({cursor:1,events:[{type:'project.updated'}]},'project-a'));
 assert(!projectContentChanged({cursor:4,events:[{type:'model.progress',body:{project:'project-a'}}]},'project-a'));
 assert(!projectContentChanged({cursor:4,events:[]},'project-a'));
});

test('native outer views avoid idle full reads; real events, periodic reconciliation and a lost refresh recover without generating requests',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'workbench-refresh-'))),app=new Platform({dataDir:root,concurrency:500,videoConcurrency:500}),password='Synthetic-refresh-20261020!',admin=app.newUser({username:'admin',password},'admin');
 try{
  const base='http://127.0.0.1:'+await app.start(0),auth=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password})}),cookie=auth.headers.get('set-cookie')!.split(';')[0];await auth.json();const paths:string[]=[],read=async(path:string)=>{paths.push(path);const r=await fetch(base+'/api'+path,{headers:{Cookie:cookie}});assert.equal(r.status,200);return r.json() as Promise<Doc>;};
  let after=0,now=1,full=0,lose=false;const loop=new WorkbenchRefresh({readEvents:n=>read('/events?after='+n) as Promise<WorkbenchEventBatch>,refresh:async()=>{full++;await read('/project');if(lose){lose=false;throw Error('lost read response');}},current:()=>true,cursor:{get:()=>after,set:v=>after=v},now:()=>now});
  await loop.poll();assert.equal(full,1);for(let n=0;n<18;n++){now+=1500;await loop.poll();}assert.equal(full,1);assert.equal(paths.filter(p=>p==='/project').length,1);
  now+=4000;await loop.poll();assert.equal(full,2,'periodic read catches changes without events');
  const change=app.projects.candidate(admin,app.projects.current().revision,{'新的剧情.md':'事件驱动读取的新内容'},{});app.projects.approve(change,admin,change.digest);const previous=after;lose=true;await assert.rejects(loop.poll(),/lost read response/);assert.equal(after,previous);const recovered=await loop.poll();assert(recovered!.events.some(e=>e.type==='project.updated'));assert(after>previous);assert.equal(full,4);await loop.poll();assert.equal(full,4);
  assert.equal(app.store.all('task').length+app.store.all('video-job').length+app.store.all('image-job').length+app.store.all('model-call').length,0);assert.equal(app.options.concurrency,500);assert.equal(app.pickups.maxConcurrency,500);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('cursor resets, concurrent polls and identity changes keep the original read lifetime; legacy views still refresh every tick',async()=>{
 let active=true,after=9,now=1,refreshes=0,resolve!:(v:WorkbenchEventBatch)=>void,reads=0;
 const loop=new WorkbenchRefresh({readEvents:async()=>{reads++;return new Promise(r=>resolve=r);},refresh:async()=>{refreshes++;},current:()=>active,cursor:{get:()=>after,set:v=>after=v},now:()=>now});
 const first=loop.poll(),same=loop.poll();resolve({cursor:12,events:[],resetRequired:true});await Promise.all([first,same]);assert.equal(reads,1);assert.equal(refreshes,1);assert.equal(after,0);
 const stale=loop.poll();active=false;resolve({cursor:20,events:[{type:'project.updated'}]});assert.equal(await stale,undefined);assert.equal(after,0);assert.equal(refreshes,1);
 active=true;const legacy=new WorkbenchRefresh({readEvents:async()=>({cursor:1,events:[]}),refresh:async()=>{refreshes++;},current:()=>active,cursor:{get:()=>after,set:v=>after=v},everyTick:true,now:()=>now});await legacy.poll();await legacy.poll();await legacy.poll();assert.equal(refreshes,4,'legacy streamed views retain their existing read frequency');
});
