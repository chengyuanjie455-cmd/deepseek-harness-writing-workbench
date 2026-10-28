const {test,after}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {policyFilename,loadHostProfile,isolatedDesktopHome}=require('../host-profile.cjs');
const {spawnSync}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'host-profile-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const active=path.join(root,'active.json'),entry=path.join(root,'entry.json');
const deployment={version:1,kind:'external-host',storagePolicy:'/Volumes/Expected/config/storage-policy.json',activeProfile:active,productionData:'/Volumes/Expected/host/live/data'};
const profile={purpose:'production',storagePolicy:deployment.storagePolicy,data:deployment.productionData};
const put=(p,v)=>fs.writeFileSync(p,JSON.stringify(v));
test('signed acceptance state is isolated without redirecting production or bound external storage',()=>{
  const qa={purpose:'acceptance',data:path.join(root,'qa-data')};
  assert.equal(isolatedDesktopHome({packaged:true,acceptance:true,profile:qa}),path.join(qa.data,'desktop-state'));
  for(const options of [{acceptance:false,profile:qa},{acceptance:true,profile:{...qa,purpose:'production'}},{acceptance:true,profile:{...qa,storagePolicy:'/bound/policy.json'}}])
    assert.equal(isolatedDesktopHome({packaged:true,requested:'/ignored/override',...options}),undefined);
  assert.throws(()=>isolatedDesktopHome({packaged:true,acceptance:true,profile:{purpose:'acceptance',data:'relative'}}),/绝对路径/);
  assert.equal(isolatedDesktopHome({packaged:false,requested:path.join(root,'dev-state')}),path.join(root,'dev-state'));
});
test('external deployment remains bound when environment is missing and rejects overrides',()=>{
  assert.equal(policyFilename(deployment,undefined),deployment.storagePolicy);
  assert.throws(()=>policyFilename(deployment,'/tmp/bypass.json'),/不一致/);
  for(const invalid of [undefined,{}, {...deployment,storagePolicy:undefined},{...deployment,kind:'typo'}])assert.throws(()=>policyFilename(invalid));
});
test('a missing active profile never falls back to bundled validation data',()=>{
  put(entry,{externalProfile:active,data:'/validation/data',autoStart:false});
  assert.throws(()=>loadHostProfile(entry,deployment),/活动配置缺失/);
  assert.equal(fs.existsSync(active),false);
  put(active,profile);assert.deepEqual(loadHostProfile(entry,deployment),profile);
});
test('broken, incomplete or test profile cannot replace production',()=>{
  put(entry,{externalProfile:active});
  for(const patch of [{storagePolicy:undefined},{data:'/validation/data'},{purpose:'validation'},{externalProfile:active}]){
    put(active,{...profile,...patch});assert.throws(()=>loadHostProfile(entry,deployment));
  }
  fs.writeFileSync(active,'{broken');assert.throws(()=>loadHostProfile(entry,deployment));
  put(active,profile);put(entry,{data:'/validation/data'});assert.throws(()=>loadHostProfile(entry,deployment),/部署绑定/);
  assert.throws(()=>loadHostProfile(path.join(root,'absent'),deployment),/入口配置缺失/);
});
test('manual server entry without the environment variable fails before any writes when bound policy is missing',()=>{
  const fixture=path.join(root,'entry-fixture');fs.mkdirSync(path.join(fixture,'server'),{recursive:true});fs.mkdirSync(path.join(fixture,'desktop'));
  fs.writeFileSync(path.join(fixture,'package.json'),'{"type":"module"}');
  fs.copyFileSync(path.join(__dirname,'../../server/external-storage.ts'),path.join(fixture,'server/external-storage.ts'));
  for(const f of ['host-profile.cjs','external-storage.cjs'])fs.copyFileSync(path.join(__dirname,'..',f),path.join(fixture,'desktop',f));
  put(path.join(fixture,'desktop/deployment.json'),deployment);
  const forbidden=path.join(fixture,'must-not-exist');
  fs.writeFileSync(path.join(fixture,'entry.ts'),`import './server/external-storage.ts';import {mkdirSync} from 'node:fs';mkdirSync(${JSON.stringify(forbidden)});`);
  const env={...process.env};delete env.PLATFORM_STORAGE_POLICY;
  const run=()=>spawnSync(process.execPath,['--experimental-strip-types',path.join(fixture,'entry.ts')],{env,encoding:'utf8'});
  let result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/storage-policy.json/);assert.equal(fs.existsSync(forbidden),false);
  fs.unlinkSync(path.join(fixture,'desktop/deployment.json'));result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/deployment.json/);assert.equal(fs.existsSync(forbidden),false);
});
