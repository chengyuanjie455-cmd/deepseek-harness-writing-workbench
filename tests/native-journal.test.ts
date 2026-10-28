import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {adaptNativeClient} from '../server/native-page.ts';
import {createNativeSyncStatus} from '../native-harness/team-project/native-sync.mjs';
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};
function deferred(){let resolve:any,reject:any;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
function queue(){const pending:any[]=[],items:any[]=[];let done=false;return {push(value:any){const r=pending.shift();if(r)r({value,done:false});else items.push(value);},close(){done=true;for(const r of pending.splice(0))r({done:true});},[Symbol.asyncIterator](){return this;},next(){return items.length?Promise.resolve({value:items.shift(),done:false}):done?Promise.resolve({done:true}):new Promise(r=>pending.push(r));}};}
function load(name:string,dependencies:any,sync?:any){let result:any;const source=readFileSync(new URL('../native-harness/node_modules/@deepseek-ai/'+name+'/lib/client.js',import.meta.url),'utf8');
 vm.runInNewContext(adaptNativeClient(source),{window:{__TEAM_SYNC__:sync,__ModuleLoader__:{load:(m:any)=>result=m.factory((n:string)=>dependencies[n])}},AbortController,AbortSignal,Error,DOMException,console,setTimeout,clearTimeout,queueMicrotask,TextEncoder,TextDecoder,URL});return result;}
const gateway=load('dsh-api-gateway',{'@deepseek-ai/cordis':{Service:class{}}});
function fixture(){
 const changes:any[]=[],health:any[]=[],errors:any[]=[],channels:any[]=[];let page:any=async()=>{throw Error('unexpected page')};
 const sync=createNativeSyncStatus({emit:(v:any)=>health.push(v)});sync.select('session-test');
 const native=load('dsh-api-session-controller',{'@deepseek-ai/cordis':{},'@deepseek-ai/dsh-client-store':{},'@deepseek-ai/dsh-api-gateway/client':gateway},sync);
 const connection={generation:{getSnapshot:()=>({}),subscribe:()=>()=>{}}};
 const remote={$stream:(opts:any)=>new gateway.RemoteStream(connection,opts),session:{follow:(_req:any,signal:AbortSignal)=>{const q=queue();signal.addEventListener('abort',()=>q.close(),{once:true});channels.push(q);return q;},page:(request:any)=>page(request)}};
 const stream=new native.SessionEventStream(remote,{kind:'session',sessionId:'session-test'},{publish:(v:any)=>changes.push(v),failed:(e:any)=>errors.push(e)});
 return {stream,changes,health,errors,channels,page(fn:any){page=fn}};
}
const record=(seq:number)=>({type:'event',event:{seq,time:seq+1,type:'fixture/sync',ignorable:true,data:{}}});
const snapshot=(last:number,first=0)=>({type:'snapshot',cursor:last,records:Array.from({length:last-first+1},(_,i)=>record(first+i)),hasMore:first>0,assistantStream:{revision:0}});
async function open(f:any,last=1){const pending=f.stream.open({maxMessages:50});f.channels[0].push(snapshot(last));await pending;return f;}
const sequences=(f:any)=>Array.from(f.changes.at(-1).entries??[],(v:any)=>v.event.seq);

test('native opening publishes its complete bounded snapshot and actual sync status',async()=>{const f=await open(fixture(),3);assert.deepEqual(sequences(f),[0,1,2,3]);assert.equal(f.health.at(-1).phase,'live');await f.stream.dispose();assert.equal(f.health.at(-1).phase,'waiting');});
test('duplicate live events are ignored without replacing history',async()=>{const f=await open(fixture());f.channels[0].push(record(1));f.channels[0].push(record(2));await flush();assert.equal(f.changes.length,2);assert.equal(f.changes[1].entry.event.seq,2);await f.stream.dispose();});
test('missing event repairs from native history while merging concurrent live events',async()=>{const f=await open(fixture()),q=deferred();f.page(async (r:any)=>{assert.equal(r.throughSeq,3);return q.promise});f.channels[0].push(record(3));await flush();f.channels[0].push(record(4));await flush();assert.equal(f.changes.length,1);q.resolve({ok:true,value:snapshot(3)});await flush();assert.deepEqual(sequences(f),[0,1,2,3,4]);assert.equal(f.errors.length,0);await f.stream.dispose();});
test('carrier loss keeps old content then native reconnect replaces from authoritative snapshot',async()=>{const f=await open(fixture());f.channels[0].close();await flush();assert(f.health.some((v:any)=>v.phase==='reconnecting'));assert.equal(f.changes.length,1);assert.equal(f.channels.length,2);f.channels[1].push(snapshot(4));await flush();assert.deepEqual(sequences(f),[0,1,2,3,4]);assert.equal(f.health.at(-1).phase,'live');await f.stream.dispose();});
test('superseded history response cannot overwrite the new connection generation',async()=>{const f=await open(fixture()),q=deferred();f.page(()=>q.promise);f.channels[0].push(record(3));await flush();f.stream.restart();await flush();f.channels[1].push(snapshot(5));await flush();q.resolve({ok:true,value:snapshot(3)});await flush();assert.deepEqual(sequences(f),[0,1,2,3,4,5]);assert.equal(f.errors.length,0);await f.stream.dispose();});
test('cursor regression fails visibly instead of claiming recovery',async()=>{const f=await open(fixture(),4);f.stream.restart();await flush();f.channels[1].push(snapshot(2));await flush();assert.equal(f.errors.length,1);assert.equal(f.health.at(-1).phase,'error');assert.deepEqual(sequences(f),[0,1,2,3,4]);await f.stream.dispose();});
test('incomplete gap repair does not publish a false complete window',async()=>{const f=await open(fixture());f.page(async()=>({ok:true,value:snapshot(2)}));f.channels[0].push(record(4));await flush();assert.equal(f.changes.length,1);assert.equal(f.errors.length,1);assert.equal(f.health.at(-1).phase,'error');await f.stream.dispose();});
test('initial history failure is reported rather than left loading',async()=>{const bad=fixture(),opening=bad.stream.open({maxMessages:50});bad.channels[0].push({...snapshot(1),cursor:3});await assert.rejects(opening);assert.equal(bad.health.at(-1).phase,'error');await bad.stream.dispose();});
test('leaving a session prevents old history from arriving later',async()=>{const f=await open(fixture());await f.stream.dispose();const n=f.changes.length;f.channels[0].push(record(2));await flush();assert.equal(f.changes.length,n);assert.equal(f.health.at(-1).phase,'waiting');});
test('status cannot cross session generations or revive a closed one',()=>{const states:any[]=[];const s=createNativeSyncStatus({emit:v=>states.push(v)});s.select('session-a');const old=s.begin('session-a'),fresh=s.begin('session-a');s.update(fresh,'live');s.update(old,'error');assert.equal(states.at(-1).phase,'live');s.select('session-b');assert.equal(states.at(-1).phase,'waiting');s.update(fresh,'error');assert.equal(states.at(-1).phase,'waiting');s.select('session-a');s.end(fresh);s.update(fresh,'live');assert.equal(states.at(-1).phase,'waiting');});
test('display observer failure cannot interrupt native data delivery',()=>{const s=createNativeSyncStatus({emit(){throw Error('detached parent')}});const token=s.begin('session-a');assert.doesNotThrow(()=>{s.select('session-a');s.update(token,'live');s.end(token)});});
test('native sync adapter is idempotent and fails on incompatible instrumentation anchors',()=>{const src=readFileSync(new URL('../native-harness/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js',import.meta.url),'utf8');const once=adaptNativeClient(src);assert.equal(adaptNativeClient(once),once);assert.throws(()=>adaptNativeClient(src.replace('constructor(remote, address, options) {','constructor(remote, renamed, options) {')),/接口变化/);});
