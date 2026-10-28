import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Platform} from '../server/app.ts';
const password='Folder-picker-test-only-123';
test('host browsing requires active admin, reveals directories only and preserves preview-confirm import and independent chats',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'host-picker-'))),folder=join(root,'选中的项目');mkdirSync(folder);mkdirSync(join(folder,'资料'));mkdirSync(join(folder,'.private'));writeFileSync(join(folder,'原稿.md'),'原件不改动');writeFileSync(join(folder,'secret.key'),'synthetic');
 const app=new Platform({dataDir:join(root,'data'),mockDelay:1});let cookie='',csrf='';
 try{const base=`http://127.0.0.1:${await app.start(0)}`;
 async function call(path:string,method='GET',body?:unknown,status=200){const r=await fetch(base+'/api'+path,{method,headers:{Cookie:cookie,Origin:base,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const b:any=await r.json();assert.equal(r.status,status,JSON.stringify(b));if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie')!.split(';')[0];if(b.csrf)csrf=b.csrf;return b;}
 const browse=(p:string,mode='create')=>'/admin/host-folders?'+new URLSearchParams({path:p,mode});
 await call(browse(folder),'GET',undefined,401);await call('/setup','POST',{username:'admin',password},201);await call('/login','POST',{username:'admin',password});
 const listing=await call(browse(folder));assert.equal(listing.path,folder);assert.deepEqual(listing.folders,[{name:'资料',path:join(folder,'资料')}]);assert.equal(listing.selectable,true);assert(!JSON.stringify(listing).includes('secret.key'));assert.equal(app.store.all('project').length,1);
 assert.equal((await call(browse(root))).selectable,false);
 for(const p of [join(root,'data'),join(root,'data/blobs'),join(folder,'.private')])await call(browse(p),'GET',undefined,403);
 symlinkSync(folder,join(root,'link'));await call(browse(join(root,'link')),'GET',undefined,409);await call(browse(root+'/link/资料'),'GET',undefined,409);
 await call(browse(root+'/missing'),'GET',undefined,404);await call(browse(root+'/../invalid'),'GET',undefined,400);await call(browse(folder,'bad'),'GET',undefined,400);
 assert.equal((await call(browse(folder)+'&q=不存在')).folders.length,0);assert.equal((await call(browse(folder)+'&q=资料')).folders.length,1);
 const member=await call('/admin/users','POST',{username:'member',password,role:'member'},201);
 rmSync(join(folder,'.private'),{recursive:true});
 const preview=await call('/admin/projects/preview','POST',{name:'选取测试',path:listing.path},201);writeFileSync(join(folder,'原稿.md'),'预览后变化');await call('/admin/projects','POST',{previewId:preview.id,digest:preview.digest},409);
 const p2=await call('/admin/projects/preview','POST',{name:'选取测试',path:listing.path},201);const project=await call('/admin/projects','POST',{previewId:p2.id,digest:p2.digest},201);assert.equal((await call(browse(folder))).selectable,false);
 const adminSession=(await call('/sessions?project='+project.id))[0];assert.equal(adminSession.fixed,true);
 await call('/login','POST',{username:'member',password});await call(browse(folder),'GET',undefined,403);assert((await call('/projects')).some((p:any)=>p.id===project.id));const memberSession=(await call('/sessions?project='+project.id))[0];assert.equal(memberSession.owner,member.id);assert.notEqual(memberSession.id,adminSession.id);await call('/sessions/'+adminSession.id+'/messages?project='+project.id,'GET',undefined,404);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
