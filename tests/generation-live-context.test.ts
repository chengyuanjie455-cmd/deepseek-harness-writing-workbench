import {test} from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../native-harness/team-project/index.mjs',import.meta.url),'utf8');
test('native model assembly reads current-session durable generation results without generating or leaking prompt/receipt',async()=>{
 let handler:any,request:any,available=true;const c:any={Date,AbortSignal,process:{env:{TEAM_NATIVE_KEY:'fixture'}},fetch:async(_url:string,options:any)=>{const payload=JSON.parse(options.body);if(payload.action==='codex_status')return {ok:true,json:async()=>({configured:false,items:[]})};request=payload;if(!available)throw Error('offline');return {ok:true,json:async()=>({total:1,items:[{kind:'image',plan:{id:'plan',model:{name:'gpt-image'},prompt:'private prompt',jobs:[{id:'job',state:'ready',mediaId:'original',receipt:{secret:true}}]}}]})};}};
 vm.runInNewContext(source.slice(source.indexOf('export function generationContext'),source.indexOf('export function failureEvents')).replaceAll('export function','function'),c);
 c.registerGenerationContext({on:(_event:string,fn:any)=>handler=fn},{baseURL:'http://host/status'});
 const result=await handler({}, {agent:{session:{id:'current-native-chat'}}},async()=>({contexts:[]}));assert.equal(request.action,'status');assert.equal(request.sessionId,'current-native-chat');assert.equal(result.contexts.length,1);assert.match(result.contexts[0].text,/ready/);assert.match(result.contexts[0].text,/media\/original/);assert(!result.contexts[0].text.includes('private prompt'));assert(!result.contexts[0].text.includes('secret'));
 available=false;const stale=await handler({}, {agent:{session:{id:'current-native-chat'}}},async()=>({contexts:[]}));assert.match(stale.contexts[0].text,/不能把历史状态当成当前进度/);
});
test('chat polling recovers after request timeout and never treats a pending job as a finished draft',async()=>{
 const script=readFileSync(new URL('../native-harness/team-project/client.js',import.meta.url),'utf8').split('window.__ModuleLoader__.load')[0];let clock=0,timer:any,visible:any,calls=0;class Clock extends Date{static now(){return clock;}}
 const factory=vm.runInNewContext(script+';createTeamPlanPoller',{Date:Clock});const updates:any[]=[];
 const poll=factory({fetchBatch:async()=>{if(++calls===1)throw Error('request timeout');return {items:[{kind:'image',plan:{id:'p',state:'awaiting_confirmation',jobs:[{state:calls<3?'submitting':'ready'}]}}]};},setTimer:(fn:any)=>timer=fn,clearTimer:()=>{timer=null;},hidden:()=>false,onVisible:(fn:any)=>{visible=fn;return()=>{};}});
 poll.subscribe('image/p',{kind:'image',plan:{id:'p',jobs:[{state:'submitting'}]}},(v:any,e:any)=>updates.push(v??e));await timer();assert.equal(updates.at(-1),'request timeout');clock=10000;await timer();assert.equal(updates.at(-1).plan.jobs[0].state,'submitting');assert(timer);visible();await timer();assert.equal(updates.at(-1).plan.jobs[0].state,'ready');assert.equal(timer,null);poll.dispose();
});

test('automatic original-download recovery updates the inline gallery on its normal cadence without a new generation request',async()=>{
 const script=readFileSync(new URL('../native-harness/team-project/client.js',import.meta.url),'utf8').split('window.__ModuleLoader__.load')[0];let clock=0,timer:any,calls=0;class Clock extends Date{static now(){return clock;}}
 const factory=vm.runInNewContext(script+';createTeamPlanPoller',{Date:Clock}),updates:any[]=[];
 const row=(ready=false)=>({kind:'image',plan:{id:'p',jobs:[ready?{id:'j',state:'ready',mediaId:'original',createAttempts:1,downloadAttempts:2}:{id:'j',state:'download_failed',nextRecoveryAt:10000,createAttempts:1,downloadAttempts:1}]}});
 const poll=factory({fetchBatch:async(keys:any)=>{assert.deepEqual(Array.from(keys),['image/p']);calls++;return {items:[row(calls>1)]};},setTimer:(fn:any)=>timer=fn,clearTimer:()=>{timer=null;},hidden:()=>false,onVisible:()=>()=>{}});
 poll.subscribe('image/p',row(),(v:any)=>updates.push(v));await timer();assert.equal(updates.at(-1).plan.jobs[0].state,'download_failed');clock=5000;await timer();assert.equal(calls,2);assert.equal(updates.at(-1).plan.jobs[0].mediaId,'original');assert.equal(updates.at(-1).plan.jobs[0].createAttempts,1);assert.equal(timer,null);poll.dispose();
});
