import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,cpSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Script,runInNewContext} from 'node:vm';
import {adaptStudioSource,prepareStudioPlugin} from '../server/native-studio.ts';
import {scopeNativeAsset,nativePageBridge} from '../server/native-page.ts';
import {NativeHarness} from '../server/native-harness.ts';
import {Platform} from '../server/app.ts';
import {studioMediaURL} from '../shared/project-studio.ts';
import {createRequire} from 'node:module';

test('direct chat composition preserves native slot ownership and parses all pinned UI modules',()=>{
 for(const name of ['layout','sidebar','conversation','workspace','settings-general']){
  const text=readFileSync(resolve('native-harness/node_modules/@deepseek-ai/dsh-client-ui-'+name+'/lib/client.js'),'utf8'),adapted=adaptStudioSource(text);
  assert.notEqual(adapted,text);new Script(adapted);
  assert.equal((text.match(/ctx\.slots\.register\(/g)??[]).length,(adapted.match(/ctx\.slots\.register\(/g)??[]).length);
  if(name==='conversation'){assert(adapted.includes("renderFactorySlot('conversation.content'"));assert(adapted.includes('__TEAM_STUDIO_ACTIONS__'));}
  if(name==='workspace')assert(adapted.includes('dsh.sessions.current:team:'));
  if(name==='settings-general'){
   assert(adapted.includes("document.querySelector('[data-studio-settings-host]')"));
   assert(adapted.includes('useModalLayer)(panel, true, onClose)'));
   assert.equal((adapted.match(/renderSlot\("settings.section"/g)??[]).length,(text.match(/renderSlot\("settings.section"/g)??[]).length);
  }
 }
 assert.throws(()=>adaptStudioSource('function ConversationMainPanel(props){}'),/接口变化/);
 assert.equal(adaptStudioSource('other module'),'other module');
});

test('native project selection and original conversation stores are scoped without replacing localStorage or migrating another account',()=>{
 const workspace=adaptStudioSource(readFileSync(resolve('native-harness/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js'),'utf8'));
 const conversation=adaptStudioSource(readFileSync(resolve('native-harness/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'),'utf8'));
 for(const [key,expression] of [['dsh.workspace.view.v5',workspace.match(/persist: (.*),\n/)![1]],['dsh.sessions.current',workspace.match(/persist: \{ name: (.*) \} \}/)![1]],['dsh.conversation',conversation.match(/const CONVERSATION_STORE_KEY = (.*);/)![1]]]){
  for(const scope of ['viewer-a:shared','viewer-a:project-b','admin-a:shared:owner-b']){
   assert.equal(runInNewContext(expression,{window:{__TEAM_STUDIO_MODE__:true,__TEAM_STUDIO_SCOPE__:scope}}),key+':team:'+encodeURIComponent(scope));
   assert.equal(runInNewContext(expression,{window:{__TEAM_STUDIO_MODE__:false}}),key);
  }
  assert(!expression.includes('localStorage.setItem'));assert(!expression.includes('Storage.prototype'));
 }
 assert.throws(()=>adaptStudioSource('function createWorkspaceViewStore(){}'),/存储接口变化/);
 assert.throws(()=>adaptStudioSource(readFileSync(resolve('native-harness/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'),'utf8').replace('restoreDraft(draft, occurrences) {','changedNativeAPI() {')),/附件恢复接口变化/);
});

test('asset scoping cannot rewrite code inside the project component bundle',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-studio-bundle-')),control=join(root,'control');
 try{
  mkdirSync(join(root,'native-harness/team-project'),{recursive:true});mkdirSync(join(control,'team-project'),{recursive:true});
  cpSync(resolve('native-harness/team-project/client.js'),join(control,'team-project/client.js'));cpSync(resolve('native-harness/team-project/package.json'),join(control,'team-project/package.json'));
  const bundle="exports.proof={name:'剧本',api:'/api/file-content',model:'script/api/model'};";writeFileSync(join(root,'native-harness/team-project/studio.cjs'),bundle);writeFileSync(join(root,'native-harness/team-project/studio.css'),'');
  prepareStudioPlugin(root,control);const prepared=readFileSync(join(control,'team-project/client.js'),'utf8'),scoped=scopeNativeAsset(prepared,'/harness/shared');
  const encoded=scoped.match(/atob\('([A-Za-z0-9+/=]+)'\)/)?.[1];assert(encoded);assert.equal(Buffer.from(encoded,'base64').toString(),bundle);new Script(scoped);
  const pkg=JSON.parse(readFileSync(join(control,'team-project/package.json'),'utf8'));assert(pkg.dsh.client.external.includes('react/jsx-runtime'));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('standalone native bootstrap keeps model RPC scoped while project navigation uses the authenticated host route',async()=>{
 const calls:any[]=[],location={href:'http://127.0.0.1:4325/harness/shared/',origin:'http://127.0.0.1:4325',host:'127.0.0.1:4325'},window:any={fetch:async(url:string,options:any)=>{calls.push({url,options});return new Response('{}');},Worker:class{postMessage(){}},WebSocket:class{},EventSource:class{}};
 const script=NativeHarness.prototype.bootstrap.call({projectSurface:true} as NativeHarness,'/harness/shared','synthetic-csrf');
 runInNewContext(script,{window,location,Request,Headers,URL});assert.equal(window.__TEAM_STUDIO_MODE__,true);
 await window.fetch('/api/session/prompt',{method:'POST'});assert.equal(new URL(calls[0].url).pathname,'/harness/shared/api/session/prompt');
 await window.__TEAM_HOST_FETCH__('/api/native/open?project=shared',{method:'POST'});assert.equal(new URL(calls[1].url).pathname,'/api/native/open');assert.equal(calls[1].options.headers.get('x-csrf-token'),'synthetic-csrf');
 for(const path of ['https://other.invalid/api/native/open','/api/admin/users','/api/login'])assert.throws(()=>window.__TEAM_HOST_FETCH__(path),/范围/);
 const legacy:any={fetch:async()=>new Response('{}'),Worker:class{},WebSocket:class{},EventSource:class{}};runInNewContext(NativeHarness.prototype.bootstrap.call({projectSurface:false} as NativeHarness,'/harness/shared','synthetic-csrf'),{window:legacy,location,Request,Headers,URL});assert.equal(legacy.__TEAM_STUDIO_MODE__,undefined);assert.equal(legacy.__TEAM_HOST_FETCH__,undefined);
});

test('standalone bridge opt-in retains existing context and sync observers without changing the legacy iframe bridge',()=>{
 const normal=nativePageBridge('synthetic-scope',{project:'shared',admin:false}),direct=nativePageBridge('synthetic-scope',{project:'shared',admin:false},true);
 assert(normal.includes('if(window.parent===window)return;'));assert(!direct.includes('if(window.parent===window)return;'));
 for(const code of [normal,direct]){new Script(code);assert(code.includes('__TEAM_SYNC__'));assert(code.includes('__TEAM_REFERENCE_INPUTS__'));}
});

test('desktop direct surface uses its existing host connection only for the narrow project navigation bridge',async()=>{
 const calls:any[]=[],window:any={teamDesktop:{projectRequest:async(...args:any[])=>{calls.push(args);return {ok:true,value:{status:200,data:{url:'synthetic'}}};}},fetch:async()=>assert.fail('host navigation must not use an unauthenticated root cookie'),Worker:class{},WebSocket:class{},EventSource:class{}},location=new URL('http://127.0.0.1:4325/harness/shared/');
 runInNewContext(NativeHarness.prototype.bootstrap.call({projectSurface:true} as NativeHarness,'/harness/shared','synthetic-csrf'),{window,location,Request,Response,Headers,URL});
 const response=await window.__TEAM_HOST_FETCH__('/api/native/open?project=shared',{method:'POST',body:'{}'});assert.equal(response.status,200);assert.deepEqual(await response.json(),{url:'synthetic'});assert.equal(calls[0][0],'/api/native/open?project=shared');assert.equal(calls[0][1],'POST');assert.equal(JSON.stringify(calls[0][2]),'{}');
 assert.throws(()=>window.__TEAM_HOST_FETCH__('/api/admin/users'),/范围/);
});

test('direct surface images and videos stay on the authenticated project path while legacy root links remain compatible',()=>{
 for(const raw of ['/api/media/123','/api/media/123/preview?variant=thumb','/api/native-attachments/'+'a'.repeat(64)+'/content']){
  assert(studioMediaURL(raw,'shared','/harness/shared/')?.startsWith('/harness/shared/team-settings/api/'));
  assert(studioMediaURL(raw,'shared','/harness/shared~11111111-1111-1111-1111-111111111111/')?.startsWith('/harness/shared~11111111-1111-1111-1111-111111111111/team-settings/api/'));
  assert(studioMediaURL(raw,'shared','/index.html')?.startsWith('/api/'));
 }
 assert.equal(studioMediaURL('/api/media/123?project=other','shared','/harness/shared/'),undefined);assert.equal(studioMediaURL('https://external.invalid/api/media/123','shared','/harness/shared/'),undefined);
});

test('local candidate surface is opt-in and never changes the default service capability',async()=>{
 for(const enabled of [false,true]){
  const data=mkdtempSync(join(tmpdir(),'native-studio-capability-')),app=new Platform({dataDir:data,nativeProjectSurface:enabled,mediaWorker:false,concurrency:500,videoConcurrency:500});
  try{const port=await app.start(0),status:any=await(await fetch('http://127.0.0.1:'+port+'/api/status')).json();assert.equal(status.capabilities.includes('native-project-surface'),enabled);assert.equal(status.textConcurrency,500);assert.equal(status.videoConcurrency,500);assert.equal(app.native.projectSurface,enabled);}
  finally{await app.close();rmSync(data,{recursive:true,force:true});}
 }
});

test('desktop ticket and project original download use actual host authentication without a root browser cookie',async()=>{
 const require=createRequire(import.meta.url),{Connection}=require('../desktop/connection.cjs'),{NativeAccess}=require('../desktop/native-access.cjs'),{openProject,isSurfacePage}=require('../desktop/project-surface.cjs');
 const data=mkdtempSync(join(tmpdir(),'surface-desktop-http-')),app=new Platform({dataDir:data,nativeProjectSurface:true,mediaWorker:false}),connection=new Connection(),access=new NativeAccess();
 const password='Synthetic-Test-Password',admin=app.newUser({username:'本机组件管理员',password},'admin'),member=app.newUser({username:'本机组件成员',password},'member');
 // The test exercises real authentication and project-file routes. Only native
 // container startup is replaced; this is not a desktop UI or Docker test.
 app.native.open=async()=>({startup:{startedAt:1,readyAt:2}} as any);
 try{
  const original='同一项目的原件，不改写中文内容。',candidate=app.projects.candidate(admin,app.projects.current().revision,{'剧本/组件验收.txt':original},{});app.projects.approve(candidate,admin,candidate.digest);
  const origin='http://127.0.0.1:'+await app.start(0);await connection.connect(origin,app.serverId);assert.equal((await connection.call('/api/login','POST',{username:member.username,password})).status,200);
  const issued=await connection.call('/api/native/open?project=shared','POST',{});assert.equal(issued.status,200);
  const opened=await openProject({url:issued.data.url,projectSurface:true,connection,access});assert.equal(isSurfacePage(opened.url,access,connection),true);
  const entry=access.find(opened.url,connection),path='/harness/shared/team-settings/api/file-content?'+new URLSearchParams({project:'shared',path:'剧本/组件验收.txt'});
  const response=await fetch(origin+path,{headers:{Cookie:entry.cookie}});assert.equal(response.status,200);assert.equal(await response.text(),original);
  assert.equal((await fetch(origin+'/api/file-content?'+new URLSearchParams({project:'shared',path:'剧本/组件验收.txt'}),{headers:{Cookie:entry.cookie}})).status,401);
  const replay=await fetch(issued.data.url,{redirect:'manual'});assert.equal(replay.status,401,'consumed tickets cannot be reused');
  await connection.call('/api/logout','POST',{});assert.equal(isSurfacePage(opened.url,access,connection),false);assert.equal((await fetch(origin+path,{headers:{Cookie:entry.cookie}})).status,401);
 }finally{connection.disconnect();await app.close();rmSync(data,{recursive:true,force:true});}
});
