import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Platform} from '../server/app.ts';import {hash} from '../server/store.ts';import {memberSubmissions} from '../server/member-submissions.ts';import {summarizeSubmissions} from '../native-harness/team-project/submissions.mjs';import {adaptNativeClient,nativePageBridge} from '../server/native-page.ts';import {runInNewContext} from 'node:vm';
const password='Synthetic-test-password-2026!';
test('native task summary deduplicates delivery, ignores tools, scheduling, subagents and inherited context',()=>{
 const m={id:'human-1',source:{kind:'user'},content:[{type:'text',text:'生成短剧片段'},{type:'image'}]},events:any[]=[];
 const add=(type:string,data:any)=>events.push({seq:events.length,time:10000+events.length,type,data});
 add('agent/inbox/spliced',{inserted:[m]});add('agent/inbox/spliced',{inserted:[m]});add('turn/start',{turn:1});add('user/message',m);add('tool/call',{name:'video_generate'});add('user/message',{id:'scheduled',source:{kind:'schedule'},content:[{type:'text',text:'自动提醒'}]});add('turn/end',{turn:1,reason:{kind:'completed'}});
 const rows=summarizeSubmissions({id:'session-a'},events);assert.equal(rows.length,1);assert.equal(rows[0].state,'completed');assert.equal(rows[0].attachments,1);assert.equal(rows[0].prompt,'生成短剧片段');assert.equal(summarizeSubmissions({id:'fork',delegationDepth:1},events).length,0);assert.equal(summarizeSubmissions({id:'fork'},events,events.length).length,0);
 add('agent/inbox/spliced',{inserted:[{...m,id:'human-2'}]});assert.equal(summarizeSubmissions({id:'session-a'},events)[1].state,'queued');
});
test('member task center protects ownership, groups human tasks and correlates generated results once',async()=>{
 const root=mkdtempSync(join(tmpdir(),'hub-summary-')),app=new Platform({dataDir:root});try{
 const admin=app.newUser({username:'admin',password,name:'管理员'},'admin'),a=app.newUser({username:'membera',password,name:'成员甲'},'member'),b=app.newUser({username:'memberb',password,name:'成员乙'},'member');
 const dir=join(root,'native-harness',hash(JSON.stringify([a.id,'shared'])).slice(0,24),'state');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'team-submissions.json'),JSON.stringify({version:1,at:Date.now(),items:[{id:'msg',session:'session-human',prompt:'修改服装',state:'completed',created:new Date().toISOString()}]}));
 app.store.put('pickup',{id:'plan',owner:a.id,project:'shared'});app.store.put('video-job',{id:'video',planId:'plan',owner:a.id,state:'download_failed',mediaId:'result',cost:{amount:999},apiKey:'MUST-NOT-LEAK'});app.store.audit(a.id,'native.video.generate','plan',{session:'session-human',sourceMessageId:'msg'});app.store.audit(a.id,'native.video.generate','plan',{session:'session-human',sourceMessageId:'msg'});
 app.store.put('task',{id:'task-b',owner:b.id,prompt:'乙的私密任务',state:'completed',created:new Date().toISOString()});app.store.put('model-call',{id:'internal',owner:a.id,state:'completed'});
 const mine=memberSubmissions(app.store,a);assert.equal(mine.items.length,1);assert.equal(mine.items[0].state,'attention');assert.equal(mine.items[0].results.length,1);assert.equal(mine.groups.length,1);assert(!JSON.stringify(mine).includes('MUST-NOT-LEAK'));assert(!JSON.stringify(mine).includes('乙的私密'));assert.equal(memberSubmissions(app.store,a,new URLSearchParams({owner:b.id})).items.length,0);assert.equal(memberSubmissions(app.store,admin).summary.total,2);
 assert.throws(()=>memberSubmissions(app.store,a,new URLSearchParams('page=0')));
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
test('embedded native settings reuses role and CSRF checks and fixes API project scope',async()=>{
 const root=mkdtempSync(join(tmpdir(),'hub-settings-')),staticDir=join(root,'web');mkdirSync(staticDir);writeFileSync(join(staticDir,'index.html'),'<script src="/assets/main.js"></script>');const app=new Platform({dataDir:join(root,'data'),staticDir});
 try{const admin=app.newUser({username:'admin',password},'admin'),member=app.newUser({username:'member',password},'member');const base='http://127.0.0.1:'+await app.start(0);
 async function ticket(username:string){const r=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username,password})}),me=await r.json() as any,token=r.headers.get('set-cookie')!.split(';')[0].split('=')[1],key='ticket-'+username;app.nativeTickets.set(key,{user:me.user.id,auth:hash(token),csrf:me.csrf,expires:Date.now()+100000});return {Cookie:'team_native='+key,'X-CSRF-Token':me.csrf,Origin:base};}
 const a=await ticket('admin'),m=await ticket('member'),prefix='/harness/shared/team-settings';
 assert.equal((await fetch(base+prefix+'/api/admin/chat-models',{headers:m})).status,403);
 assert.equal((await fetch(base+prefix+'/api/admin/chat-models',{headers:a})).status,200);
 assert.equal((await fetch(base+prefix+'/api/admin/concurrency',{method:'POST',headers:{Cookie:a.Cookie,Origin:base},body:'{}'})).status,403);
 const project=await(await fetch(base+prefix+'/api/project?project=outside',{headers:m})).json() as any;assert.equal(project.id,'shared');
 const html=await fetch(base+prefix+'/?panel=models',{headers:a});assert.equal(html.status,200);assert((await html.text()).includes(prefix+'/assets/main.js'));assert.equal(html.headers.get('x-frame-options'),null);
 assert.equal((await fetch(base+prefix+'/api/native/open',{method:'POST',headers:a,body:'{}'})).status,404);
 app.store.put('user',{...member,active:false});assert.equal((await fetch(base+prefix+'/api/me',{headers:m})).status,401);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
