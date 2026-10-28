import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,cpSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {setTimeout as delay} from 'node:timers/promises';import {execFileSync} from 'node:child_process';import {Readable} from 'node:stream';
import {Platform} from '../server/app.ts';import {id,hash,now,type Doc} from '../server/store.ts';
const password='project-fixture-only-12345';
class Client {cookie='';csrf='';project='shared';constructor(public base:string){}async call(path:string,method='GET',body?:Doc,expected=200){const query=this.project==='shared'?'':(path.includes('?')?'&':'?')+'project='+this.project;const r=await fetch(this.base+'/api'+path+query,{method,headers:{Origin:this.base,Cookie:this.cookie,'X-CSRF-Token':this.csrf,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const b=await r.json() as Doc;assert.equal(r.status,expected,JSON.stringify(b));if(r.headers.get('set-cookie'))this.cookie=r.headers.get('set-cookie')!.split(';')[0];if(b.csrf)this.csrf=b.csrf;return b;}async login(name:string){return this.call('/login','POST',{username:name,password});}}
async function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'multi-project-'))),data=join(root,'data');let app=new Platform({dataDir:data,mockDelay:1});const admin=new Client('http://127.0.0.1:'+await app.start(0));await admin.call('/setup','POST',{username:'admin',password},201);await admin.login('admin');function folder(name:string){const path=join(root,name);mkdirSync(path);writeFileSync(join(path,'剧本.md'),name+'的独立剧本');return path;}
 async function create(name:string){const path=folder(name);const preview=await admin.call('/admin/projects/preview','POST',{name,path},201),project=await admin.call('/admin/projects','POST',{previewId:preview.id,digest:preview.digest},201);return {project,path,preview};}
 async function settle(){for(let n=0;n<400;n++){if(!app.store.all('task').some(t=>['queued','running'].includes(t.state)))return;await delay(20);}throw Error('tasks did not finish');}
 return {root,data,app,admin,folder,create,settle};}

