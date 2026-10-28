import {readModelJSON} from './helpers/model-json.ts';
import {closeNativeFixture} from './helpers/close-native-fixture.ts';
import {scopeNativeAsset} from '../server/native-page.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,existsSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {Platform} from '../server/app.ts';
import {NativeHarness,NATIVE_FEATURES} from '../server/native-harness.ts';
import {id,hash} from '../server/store.ts';
import {budgetStatus} from '../server/model.ts';
import {runInNewContext} from 'node:vm';
import {waitNativeStartupToken} from '../server/native-health.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const password='Synthetic-native-test-123!';
async function until(fn:()=>boolean){for(let n=0;n<200;n++){if(fn())return;await delay(100);}throw Error('Native condition timed out');}

test('native browser transport carries upload authentication without leaking it to external origins',async()=>{
 const n=new NativeHarness({} as any,{} as any,()=>({} as any)),calls:any[]=[],messages:any[]=[];
 assert(existsSync(join(n.codeRoot,'native-harness/team-guard.mjs')),'runtime assets must resolve from the source module, independent of the launch directory');
 class Worker {postMessage(message:any,transfer:any){messages.push({message,transfer});}}
 const window:any={Worker,WebSocket:class{},EventSource:class{},fetch:async(input:any,options:any)=>{calls.push({input,options});}};
 runInNewContext(n.bootstrap('/harness/shared','fixture-csrf'),{window,URL,Headers,Request,location:new URL('http://127.0.0.1:4326/harness/shared/')});
 const worker=new window.Worker(),body=new Uint8Array([1,2,3]);worker.postMessage({url:'http://127.0.0.1:4326/api/session/uploadFileBinary?name=a.txt',headers:{'content-type':'application/octet-stream'},body},[body.buffer]);
 assert.equal(messages[0].message.url,'http://127.0.0.1:4326/harness/shared/api/session/uploadFileBinary?name=a.txt');assert.equal(messages[0].message.headers['X-CSRF-Token'],'fixture-csrf');assert.equal(messages[0].message.body,body);assert.equal(messages[0].transfer[0],body.buffer);
 worker.postMessage({url:'https://external.example/upload',headers:{},body});assert.equal(messages[1].message.headers['X-CSRF-Token'],undefined);
 await window.fetch(new Request('http://127.0.0.1:4326/api/test',{method:'POST',body:'fixture'}));assert.equal(calls[0].input.url,'http://127.0.0.1:4326/harness/shared/api/test');assert.equal(await calls[0].input.text(),'fixture');assert.equal(calls[0].options.headers.get('X-CSRF-Token'),'fixture-csrf');
 await window.fetch('https://external.example/data');assert.equal(calls[1].options.headers.get('X-CSRF-Token'),null);await n.close();
});

test('native sync refuses symlink parents and never touches files outside the mounted workspace',async()=>{
 const root=mkdtempSync(join(tmpdir(),'native-fs-')),work=join(root,'work'),outside=join(root,'outside');mkdirSync(work);mkdirSync(outside);mkdirSync(join(root,'blobs'));writeFileSync(join(outside,'secret.txt'),'outside secret');symlinkSync(outside,join(work,'folder'));const digest=hash('new project value');writeFileSync(join(root,'blobs',digest),'new project value');
 const current={revision:'r2'},n=new NativeHarness({root} as any,{} as any,()=>({projects:{current:()=>current,revision:()=>({manifest:{'folder/secret.txt':digest}})}} as any));const i={root,work} as any;
 const r=n.sync(i,{});assert.deepEqual(r.conflicts,['folder/secret.txt']);assert.equal(readFileSync(join(outside,'secret.txt'),'utf8'),'outside secret');assert.deepEqual(n.files(i),{});assert.equal(n.safePath(i,'folder/secret.txt'),false);assert.equal(n.safePath(i,'new/path.txt'),true);await n.close();rmSync(root,{recursive:true,force:true});
});

