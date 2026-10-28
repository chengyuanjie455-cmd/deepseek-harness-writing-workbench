import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {NativeConnection} from '../web/native-connection.ts';
import {nativePageBridge} from '../server/native-page.ts';
const source=readFileSync(new URL('../native-harness/team-project/client.js',import.meta.url),'utf8').split('window.__ModuleLoader__.load')[0];
const helpers=()=>vm.runInNewContext(source+';({createTeamPlanPoller,createChatGalleryFeed})',{Date,AbortController,Promise});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve!:(v:any)=>void,reject!:(e:any)=>void;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function timers(){let id=0;const pending=new Map<number,{fn:Function,ms:number}>();return {setTimer:(fn:Function,ms:number)=>{pending.set(++id,{fn,ms});return id;},clearTimer:(id:number)=>pending.delete(id),async run(ms:number){const found=[...pending].find(([,v])=>v.ms===ms);assert(found,'expected timer '+ms);pending.delete(found[0]);return found[1].fn();},pending};}
const row=(state:string)=>({kind:'image',sessionId:'session-a',plan:{id:'p',owner:'member',jobs:[{id:'j',state,...(state==='ready'?{mediaId:'original'}:{})}]}});

for(const denied of [false,true])test('obsolete native status '+(denied?'401':'instance')+' cannot invalidate a new connection',async()=>{
 const status=deferred();let opens=0;
 const c=new NativeConnection({emit:()=>{},snapshot:async()=>'#/session/kept',api:async path=>path==='/native/open'?{url:'http://localhost/harness/shared/',scope:'member:shared',serverInstance:'s'+(++opens),generation:'g'+opens}:status.promise});
 await c.open();c.ready();const checking=c.check();await c.open();c.ready(c.state.version);
 if(denied)status.reject(Object.assign(Error('old login'),{status:401}));else status.resolve({state:'ready',serverInstance:'s0',generation:'g0'});
 await checking;await flush();assert.equal(opens,2);assert.equal(c.state.blocked,false);assert.equal(c.state.phase,'ready');c.stop();
});
test('ready from an old iframe or a revoked login cannot clear recovery state',async()=>{
 let denied=false;const c=new NativeConnection({emit:()=>{},snapshot:async()=>'',api:async path=>{if(denied)throw Object.assign(Error('revoked'),{status:401});return path==='/native/open'?{url:'http://localhost/harness/shared/',scope:'u:p'}:{state:'ready'};}});
 await c.open();const previous=c.state.version;await c.open();c.ready(previous);assert.equal(c.state.ready,false);c.ready(c.state.version);assert(c.state.ready);
 denied=true;await c.check();c.loaded();c.ready(c.state.version);assert.equal(c.state.phase,'blocked');c.stop();
});
test('native bridge echoes render generation and snapshot request identity without submitting',()=>{
 const sent:any[]=[],events=new Map<string,Function>(),parent={postMessage:(v:any)=>sent.push(v)};
 const composer={textContent:''};const document={referrer:'https://host.example/',readyState:'complete',body:{},querySelector:(s:string)=>s.startsWith('[data-composer')?composer:s.startsWith('button')?{}:null};
 const window={parent,addEventListener:(n:string,f:Function)=>events.set(n,f)};
 vm.runInNewContext(nativePageBridge('member:p'),{window,document,location:{hash:'#/session/a',origin:'https://host.example'},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},URL,Date,MutationObserver:class{observe(){}disconnect(){}},setTimeout(){}});
 const receive=(data:any)=>events.get('message')!({source:parent,origin:'https://host.example',data:{scope:'member:p',...data}});
 receive({type:'team-native-probe',version:7});assert.equal(sent.find(v=>v.type==='team-native-ready'&&v.version===7)?.version,7);assert.equal(sent.at(-1).type,'team-native-sync');assert.equal(sent.at(-1).version,7);
 receive({type:'team-native-snapshot',requestId:42});assert.equal(sent.at(-1).requestId,42);assert.equal(sent.at(-1).type,'team-native-snapshot-saved');
 const count=sent.length;events.get('message')!({source:parent,origin:'https://other.example',data:{scope:'member:p',type:'team-native-probe',version:8}});assert.equal(sent.length,count);
});
test('an old plan poll cannot overwrite a confirmed newer media result',async()=>{
 const q=deferred(),clock=timers(),updates:any[]=[],changes:any[]=[];let calls=0;
 const poll=helpers().createTeamPlanPoller({...clock,hidden:()=>false,onVisible:()=>()=>{},fetchBatch:()=>++calls===1?q.promise:Promise.resolve({items:[row('ready')]}),onChange:(v:any)=>changes.push(v)});
 poll.subscribe('image/p',row('running'),(v:any)=>{if(v)updates.push(v);});const first=clock.run(0);poll.refresh('image/p',row('ready'));q.resolve({items:[row('running')]});await first;
 assert.equal(updates.at(-1).plan.jobs[0].state,'ready');assert.equal(changes.length,1);await clock.run(0);assert.equal(calls,2);poll.dispose();
});
test('leaving and reopening a plan rejects the previous subscription response',async()=>{
 const q=deferred(),clock=timers(),updates:any[]=[];const poll=helpers().createTeamPlanPoller({...clock,hidden:()=>false,onVisible:()=>()=>{},fetchBatch:()=>q.promise});
 const off=poll.subscribe('image/p',row('running'),()=>{});const first=clock.run(0);off();poll.subscribe('image/p',row('ready'),(v:any)=>updates.push(v));q.resolve({items:[row('queued')]});await first;
 assert.equal(updates.length,1);assert.equal(updates[0].plan.jobs[0].mediaId,'original');poll.dispose();
});
test('disposed plan subscribers receive no late results or media notifications',async()=>{
 const q=deferred(),clock=timers();let notifications=0,updates=0;const poll=helpers().createTeamPlanPoller({...clock,hidden:()=>false,onVisible:()=>()=>{},fetchBatch:()=>q.promise,onChange:()=>notifications++});
 poll.subscribe('image/p',row('running'),()=>updates++);const first=clock.run(0);poll.dispose();q.resolve({items:[row('ready')]});await first;assert.equal(updates,1);assert.equal(notifications,0);assert.equal(clock.pending.size,0);
});
test('gallery refresh failure keeps originals and recovers on foreground without recreating work',async()=>{
 const clock=timers(),states:any[]=[];let wake!:()=>void,offline=false,reads=0;
 const feed=helpers().createChatGalleryFeed({...clock,hidden:()=>false,onVisible:(f:any)=>{wake=f;return()=>{};},emit:(v:any)=>states.push(v),fetchItems:async()=>{reads++;if(offline)throw Error('offline');return {items:[{id:'media:original'}],warnings:[]};}});
 await feed.refresh();offline=true;await feed.refresh();assert.equal(states.at(-1).items[0].id,'media:original');assert.equal(states.at(-1).error,'offline');
 offline=false;wake();await flush();assert.equal(reads,3);assert.equal(states.at(-1).error,'');assert(states.at(-1).checkedAt>0);feed.dispose();assert.equal(clock.pending.size,0);
});
test('gallery wake events coalesce while a request is in flight',async()=>{
 const q=deferred(),clock=timers();let reads=0;const feed=helpers().createChatGalleryFeed({...clock,hidden:()=>false,onVisible:()=>()=>{},emit:()=>{},fetchItems:async()=>{reads++;return q.promise;}});
 const first=feed.refresh();await flush();feed.refresh();feed.refresh();assert.equal(reads,1);q.resolve({items:[],warnings:[]});await first;await clock.run(0);assert.equal(reads,2);feed.dispose();
});
test('gallery timeout aborts the read, keeps prior media and schedules recovery',async()=>{
 const clock=timers();let stuck=false;
 const feed=helpers().createChatGalleryFeed({...clock,hidden:()=>false,onVisible:()=>()=>{},emit:()=>{},fetchItems:async(signal:AbortSignal)=>stuck?new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true})):{items:[{id:'kept'}],warnings:[]}});
 await feed.refresh();stuck=true;const read=feed.refresh();await flush();await clock.run(20000);await read;assert.equal(feed.getSnapshot().items[0].id,'kept');assert.match(feed.getSnapshot().error,/超时/);assert([...clock.pending.values()].some(v=>v.ms===10000));feed.dispose();
});
test('leaving a chat aborts its gallery read and drops late account data',async()=>{
 const clock=timers(),q=deferred(),states:any[]=[];let signal!:AbortSignal;
 const feed=helpers().createChatGalleryFeed({...clock,hidden:()=>false,onVisible:()=>()=>{},emit:(v:any)=>states.push(v),fetchItems:async(s:AbortSignal)=>{signal=s;return q.promise;}});
 const read=feed.refresh();await flush();feed.dispose();assert(signal.aborted);const count=states.length;q.resolve({items:[{id:'old-account'}],warnings:[]});await read;assert.equal(states.length,count);assert.equal(clock.pending.size,0);
});
