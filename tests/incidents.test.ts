import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Readable} from 'node:stream';
import {Platform} from '../server/app.ts';
import {hash,id,type Doc} from '../server/store.ts';
import {CodexExec,codexArgs,parseDecision,type IncidentRunner,type Decision,type CodexInput} from '../server/incident-codex.ts';
import {redactor} from '../server/incident-context.ts';
const password='Synthetic-Test-Password';
const decision=(action:Decision['action'],message='测试诊断结果',kind='',jobId=''):Decision=>({action,message,kind,jobId});
class Runner implements IncidentRunner{
 inputs:CodexInput[]=[];threads=new Map<string,string>();behavior:(input:CodexInput)=>Promise<Decision>=async()=>decision('needs_info','请补充点击后看到的现象');
 async run(input:CodexInput){this.inputs.push(input);const thread=this.threads.get(input.workspace)??id();this.threads.set(input.workspace,thread);input.onEvent({type:'thread.started',thread_id:thread});const d=await this.behavior(input);input.onEvent({type:'turn.completed',usage:{input_tokens:30,output_tokens:10}});return d;}
}
async function fixture(enabled=false,runner?:IncidentRunner,verifyPatch?:any){const root=mkdtempSync(join(tmpdir(),'incident-test-')),source=join(root,'code');mkdirSync(source);writeFileSync(join(source,'package.json'),'{"name":"fixture"}');writeFileSync(join(source,'example.txt'),'old\n');const app=new Platform({dataDir:join(root,'data'),mockDelay:1,incidents:{sourceRoot:source,runner,enabled,concurrency:3,verifyPatch}});const admin=app.newUser({username:'admin',password},'admin'),members=Array.from({length:8},(_,n)=>app.newUser({username:'member'+n,password,name:'成员'+n},'member'));
 app.native.history.read=async(_key,session,_window,purpose)=>purpose==='evidence'?{header:{id:session},events:Array.from({length:350},(_,n)=>({seq:n,type:n%2?'assistant/message':'user/message',data:{content:[{type:'text',text:'完整内容-'+n}]}}))}:{items:[]};
 return {root,source,app,admin,members,close:async()=>{await app.close();rmSync(root,{recursive:true,force:true});}};}
async function waitFor(fn:()=>any,description='condition',ms=10000){for(let i=0;i<ms/10;i++){const v=fn();if(v)return v;await delay(10);}throw Error('timeout '+description);}
const report=(app:Platform,u:Doc,s='session-first',description='视频点击后不能播放',extra:Doc={})=>app.incidents.report(u,'shared',undefined,{requestId:id(),session:s,description,...extra});

test('8 members × 3 chats preserve full context; same request id is idempotent and conversations never merge',async()=>{
 const f=await fixture();try{
  const inputs=f.members.flatMap(m=>Array.from({length:3},(_,n)=>({m,b:{requestId:id(),session:'session-'+m.id+'-'+n,description:'提交视频后无法播放',client:{phase:'ready'}}})));
  const reports=await Promise.all(inputs.map(async x=>f.app.incidents.report(x.m,'shared',undefined,x.b)));
  assert.equal(new Set(reports.map(r=>r.id)).size,24);
  await waitFor(()=>f.app.store.all('incident').every(i=>i.snapshots.length===1),'24 snapshots');
  for(let n=0;n<inputs.length;n++){const x=inputs[n],r=reports[n];assert.equal(f.app.incidents.report(x.m,'shared',undefined,x.b).id,r.id);const stored=f.app.store.get('incident',r.id)!;const native=JSON.parse(readFileSync(join(f.app.store.root,'incidents',r.id,'evidence',stored.snapshots[0].id,'native-chat.json'),'utf8'));assert.equal(native.events.length,350);assert.equal(native.events.at(-1).data.content[0].text,'完整内容-349');assert.equal(native.header.id,x.b.session);}
  for(const m of f.members)assert.equal(f.app.incidents.list(m,'shared').length,3);
  assert.throws(()=>f.app.incidents.owned(f.members[1],reports[0].id),/无权限/);
  assert.throws(()=>f.app.incidents.report(inputs[0].m,'shared',undefined,{...inputs[0].b,description:'changed'}),/内容已改变/);
  assert.equal(f.app.store.all('task').length,0,'support events are not generation submissions');
 }finally{await f.close();}
});