test('startup skips unchanged upstream files while preserving edits, deletions and later conflict checks',async()=>{
 const root=mkdtempSync(join(tmpdir(),'native-delta-')),work=join(root,'work');mkdirSync(work);mkdirSync(join(root,'blobs'));
 let manifest:Record<string,string>={};const n=new NativeHarness({root} as any,{} as any,()=>({projects:{current:()=>({revision:'r'}),revision:()=>({manifest})}} as any));const i={root,work} as any;
 const value=(s:string)=>{const h=hash(s);writeFileSync(join(root,'blobs',h),s);return h;};
 try{
  manifest={'edit.txt':value('original'),'deleted.txt':value('deleted baseline'),'same.txt':value('same')};n.sync(i,{},true);
  writeFileSync(join(work,'edit.txt'),'member draft');unlinkSync(join(work,'deleted.txt'));
  const unchanged=n.sync(i,{},true);assert.equal(unchanged.metrics.hashedBytes,0);assert.equal(unchanged.metrics.unchanged,3);
  assert.equal(readFileSync(join(work,'edit.txt'),'utf8'),'member draft');assert(!existsSync(join(work,'deleted.txt')));
  assert.deepEqual(n.sync(i,{}).conflicts.sort(),['deleted.txt','edit.txt']);
  manifest={...manifest,'edit.txt':value('upstream edit'),'same.txt':value('updated'),'new.txt':value('added')};
  const changed=n.sync(i,{},true);assert.deepEqual(changed.conflicts,['edit.txt']);assert.equal(changed.metrics.copied,2);
  assert.equal(readFileSync(join(work,'edit.txt'),'utf8'),'member draft');assert.equal(readFileSync(join(work,'same.txt'),'utf8'),'updated');assert.equal(readFileSync(join(work,'new.txt'),'utf8'),'added');
  assert.equal(JSON.parse(readFileSync(join(root,'base.json'),'utf8')).manifest['edit.txt'],hash('original'));
  // Removing an unchanged upstream file removes only the unchanged local copy.
  delete manifest['new.txt'];n.sync(i,{},true);assert(!existsSync(join(work,'new.txt')));
 }finally{await n.close();rmSync(root,{recursive:true,force:true});}
});

test('native administrator switches cover commands, uploads, model selection and member onboarding',async()=>{
 const n=new NativeHarness({get:()=>undefined} as any,{options:()=>({multipleSessions:true}),select:()=>{throw Error('model revoked');}} as any,()=>({} as any));let policy=n.policy('shared');n.policy=()=>policy;const user={id:'member',role:'member'},i={project:'shared'} as any,body=(args:any)=>Buffer.from(JSON.stringify({payload:{args}}));
 await n.checkRoute(user,i,'/api/settings/mutate',body({ns:'ui-onboarding'}));await n.checkRoute(user,i,'/api/agentPresets/select',body({agentPreset:'standard'}));await assert.rejects(n.checkRoute(user,i,'/api/settings/update',body({ns:'llm-deepseek'})),/管理员/);
 for(const [feature,path,args] of [['attachments','/api/session/uploadFileBinary',{}],['export','/api/session.export',{}],['goals','/api/commands/execute',{line:'/goal new task'}],['permissions','/api/commands/execute',{line:'/permission read-only'}],['models','/api/session/selectModel',{request:{model:'revoked'}}]] as const){policy={...policy,features:{...policy.features,[feature]:false}};await assert.rejects(n.checkRoute(user,i,path,body(args)),/管理员/);policy={...policy,features:{...policy.features,[feature]:true}};}
 policy={...policy,permissions:['read-only']};await assert.rejects(n.checkRoute(user,i,'/api/commands/execute',body({line:'/permission danger-full-access'})),/未开放/);await assert.rejects(n.checkRoute(user,i,'/api/session/selectModel',body({request:{model:'revoked'}})),/revoked/);await assert.rejects(n.checkRoute(user,i,'/api/workspace/create',body({request:{path:'/state'}})),/工作区/);await assert.rejects(n.checkRoute(user,i,'/api/session/create',body({request:{cwd:'/opt'}})),/工作区/);await n.close();
});

