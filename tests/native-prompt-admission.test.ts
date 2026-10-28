import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installPromptAdmissionGuard} from '../native-harness/prompt-admission.mjs';

function fixture(){
 const listeners=new Map<string,Set<Function>>(),journal=new Set<string>(),received:any[]=[];
 const commands={async prompt(request:any){const key=JSON.stringify([request.sessionId,request.requestId]);if(!journal.has(key))received.push(request);return {accepted:true};}},original=commands.prompt;
 const ctx={sessionController:{commands},on(name:string,listener:Function){let rows=listeners.get(name);if(!rows)listeners.set(name,rows=new Set());rows.add(listener);return()=>{rows!.delete(listener);};}};
 const emit=(name:string,...args:any[])=>{for(const listener of listeners.get(name)??[])listener(...args);};
 const append=(sessionId:string,requestId:string)=>{journal.add(JSON.stringify([sessionId,requestId]));emit('session/event',{id:sessionId},{type:'user/message',data:{source:{kind:'user',rpcId:requestId}}});};
 const dispose=installPromptAdmissionGuard(ctx);
 return {commands,original,received,journal,emit,append,dispose};
}

test('an idle native inbox-to-journal gap and concurrent retransmissions admit a request only once',async()=>{
 const f=fixture(),request={sessionId:'one',requestId:'same-id',mode:'queue',content:[{type:'text',text:'ten images'}]};try{
  const values=await Promise.all(Array.from({length:12},()=>f.commands.prompt(request)));assert(values.every(v=>v.accepted));assert.equal(f.received.length,1);
  await f.commands.prompt({...request});assert.equal(f.received.length,1,'an accepted receipt remains while the inbox is empty but the journal has not appended');
  f.append('one','same-id');await f.commands.prompt(request);assert.equal(f.received.length,1,'after native journaling the original controller supplies durable deduplication');
 }finally{f.dispose();}
});

test('distinct request IDs, sessions and delivery modes retain the native admission behavior',async()=>{
 const f=fixture();try{
  await Promise.all([{sessionId:'one',requestId:'a',mode:'queue'},{sessionId:'one',requestId:'b',mode:'steer'},{sessionId:'two',requestId:'a',mode:'queue'}].map(v=>f.commands.prompt(v)));
  assert.equal(f.received.length,3);assert.deepEqual(f.received.map(v=>v.mode).sort(),['queue','queue','steer']);
 }finally{f.dispose();}
});

test('native admission failures remain visible and an unaccepted request can be tried again',async()=>{
 let calls=0;const error=Error('native attachment validation rejected');
 const commands={async prompt(_request?:any){if(++calls===1)throw error;return {accepted:true};}},ctx={sessionController:{commands},on(){return()=>{};}},dispose=installPromptAdmissionGuard(ctx);
 try{await assert.rejects(commands.prompt({sessionId:'one',requestId:'one'} as never),e=>e===error);assert.deepEqual(await commands.prompt({sessionId:'one',requestId:'one'} as never),{accepted:true});assert.equal(calls,2);}finally{dispose();}
});

test('native service replacement is explicit and plugin disposal restores the original method and listeners',async()=>{
 assert.throws(()=>installPromptAdmissionGuard({on:()=>undefined}),/接收接口变化/);
 const f=fixture();await f.commands.prompt({sessionId:'one',requestId:'one'});f.dispose();assert.equal(f.commands.prompt,f.original);await f.commands.prompt({sessionId:'one',requestId:'one'});assert.equal(f.received.length,2);
});
