const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const http=require('node:http');
const {HostControl}=require('../host-control.cjs');

test('live host uses only the one-shot entry and an independent explicit LAN configuration',()=>{
 const profile={root:'/synthetic/source',data:'/synthetic/live/data',mode:'pickup-live',live:{bind:'192.168.200.10',port:4325,extraBinds:['192.168.200.254'],textConfig:'/synthetic/private/model'}};
 const host=new HostControl(profile);
 assert.equal(host.entry,'/synthetic/source/scripts/live-single-shot.ts');
 assert.equal(host.config().url,'http://192.168.200.10:4325');
 for(const port of [4317,4324,22,65536,'4325'])assert.throws(()=>new HostControl({...profile,live:{...profile.live,port}}).config());
 for(const patch of [{bind:'example.com'},{extraBinds:['0.0.0.0']},{extraBinds:'192.168.1.1'},{textConfig:'relative'}])assert.throws(()=>new HostControl({...profile,live:{...profile.live,...patch}}).config());
 assert.throws(()=>new HostControl({...profile,data:'/synthetic/live'}));
 assert.equal(new HostControl({...profile,mode:'pickup-uat'}).entry,'/synthetic/source/scripts/uat-pickups.ts');
 assert.equal(new HostControl({...profile,mode:undefined}).entry,'/synthetic/source/server/main.ts');
 assert.equal(new HostControl({...profile,live:{...profile.live,automatic:true}}).config().url,'http://127.0.0.1:4325');
 assert.equal(new HostControl({...profile,live:{...profile.live,automatic:true,bind:'192.168.210.42'}}).config().url,'http://127.0.0.1:4325');
 assert.throws(()=>new HostControl({...profile,live:{...profile.live,automatic:'yes'}}).config());
});

test('live host checks entry, identity, instance and URL before it can manage an existing service',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'team-host-'));const data=path.join(root,'data');fs.mkdirSync(data);
 const serverId='11111111-1111-1111-1111-111111111111',serverInstance='22222222-2222-2222-2222-222222222222';
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({serverId,serverInstance,protocol:{min:1,max:1}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const port=server.address().port,host=new HostControl({root,data,mode:'pickup-live',node:process.execPath,live:{bind:'127.0.0.1',port,textConfig:path.join(root,'private')}});
  const runtime={pid:process.pid,entry:host.entry,url:`http://127.0.0.1:${port}`,serverId,serverInstance,additionalUrls:['http://192.168.210.42:4325','http://8.8.8.8'],lan:{automatic:true}};
  const save=r=>fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify(r));save(runtime);
  assert((await host.status()).managed);assert((await host.start()).managed);
  assert.deepEqual((await host.status()).lanUrls,['http://192.168.210.42:4325']);assert((await host.status()).automaticLan);
  const memberUrl=`http://work-mac.local:${port}`;
  save({...runtime,lan:{automatic:true,memberUrl}});assert.equal((await host.status()).memberUrl,memberUrl);
  for(const invalid of ['http://evil.example:'+port,memberUrl+'/extra','http://user:password@work-mac.local:'+port,memberUrl+'?q=1','http://work-mac.local:4324']) {
   save({...runtime,lan:{automatic:true,memberUrl:invalid}});assert.equal((await host.status()).memberUrl,null);
  }
  for(const patch of [{entry:path.join(root,'scripts/uat-pickups.ts')},{serverInstance:'old'},{serverId:'other'},{url:'http://127.0.0.1:4325'},{pid:0}]){
   save({...runtime,...patch});assert.equal((await host.status()).managed,false);
   await assert.rejects(host.start(),/不是此控制台/);await assert.rejects(host.stop(),/不能安全确认/);
  }
 }finally{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
