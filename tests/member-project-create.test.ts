import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,symlinkSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Platform} from '../server/app.ts';
import {id,hash,type Doc} from '../server/store.ts';
const password='member-project-fixture-12345';
class Client{
 cookie='';csrf='';project='shared';constructor(public base:string){}
 async call(path:string,method='GET',body?:Doc,status=200){const r=await fetch(this.base+'/api'+path+(path.includes('?')?'&':'?')+'project='+this.project,{method,headers:{Origin:this.base,Cookie:this.cookie,'X-CSRF-Token':this.csrf,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const json=await r.json() as Doc;assert.equal(r.status,status,JSON.stringify(json));if(r.headers.get('set-cookie'))this.cookie=r.headers.get('set-cookie')!.split(';')[0];if(json.csrf)this.csrf=json.csrf;return json;}
 async login(name:string){return this.call('/login','POST',{username:name,password});}
}
async function fixture(count=2){const root=realpathSync(mkdtempSync(join(tmpdir(),'member-project-'))),data=join(root,'data'),app=new Platform({dataDir:data,mockDelay:1});const admin=new Client('http://127.0.0.1:'+await app.start(0));await admin.call('/setup','POST',{username:'admin',password},201);await admin.login('admin');const members:Client[]=[];
 for(let n=0;n<count;n++){await admin.call('/admin/users','POST',{username:'member'+n,password,role:'member'},201);const member=new Client(admin.base);await member.login('member'+n);members.push(member);}return {root,data,app,admin,members};}

test('eight members create separate folders and shared project entries without sharing chats',async()=>{
 const f=await fixture(8);try{const baseline=f.app.projects.current().revision;const previous=await Promise.all(f.members.map(m=>m.call('/sessions')));
  const created=await Promise.all(f.members.map((m,n)=>m.call('/projects','POST',{name:'成员项目 '+n,requestId:id()},201)));assert.equal(new Set(created.map(p=>p.id)).size,8);assert.equal(f.app.store.all('project').length,9);assert.equal(f.app.projects.current().revision,baseline);
  for(const p of created){assert(p.managed);assert(!JSON.stringify(p).includes(f.data));const directory=f.app.workspace(p.id).projects.canonical;assert.equal(directory,join(f.data,'member-projects',p.id));assert(existsSync(directory));assert.equal(Object.keys(f.app.workspace(p.id).projects.revision().manifest).length,0);}
  const p=created[0];const sessions=await Promise.all(f.members.map(async(m)=>{assert.equal((await m.call('/projects')).length,9);m.project=p.id;return (await m.call('/sessions'))[0];}));assert.equal(new Set(sessions.map(s=>s.id)).size,8);
  await f.members[1].call('/sessions/'+sessions[0].id+'/messages','GET',undefined,404);
  f.members[0].project=created[1].id;await f.members[0].call('/sessions/'+sessions[0].id+'/messages','GET',undefined,404);f.members[0].project='shared';assert.equal((await f.members[0].call('/sessions'))[0].id,previous[0][0].id);
  assert.equal(f.app.store.db.prepare("SELECT count(*) AS count FROM audit WHERE action='project.create'").get()!.count,8);
 }finally{await f.app.close();}
});
test('duplicate clicks and retries after a restart recover the same project, including LAN-safe request IDs',async()=>{
 const f=await fixture();let app=f.app;try{const body={name:'可以恢复的项目',requestId:id().replaceAll('-','')};const result=await Promise.all(Array.from({length:8},()=>f.members[0].call('/projects','POST',body,201)));assert.equal(new Set(result.map(p=>p.id)).size,1);assert.equal(app.store.all('project').length,2);
  await f.members[0].call('/projects','POST',{...body,name:'改过名称'},409);await f.members[1].call('/projects','POST',body,409);await app.close();app=new Platform({dataDir:f.data,mockDelay:1});const c=new Client('http://127.0.0.1:'+await app.start(0));await c.login('member0');const restored=await c.call('/projects','POST',body,201);assert.equal(restored.id,result[0].id);assert.equal(app.store.all('project').length,2);assert.equal(app.store.db.prepare("SELECT count(*) AS count FROM audit WHERE action='project.create'").get()!.count,1);
 }finally{if(!app.closing)await app.close();}
});
test('member creation cannot select, import, bind or delete host folders, and disabled users cannot create',async()=>{
 const f=await fixture();try{const c=f.members[0],outside=join(f.root,'host-only');mkdirSync(outside);
  await c.call('/projects','POST',{name:'越权路径',requestId:id(),path:outside},400);await c.call('/projects','POST',{name:'spoof-owner',requestId:id(),owner:'admin'},400);await c.call('/projects','POST',{name:'',requestId:id()},400);await c.call('/projects','POST',{name:'bad-id',requestId:'../data'},400);
  await c.call('/admin/projects/preview','POST',{name:'host-only',path:outside},403);await c.call('/admin/project-directory/bind','POST',{previewId:id(),digest:'fake'},403);
  const created=await c.call('/projects','POST',{name:'正常项目',requestId:id()},201);c.project=created.id;await c.call('/changes','POST',{base:created.revision,writes:{'删除.md':null}},403);
  const member=f.app.store.all('user').find(u=>u.username==='member0')!;await f.admin.call('/admin/users/'+member.id,'PATCH',{active:false});await c.call('/projects','POST',{name:'停用后的项目',requestId:id()},401);assert.equal(f.app.store.all('project').length,2);assert(!existsSync(join(outside,'删除.md')));
 }finally{await f.app.close();}
});
test('symbolic links in the managed parent are blocked without writing outside platform storage',async()=>{
 const f=await fixture();try{const outside=join(f.root,'outside');mkdirSync(outside);symlinkSync(outside,join(f.data,'member-projects'));await f.members[0].call('/projects','POST',{name:'不跟随链接',requestId:id()},409);assert.equal(f.app.store.all('project').length,1);assert.equal(f.app.store.all('project-create-preview').length,0);
 }finally{await f.app.close();}
});
test('a workspace startup failure does not create another project on recovery',async()=>{
 const f=await fixture();try{const original=f.app.startWorkspace.bind(f.app),body={name:'启动恢复项目',requestId:id()};let fail=true;f.app.startWorkspace=async ws=>{if(fail&&ws.projects.projectId!=='shared'){fail=false;throw Error('injected startup failure');}return original(ws);};await f.members[0].call('/projects','POST',body,500);assert.equal(f.app.store.all('project').length,2);const p=await f.members[0].call('/projects','POST',body,201);assert(p.id);assert.equal(f.app.store.all('project').length,2);assert.equal(f.app.store.all('project-create-preview').filter(p=>p.mode==='managed').length,1);
 }finally{await f.app.close();}
});

test('interrupted chat assignment completes the original project and emits its creation event once',async()=>{
 const f=await fixture();try{const original=f.app.fixedChat.bind(f.app),body={name:'聊天初始化恢复项目',requestId:id()};let fail=true;f.app.fixedChat=(user,project='shared')=>{if(fail&&project!=='shared'){fail=false;throw Error('injected chat assignment failure');}return original(user,project);};await f.members[0].call('/projects','POST',body,500);assert.equal(f.app.store.all('project').length,2);assert.equal(f.app.store.db.prepare("SELECT count(*) AS count FROM audit WHERE action='project.create'").get()!.count,0);
  const created=await f.members[0].call('/projects','POST',body,201);assert.equal(f.app.workspace(created.id).store.all('member-chat').length,3);await f.members[0].call('/projects','POST',body,201);assert.equal(f.app.store.all('project').length,2);assert.equal(f.app.store.db.prepare("SELECT count(*) AS count FROM events WHERE type='project.created'").get()!.count,1);assert.equal(f.app.store.db.prepare("SELECT count(*) AS count FROM audit WHERE action='project.create'").get()!.count,1);
 }finally{await f.app.close();}
});