test('snapshots include original assets, all audits and tool events, redact credentials, show missing evidence',async()=>{
 const f=await fixture();try{const u=f.members[0],s='session-assets',digest=hash('source script\n'),key=hash(JSON.stringify([u.id,'shared'])).slice(0,24),attachment=join(f.app.store.root,'native-harness',key,'state/attachments/v1/files',digest.slice(0,2),digest);mkdirSync(attachment,{recursive:true});writeFileSync(join(attachment,'script.txt'),'source script\n');
  f.app.native.history.read=async()=>({header:{id:s},events:[{type:'tool/result',data:{content:[{type:'file',attachment:{attachmentId:'sha256:'+digest,name:'script.txt'}},{type:'text',text:'Authorization: Bearer sk-TEST-REDACTED password=pass-redacted'}],apiKey:'secret-value-redacted'}}]});
  f.app.store.put('chat-model',{id:'secret-fixture',apiKey:'secret-value-redacted'});
  const plan={id:id(),owner:u.id,nativeSession:s,prompt:'原始最终提示词 secret-value-redacted',model:{model:'wan3'},shots:[]};f.app.store.put('pickup',plan);
  for(let n=0;n<230;n++)f.app.store.audit(u.id,'video.poll',plan.id,{n,project:'shared',session:s});
  const r=report(f.app,u,s);await waitFor(()=>f.app.store.get('incident',r.id)?.snapshots.length);const i=f.app.store.get('incident',r.id)!,folder=join(f.app.store.root,'incidents',r.id,'evidence',i.snapshots[0].id);
  assert.equal(JSON.parse(readFileSync(join(folder,'audit.json'),'utf8')).filter((a:Doc)=>a.action==='video.poll').length,230);const assets=JSON.parse(readFileSync(join(folder,'attachments.json'),'utf8'));assert.equal(assets.length,1);assert.equal(readFileSync(join(folder,assets[0].path),'utf8'),'source script\n');assert.equal(assets[0].originalSha256,digest);
  const content=['native-chat.json','records.json'].map(n=>readFileSync(join(folder,n),'utf8')).join('');assert(!content.includes('secret-value-redacted'));assert(!content.includes('sk-TEST-REDACTED'));assert(!content.includes('pass-redacted'));assert(content.includes('tool/result'));
  f.app.native.history.read=async()=>{throw Error('native history offline');};const r2=report(f.app,u,'session-offline');await waitFor(()=>f.app.store.get('incident',r2.id)?.snapshots.length);assert.equal(f.app.store.get('incident',r2.id)!.snapshots[0].complete,false);assert.match(f.app.store.get('incident',r2.id)!.snapshots[0].gaps[0].reason,/offline/);
 }finally{await f.close();}
});

