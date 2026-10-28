/** Offline 500-member scheduler acceptance. No paid provider requests. CONCURRENCY_REPORT optionally selects the JSON report path. */
import {Platform} from '../server/app.ts';
import {id,hash,now,passwordHash} from '../server/store.ts';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'concurrency-500-')),fixture=join(root,'fixture.mp4');execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=12','-t','4','-c:v','libx264','-pix_fmt','yuv420p',fixture]);const video=readFileSync(fixture);
let finish!:()=>void;const gate=new Promise<void>(r=>finish=r);let creates=0,peak=0,active=0;
const app=new Platform({dataDir:join(root,'data'),concurrency:500,videoConcurrency:500,simulatedVideo:true,videoAdapter:{async create(_c,_k,_p,s){creates++;active++;peak=Math.max(peak,active);await Promise.race([gate,new Promise((_,r)=>s.addEventListener('abort',()=>r(Error('aborted')),{once:true}))]);active--;return {id:'fixture-'+id(),status:'queued'};},async query(_c,_k,t){return {id:t,status:'completed'};},async content(){return new Response(video);}}});
app.pickups.media.technicalQA=async()=>({passed:true,duration:4,width:160,height:90,hasAudio:false,frames:[],fixtureOnly:true});
const report:any={mode:'synthetic-control-plane',count:500,realProviderCalls:0,realFFmpegPerTask:false,fixtureSHA256:hash(video),samples:[]};
try{
 const admin=app.newUser({username:'stressadmin',password:'Synthetic-Test-Password'},'admin');
 const c=app.pickups.catalog.saveChannel(admin,{name:'合成500并发',origin:'https://synthetic.invalid',adapter:'ruiyun',apiKey:'synthetic-only',enabled:true,concurrency:500,noRetryEvidence:'offline controlled adapter'});const full={...app.store.get('video-channel',c.id)!,verified:true,reachableModels:['fixture']};app.store.put('video-channel',full);app.store.put('video-channel-version',{...full,id:c.revision});
 const m=app.pickups.catalog.saveModel(admin,{name:'合成模型',aliases:[],channelId:c.id,remoteModel:'fixture',status:'testing',memberAccess:true,default:true,params:{resolution:['90p']},defaults:{resolution:'90p'},secondsType:'number',durations:[4],referenceField:'none',maxReferences:0,pricePerSecond:null,currency:'CNY',capabilityEvidence:'offline fixture'});
 app.pickups.catalog.saveTemplate(admin,{name:'模板',body:'{{dayPeriod}} {{duration}} {{storyboard}} {{notes}} {{assets}}',status:'published',modelIds:[m.id],default:true});
 const text=Array.from({length:500},(_,i)=>`成员${String(i).padStart(3,'0')}将蓝色信封放在木桌中央。`).join('\n');const change=app.projects.candidate(admin,app.projects.current().revision,{'剧本.md':text},{});app.projects.approve(change,admin,change.digest);
 const shots=text.split('\n').map((s,i)=>({id:'S'+i,episode:'500模拟',scriptPath:'剧本.md',scriptQuote:s,storyboardPath:'剧本.md',storyboardQuote:s,duration:4,dayPeriod:'day',kind:'action',framing:'medium',visualDescription:s,characters:[],assets:[],dialogue:[]}));app.pickups.publishIndex(admin,{base:app.projects.current().revision,shots});
 const base=`http://127.0.0.1:${await app.start(0)}`;const passwd=passwordHash('Synthetic-Test-Password');
 const clients=Array.from({length:500},(_,i)=>{const user={id:id(),username:'m'+i,name:'成员'+i,role:'member',active:true,password:passwd,created:now()};app.store.put('user',user);const token=id(),csrf=id();app.store.db.prepare('INSERT INTO auth VALUES(?,?,?,?)').run(hash(token),user.id,csrf,Date.now()+3600000);const session={id:id(),owner:user.id,title:'压力会话',created:now()};app.store.put('session',session);return {user,session,headers:{Origin:base,Cookie:`${app.cookieName}=${token}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'}};});
 async function call(i:number,path:string,body?:any){const start=performance.now(),r=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:clients[i].headers,...(body?{body:JSON.stringify(body)}:{})});const j=await r.json();assert(r.ok,JSON.stringify(j));report.samples.push({path:path.split('/')[1],ms:performance.now()-start});return j;}
 let t=performance.now();const tasks=await Promise.all(clients.map((c,i)=>call(i,'/tasks',{session:c.session.id,requestId:id(),prompt:`剧本片段：${shots[i].scriptQuote}\n补抽意见：保持道具不变，动作放慢。\n视频模型：合成模型\n镜头：S${i}`,workflow:'pickup',paths:[]})));report.textAdmissionMs=performance.now()-t;
 const plans=tasks.map(t=>app.store.get('pickup',t.id)!);assert(plans.every(p=>p?.state==='awaiting_confirmation'));
 t=performance.now();await Promise.all(plans.map((p,i)=>call(i,`/pickups/${p.id}/confirm`,{digest:p.digest})));report.videoAdmissionMs=performance.now()-t;assert.equal(creates,500);assert.equal(peak,500);finish();
 t=performance.now();for(let n=0;n<180;n++){const jobs=app.store.all('video-job');if(jobs.every(j=>j.state==='ready'))break;if(jobs.some(j=>['blocked','submission_unknown','qa_failed'].includes(j.state)))throw Error('failed job');await delay(1000);}report.recoveryMs=performance.now()-t;
 const jobs=app.store.all('video-job');assert.equal(jobs.filter(j=>j.state==='ready').length,500);assert.equal(new Set(jobs.map(j=>j.remoteTaskId)).size,500);
 for(const i of [0,249,499]){const j=jobs.find(j=>j.owner===clients[i].user.id)!;const own=await fetch(base+'/api/media/'+j.mediaId,{headers:clients[i].headers});assert.equal(own.status,200);assert.equal(hash(Buffer.from(await own.arrayBuffer())),hash(video));const other=await fetch(base+'/api/media/'+j.mediaId,{headers:clients[(i+1)%500].headers});assert.equal(other.status,404);}
 report.completed=500;report.peakActiveCreates=peak;report.uniqueRemoteTasks=500;report.isolationSamples=3;report.processMemory=process.memoryUsage();report.passed=true;
}catch(e){report.passed=false;report.error=e instanceof Error?e.message:String(e);process.exitCode=1;}finally{finish?.();await app.close();writeFileSync(process.env.CONCURRENCY_REPORT??join(process.cwd(),'concurrency-stress-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,samples:undefined}));}