test('pinned native settings and title adapter retains a single settings shell',()=>{const s='const productTitle = "DeepSeek Harness"; const [activeId, setActiveId] = (0, react.useState)(void 0);';const out=adaptNativeClient(s);assert(out.includes('哇唔哇唔智能体'));assert(out.includes("team-open-settings"));assert(out.includes('setOpen(true)'));});
test('returning from task settings can close the original settings dialog without changing its selected section',()=>{
 const listeners=new Map<string,any>(),cleanups:any[]=[],states:boolean[]=[];let selected:string|undefined;
 const source='const [activeId, setActiveId] = (0, react.useState)(void 0);';
 runInNewContext(adaptNativeClient(source),{react:{useState:()=>[undefined,(id:string)=>{selected=id;}],useEffect:(fn:any)=>cleanups.push(fn())},setOpen:(open:boolean)=>states.push(open),window:{addEventListener:(name:string,fn:any)=>listeners.set(name,fn),removeEventListener:(name:string)=>listeners.delete(name)}});
 listeners.get('team-open-settings')({detail:'tasks'});assert.equal(selected,'tasks');assert.deepEqual(states,[true]);
 listeners.get('team-close-settings')();assert.deepEqual(states,[true,false]);assert.equal(selected,'tasks');
 for(const cleanup of cleanups)cleanup();assert.equal(listeners.size,0);
});
test('video totals count each returned video once, prefer measured seconds and never include images or another member',async()=>{
 const root=mkdtempSync(join(tmpdir(),'hub-video-totals-')),app=new Platform({dataDir:root});try{
  const admin=app.newUser({username:'totalsadmin',password},'admin'),a=app.newUser({username:'totalsa',password},'member'),b=app.newUser({username:'totalsb',password},'member');
  for(const [owner,suffix] of [[a.id,'a'],[b.id,'b']]){app.store.put('task',{id:'task-'+suffix,owner,project:'shared',prompt:'video',state:'completed',created:new Date().toISOString()});app.store.put('pickup',{id:'plan-'+suffix,owner,shots:[{source:{id:'shot'},params:{seconds:4}}],model:{name:'fixture'}});app.store.put('video-job',{id:'job-'+suffix,owner,project:'shared',task:'task-'+suffix,planId:'plan-'+suffix,sourceId:'shot',mediaId:'media-'+suffix,state:'ready',technicalQA:suffix==='a'?{duration:4.08}:undefined});}
  app.store.put('image-job',{id:'image',owner:a.id,task:'task-a',mediaId:'image-media',state:'ready'});app.store.put('video-job',{id:'failed',owner:a.id,task:'task-a',state:'failed'});app.store.put('video-job',{id:'unknown',owner:a.id,task:'task-a',mediaId:'unknown-media',state:'ready'});
  const mine=memberSubmissions(app.store,a);assert.equal(mine.summary.videoCount,2);assert.equal(mine.summary.videoSeconds,4.08);assert.equal(mine.summary.unknownDurations,1);assert.equal(mine.items[0].results.find((r:any)=>r.id==='job-a').durationSource,'measured');assert.equal(mine.groups.length,1);
  const all=memberSubmissions(app.store,admin);assert.equal(all.summary.videoCount,3);assert.equal(all.summary.videoSeconds,8.08);assert.equal(all.items.find(t=>t.owner===b.id)!.results[0].durationSource,'requested');
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('native connection becomes ready when team panel opens before composer without consuming a pending draft',()=>{
 const messages:any[]=[],saved=JSON.stringify({hash:'',text:'existing draft',time:Date.now()}),removed:string[]=[];
 const window:any={parent:{postMessage:(m:any)=>messages.push(m)},addEventListener(){}};
 runInNewContext(nativePageBridge('fixture'),{window,document:{referrer:'http://local/',body:{},readyState:'complete',querySelector:(s:string)=>s==='iframe[data-team-settings]'?{}:null},location:{origin:'http://local',hash:''},URL,MutationObserver:class{observe(){}disconnect(){}},sessionStorage:{getItem:()=>saved,removeItem:(key:string)=>removed.push(key)},setTimeout:()=>0});
 assert(messages.some(m=>m.type==='team-native-ready'));assert.equal(removed.length,0);
});
