import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {registerNativeModelTrace} from '../native-harness/team-project/model-trace.mjs';
test('native trace metadata remains session-local across concurrent streams and never reaches another host or a wrong credential',async()=>{
 const original=globalThis.fetch,previous=process.env.TEAM_NATIVE_KEY,calls:any[]=[];let handler:any,dispose:()=>void=()=>{};
 process.env.TEAM_NATIVE_KEY='synthetic-local-hop';
 globalThis.fetch=(async(input:any,init:any)=>{calls.push({url:String(input),headers:Object.fromEntries(new Headers(init?.headers)),body:init?.body});return new Response('synthetic');}) as typeof fetch;
 try{
  registerNativeModelTrace({on(name:string,fn:any){assert.equal(name,'llm/stream');handler=fn;},effect(fn:any){dispose=fn();}},{baseURL:'http://host.docker.internal:12345/native-model/key/team'});
  const endpoint='http://host.docker.internal:12345/native-model/key/chat/completions';
  const send=(url=endpoint,key='synthetic-local-hop')=>fetch(url,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:'unchanged body'});
  async function* stream(n:number){await delay((8-n)*2);await send();yield n;await delay(n*2);await send('https://synthetic.invalid/chat/completions');await send(endpoint,'wrong-key');}
  await Promise.all(Array.from({length:8},async(_,n)=>{for await(const value of handler({sessionId:'session-'+n,purpose:n===0?'compaction':undefined},()=>stream(n)))assert.equal(value,n);}));
  const local=calls.filter(r=>r.url===endpoint&&r.headers.authorization==='Bearer synthetic-local-hop');assert.equal(local.length,8);assert.equal(new Set(local.map(r=>r.headers['x-team-native-session'])).size,8);assert.equal(new Set(local.map(r=>r.headers['x-team-native-attempt'])).size,8);assert(local.some(r=>r.headers['x-team-native-purpose']==='compaction'));
  assert(local.every(r=>r.body==='unchanged body'));
  for(const c of calls.filter(r=>r.url!==endpoint||r.headers.authorization==='Bearer wrong-key'))assert.equal(c.headers['x-team-native-session'],undefined);
  await send();assert.equal(calls.at(-1).headers['x-team-native-session'],undefined);dispose();await send();assert.equal(calls.at(-1).headers['x-team-native-session'],undefined);
 }finally{dispose();globalThis.fetch=original;if(previous===undefined)delete process.env.TEAM_NATIVE_KEY;else process.env.TEAM_NATIVE_KEY=previous;}
});

test('native pressure uses the existing meter and stays on the exact authenticated hop, excluding auxiliary summaries',async()=>{
 const original=globalThis.fetch,previous=process.env.TEAM_NATIVE_KEY,calls:any[]=[];let handler:any,dispose=()=>{};process.env.TEAM_NATIVE_KEY='synthetic-meter-hop';
 globalThis.fetch=(async(input:any,init:any)=>{calls.push({url:String(input),headers:Object.fromEntries(new Headers(init?.headers)),body:init?.body});return new Response('synthetic');}) as typeof fetch;
 try{
  registerNativeModelTrace({agents:{get:(id:string)=>({session:{id}})},get:(name:string)=>name==='tokenMeter'?{measure:(session:any)=>({totalTokens:session.id==='a'?6000:9000,logRevision:123,baseline:{kind:'usage'}})}:undefined,on:(_name:string,fn:any)=>handler=fn,effect:(fn:any)=>dispose=fn()},{baseURL:'http://host.docker.internal:12345/native-model/key/team'});
  const url='http://host.docker.internal:12345/native-model/key/chat/completions';
  async function* send(){await fetch(url,{method:'POST',headers:{Authorization:'Bearer synthetic-meter-hop'},body:'original body'});await fetch('https://synthetic.invalid/chat/completions',{method:'POST',body:'original body'});yield 1;}
  for(const options of [{sessionId:'a'},{sessionId:'b'},{sessionId:'a',purpose:'compaction'}])for await(const _ of handler(options,send)){}
  assert.equal(calls[0].headers['x-team-native-context-tokens'],'6000');assert.equal(calls[2].headers['x-team-native-context-tokens'],'9000');assert.equal(calls[4].headers['x-team-native-context-tokens'],undefined);assert(calls.filter(v=>v.url!==url).every(v=>v.headers['x-team-native-context-tokens']===undefined));assert(calls.every(v=>v.body==='original body'));
 }finally{dispose();globalThis.fetch=original;if(previous===undefined)delete process.env.TEAM_NATIVE_KEY;else process.env.TEAM_NATIVE_KEY=previous;}
});

test('the native plugin still imports when an older running host has not copied the optional trace companion',async()=>{
 const {mkdtempSync,copyFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {pathToFileURL}=await import('node:url');const root=mkdtempSync(join(tmpdir(),'native-trace-compatible-'));
 try{for(const file of ['index.mjs','submissions.mjs'])copyFileSync(new URL('../native-harness/team-project/'+file,import.meta.url),join(root,file));const plugin=await import(pathToFileURL(join(root,'index.mjs')).href);assert.equal(plugin.name,'team-project-integration');assert(plugin.teamDefinitions.some((r:any)=>r[0]==='team_video_generate'));assert.equal(typeof plugin.registerGenerationContext,'function');
 }finally{rmSync(root,{recursive:true,force:true});}
});
