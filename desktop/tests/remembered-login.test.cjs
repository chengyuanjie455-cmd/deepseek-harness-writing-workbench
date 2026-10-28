const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {RememberedLogin}=require('../remembered-login.cjs');
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'admin-remember-')),filename=path.join(root,'admin.enc.json'),key=crypto.randomBytes(32);
 let available=true,role='admin',status=200;
 const calls=[];
 const connection={origin:'http://127.0.0.1:4325',serverId:'11111111-1111-1111-1111-111111111111',epoch:0,async call(p,m,b){calls.push(b);this.epoch++;if(status===401)this.epoch++;return {status,data:status===200?{user:{id:'user',username:b.username,role},csrf:'memory-only-token'}:{error:'invalid'}};}};
 const storage={isEncryptionAvailable:()=>available,encryptString(s){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(s),c.final(),c.getAuthTag()]);},decryptString(b){const c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString();}};
 const target=async()=>({managed:true,url:connection.origin,serverId:connection.serverId});
 const options={filename,connection,storage,target,platform:'darwin'},manager=new RememberedLogin(options),body={username:'synthetic_admin',password:'Synthetic-private-123456!',remember:true};
 return {root,filename,manager,options,connection,calls,body,availability:v=>available=v,role:v=>role=v,status:v=>status=v};
}
test('successful admin opt-in persists encrypted credentials; status never reveals password or session token',async()=>{
 const f=fixture();try {
  assert.equal((await f.manager.status()).saved,false);assert.equal(f.calls.length,0);
  assert.equal((await f.manager.login(f.body)).status,200);
  const raw=fs.readFileSync(f.filename,'utf8');assert(!raw.includes(f.body.password));assert(!raw.includes('memory-only-token'));assert.equal(fs.statSync(f.filename).mode&0o777,0o600);
  const next=new RememberedLogin(f.options);const info=await next.status();assert.equal(info.username,f.body.username);assert(info.saved);assert(!('password' in info));assert.equal(f.calls.length,1);
  await next.login({username:f.body.username,useSaved:true,remember:true});assert.equal(f.calls.length,2);assert.equal(f.calls[1].password,f.body.password);
  assert.deepEqual(Object.keys(f.calls[1]).sort(),['password','username']);
 }finally{fs.rmSync(f.root,{recursive:true});}
});
test('reopening automatically restores saved login without rewriting the encrypted record',async()=>{
 const f=fixture();try{
  await f.manager.login(f.body);const before=fs.readFileSync(f.filename,'utf8');
  const reopened=new RememberedLogin(f.options),restored=await reopened.restore();
  assert.equal(restored.status,200);assert.equal(f.calls.length,2);assert.equal(f.calls[1].password,f.body.password);
  assert.equal(fs.readFileSync(f.filename,'utf8'),before);assert(!JSON.stringify(restored).includes(f.body.password));
 }finally{fs.rmSync(f.root,{recursive:true});}
});
test('simultaneous restores coalesce, but explicit logout suppresses restoration until a manual login',async()=>{
 const f=fixture();try{
  await f.manager.login(f.body);const reopened=new RememberedLogin(f.options);
  const a=reopened.restore(),b=reopened.restore();assert.equal(a,b);await a;assert.equal(f.calls.length,2);
  reopened.pauseAutoLogin();assert.equal((await reopened.restore()).status,204);assert.equal(f.calls.length,2);assert(fs.existsSync(f.filename));
  await reopened.login({username:f.body.username,useSaved:true,remember:true});assert.equal((await reopened.restore()).status,200);
 }finally{fs.rmSync(f.root,{recursive:true});}
});
test('restore keeps saved credentials after a temporary failure and never sends them to another host',async()=>{
 const f=fixture();try{
  assert.equal((await f.manager.restore()).status,204);await f.manager.login(f.body);
  const next=new RememberedLogin(f.options);f.connection.serverId='22222222-2222-2222-2222-222222222222';
  assert.equal((await next.restore()).status,204);assert.equal(f.calls.length,1);
  f.connection.serverId='11111111-1111-1111-1111-111111111111';let calls=0;f.connection.call=async()=>{calls++;throw Error('temporary failure');};
  await assert.rejects(next.restore(),/temporary failure/);assert.equal(calls,1);assert(fs.existsSync(f.filename));
 }finally{fs.rmSync(f.root,{recursive:true});}
});
test('member accounts cannot persist credentials',async()=>{const f=fixture();try{f.role('member');const r=await f.manager.login(f.body);assert.equal(r.status,200);assert.match(r.data.credentialNotice,/仅超级管理员/);assert(!fs.existsSync(f.filename));}finally{fs.rmSync(f.root,{recursive:true});}});
test('a formerly remembered admin is forgotten if the server now returns a member role',async()=>{const f=fixture();try{await f.manager.login(f.body);f.role('member');assert.equal((await f.manager.login({username:f.body.username,useSaved:true,remember:true})).status,200);assert(!fs.existsSync(f.filename));}finally{fs.rmSync(f.root,{recursive:true});}});
test('changed server, origin, or username cannot replay a saved password',async()=>{const f=fixture();try{
 await f.manager.login(f.body);f.connection.serverId='22222222-2222-2222-2222-222222222222';assert.equal((await f.manager.status()).saved,false);assert.equal((await f.manager.login({username:f.body.username,useSaved:true})).status,409);assert.equal(f.calls.length,1);
 f.connection.serverId=f.options.connection.serverId='11111111-1111-1111-1111-111111111111';f.connection.origin='http://127.0.0.1:4326';assert.equal((await f.manager.status()).saved,false);assert.equal((await f.manager.login({username:f.body.username,useSaved:true})).status,409);
 f.connection.origin='http://127.0.0.1:4325';assert.equal((await f.manager.login({username:'other_admin',useSaved:true})).status,409);assert.equal(f.calls.length,1);
}finally{fs.rmSync(f.root,{recursive:true});}});
test('unmanaged or LAN targets receive no remembered credentials',async()=>{const f=fixture();try{
 await f.manager.login(f.body);f.options.target=async()=>({managed:false});await assert.rejects(new RememberedLogin(f.options).status());
 f.connection.origin='http://192.168.210.42:4325';await assert.rejects(f.manager.login({username:f.body.username,useSaved:true}));assert.equal(f.calls.length,1);
}finally{fs.rmSync(f.root,{recursive:true});}});
test('no OS encryption has no plaintext fallback; ordinary successful login can report unsaved state',async()=>{const f=fixture();try{
 f.availability(false);const r=await f.manager.login(f.body);assert.equal(r.status,200);assert.match(r.data.credentialNotice,/保存失败/);assert(!fs.existsSync(f.filename));assert.equal((await f.manager.status()).supported,false);
 assert.equal(new RememberedLogin({...f.options,platform:'linux'}).available(),false);
}finally{fs.rmSync(f.root,{recursive:true});}});
test('clear and invalid saved password remove persistence; transport failures never cause a repeated login',async()=>{const f=fixture();try{
 await f.manager.login(f.body);await f.manager.clear();assert(!fs.existsSync(f.filename));
 await f.manager.login(f.body);f.status(401);assert.equal((await f.manager.login({username:f.body.username,useSaved:true,remember:true})).status,401);assert(!fs.existsSync(f.filename));
 f.status(200);await f.manager.login(f.body);let count=0;f.connection.call=async()=>{count++;throw Error('transport');};await assert.rejects(f.manager.login({username:f.body.username,useSaved:true}));assert.equal(count,1);assert(fs.existsSync(f.filename));
}finally{fs.rmSync(f.root,{recursive:true});}});
test('corrupted ciphertext is not used; can be cleared without decrypting',async()=>{const f=fixture();try{
 await f.manager.login(f.body);fs.writeFileSync(f.filename,'{"version":1,"encrypted":"AAAA"}');const s=await f.manager.status();assert(!s.saved&&s.canClear);await assert.rejects(f.manager.login({username:f.body.username,useSaved:true}));assert.equal(f.calls.length,1);await f.manager.clear();assert(!fs.existsSync(f.filename));
}finally{fs.rmSync(f.root,{recursive:true});}});
test('identity switch during host verification and duplicate submissions cannot store credentials',async()=>{const f=fixture();try{
 const m=new RememberedLogin({...f.options,target:async()=>{f.connection.epoch++;return {managed:true,url:f.connection.origin,serverId:f.connection.serverId};}});await assert.rejects(m.login(f.body));assert.equal(f.calls.length,0);
 let release;f.connection.call=async()=>{f.connection.epoch++;await new Promise(r=>release=r);return {status:200,data:{user:{id:'u',username:f.body.username,role:'admin'}}};};
 const first=f.manager.login(f.body);while(!release)await new Promise(r=>setImmediate(r));assert.equal((await f.manager.login(f.body)).status,409);release();assert.equal((await first).status,200);
}finally{fs.rmSync(f.root,{recursive:true});}});