test('admin creates independent projects; eight members synchronize private chats, project reads and concurrent tasks',async()=>{
 const f=await fixture();try{
  const clients:Client[]=[],oldChats:string[]=[];for(let n=1;n<=8;n++){await f.admin.call('/admin/users','POST',{username:'member'+n,password,role:'member'},201);const c=new Client(f.admin.base);await c.login('member'+n);oldChats.push((await c.call('/sessions'))[0].id);clients.push(c);}
  const original=f.app.projects.current().revision,a=await f.create('项目甲'),b=await f.create('项目乙');assert.equal(f.app.projects.current().revision,original);assert.equal(f.app.store.all('project').length,3);
  assert.equal((await f.admin.call('/admin/projects','POST',{previewId:a.preview.id,digest:a.preview.digest},201)).id,a.project.id);assert.equal(f.app.store.all('project').length,3);
  const chats:string[]=[];const tasks:Doc[]=await Promise.all(clients.map(async(c,n)=>{const projects=await c.call('/projects');assert.equal(projects.length,3);assert(!JSON.stringify(projects).includes(f.root));c.project=n%2?a.project.id:b.project.id;const p=await c.call('/project');assert.equal(p.id,c.project);const s=(await c.call('/sessions'))[0];chats.push(s.id);assert.notEqual(s.id,oldChats[n]);assert.equal(s.fixed,true);const content=await c.call('/file?path='+encodeURIComponent('剧本.md'));assert.equal(content.content,n%2?'项目甲的独立剧本':'项目乙的独立剧本');return c.call('/tasks','POST',{session:s.id,requestId:id(),prompt:'整理所选资料，保留项目来源',workflow:'organize',paths:['剧本.md']},202);}));
  assert.equal(new Set(chats).size,8);await f.settle();for(let n=0;n<clients.length;n++){const c=clients[n],t=f.app.store.get('task',tasks[n].id)!;assert.equal(t.project,c.project);assert.equal(t.state,'awaiting_review');assert.equal((await c.call('/tasks')).length,1);const messages=await c.call('/sessions/'+t.session+'/messages');assert.equal(messages.length,2);assert(JSON.stringify(messages).includes(n%2?'项目甲的独立剧本':'项目乙的独立剧本'));}
  // A known id or revision from another project must not change the selected workspace.
  const c=clients[0];await c.call('/file?path='+encodeURIComponent('剧本.md')+'&revision='+a.project.revision,'GET',undefined,404);await c.call('/changes','POST',{base:a.project.revision,writes:{'bad.md':'wrong project'}},404);
  c.project=a.project.id;await c.call('/sessions/'+tasks[0].session+'/messages','GET',undefined,404);await c.call('/tasks','POST',{session:tasks[0].session,requestId:id(),prompt:'wrong session',workflow:'chat',paths:[]},404);
  await c.call('/admin/projects/preview','POST',{name:'forbidden',path:a.path},403);await c.call('/admin/projects','POST',{previewId:a.preview.id,digest:a.preview.digest},403);await c.call('/sessions/'+tasks[1].session+'/messages','GET',undefined,404);
  const ownA=(await c.call('/sessions'))[0];assert.equal((await c.call('/sessions/'+ownA.id+'/messages')).length,0);c.project='shared';assert.equal((await c.call('/sessions'))[0].id,oldChats[0]);assert.equal((await c.call('/tasks')).length,0);
  f.admin.project=b.project.id;const change=await f.admin.call('/changes','POST',{base:b.project.revision,writes:{'成果.md':'乙的已审核内容'}},201);await f.admin.call('/changes/'+change.id+'/approve','POST',{digest:change.digest});assert.equal(readFileSync(join(b.path,'成果.md'),'utf8'),'乙的已审核内容');assert.throws(()=>readFileSync(join(a.path,'成果.md')));
  const identity=f.app.serverId;await f.app.close();const resumed=new Platform({dataDir:f.data,mockDelay:1});try{const restored=new Client('http://127.0.0.1:'+await resumed.start(0));await restored.login('member1');restored.project=b.project.id;assert.equal((await restored.call('/sessions'))[0].id,tasks[0].session);assert.equal((await restored.call('/tasks')).length,1);assert.equal(resumed.serverId,identity);assert.equal((await restored.call('/file?path='+encodeURIComponent('成果.md'))).content,'乙的已审核内容');}finally{await resumed.close();}
 }finally{if(!f.app.closing)await f.app.close();}
});

test('create requires frozen directory preview, rejects overlap, symlinks, duplicates and platform storage',async()=>{
 const f=await fixture();try{
  const a=await f.create('项目甲');for(const path of [a.path,join(a.path,'child')]){if(path!==a.path)mkdirSync(path);await f.admin.call('/admin/projects/preview','POST',{path,name:'overlap'},409);}
  const dir=f.folder('项目乙'),p=await f.admin.call('/admin/projects/preview','POST',{name:'项目乙',path:dir},201);writeFileSync(join(dir,'剧本.md'),'修改后的内容');await f.admin.call('/admin/projects','POST',{previewId:p.id,digest:p.digest},409);assert.equal(f.app.store.all('project').length,2);
  const link=join(f.root,'linked');symlinkSync(dir,link);await f.admin.call('/admin/projects/preview','POST',{name:'linked',path:link},409);await f.admin.call('/admin/projects/preview','POST',{name:'data',path:f.data},403);await f.admin.call('/admin/projects/preview','POST',{name:'项目甲',path:dir},409);
  writeFileSync(join(dir,'原件.bin'),Buffer.from([255,255]));await f.admin.call('/admin/projects/preview','POST',{name:'binary-supported',path:dir},201);
  const empty=join(f.root,'空目录');mkdirSync(empty);const e=await f.admin.call('/admin/projects/preview','POST',{name:'空项目',path:empty},201);const created=await f.admin.call('/admin/projects','POST',{previewId:e.id,digest:e.digest},201);f.admin.project=created.id;assert.equal((await f.admin.call('/project')).files.length,0);
 }finally{await f.app.close();}
});

