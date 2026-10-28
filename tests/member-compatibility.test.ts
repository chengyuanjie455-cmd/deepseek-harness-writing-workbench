import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,renameSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Platform} from '../server/app.ts';
import {type Doc} from '../server/store.ts';

const password='Synthetic-member-compatibility-20261020!';
async function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'member-compatibility-'))),app=new Platform({dataDir:join(root,'data'),concurrency:500,videoConcurrency:500});
 const admin=app.newUser({username:'admin',password},'admin'),member=app.newUser({username:'member',password},'member');
 const publish=(writes:Record<string,string|null>)=>{const c=app.projects.candidate(admin,app.projects.current().revision,writes,{});return app.projects.approve(c,admin,c.digest);};
 return {root,app,admin,member,publish,close:async()=>{await app.close();rmSync(root,{recursive:true,force:true});}};
}

test('Chinese account names work through admin creation and login without changing existing account identities',async()=>{
 const f=await fixture();let app=f.app;try{
  const base='http://127.0.0.1:'+await app.start(0),login=async(name:string,expected=200)=>{
   const r=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:name,password})});const result=await r.json() as Doc;assert.equal(r.status,expected,JSON.stringify(result));return {r,result};
  };
  const originalId=(await login('member')).result.user.id,{r,result}=await login('admin'),headers={Origin:base,'Content-Type':'application/json',Cookie:r.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':result.csrf};
  for(const name of ['子涵','朱敬涛','刘茜']){
   const created=await fetch(base+'/api/admin/users',{method:'POST',headers,body:JSON.stringify({username:name,password,role:'member'})});assert.equal(created.status,201,await created.clone().text());const u=await created.json() as Doc;assert.equal(u.username,name);assert.equal((await login(name)).result.user.id,u.id);
  }
  const duplicate=await fetch(base+'/api/admin/users',{method:'POST',headers,body:JSON.stringify({username:'子涵',password,role:'member'})});assert.equal(duplicate.status,409);await duplicate.text();
  assert.equal((await login('member')).result.user.id,originalId);assert.equal(app.options.concurrency,500);assert.equal(app.pickups.maxConcurrency,500);
  for(const username of ['../子涵','子 涵','子涵\n','x'.repeat(41),'\u202eadmin'])assert.throws(()=>app.newUser({username,password},'member'),/账号/);
  const accented=app.newUser({username:'Cafe\u0301',password},'member');assert.equal(accented.username,'Café');assert.throws(()=>app.newUser({username:'Café',password},'member'),/存在/);
  await app.close();app=new Platform({dataDir:join(f.root,'data')});const after='http://127.0.0.1:'+await app.start(0),auth=await fetch(after+'/api/login',{method:'POST',headers:{Origin:after,'Content-Type':'application/json'},body:JSON.stringify({username:'子涵',password})});assert.equal(auth.status,200);const who=await auth.json() as Doc;assert.equal(who.user.username,'子涵');assert.equal(app.store.all('user').find(v=>v.username==='member')!.id,originalId);assert.equal(app.store.all('model-call').length,0);
 }finally{await app.close();rmSync(f.root,{recursive:true,force:true});}
});