test('Codex binds a dedicated thread; supplements resume it and never select global last',async()=>{
 const runner=new Runner(),f=await fixture(true,runner);try{const r=report(f.app,f.members[0]);await waitFor(()=>f.app.store.get('incident',r.id)?.state==='needs_info');const first=f.app.store.get('incident',r.id)!;assert(first.thread);f.app.incidents.supplement(f.members[0],r.id,{text:'点击后是黑屏，声音也没有'});await waitFor(()=>runner.inputs.length===2&&f.app.store.get('incident',r.id)?.state==='needs_info');assert.equal(runner.inputs[1].thread,first.thread);assert(runner.inputs[1].prompt.includes('黑屏'));assert.equal(f.app.store.get('incident',r.id)!.snapshots.length,2);
 const args=codexArgs(runner.inputs[1],{command:'/codex',home:'/auth'},'/schema','/result');assert(args.includes('resume'));assert(args.includes(first.thread));assert(!args.includes('--last'));assert(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
 }finally{await f.close();}
});

test('recover original video task once, verify member media, survive delayed completion without resubmission',async()=>{
 const runner=new Runner(),f=await fixture(true,runner);try{const u=f.members[0],s='session-recover',plan={id:id(),owner:u.id,nativeSession:s},job={id:id(),owner:u.id,plan:plan.id,remoteTaskId:'existing-provider-receipt',state:'running',createAttempts:1,seconds:1};f.app.store.put('pickup',plan);f.app.store.put('video-job',job);let pumped=0;f.app.pickups.pump=()=>{pumped++;};
 runner.behavior=async()=>decision('recover','继续原任务下载','video-job',job.id);const r=report(f.app,u,s);await waitFor(()=>f.app.store.get('incident',r.id)?.state==='recovering');assert.equal(pumped,1);assert.equal(f.app.store.get('video-job',job.id)!.createAttempts,1);
 await f.app.incidents.tick();await delay(30);assert.equal(pumped,1);assert.equal(f.app.store.get('incident',r.id)!.state,'recovering','accepted recovery is not completion');
 const video=join(f.root,'original.mp4');execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=12','-t','1','-c:v','libx264','-pix_fmt','yuv420p',video]);const media=await f.app.pickups.media.ingest(Readable.from([readFileSync(video)]),u.id,'private');f.app.store.put('video-job',{...job,state:'ready',mediaId:media.id});await f.app.incidents.tick();await waitFor(()=>f.app.store.get('incident',r.id)?.state==='awaiting_client');assert.equal(f.app.store.get('incident',r.id)!.state,'awaiting_client');const probe=f.app.store.get('incident',r.id)!.mediaProbe;assert.throws(()=>f.app.incidents.clientCheck(f.members[1],r.id,{nonce:probe.nonce,loaded:true}),/无权限/);f.app.incidents.clientCheck(u,r.id,{nonce:probe.nonce,loaded:true});assert.equal(f.app.store.get('incident',r.id)!.state,'verified');assert.equal(f.app.store.get('incident',r.id)!.verification.member,u.id);assert.equal(f.app.store.all('incident-action').length,1);assert.equal(pumped,1);
 }finally{await f.close();}
});

test('unknown receipt, wrong owner and model claims cannot create paid jobs or mark resolved',async()=>{
 const runner=new Runner(),f=await fixture(true,runner);try{const u=f.members[0],s='session-unknown',plan={id:id(),owner:u.id,nativeSession:s},job={id:id(),owner:u.id,plan:plan.id,state:'submission_unknown',createAttempts:1};f.app.store.put('pickup',plan);f.app.store.put('video-job',job);let pumped=0;f.app.pickups.pump=()=>{pumped++;};runner.behavior=async()=>decision('recover','已经全部修好了','video-job',job.id);const r=report(f.app,u,s);await waitFor(()=>f.app.store.get('incident',r.id)?.state==='blocked');assert.equal(pumped,0);assert.equal(f.app.store.all('video-job').length,1);
 runner.behavior=async()=>decision('verify','已经解决','video-job',job.id);const other=report(f.app,f.members[1],'session-other');await waitFor(()=>f.app.store.get('incident',other.id)?.state==='blocked');assert.equal(pumped,0);
 assert.throws(()=>parseDecision({action:'solved',message:'trust me',jobId:'',kind:''}),/结构化/);
 }finally{await f.close();}
});

test('code fix stays isolated; independent verification yields waiting-for-update, never live deployment',async()=>{
 const runner=new Runner();let verifies=0;const f=await fixture(true,runner,async(work:string)=>{verifies++;return {passed:readFileSync(join(work,'source/example.txt'),'utf8')==='fixed\n',checks:[{name:'regression',passed:true}]};});try{runner.behavior=async input=>{writeFileSync(join(input.workspace,'source/example.txt'),'fixed\n');return decision('code_fix');};const r=report(f.app,f.members[0]);await waitFor(()=>f.app.store.get('incident',r.id)?.state==='awaiting_update');assert.equal(verifies,1);assert.equal(readFileSync(join(f.source,'example.txt'),'utf8'),'old\n');assert.equal(f.app.store.get('incident',r.id)!.repair.autoDeploy,false);assert.equal(f.app.store.get('incident',r.id)!.repair.changes.length,1);
 }finally{await f.close();}
});

test('no verifier, failing tests and source drift all block a code fix',async()=>{
 for(const mode of ['none','fail','drift']){const runner=new Runner(),f=await fixture(true,runner,mode==='none'?undefined:async()=>({passed:mode==='drift',checks:[{passed:false}]}));try{runner.behavior=async input=>{writeFileSync(join(input.workspace,'source/example.txt'),'candidate');if(mode==='drift')writeFileSync(join(f.source,'example.txt'),'changed by another developer');return decision('code_fix');};const r=report(f.app,f.members[0]);await waitFor(()=>f.app.store.get('incident',r.id)?.state==='blocked');assert(!f.app.store.get('incident',r.id)!.verification);
 }finally{await f.close();}}
});

test('two distinct failure attempts trigger once; polling duplicates and creative feedback do not',async()=>{
 const f=await fixture();try{f.app.incidents.configure(f.admin,{enabled:false,autoFailures:true,concurrency:1});const u=f.members[0];for(let n=0;n<12;n++)f.app.incidents.failure(u.id,'shared','session-failure','attempt-1','download failed');assert.equal(f.app.store.all('incident').length,0);f.app.incidents.failure(u.id,'shared','session-failure','attempt-2','download failed');assert.equal(f.app.store.all('incident').length,1);f.app.incidents.failure(u.id,'shared','session-failure','attempt-3','download failed');assert.equal(f.app.store.all('incident').length,1);
 }finally{await f.close();}
});

test('HTTP member/admin scope, CSRF, native settings and read-only report access',async()=>{
 const f=await fixture();const port=await f.app.start(0),base='http://127.0.0.1:'+port;
 async function login(name:string){const r=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:name,password})});const data=await r.json() as any;return {Origin:base,'Content-Type':'application/json',Cookie:r.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':data.csrf};}
 try{const member=await login('member0'),other=await login('member1'),admin=await login('admin'),body=JSON.stringify({requestId:id(),session:'session-http',description:'页面打不开'});
 const posted=await fetch(base+'/api/incidents',{method:'POST',headers:member,body});assert.equal(posted.status,202);const report=await posted.json() as Doc;
 assert.equal((await fetch(base+'/api/incidents/'+report.id,{headers:other})).status,404);assert.equal((await fetch(base+'/api/admin/incidents',{headers:member})).status,403);
 assert.equal((await fetch(base+'/api/incidents?member='+f.members[1].id,{method:'POST',headers:member,body})).status,403);
 assert.equal((await fetch(base+'/api/incidents',{method:'POST',headers:{...member,'X-CSRF-Token':'wrong'},body})).status,403);
 assert.equal((await fetch(base+'/api/incidents?member='+f.members[1].id,{method:'POST',headers:admin,body})).status,202);
 const list=await(await fetch(base+'/api/incidents?session=session-http',{headers:member})).json() as Doc[];assert.equal(list.length,1);assert(!('thread' in list[0]));assert(!('snapshots' in list[0]));
 f.app.store.put('user',{...f.members[0],active:false});assert.equal((await fetch(base+'/api/incidents/'+report.id,{headers:member})).status,401);
 }finally{await f.close();}
});

