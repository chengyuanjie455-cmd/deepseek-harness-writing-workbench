import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createNativeReferenceBridge} from '../native-harness/team-project/reference-bridge.mjs';
import {nativePageBridge} from '../server/native-page.ts';

function setup(){
 const saved=new Map<string,string>(),edits:string[]=[];let active='session-one',ready=true;
 const options={scope:'member:project',project:'project',storage:{getItem:(k:string)=>saved.get(k)??null,setItem:(k:string,v:string)=>saved.set(k,v)},currentSession:()=>active,insert:async(_s:string,text:string)=>{if(!ready)return false;edits.push(text);return true;}};
 const request={protocolVersion:1,version:7,project:'project',session:'session-one',requestId:'ref-1',text:'引用：EP001 / v1'};
 return {options,request,edits,bridge:createNativeReferenceBridge(options),session:(v:string)=>active=v,ready:(v:boolean)=>ready=v};
}
test('reference receipts deduplicate lost replies, concurrent retries and iframe reloads without sending a prompt',async()=>{
 const f=setup();const values=await Promise.all(Array.from({length:8},()=>f.bridge.receive(f.request)));
 assert(values.every(v=>v.state==='inserted'));assert.equal(f.edits.length,1);
 assert.equal((await createNativeReferenceBridge(f.options).receive(f.request)).state,'inserted');assert.equal(f.edits.length,1);
 assert.equal((await f.bridge.receive({...f.request,requestId:'ref-2'})).state,'inserted');assert.equal(f.edits.length,2);
});
test('unready inputs and wrong session/project/version retain references rather than acknowledging loss',async()=>{
 const f=setup();f.ready(false);assert.equal((await f.bridge.receive(f.request)).state,'waiting');f.ready(true);
 f.session('session-two');assert.equal((await f.bridge.receive(f.request)).state,'waiting');assert.equal(f.edits.length,0);
 f.session('session-one');assert.equal((await f.bridge.receive({...f.request,project:'foreign'})).state,'rejected');
 assert.equal((await f.bridge.receive({...f.request,protocolVersion:2})).state,'rejected');
 assert.equal((await f.bridge.receive(f.request)).state,'inserted');assert.equal(f.edits.length,1);
});
test('native input actions preserve selected text, reference chips, attachments and admission locks',()=>{
 const client=readFileSync(new URL('../native-harness/team-project/client.js',import.meta.url),'utf8').split('window.__ModuleLoader__.load')[0];
 const insert=vm.runInNewContext(client+';insertNativeReference');
 const calls:any[]=[];const actions={captureInsertion:()=>({start:1,end:4,draftRev:9}),insertText:(text:string,span:any)=>{calls.push({text,span});return true;}};
 const input={draft:'既有草稿与引用',phase:'plain',attachmentIds:['original-upload'],occurrences:[{ref:'asset'}]};
 assert.equal(insert(actions,input,'新引用'),true);assert.equal(calls[0].text,'\n\n新引用');assert.equal(calls[0].span.start,4);assert.equal(calls[0].span.end,4);
 assert.deepEqual(input.attachmentIds,['original-upload']);assert.equal(input.occurrences.length,1);
 for(const phase of ['adjudicating','submitting'])assert.equal(insert(actions,{...input,phase},'不应写入'),false);
 assert.equal(calls.length,1);assert.equal(insert({...actions,insertText:()=>false},input,'修订冲突'),false);
});
test('authenticated bridge validates source, origin, generation and scope before native input delivery',async()=>{
 const sent:any[]=[],events=new Map<string,Function>(),parent={postMessage:(v:any)=>sent.push(v)},edits:string[]=[];
 const window:any={parent,__TEAM_CURRENT_SESSION__:'session-one',__TEAM_REFERENCE_INPUTS__:new Map([['session-one',(t:string)=>{edits.push(t);return true;}]]),addEventListener:(n:string,f:Function)=>events.set(n,f)};
 const document={referrer:'https://host.example/',readyState:'complete',body:{},querySelector:(s:string)=>s.startsWith('[data-composer')?{}:s.startsWith('button')?{}:null};
 vm.runInNewContext(nativePageBridge('member:project',{project:'project',admin:false}),{window,document,location:{hash:'#/session/one',origin:'https://host.example'},sessionStorage:{getItem:()=>null,setItem(){}},URL,Date,Map,Promise,MutationObserver:class{observe(){}disconnect(){}},setTimeout(){}});
 const receive=(data:any,origin='https://host.example',source=parent)=>events.get('message')!({source,origin,data:{scope:'member:project',...data}});
 receive({type:'team-native-probe',version:7});
 const request={type:'team-native-reference',protocolVersion:1,version:7,project:'project',session:'session-one',requestId:'r',text:'新引用'};
 receive(request,'https://attacker.example');receive({...request,scope:'foreign'});receive({...request,version:6});receive(request,undefined,{} as any);
 await new Promise(setImmediate);assert.equal(edits.length,0);
 receive(request);receive(request);await new Promise(setImmediate);assert.deepEqual(edits,['新引用']);assert(sent.some(v=>v.type==='team-native-reference-receipt'&&v.state==='inserted'));
});