test('native member rename preserves original bytes and identity; real deletion, overwrite disguises and stale permissions still fail',async()=>{
 const f=await fixture();try{
  f.publish({'剧本/原名.md':'原版剧情，纸风筝。','剧本/重名目标.md':'另一份原件。'});const before=f.app.projects.current().revision;
  const first=(await f.app.workspace('shared').content.search(f.member,{query:'纸风筝'})).items[0];
  const i:any={owner:f.member.id,key:'member-rename-fixture',project:'shared',work:join(f.root,'workspace'),root:join(f.root,'native')};mkdirSync(i.work);mkdirSync(i.root);f.app.native.sync(i,f.member);mkdirSync(join(i.work,'剧本'),{recursive:true});
  renameSync(join(i.work,'剧本/原名.md'),join(i.work,'剧本/新名.md'));
  const change=f.app.native.submit(i,f.member,['剧本/原名.md','剧本/新名.md']);const published=f.app.projects.publishNative(change,f.member);assert.equal(published.state,'committed');assert.equal(f.app.projects.read('剧本/新名.md').toString(),'原版剧情，纸风筝。');assert(!f.app.projects.revision().manifest['剧本/原名.md']);assert.equal(f.app.projects.read('剧本/原名.md',before).toString(),'原版剧情，纸风筝。');
  const renamed=(await f.app.workspace('shared').content.search(f.member,{query:'纸风筝'})).items[0];assert.equal(renamed.entityId,first.entityId);assert.equal(renamed.versionId,first.versionId);
  const candidate=(writes:Record<string,string|null>)=>f.app.projects.candidateObjects(f.member,f.app.projects.current().revision,writes,{}, {nativeWorkspace:i.key});
  const deletion=candidate({'剧本/新名.md':null});assert.throws(()=>f.app.projects.publishNative({...deletion,writes:{}},f.member),/不能删除/,'untrusted caller cannot hide stored deletion');
  const overwrite=candidate({'剧本/新名.md':null,'剧本/重名目标.md':f.app.projects.revision().manifest['剧本/新名.md']});assert.throws(()=>f.app.projects.publishNative(overwrite,f.member),/不能删除/);
  f.publish({'副本甲.md':'重复','副本乙.md':'重复'});const one=f.app.projects.revision().manifest['副本甲.md'],collapse=candidate({'副本甲.md':null,'副本乙.md':null,'合并副本.md':one});assert.throws(()=>f.app.projects.publishNative(collapse,f.member),/不能删除/);
  const stopped=candidate({'新建.md':f.app.projects.blob('无损新建')});f.app.store.put('user',{...f.member,active:false});assert.throws(()=>f.app.projects.publishNative(stopped,f.member),/停用/);assert.equal(f.app.projects.read('剧本/重名目标.md').toString(),'另一份原件。');assert.equal(f.app.store.all('video-job').length+f.app.store.all('image-job').length+f.app.store.all('model-call').length,0);
 }finally{await f.close();}
});

test('two members renaming the same original cannot overwrite each other; stale administrator role cannot bypass member deletion rules',async()=>{
 const f=await fixture();try{
  f.publish({'原名.md':'两名成员共享的原件'});const base=f.app.projects.current().revision,digest=f.app.projects.revision().manifest['原名.md'],other=f.app.newUser({username:'另一成员',password},'member');
  const a=f.app.projects.candidateObjects(f.member,base,{'原名.md':null,'甲的新名.md':digest},{'原名.md':digest},{nativeWorkspace:'member-a'}),b=f.app.projects.candidateObjects(other,base,{'原名.md':null,'乙的新名.md':digest},{'原名.md':digest},{nativeWorkspace:'member-b'});
  f.app.projects.publishNative(a,f.member);assert.throws(()=>f.app.projects.publishNative(b,other),/资料已变化/);assert.equal(f.app.store.get('change',b.id)!.state,'conflict');assert.equal(f.app.projects.read('甲的新名.md').toString(),'两名成员共享的原件');assert(!f.app.projects.revision().manifest['乙的新名.md']);assert.equal(f.app.projects.read('原名.md',base).toString(),'两名成员共享的原件');
  const elevated=f.app.newUser({username:'temporary-admin',password},'admin'),deletion=f.app.projects.candidateObjects(elevated,f.app.projects.current().revision,{'甲的新名.md':null},{},{nativeWorkspace:'stale-admin'});f.app.store.put('user',{...elevated,role:'member'});assert.throws(()=>f.app.projects.publishNative(deletion,elevated),/不能删除/);assert.equal(f.app.projects.pending().length,0);
 }finally{await f.close();}
});