test('native multi-turn GLM proxy removes DeepSeek-only metadata while preserving conversation and tools',async()=>{
 const requests:any[]=[],fixture=createServer(async(req,res)=>{const b=await readModelJSON(req);requests.push(b);if('dsh_plugin_packages'in b||'dsh_session_log'in b){res.writeHead(400);res.end('Extra inputs are not permitted');return;}res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'synthetic GLM reply'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10}})+'\n\ndata: [DONE]\n\n');});await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));
 const root=mkdtempSync(join(tmpdir(),'native-glm-')),app=new Platform({dataDir:root,model:{provider:'opencode-zen',model:'glm-5.3-flash',apiKey:'synthetic-only',baseURL:'http://127.0.0.1:'+(fixture.address() as any).port,configId:'native-glm-fixture',reasoningEffort:'high',fixture:true}}),member=app.newUser({username:'nativeglm',password},'member'),key='0123456789abcdef01234567',token='synthetic-native-token';
 app.native.instances.set(key,{key,owner:member.id,project:'shared',active:0,closed:false,token} as any);const proxy=createServer((req,res)=>void app.native.model(req,res).catch(e=>{res.writeHead(500);res.end(e.message);}));await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
 try{const messages:any[]=[{role:'user',content:'Prepare a plan only'}],tools=[{type:'function',function:{name:'team_video_prepare',parameters:{type:'object'}}}];for(let turn=0;turn<2;turn++){const r=await fetch(`http://127.0.0.1:${(proxy.address() as any).port}/native-model/${key}/chat/completions`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({model:'default',stream:true,max_tokens:1024,thinking:{type:'enabled'},messages,tools,...(turn?{dsh_plugin_packages:{packages:['synthetic']},dsh_session_log:{entries:['synthetic']}}:{})})});const responseText=await r.text();assert.equal(r.status,200,responseText);assert.equal(requests[turn].model,'glm-5.3-flash');assert.deepEqual(requests[turn].messages,messages);assert.deepEqual(requests[turn].tools,tools);assert.equal(requests[turn].thinking,undefined);assert.equal(requests[turn].reasoning_effort,'high');messages.push({role:'assistant',content:'First response'},{role:'user',content:'Revise the previous plan'});}assert.equal(requests.length,2);assert.equal(app.store.all('model-call').filter(c=>c.state==='usage_recorded').length,2);
 }finally{app.native.instances.delete(key);await closeNativeFixture(app);await Promise.all([new Promise<void>(r=>proxy.close(()=>r())),new Promise<void>(r=>fixture.close(()=>r()))]);rmSync(root,{recursive:true,force:true});}
});

