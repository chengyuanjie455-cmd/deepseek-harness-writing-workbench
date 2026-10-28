import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,hash} from '../server/store.ts';
import {nativeModelProfile,nativeCatalogProfile,nativeContextPolicies} from '../server/model-capabilities.ts';
test('native catalog uses the selected connection window, output, modalities and exact declared reasoning efforts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-model-profile-')),store=new Store(dir);
 try{
  const c={metadata:{contextWindow:64000,maxTokens:8000,inputModalities:['text','image'],efforts:['off','low','high','max']}};
  const profile=nativeModelProfile(store,{id:'model',name:'Declared model'},c);
  assert.equal(profile.contextWindow,64000);assert.equal(profile.maxTokens,8000);assert.deepEqual(profile.input,['text','image']);assert.equal(profile.reasoningEfforts.max,'max');assert(!('medium' in profile.reasoningEfforts));
  assert.deepEqual(c.metadata.efforts,['off','low','high','max']);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('small model contexts receive fitting native compaction reserves while unknown capacities are not invented',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-context-policy-')),store=new Store(dir);
 try{const models=[{id:'small'},{id:'large'},{id:'unknown'}],connections:any={small:{metadata:{contextWindow:8192,maxTokens:1024}},large:{metadata:{contextWindow:1000000,maxTokens:65536}},unknown:{}};
  const policies=nativeContextPolicies(store,models,id=>connections[id]);assert.equal(policies.length,2);
  for(const p of policies){const c=connections[p.model].metadata,trigger=Math.floor(Math.min(c.contextWindow*p.thresholdRatio,c.contextWindow-c.maxTokens-p.headroomTokens));assert(trigger>0);assert((c.contextWindow-c.maxTokens)*p.retainRatio<trigger);assert(p.maxTokens>0&&p.maxTokens<=c.maxTokens);}
  assert(policies[0].headroomTokens<8192);assert.equal(policies[1].headroomTokens,65536);assert.equal(nativeModelProfile(store,{id:'small'},{...connections.small,limits:{maxTokens:512}}).maxTokens,512);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('native catalog can recover current-credential metadata, without borrowing another key or provider',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-model-directory-')),store=new Store(dir);
 try{
  const c={provider:'ruiyun',model:'same-name',apiKey:'fixture-current-key'};
  store.put('model-directory',{id:hash(JSON.stringify([c.provider,hash(c.apiKey)])),provider:c.provider,models:[{id:c.model,contextWindow:32000,maxTokens:2048,inputModalities:['text'],efforts:['low']}]});
  assert.equal(nativeModelProfile(store,{id:'m',name:'Model'},c).contextWindow,32000);
  assert.equal(nativeModelProfile(store,{id:'other',name:'Other'},{...c,apiKey:'different-fixture-key'}).contextWindow,undefined);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('automatic native profile exposes a configured vision fallback and its context window without changing fixed model profiles',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-auto-profile-')),store=new Store(dir);
 try{
  store.put('model-routing-policy',{id:'shared',enabled:true,primaryModelId:'text',fallbackModelIds:['vision','unknown']});
  const connections:any={text:{configId:'a',baseURL:'https://synthetic.invalid/a',apiKey:'synthetic-a',metadata:{contextWindow:8192,maxTokens:1024,inputModalities:['text'],efforts:['off','low']}},vision:{configId:'b',baseURL:'https://synthetic.invalid/b',apiKey:'synthetic-b',metadata:{contextWindow:128000,maxTokens:8192,inputModalities:['text','image'],efforts:['off','high']}},unknown:{configId:'c',metadata:{inputModalities:['audio']}}};
  const catalog:any={modelConnection:(id:string)=>connections[id==='team-auto'?'text':id]},profile=nativeCatalogProfile(store,catalog,'shared',{id:'team-auto',name:'自动'});
  assert.deepEqual(profile.input,['text','image']);assert.equal(profile.contextWindow,128000);assert.equal(profile.maxTokens,8192);assert.equal(profile.reasoningEfforts.high,'high');assert(!profile.input.includes('audio'));
  const fixed=nativeCatalogProfile(store,catalog,'shared',{id:'text'});assert.deepEqual(fixed.input,['text']);assert.equal(fixed.contextWindow,8192);assert(!('high' in fixed.reasoningEfforts));
  const policies=nativeContextPolicies(store,[{id:'team-auto'}],id=>catalog.modelConnection(id),m=>nativeCatalogProfile(store,catalog,'shared',m));assert.equal(policies.length,1);assert(policies[0].headroomTokens>8192);assert(policies[0].maxTokens<=8192);
  delete connections.vision;const after=nativeCatalogProfile(store,catalog,'shared',{id:'team-auto'});assert.deepEqual(after.input,['text']);assert.equal(after.contextWindow,8192);
  assert(!JSON.stringify(profile).includes('synthetic-'));
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