test('denied Keychain access preserves the encrypted account and does not request password replacement',async()=>{
 const f=fixture();try{
  await f.manager.login(f.body);const before=fs.readFileSync(f.filename,'utf8');
  const locked=new RememberedLogin({...f.options,storage:{...f.options.storage,decryptString(){throw Error('access denied');}}});
  const info=await locked.status();assert.equal(info.saved,false);assert.match(info.error,/记录仍保留/);assert(!info.error.includes('请清除'));
  await assert.rejects(locked.restore(),/记录仍保留/);assert.equal(fs.readFileSync(f.filename,'utf8'),before);assert.equal(f.calls.length,1);
 }finally{fs.rmSync(f.root,{recursive:true});}
});

test('authorized local identity fork keeps encrypted login, but a different origin or ciphertext cannot migrate',async()=>{
 const f=fixture();try{
  await f.manager.login(f.body);const from=f.connection.serverId,to='22222222-2222-2222-2222-222222222222';
  const original=fs.readFileSync(f.filename),migration={version:1,origin:f.connection.origin,from,to,encryptedSHA256:crypto.createHash('sha256').update(original).digest('hex')};
  f.connection.serverId=to;const p=f.filename+'.identity-migration.json';
  fs.writeFileSync(p,JSON.stringify({...migration,origin:'http://127.0.0.1:4326'}),{mode:0o600});assert.equal((await f.manager.status()).saved,false);
  fs.writeFileSync(p,JSON.stringify({...migration,encryptedSHA256:'wrong'}));assert.equal((await f.manager.status()).saved,false);
  fs.writeFileSync(p,JSON.stringify(migration));assert.equal((await f.manager.status()).saved,true);assert(fs.existsSync(p+'.applied'));
  assert(!fs.readFileSync(f.filename,'utf8').includes(f.body.password));
  assert.equal((await new RememberedLogin(f.options).restore()).status,200);assert.equal(f.calls.length,2);
  f.connection.serverId='33333333-3333-3333-3333-333333333333';assert.equal((await f.manager.status()).saved,false);
 }finally{fs.rmSync(f.root,{recursive:true});}
});
