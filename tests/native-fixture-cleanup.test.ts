import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Platform} from '../server/app.ts';
import {fixture} from './helpers/native-team-fixture.ts';
import {closeNativeFixture} from './helpers/close-native-fixture.ts';

async function refused(origin:string){await assert.rejects(fetch(origin+'/api/status',{signal:AbortSignal.timeout(1500)}));}
function inactiveUsers(data:string){
 const db=new DatabaseSync(join(data,'platform.sqlite'),{readOnly:true});
 try{return (db.prepare("SELECT body FROM docs WHERE kind='user'").all() as any[]).map(row=>JSON.parse(row.body));}finally{db.close();}
}

test('fixture bind failure closes the already-open model server and releases its database writer',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'native-fixture-bind-failure-')),root=join(parent,'fixture'),original=Platform.prototype.start;
 try{
  Platform.prototype.start=async()=>{throw Error('synthetic fixture bind failure');};
  await assert.rejects(fixture(false,{root,keepData:true}),/synthetic fixture bind failure/);
  const proof=JSON.parse(readFileSync(join(root,'setup-failure.json'),'utf8'));
  assert(proof.modelServerClosed&&proof.platformCleanupCompleted&&proof.writerLockReleased);
  assert.equal(existsSync(join(root,'data/writer.lock')),false);assert.equal(inactiveUsers(join(root,'data')).length,0);
  await refused(proof.modelOrigin);
 }finally{Platform.prototype.start=original;rmSync(parent,{recursive:true,force:true});}
});

test('fixture onboarding failure disables partially-created accounts and closes both listening services',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'native-fixture-onboard-failure-')),root=join(parent,'fixture'),original=Platform.prototype.newUser;let calls=0;
 try{
  Platform.prototype.newUser=function(...args:Parameters<Platform['newUser']>){if(++calls===8)throw Error('synthetic fixture onboarding failure');return original.apply(this,args);};
  await assert.rejects(fixture(false,{root,keepData:true}),/synthetic fixture onboarding failure/);
  const proof=JSON.parse(readFileSync(join(root,'setup-failure.json'),'utf8'));
  assert(proof.modelServerClosed&&proof.platformCleanupCompleted&&proof.writerLockReleased);
  const users=inactiveUsers(join(root,'data'));assert.equal(users.length,7);assert(users.every(user=>user.active===false));
  await refused(proof.modelOrigin);await refused(proof.platformOrigin);
 }finally{Platform.prototype.newUser=original;rmSync(parent,{recursive:true,force:true});}
});

test('a platform cleanup error still closes the mock model server and is surfaced to the caller',async()=>{
 const f=await fixture(false,{keepData:true}),original=f.app.close;
 try{
  f.app.close=async()=>{throw Error('synthetic platform cleanup failure');};
  await assert.rejects(f.close(),(error:any)=>error instanceof AggregateError&&error.errors.some((item:Error)=>item.message==='synthetic platform cleanup failure'));
  await refused(f.modelOrigin);
 }finally{f.app.close=original;await closeNativeFixture(f.app);rmSync(f.root,{recursive:true,force:true});}
});
