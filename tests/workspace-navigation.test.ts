import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Platform} from '../server/app.ts';
import {hash,id} from '../server/store.ts';
const password='Synthetic-navigation-password-123!';
test('all projects share a read-only navigation endpoint; members see only their own chats, including in the native frame',async()=>{
 const root=mkdtempSync(join(tmpdir(),'project-navigation-')),app=new Platform({dataDir:root});
 try{
  const admin=app.newUser({username:'admin',password},'admin'),a=app.newUser({username:'membera',password},'member'),b=app.newUser({username:'memberb',password},'member'),project=id();
  app.store.put('project',{id:project,name:'项目乙'});
  for(const u of [admin,a,b])for(const p of ['shared',project])mkdirSync(join(root,'native-harness',app.native.key(u,p),'state/sessions'),{recursive:true});
  const reads:string[]=[];app.native.history.read=async key=>{reads.push(key);return {items:[{id:'session-same',title:key,updated:1,messageCount:2}]};};
  const before=app.store.db.prepare('select count(*) as count from docs').get();
  const member=await app.native.history.navigation(a);assert.equal(member.projects.length,2);assert(member.projects.every(p=>p.members.length===1&&p.members[0].id===a.id&&p.members[0].self));assert.equal(reads.length,2);await app.native.history.navigation(a);assert.equal(reads.length,2,'coalesce repeated sidebar polling via cached summaries');
  const all=await app.native.history.navigation(admin);assert(all.projects.every(p=>p.members.length===3));assert.deepEqual(app.store.db.prepare('select count(*) as count from docs').get(),before,'navigation writes no chat or project records');
  assert.equal(app.native.instances.size,0,'navigation must not start any project agent');
  const base='http://127.0.0.1:'+await app.start(0),login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'membera',password})}),me:any=await login.json();
  const cookie=login.headers.get('set-cookie')!.split(';')[0];app.nativeTickets.set('nav-test',{user:a.id,auth:hash(cookie.split('=')[1]),csrf:me.csrf,expires:Date.now()+60000});
  for(const [path,Cookie] of [['/api/workspace-navigation',cookie],['/harness/shared/team-settings/api/workspace-navigation','team_native=nav-test']]){
   const response=await fetch(base+path,{headers:{Cookie}}),result:any=await response.json();assert.equal(response.status,200);assert.equal(result.projects.length,2);assert(result.projects.every((p:any)=>p.members.every((m:any)=>m.id===a.id)));
  }
  assert.equal((await fetch(base+'/api/workspace-navigation')).status,401);
  app.store.put('user',{...a,active:false});await assert.rejects(app.native.history.navigation(a),/身份/);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
test('navigation fails closed if identity is revoked during a summary read',async()=>{
 const root=mkdtempSync(join(tmpdir(),'project-revocation-')),app=new Platform({dataDir:root});
 try{
  const admin=app.newUser({username:'admin',password},'admin');mkdirSync(join(root,'native-harness',app.native.key(admin,'shared'),'state/sessions'),{recursive:true});
  app.native.history.read=async()=>{app.store.put('user',{...admin,role:'member'});return {items:[]};};await assert.rejects(app.native.history.navigation(admin),/身份/);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('workspace membership requires an active account and message history in that project; records and empty projects remain intact',async()=>{
 const root=mkdtempSync(join(tmpdir(),'project-visible-members-')),app=new Platform({dataDir:root});
 try{
  const admin=app.newUser({username:'admin',password},'admin'),active=app.newUser({username:'active',password},'member'),disabled=app.newUser({username:'disabled',password},'member'),draft=app.newUser({username:'draft',password},'member'),legacy=app.newUser({username:'legacy',password},'member'),project=id(),emptyProject=id();
  app.store.put('user',{...disabled,active:false});app.store.put('project',{id:project,name:'另一个项目'});app.store.put('project',{id:emptyProject,name:'还没有聊天的项目'});
  const histories=new Map<string,any[]>();
  const seed=(user:any,p:string,items:any[])=>{const key=app.native.key(user,p);mkdirSync(join(root,'native-harness',key,'state/sessions'),{recursive:true});histories.set(key,items);};
  seed(active,'shared',[{id:'session-history',messageCount:2},{id:'session-draft',messageCount:0}]);
  seed(disabled,'shared',[{id:'session-disabled',messageCount:2}]);
  seed(draft,'shared',[{id:'session-empty',messageCount:0},{id:'session-error',error:true}]);
  seed(draft,project,[{id:'session-other-project',messageCount:1,archived:true}]);
  const session=id();app.store.put('session',{id:session,owner:legacy.id,project:'shared',title:'旧版对话'});
  app.store.put('harness',{id:session,header:{id:session},events:[{seq:0,time:1,type:'user/message',data:{id:'message',role:'user',source:{kind:'user'},content:[{type:'text',text:'保存的原始对话'}]}}]},legacy.id);
  const reads:string[]=[];app.native.history.read=async key=>{reads.push(key);return {items:histories.get(key)??[]};};
  const before=app.store.db.prepare('select * from docs order by kind,id').all();
  const result=await app.native.history.navigation(admin),shared=result.projects.find(p=>p.id==='shared')!;
  assert.deepEqual(shared.members.map(m=>m.id).sort(),[active.id,legacy.id].sort());
  assert.equal(shared.members.find(m=>m.id===active.id)!.sessions.length,2,'an existing member keeps unfinished drafts alongside their history');
  assert.deepEqual(result.projects.find(p=>p.id===project)!.members.map(m=>m.id),[draft.id],'history in another project must not leak into this one');
  assert.equal(result.projects.find(p=>p.id===emptyProject)!.members.length,0,'empty projects remain available for new chats');
  assert(!reads.includes(app.native.key(disabled,'shared')),'disabled members need no workspace history scan');
  assert.deepEqual(app.store.db.prepare('select * from docs order by kind,id').all(),before,'visibility must never delete accounts or conversations');
  assert.equal(app.native.instances.size,0,'listing must not start member agents');
  app.store.put('user',{...active,active:false});const refreshed=await app.native.history.navigation(admin);
  assert(!refreshed.projects.some(p=>p.members.some(m=>m.id===active.id)),'cached history cannot keep a newly disabled member visible');
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('workspace rechecks a member disabled during history reads and retains known history on a temporary read failure',async()=>{
 const root=mkdtempSync(join(tmpdir(),'project-history-refresh-')),app=new Platform({dataDir:root});
 try{
  const admin=app.newUser({username:'admin',password},'admin'),member=app.newUser({username:'member',password},'member'),key=app.native.key(member,'shared');
  mkdirSync(join(root,'native-harness',key,'state/sessions'),{recursive:true});
  app.native.history.read=async()=>({items:[{id:'session-known',messageCount:1}]});
  assert.equal((await app.native.history.navigation(admin)).projects[0].members.length,1);
  (app.native.history as any).navigationCache.get(key).at=0;
  app.native.history.read=async()=>{throw Error('temporary reader failure');};
  const recovered=await app.native.history.navigation(admin);assert.equal(recovered.projects[0].members[0].sessions[0].id,'session-known');assert.match(recovered.projects[0].members[0].error!,/重试/);
  app.native.history.read=async()=>{app.store.put('user',{...member,active:false});return {items:[{id:'session-known',messageCount:1}]};};
  assert.equal((await app.native.history.navigation(admin)).projects[0].members.length,0);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