test('official native runtime: model, tools, sessions, controls, account isolation, durable review and accounting',{skip:process.env.NATIVE_HARNESS_TEST!=='1',timeout:120000},async()=>{
 const requests:any[]=[];const fixture=createServer(async(req,res)=>{const b=await readModelJSON(req);requests.push(b);res.writeHead(200,{'Content-Type':'text/event-stream'});const toolDone=b.messages.some((m:any)=>m.role==='tool');const text=JSON.stringify(b.messages.filter((m:any)=>m.role==='user')),kind=text.includes('RUN_BASH_FIXTURE')?'bash':text.includes('RUN_DENIED_FIXTURE')?'denied':'write';const toolRequest=/RUN_(WRITE|BASH|DENIED)_FIXTURE/.test(text);
 const delta=toolRequest&&!toolDone?{role:'assistant',reasoning_content:'synthetic tool check',tool_calls:[{index:0,id:'fixture-write',type:'function',function:{name:kind==='bash'?'bash':'write',arguments:JSON.stringify(kind==='bash'?{command:'printf native-shell > native-shell.txt',description:'Write a synthetic native shell result'}:{file_path:kind==='denied'?'/workspace/must-not-exist.txt':'/workspace/native-result.txt',content:'native tool result'})}}]}:{role:'assistant',reasoning_content:'synthetic reasoning',content:'native fixture complete'};
 for(const j of [{choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:toolRequest&&!toolDone?'tool_calls':'stop'}]},{choices:[],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}])res.write('data: '+JSON.stringify({id:'native-fixture',...j})+'\n\n');res.end('data: [DONE]\n\n');});await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));
 const root=mkdtempSync(join(tmpdir(),'native-full-')),app=new Platform({dataDir:root,nativeProjectSurface:true,model:{provider:'deepseek-official',model:'deepseek-flash',apiKey:'synthetic-native-fixture-only',baseURL:'http://127.0.0.1:'+(fixture.address() as any).port,configId:'native-fixture',reasoningEffort:'high',fixture:true}});
 try{await app.start(0);const admin=app.newUser({username:'nativeadmin',password},'admin'),member=app.newUser({username:'nativemember',password},'member');const i=await app.native.get(admin,'shared'),other=await app.native.get(member,'shared');assert.notEqual(i.port,other.port);assert.notEqual(i.work,other.work);
  const rpc=(method:string,args:any={})=>app.native.rpc(i,method,args,true),s=await rpc('session/create',{request:{cwd:'/workspace'}}),s2=await rpc('session/create',{request:{cwd:'/workspace'}});assert.notEqual(s.sessionId,s2.sessionId);await rpc('session/rename',{request:{sessionId:s.sessionId,title:'原生验收会话'}});
  const docker=['/opt/homebrew/bin/docker','/usr/local/bin/docker','/Applications/Docker.app/Contents/Resources/bin/docker'].find(existsSync)!,run=promisify(execFile),beforeId=(await run(docker,['inspect','--format','{{.Id}}',i.name])).stdout.trim();let logReads=0;
  const startupToken=await waitNativeStartupToken({readLogs:async()=>{if(++logReads===1)throw Object.assign(Error('synthetic Docker socket read interruption'),{code:1,stderr:'Cannot connect to the Docker daemon'});const out=await run(docker,['logs','--tail','30',i.name]);return out.stdout+out.stderr;}});
  assert(startupToken,'the same live runtime must still supply its token');assert(logReads>=2&&logReads<=100);assert.equal((await run(docker,['inspect','--format','{{.Id}}',i.name])).stdout.trim(),beforeId);assert.equal(app.native.instances.size,2);
  console.log(JSON.stringify({sameContainerLogReadRecovery:true,logReads,noRuntimeReplacement:true}));
  // A host UID (for example macOS 501) may have no /etc/passwd entry in Linux.
  // Exercise native shell discovery and a real PTY instead of only the bash tool.
  const shells=await rpc('terminal/shells',{agentId:s.sessionId});assert(Array.isArray(shells)&&shells.some((v:any)=>v.path==='/bin/bash'));const terminalId=id();
  try{const terminal=await rpc('terminal/create',{agentId:s.sessionId,request:{id:terminalId,cols:80,rows:24}});assert.equal(terminal.id,terminalId);}finally{await rpc('terminal/close',{agentId:s.sessionId,id:terminalId});}
  const ownList=await rpc('session/list',{_request:{}});assert(JSON.stringify(ownList).includes('原生验收会话'));const otherList=await app.native.rpc(other,'session/list',{_request:{}},true);assert(!JSON.stringify(otherList).includes(s.sessionId));
  const catalog=await rpc('session/modelCatalog');assert(JSON.stringify(catalog).includes('deepseek-flash'));const commands=await rpc('commands/list',{agentId:s.sessionId});assert(JSON.stringify(commands).includes('compact'));assert(JSON.stringify(commands).includes('goal'));
  await rpc('session/prompt',{request:{sessionId:s.sessionId,requestId:id(),mode:'queue',content:[{type:'text',text:'RUN_WRITE_FIXTURE'}]}});await until(()=>existsSync(join(i.work,'native-result.txt')));await until(()=>i.active===0&&app.store.all('model-call').some(c=>c.state==='usage_recorded'));assert.equal(readFileSync(join(i.work,'native-result.txt'),'utf8'),'native tool result');
  const names=requests.find(r=>r.tools?.length)?.tools.map((t:any)=>t.function.name)??[];for(const name of ['bash','read','write','edit','glob','grep','web_search','web_fetch','skill','subagent','subagent_fork','send_message','workflow','ralph','create_goal','ask_user_question','todo_write','present','schedule_create','job_list'])assert(names.includes(name),'Missing native tool '+name);
  const shellSession=await rpc('session/create',{request:{cwd:'/workspace'}});await rpc('session/prompt',{request:{sessionId:shellSession.sessionId,requestId:id(),mode:'queue',content:[{type:'text',text:'RUN_BASH_FIXTURE'}]}});await until(()=>{const p=join(i.root,'state/team-submissions.json');return existsSync(p)&&JSON.parse(readFileSync(p,'utf8')).items.some((v:any)=>v.session===shellSession.sessionId&&v.state==='completed');});assert.equal(readFileSync(join(i.work,'native-shell.txt'),'utf8'),'native-shell');const budget=budgetStatus(app.store);assert(Number.isFinite(budget.usedEstimateUsd));assert(budget.usedEstimateUsd>0);
  const changes=await app.native.frozen(i,()=>app.native.changes(i));assert(changes.files.some(f=>f.path==='native-result.txt'));const candidate=await app.native.frozen(i,()=>app.native.submit(i,admin,['native-result.txt']));assert.equal(candidate.state,'submitted');assert(!app.projects.revision(app.projects.current().revision).manifest['native-result.txt']);await app.projects.approve(candidate,admin,candidate.digest);assert.equal(app.projects.revision(app.projects.current().revision).manifest['native-result.txt'],hash('native tool result'));
  const exported=await fetch(`http://127.0.0.1:${i.port}/api/session.export?sessionId=${s.sessionId}`,{headers:{Cookie:i.cookie}});assert.equal(exported.status,200);assert((await exported.arrayBuffer()).byteLength>100);
  const indexFile=join(i.root,'state/team-submissions.json');await until(()=>existsSync(indexFile)&&JSON.parse(readFileSync(indexFile,'utf8')).items.some((v:any)=>v.session===s.sessionId&&v.state==='completed'));const summary=JSON.parse(readFileSync(indexFile,'utf8'));assert.equal(summary.items.filter((v:any)=>v.session===s.sessionId).length,1);assert(!JSON.stringify(summary).includes('synthetic reasoning'));
  const saved=app.native.policy('shared');await app.native.savePolicy(admin,'shared',{...saved,features:{...saved.features,files:false}});const guarded=await rpc('session/create',{request:{cwd:'/workspace'}});await rpc('session/prompt',{request:{sessionId:guarded.sessionId,requestId:id(),mode:'queue',content:[{type:'text',text:'RUN_DENIED_FIXTURE'}]}});await until(()=>existsSync(join(i.work,'must-not-exist.txt')));assert.equal(JSON.parse(readFileSync(join(i.root,'control/policy.json'),'utf8')).features.files,true);await app.native.savePolicy(admin,'shared',saved);await until(()=>i.active===0&&app.native.activity(i)?.agents===0);await app.native.stop(admin,'shared',i.key);const resumed=await app.native.get(admin,'shared');const persisted=await app.native.rpc(resumed,'session/list',{_request:{}},true);assert(JSON.stringify(persisted).includes(s.sessionId));await app.native.savePolicy(admin,'shared',{...saved,enabled:false});assert.equal(app.native.policy('shared').enabled,true);assert.equal((await app.native.get(admin,'shared')).owner,admin.id);
 }finally{if(process.env.NATIVE_TEST_EVIDENCE){mkdirSync(process.env.NATIVE_TEST_EVIDENCE,{recursive:true});for(const i of app.native.instances.values())for(const f of ['startup.log','startup-error.json'])if(existsSync(join(i.root,f)))writeFileSync(join(process.env.NATIVE_TEST_EVIDENCE,i.key+'-'+f),readFileSync(join(i.root,f)),{mode:0o600});}await closeNativeFixture(app);await new Promise<void>(r=>fixture.close(()=>r()));rmSync(root,{recursive:true,force:true});}
});


