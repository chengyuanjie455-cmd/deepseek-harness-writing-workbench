import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CompanionRunners} from '../server/companion-runner.ts';

const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
test('simultaneous identity reads register once per account, without sharing accounts', async()=>{
  const root=mkdtempSync(join(tmpdir(),'companion-'));
  try {
    writeFileSync(join(root,'companion-runner.json'),'{"enabled":true}');
    const calls:string[]=[];
    const runner=new CompanionRunners(async(_root,id)=>{calls.push(id);await new Promise(r=>setTimeout(r,10));return {state:'registered',namespace:id};});
    const results=await Promise.all([runner.ensure(root,a),runner.ensure(root,a),runner.ensure(root,b)]);
    assert.deepEqual(calls,[a,b]);assert.equal(results[0].namespace,a);assert.equal(results[2].namespace,b);
    await runner.ensure(root,a);assert.equal(calls.length,2);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('disabled environments do not launch a runtime, invalid accounts cannot launch',async()=>{
  const root=mkdtempSync(join(tmpdir(),'companion-'));let calls=0;
  try{
    const runner=new CompanionRunners(async()=>{calls++;return {state:'registered'};});
    assert.equal((await runner.ensure(root,a)).state,'disabled');
    await assert.rejects(runner.ensure(root,'../../owner'));
    assert.equal(calls,0);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('launcher errors are sanitized and retriable',async()=>{
  const root=mkdtempSync(join(tmpdir(),'companion-'));let calls=0;
  try{
    writeFileSync(join(root,'companion-runner.json'),'{"enabled":true}');
    const runner=new CompanionRunners(async()=>{if(++calls===1)throw new Error('private diagnostic');return {state:'registered'};});
    await assert.rejects(runner.ensure(root,a),e=>e instanceof Error&&!e.message.includes('private diagnostic'));
    assert.equal((await runner.ensure(root,a)).state,'registered');assert.equal(calls,2);
  }finally{rmSync(root,{recursive:true,force:true});}
});
