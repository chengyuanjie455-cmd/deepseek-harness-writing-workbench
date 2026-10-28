import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProjectRead} from '../web/project-read.ts';

test('a slower read still becomes visible during continuous events and only one follow-up is queued',async()=>{
 const pending:((value:number)=>void)[]=[],visible:number[]=[],busy:boolean[]=[];let active=0,peak=0,calls=0;
 const feed=new ProjectRead({read:async()=>{calls++;active++;peak=Math.max(peak,active);const value=await new Promise<number>(r=>pending.push(r));active--;return value;},commit:value=>visible.push(value),fail:error=>{throw error;},busy:value=>busy.push(value)});
 const first=feed.refresh();for(let i=0;i<100;i++)void feed.refresh();assert.equal(calls,1);pending.shift()!(1);
 await new Promise(r=>setImmediate(r));assert.deepEqual(visible,[1]);assert.equal(calls,2);
 for(let i=0;i<100;i++)void feed.refresh();pending.shift()!(2);await new Promise(r=>setImmediate(r));assert.deepEqual(visible,[1,2]);assert.equal(calls,3);
 pending.shift()!(3);await first;assert.deepEqual(visible,[1,2,3]);assert.equal(peak,1);assert.deepEqual(busy,[true,false]);feed.close();
});

test('a failed refresh preserves the last good view and later events can recover it',async()=>{
 const views:number[]=[],failures:string[]=[];let attempt=0;
 const feed=new ProjectRead({read:async()=>{if(++attempt===2)throw Error('synthetic read failed');return attempt;},commit:value=>views.push(value),fail:error=>failures.push((error as Error).message)});
 await feed.refresh();await feed.refresh();assert.deepEqual(views,[1]);assert.deepEqual(failures,['synthetic read failed']);await feed.refresh();assert.deepEqual(views,[1,3]);feed.close();
});

test('switching project, query or user drops the old result and cannot start its queued follow-up',async()=>{
 let finish!:(value:string)=>void,oldCalls=0;const views:string[]=[];
 const old=new ProjectRead({read:()=>{oldCalls++;return new Promise<string>(r=>finish=r);},commit:value=>views.push(value),fail:()=>assert.fail('disposed reader published an error')});
 const work=old.refresh();void old.refresh();old.close();
 const current=new ProjectRead({read:async()=>'new query',commit:value=>views.push(value),fail:()=>assert.fail('unexpected failure')});await current.refresh();finish('old query');await work;
 assert.deepEqual(views,['new query']);assert.equal(oldCalls,1);await old.refresh();assert.equal(oldCalls,1);current.close();
});

test('an event arriving as the previous result settles cannot be lost between reads',async()=>{
 const views:number[]=[];let count=0;
 const feed=new ProjectRead({read:async()=>++count,commit:value=>{views.push(value);if(value===1)queueMicrotask(()=>void feed.refresh());},fail:error=>{throw error;}});
 await feed.refresh();await new Promise(r=>setImmediate(r));assert.deepEqual(views,[1,2]);feed.close();
});
