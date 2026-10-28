/** Isolated, explicitly simulated LAN acceptance server. Never imports production data or credentials. */
import { Platform } from '../server/app.ts';
import { id, hash, type Doc } from '../server/store.ts';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { advertise } from '../server/discovery.ts';
const root=resolve(process.env.PICKUP_UAT_ROOT ?? '../uat');
const bind=process.env.PICKUP_UAT_BIND ?? '127.0.0.1',port=Number(process.env.PORT??4324);
if(port===4317)throw Error('验收服务禁止使用正式端口');
mkdirSync(root,{recursive:true,mode:0o700});const video=join(root,'synthetic-original.mp4');
if(!existsSync(video))execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=320x180:r=12','-t','4','-c:v','libx264','-pix_fmt','yuv420p',video]);
process.env.PLATFORM_ALLOWED_HOSTS=bind;
const app=new Platform({dataDir:join(root,'data'),staticDir:resolve('dist'),mockDelay:1,allowLanHttp:true,simulatedVideo:true,videoAdapter:{
 async create(){await new Promise(r=>setTimeout(r,1200));return {id:'simulated-'+id(),status:'queued'};},
 async query(_c,_k,taskId){const count=app.store.all('video-job').find(j=>j.remoteTaskId===taskId)?.pollAttempts??3;return {id:taskId,status:count===1?'queued':count===2?'in_progress':'completed',progress:count===1?0:count===2?55:100};},
 async content(_c,_k,_id,signal){const bytes=readFileSync(video);const stream=Readable.from((async function*(){for(let i=0;i<bytes.length;i+=256){signal.throwIfAborted();yield bytes.subarray(i,i+256);await delay(100,undefined,{signal});}})());return new Response(Readable.toWeb(stream) as ReadableStream,{headers:{'Content-Type':'video/mp4','Content-Length':String(bytes.length)}});}
}});
if(!app.store.all('user').length){
 const adminPassword=randomBytes(18).toString('base64url');const admin=app.newUser({username:'uatadmin',name:'验收超管',password:adminPassword},'admin');
 const accounts:Doc[]=[{username:'uatadmin',password:adminPassword,role:'admin'}];
 for(let i=1;i<=8;i++){const password=randomBytes(15).toString('base64url');app.newUser({username:'uat'+i,name:'验收成员'+i,password},'member');accounts.push({username:'uat'+i,password,role:'member'});}
 writeFileSync(join(root,'uat-access.private.json'),JSON.stringify({purpose:'isolated synthetic LAN UAT only',accounts},null,2),{mode:0o600,flag:'wx'});
 const channel=app.pickups.catalog.saveChannel(admin,{name:'模拟瑞云（不联网）',origin:'https://synthetic.invalid',adapter:'ruiyun',apiKey:'synthetic-only',enabled:true,concurrency:2,noRetryEvidence:'隔离模拟执行器，仅本机合成验证，不是在线单次创建证据'});
 const c:Doc={...app.store.get('video-channel',channel.id)!,verified:true,reachableModels:['synthetic-video']};app.store.put('video-channel',c);app.store.put('video-channel-version',{...c,id:c.revision,channelId:c.id});
 const m=app.pickups.catalog.saveModel(admin,{name:'验收视频',aliases:['测试视频'],channelId:c.id,remoteModel:'synthetic-video',status:'testing',default:true,params:{resolution:['180p'],aspect_ratio:['16:9'],audio:[false]},defaults:{resolution:'180p',aspect_ratio:'16:9',audio:false},secondsType:'number',durations:[4],referenceField:'none',maxReferences:0,capabilityEvidence:'仅模拟协议，不证明线上能力',pricePerSecond:null,currency:'CNY'});
 app.store.put('video-model',{...m,status:'published'}); // Fixture-only: the public publishing API rejects simulated evidence.
 app.pickups.catalog.saveTemplate(admin,{name:'合成镜头补抽',body:'{{dayPeriod}}，{{duration}}秒。\n分镜：{{storyboard}}\n原剧本：{{script}}\n素材：{{assets}}\n补抽意见：{{notes}}\n保持人物、服装和场景连续性。台词及反应镜头使用单人近景。',status:'published',modelIds:[],default:true});
 const lines=Array.from({length:8},(_,i)=>`验收片段${i+1}：蓝色房门上方的灯亮起。`);const script=lines.join('\n');
 let change=app.projects.candidate(admin,app.projects.current().revision,{'验收/剧本.md':script,'验收/分镜.md':script},{});app.projects.approve(change,admin,change.digest);
 app.pickups.publishIndex(admin,{base:app.projects.current().revision,shots:lines.map((line,i)=>({id:'UAT-S'+(i+1),episode:'合成验收',scriptPath:'验收/剧本.md',scriptQuote:line,storyboardPath:'验收/分镜.md',storyboardQuote:line,duration:4,dayPeriod:'day',kind:'establishing',framing:'wide',visualDescription:'蓝色房门上方的灯亮起。',characters:[],assets:[],dialogue:[]}))});
}
await app.start(port,bind);const stopDiscovery=bind!=='127.0.0.1'?advertise(app.serverId,port,bind,false):undefined;
writeFileSync(join(root,'runtime.json'),JSON.stringify({pid:process.pid,url:`http://${bind}:${port}`,serverId:app.serverId,version:'0.7.2',simulated:true,created:new Date().toISOString()}),{mode:0o600});
writeFileSync(join(root,'data/runtime-state.json'),JSON.stringify({pid:process.pid,entry:fileURLToPath(import.meta.url),url:`http://${bind}:${port}`,serverId:app.serverId,serverInstance:app.instanceId,simulated:true,created:new Date().toISOString()}),{mode:0o600});
console.log(JSON.stringify({state:'listening',url:`http://${bind}:${port}`,version:'0.7.2',simulated:true,accountsFile:join(root,'uat-access.private.json')}));
let stopping=false;for(const sig of ['SIGINT','SIGTERM'] as const)process.on(sig,async()=>{if(stopping)return;stopping=true;stopDiscovery?.();await app.close();process.exit(0);});