test('same shot identifiers, scoped media, external imports and restoration stay within their own project',async()=>{
 const f=await fixture();try{
  const a=await f.create('项目甲'),b=await f.create('项目乙'),wa=f.app.workspace(a.project.id),wb=f.app.workspace(b.project.id),admin=f.app.store.all('user')[0];
  wa.store.put('video-job',{id:id(),project:a.project.id,sourceId:'S1',state:'failed',createAttempts:1});assert.equal(wa.pickups.quota.status(a.project.id,'S1').used,1);assert.equal(wb.pickups.quota.status(b.project.id,'S1').used,0);
  const media=await wa.pickups.media.ingest(Readable.from([Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0])]),admin.id,'project','fixture.png');assert.equal(wa.images.originals(admin).length,1);assert.equal(wb.images.originals(admin).length,0);assert.throws(()=>wb.pickups.media.get(media.id));
  // Foreign keys cannot be written through another project view, even for the same owner.
  assert.throws(()=>wb.store.put('media',{...media,scope:'project'}));
  writeFileSync(join(a.path,'剧本.md'),'外部甲新版本');f.admin.project=a.project.id;const diff=await f.admin.call('/admin/import-diff','POST',{},201);f.admin.project=b.project.id;await f.admin.call('/changes/'+diff.id+'/approve','POST',{digest:diff.digest},404);f.admin.project=a.project.id;await f.admin.call('/changes/'+diff.id+'/approve','POST',{digest:diff.digest});assert.equal(readFileSync(join(b.path,'剧本.md'),'utf8'),'项目乙的独立剧本');
  await f.app.close();const copy=join(f.root,'恢复数据');cpSync(f.data,copy,{recursive:true});assert.throws(()=>new Platform({dataDir:copy,mockDelay:1}),/数据目录迁移/);assert.equal(readFileSync(join(a.path,'剧本.md'),'utf8'),'外部甲新版本');
  for(const item of [a,b]){const directory=join(f.root,'restored-'+item.project.name);cpSync(item.path,directory,{recursive:true});execFileSync(process.execPath,['--import','tsx','scripts/rebind-restored-project.ts','--data',copy,'--project',directory,'--project-id',item.project.id],{cwd:process.cwd(),stdio:'pipe'});}
  const restored=new Platform({dataDir:copy,mockDelay:1});try{await restored.start(0);assert.equal(restored.workspaces.size,3);restored.workspace(a.project.id).projects.assertClean();restored.workspace(b.project.id).projects.assertClean();assert.equal(readFileSync(join(a.path,'剧本.md'),'utf8'),'外部甲新版本');}finally{await restored.close();}
 }finally{if(!f.app.closing)await f.app.close();}
});


test('video and image concurrency remain global while projects have independent queues',async()=>{
 const f=await fixture();try{const a=await f.create('项目甲'),b=await f.create('项目乙'),wa=f.app.workspace(a.project.id),wb=f.app.workspace(b.project.id);const channel={id:id(),revision:id(),concurrency:2};f.app.store.put('video-channel-version',{...channel,id:channel.revision});
 for(let i=0;i<2;i++)wa.store.put('video-job',{id:id(),channelId:channel.id,state:'submission_unknown',createAttempts:1});
 const waiting={id:id(),channelId:channel.id,channelRevision:channel.revision,state:'queued',createAttempts:0};wb.store.put('video-job',waiting);let creates=0;wb.pickups.launch=()=>{creates++;};wb.pickups.pump();assert.equal(creates,0);assert.equal(wb.store.get('video-job',waiting.id)?.state,'queued');
 const image={id:id(),channelId:channel.id,channelRevision:channel.revision,state:'queued',createAttempts:0};wb.store.put('image-job',image);wb.images.drive=async()=>{creates++;wb.store.put('image-job',{...image,state:'ready'});};wb.images.pump();assert.equal(creates,1,'image capacity is independent of video-channel thresholds');
 }finally{await f.app.close();}
});
