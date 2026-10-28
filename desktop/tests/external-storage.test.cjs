const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {assertVolume,assertPath,loadPolicy,monitor}=require('../external-storage.cjs');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'external-storage-')));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const policy={version:1,root,volumeUUID:'53C2C5CE-5CAD-450E-8A73-AE616FBA34AD',allowInternalFallback:false};
const info={Internal:false,VolumeUUID:policy.volumeUUID,FilesystemType:'apfs',Writable:true,MountPoint:root};
test('accepts only the expected writable external volume',()=>assert.equal(assertVolume(policy,()=>info).root,root));
for(const [field,value] of [['Internal',true],['VolumeUUID','OTHER'],['Writable',false],['FilesystemType','exfat']])test('rejects mismatched '+field,()=>assert.throws(()=>assertVolume(policy,()=>({...info,[field]:value}))));
test('missing disk cannot recreate a folder on the internal disk',()=>{const missing=path.join(root,'missing');assert.throws(()=>assertVolume({...policy,root:missing},()=>info));assert.equal(fs.existsSync(missing),false);});
test('new folders must remain on the same volume',()=>{const state=assertVolume(policy,()=>info);assert.equal(assertPath(policy,path.join(root,'new','file'),state),path.join(root,'new','file'));assert.throws(()=>assertPath(policy,path.dirname(root),state));});
test('rejects symlink escape',()=>{const link=path.join(root,'escape');fs.symlinkSync(os.tmpdir(),link);assert.throws(()=>assertPath(policy,path.join(link,'test'),assertVolume(policy,()=>info)));});
test('configuration may not enable internal fallback',()=>{const filename=path.join(root,'invalid.json');fs.writeFileSync(filename,JSON.stringify({...policy,root:'/Volumes/Test/host',allowInternalFallback:true}));assert.throws(()=>loadPolicy(filename));});
test('dangling links at both leaf and parent are rejected without creating their target',()=>{
  const target=path.join(os.tmpdir(),'missing-external-target-'+process.pid),link=path.join(root,'dangling');
  fs.symlinkSync(target,link);const state=assertVolume(policy,()=>info);
  assert.throws(()=>assertPath(policy,link,state),/链接/);
  assert.throws(()=>assertPath(policy,path.join(link,'file'),state),/链接/);
  assert.equal(fs.existsSync(target),false);
});
test('missing policy is a startup failure',()=>assert.throws(()=>loadPolicy(path.join(root,'absent-policy.json'))));
for(const failure of ['removed','replaced','read-only','full'])test('runtime '+failure+' triggers one stop and accepts recovery only after restart',async()=>{
  let failed=false,stops=0;const io={...fs,
    realpathSync:p=>{if(failed&&failure==='removed')throw Error('ENOENT');return fs.realpathSync(p);},
    statSync:p=>({...fs.statSync(p),dev:failed&&failure==='replaced'?-1:fs.statSync(p).dev}),
    accessSync:()=>{if(failed&&failure==='read-only')throw Object.assign(Error('EROFS'),{code:'EROFS'});},
    statfsSync:()=>({bsize:4096,bavail:failed&&failure==='full'?0:1000000})};
  const stop=monitor(policy,()=>stops++,{inspect:()=>info,io,intervalMs:10});
  try{failed=true;await new Promise(r=>setTimeout(r,45));assert.equal(stops,1);failed=false;await new Promise(r=>setTimeout(r,25));assert.equal(stops,1);
    const restarted=monitor(policy,()=>stops++,{inspect:()=>info,io,intervalMs:10});restarted();
  }finally{stop();}
});