test('native 0.2 stream route is scoped once even when the page base includes a project and member',async()=>{
 const {scopeNativeAsset}=await import('../server/native-page.ts');
 const source=`const REMOTE_STREAM_MUX_PATH = "/api/remote.mux";function remoteStreamUrl(){const globals=globalThis;const url=new URL(REMOTE_STREAM_MUX_PATH.slice(1),globals.__DSH_TRANSPORT__?.streamBaseUrl??document.baseURI);url.protocol='ws:';return url.href;}result=remoteStreamUrl();`;
 for(const prefix of ['/harness/shared','/harness/shared~member']){const context:any={URL,document:{baseURI:'http://127.0.0.1:4325'+prefix+'/'}};runInNewContext(scopeNativeAsset(source,prefix),context);assert.equal(context.result,'ws://127.0.0.1:4325'+prefix+'/api/remote.mux');}
});

test('pinned 0.2 client keeps native workspace slots, media turns and scoped relative routes',()=>{
 const root=new URL('../native-harness/node_modules/@deepseek-ai/',import.meta.url);
 const workspace=readFileSync(new URL('dsh-client-ui-workspace/lib/client.js',root),'utf8');
 const adapted=scopeNativeAsset(workspace,'/harness/shared');
 assert(adapted.includes('function SessionTree({ renderMemberGroups, list,'));
 assert(adapted.includes('window.__TEAM_WORKSPACE_BROWSER__(WorkspaceBrowser, props)'));
 assert(adapted.includes('renderMemberGroups(group, renderRow)'));
 for(const name of ['sidebar.workspaces.session.menu.item','sidebar.workspaces.session.row.action','sidebar.session.row.leading','sidebar.session.row.hover'])assert(adapted.includes('"'+name+'": {'));
 const chat=scopeNativeAsset(readFileSync(new URL('dsh-client-ui-tool/lib/client.js',root),'utf8'),'/harness/shared');
 assert(chat.includes('teamGalleryTurn:node.location?.turn?.turn'));
 for(const path of ['dsh-session-log-export','dsh-client-file-upload','dsh-client-ui-deliverables','dsh-client-hmr']){
  const js=scopeNativeAsset(readFileSync(new URL(path+'/lib/client.js',root),'utf8'),'/harness/shared~member');
  assert(!/['"]\/harness\/[^'"\n]+['"]\.slice\(1\)/.test(js),path+' literal route');
  for(const m of js.matchAll(/const (\w+) = ['"]\/harness\//g))assert(!js.includes(m[1]+'.slice(1)'),path+' constant route');
 }
});