test('Codex CLI adapter handles JSONL, stdin, exact resume and nonzero/invalid/timeout outcomes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'incident-cli-'));try{const command=join(root,'fake-codex');writeFileSync(command,`#!/usr/bin/env node\nlet prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{const a=process.argv.slice(2),out=a[a.indexOf('--output-last-message')+1];require('node:fs').writeFileSync('${join(root,'args.json')}',JSON.stringify({a,prompt}));console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-1111-1111-111111111111'}));if(prompt==='fail\\n')process.exit(7);if(prompt==='hang\\n')return setInterval(()=>{},1000);require('node:fs').writeFileSync(out,JSON.stringify({action:'needs_info',message:'需要截图',kind:'',jobId:''}));console.log(JSON.stringify({type:'error',message:'Reconnecting... 1/5'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1}}));});\n`,{mode:0o700});const runner=new CodexExec({command,home:root,timeoutMs:4000}),events:Doc[]=[],input={workspace:root,evidence:'evidence',prompt:'内容包含 `not a shell` $(no-command)',signal:new AbortController().signal,onEvent:(e:Doc)=>events.push(e)};
 const result=await runner.run(input);assert.equal(result.action,'needs_info');const saved=JSON.parse(readFileSync(join(root,'args.json'),'utf8'));assert.equal(saved.prompt,input.prompt+'\n');assert(saved.a.includes('--ignore-user-config'));assert.equal(events[0].type,'thread.started');
 await assert.rejects(()=>runner.run({...input,prompt:'fail'}),/退出 7/);await assert.rejects(()=>new CodexExec({command,home:root,timeoutMs:30}).run({...input,prompt:'hang'}),/超时/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('redaction keeps usage counts and supplier IDs but removes secrets in strings',()=>{const r=redactor(['literal-credential-redacted']);const data=r.clean({usage:{input_tokens:320},remoteTaskId:'job-123',Authorization:'Bearer abc',text:'token=abc123 https://user:pass@example.org/?signature=abc sk-TEST-REDACTED literal-credential-redacted'});assert.equal(data.usage.input_tokens,320);assert.equal(data.remoteTaskId,'job-123');assert(!JSON.stringify(data).includes('abc123'));assert(!JSON.stringify(data).includes('user:pass'));assert(!JSON.stringify(data).includes('literal-credential-redacted'));});

test('24 reports run with a bounded repair queue and 24 distinct Codex threads',async()=>{
 const runner=new Runner(),f=await fixture(true,runner);let concurrent=0,peak=0;try{runner.behavior=async()=>{peak=Math.max(peak,++concurrent);await delay(15);concurrent--;return decision('needs_info');};const reports=f.members.flatMap(u=>Array.from({length:3},(_,n)=>report(f.app,u,'session-queue-'+u.id+'-'+n)));
 for(let n=0;n<1000&&!f.app.store.all('incident').every(i=>i.state==='needs_info');n++){await f.app.incidents.tick();await delay(10);}
 assert(f.app.store.all('incident').every(i=>i.state==='needs_info'));assert.equal(new Set(f.app.store.all('incident').map(i=>i.thread)).size,24);assert(peak>1&&peak<=3);assert.equal(runner.inputs.length,24);assert.equal(reports.length,24);
 }finally{await f.close();}
});

test('native agent reporting tool uses the invoking member and keeps reports out of video statistics',async()=>{
 const f=await fixture();try{const u=f.members[0],instance:any={key:hash(JSON.stringify([u.id,'shared'])).slice(0,24),owner:u.id,project:'shared'},body={action:'issue_report',sessionId:'session-agent',callId:'tool-call-1',sourceMessageId:'msg-1',args:{description:'明确报告软件故障：视频打不开'}};
 const r=await f.app.native.team.tool(instance,u,body),again=await f.app.native.team.tool(instance,u,body);assert.equal(r.kind,'incident');assert.equal(r.report.id,again.report.id);assert.equal(r.report.owner,u.id);assert.equal(f.app.store.all('video-job').length,0);assert.equal(f.app.store.all('task').length,0);
 }finally{await f.close();}
});

test('native failure telemetry is scoped by host instance and ignores old history/replayed events',async()=>{
 const f=await fixture();try{f.app.incidents.configure(f.admin,{enabled:false,autoFailures:true,concurrency:1});const u=f.members[0],root=join(f.root,'native-fixture');mkdirSync(join(root,'state'),{recursive:true});f.app.native.instances.set('test-key',{key:'test-key',root,owner:u.id,project:'shared',closed:true} as any);
 const items=[{session:'session-fault',attemptId:'old',time:1,error:'old'},{session:'session-fault',attemptId:'a',time:Date.now()+1,error:'error a'},{session:'session-fault',attemptId:'a',time:Date.now()+2,error:'duplicate a'},{session:'session-fault',attemptId:'b',time:Date.now()+3,error:'error b'}];writeFileSync(join(root,'state/team-failures.json'),JSON.stringify({items}));await f.app.incidents.tick();await f.app.incidents.tick();assert.equal(f.app.store.all('incident').length,1);assert.equal(f.app.store.all('incident')[0].owner,u.id);
 }finally{f.app.native.instances.clear();await f.close();}
});

test('tampering with workspace baseline does not bypass source drift or missing changes',async()=>{
 const runner=new Runner(),f=await fixture(true,runner,async()=>({passed:true,checks:[{passed:true}]}));try{runner.behavior=async input=>{writeFileSync(join(input.workspace,'baseline.json'),'{}');writeFileSync(join(f.source,'example.txt'),'unrelated newer version');writeFileSync(join(input.workspace,'source/example.txt'),'candidate');return decision('code_fix');};const r=report(f.app,f.members[0]);await waitFor(()=>f.app.store.get('incident',r.id)?.state==='blocked');assert.match(f.app.incidents.public(f.app.store.get('incident',r.id)!).updates.at(-1)!.message,/基线/);
 }finally{await f.close();}
});

test('missing or corrupt original media cannot be reported as restored',async()=>{
 const runner=new Runner(),f=await fixture(true,runner);try{const u=f.members[0],plan={id:id(),owner:u.id,nativeSession:'session-corrupt'},mid=id(),job={id:id(),owner:u.id,plan:plan.id,state:'ready',mediaId:mid,seconds:1};f.app.store.put('pickup',plan);f.app.store.put('video-job',job);f.app.store.put('media',{id:mid,owner:u.id,scope:'private',mime:'video/mp4',bytes:10,sha256:'wrong'});writeFileSync(f.app.pickups.media.path(mid),'not a video');runner.behavior=async()=>decision('verify','已恢复','video-job',job.id);const r=report(f.app,u,'session-corrupt');await waitFor(()=>f.app.store.get('incident',r.id)?.state==='blocked');assert(!f.app.store.get('incident',r.id)!.verification);
 }finally{await f.close();}
});

test('cancelled Codex work cannot overwrite the cancellation and disabled accounts are never processed',async()=>{
 const runner=new Runner(),f=await fixture(true,runner);try{runner.behavior=async input=>{await new Promise<void>(r=>input.signal.addEventListener('abort',()=>r(),{once:true}));return decision('needs_info');};const r=report(f.app,f.members[0]);await waitFor(()=>runner.inputs.length===1);f.app.incidents.cancel(f.members[0],r.id);await waitFor(()=>f.app.incidents.running.size===0);assert.equal(f.app.store.get('incident',r.id)!.state,'cancelled');const u=f.members[1];f.app.store.put('user',{...u,active:false});assert.throws(()=>report(f.app,u),/停用/);
 }finally{await f.close();}
});

test('native failures count failed terminal turns, excluding inherited forks, cancellation and tool messages',async()=>{
 // The pinned native plugin is loaded without starting its runtime.
 const {failureEvents}=await import('../native-harness/team-project/index.mjs');
 const events=[{seq:1,time:100,type:'turn/end',data:{reason:{kind:'error'}}},{seq:2,time:200,type:'tool/result',data:{error:'创作反馈：失败'}},{seq:3,time:300,type:'turn/end',data:{reason:{kind:'cancelled'}}},{seq:4,time:400,type:'turn/end',data:{reason:{kind:'error',message:'真实失败'}}}];
 assert.deepEqual(failureEvents('session-child',events,1),[{session:'session-child',attemptId:'session-child:turn:4',time:400,error:'{"kind":"error","message":"真实失败"}'}]);
});

test('repair worker restart keeps an in-progress recovery and never replays an accepted action',async()=>{
 const {Incidents}=await import('../server/incidents.ts'),runner=new Runner(),f=await fixture(true,runner);try{const u=f.members[0],plan={id:id(),owner:u.id,nativeSession:'session-restart'},job={id:id(),owner:u.id,planId:plan.id,state:'running',remoteTaskId:'original-only',createAttempts:1};f.app.store.put('pickup',plan);f.app.store.put('video-job',job);let pumps=0;f.app.pickups.pump=()=>{pumps++;};runner.behavior=async()=>decision('recover','恢复原任务','video-job',job.id);const r=report(f.app,u,'session-restart');await waitFor(()=>f.app.store.get('incident',r.id)?.state==='recovering');await f.app.incidents.close();f.app.incidents=new Incidents(f.app,{sourceRoot:f.source,runner,enabled:true});await f.app.incidents.tick();await waitFor(()=>f.app.incidents.running.size===0);assert.equal(pumps,1);assert.equal(runner.inputs.length,1);assert.equal(f.app.store.get('incident',r.id)!.state,'recovering');assert.equal(f.app.store.all('incident-action').length,1);
 }finally{await f.close();}
});

test('a later diagnostic round may retry a failed original download without creating another paid generation',async()=>{
 const runner=new Runner(),f=await fixture(true,runner);try{const u=f.members[0],plan={id:id(),owner:u.id,nativeSession:'session-download-again'},job={id:id(),owner:u.id,planId:plan.id,state:'download_failed',receipt:{url:'https://example.invalid/original'},createAttempts:1};f.app.store.put('image-plan',plan);f.app.store.put('image-job',job);let downloads=0;f.app.images.recover=()=>{downloads++;return {resumed:true};};runner.behavior=async()=>decision('recover','恢复原图下载','image-job',job.id);const r=report(f.app,u,'session-download-again');await waitFor(()=>downloads===1&&f.app.incidents.running.size===0);f.app.incidents.supplement(u,r.id,{text:'网络现在恢复了，请继续下载原图'});for(let n=0;n<200&&downloads<2;n++){await f.app.incidents.tick();await delay(10);}assert.equal(downloads,2);assert.equal(f.app.store.all('image-job').length,1);assert.equal(f.app.store.get('image-job',job.id)!.createAttempts,1);
 }finally{await f.close();}
});

test('native runtime credentials in shell diagnostics are redacted without losing failure details',()=>{
 const token='ab'.repeat(32),r=redactor();
 const view=r.clean({TEAM_NATIVE_KEY:token,message:'docker run --env TEAM_NATIVE_KEY='+token+' image',code:143,phase:'runtime'});
 assert.equal(view.code,143);assert.equal(view.phase,'runtime');assert(view.message.includes('docker run'));assert(!JSON.stringify(view).includes(token));
});
