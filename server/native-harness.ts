import {chatAccountingUsage} from './model-usage.ts';
import {nativeContextPresetPatch} from './native-context-presets.ts';
import type {NativeAttachments} from './native-attachments.ts';
import type {ProjectLinks} from './project-links.ts';
import type {EpisodeAssembly} from './episode-assembly.ts';
import type {ProjectContent} from './project-content.ts';
import {cloneFileSync} from './clone-file.ts';
import {storeRedactor} from './incident-context.ts';
import {assertStoragePath} from './external-storage.ts';
import {NativeHistory} from './native-history.ts';
import {NativeProbeCache,probeNativeHealth,waitNativeStartupToken,type NativeHealth} from './native-health.ts';
import {hostFiles,conversationFilePath} from './host-files.ts';
import {connectionEvidenceId,connectionModalities,nativeModelProfile,nativeCatalogProfile,nativeContextPolicies} from './model-capabilities.ts';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync,chmodSync,readdirSync,lstatSync,unlinkSync,cpSync,rmSync,renameSync,constants} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket,WebSocketServer} from 'ws';
import {Store,requireThat,id,hash,now,type Doc} from './store.ts';
import {Projects,validPath} from './project.ts';
import {objectPath,storeFile,fileHash} from './file-objects.ts';
import {modelPricing} from './model.ts';
import {fetchModel} from './model-transport.ts';
import {ModelRouting,routingPolicy,publicModelRoute,nativeContextPressure} from './model-routing.ts';
import {privateSkillRedactor} from './private-skill-content.ts';
import {preparePrivateSkillHistory,verifyPrivateSkillHistory} from './private-skill-history.ts';
import {removeNativeContainer} from './native-container.ts';
import {adaptChatRequest,estimateUsd} from './chat-wire.ts';
import {FairQueue} from './fair-queue.ts';
import {NativeTeam} from './native-team.ts';
import {NativeStaticCache,nativeStaticPath} from './native-static.ts';
import {nativePageBridge,scopeNativeAsset,credentialedManifestLinks} from './native-page.ts';
import {adaptStudioSource,prepareStudioPlugin,studioStyle} from './native-studio.ts';
import type {Pickups} from './pickups.ts';
import type {ImageGeneration} from './image-generation.ts';
import type {ChatCatalog} from './chat-catalog.ts';
const exec=promisify(execFile);
const DOCKER=['/opt/homebrew/bin/docker','/usr/local/bin/docker','/Applications/Docker.app/Contents/Resources/bin/docker'].find(existsSync)??'docker';
/** Only the native prompt endpoint has a durable requestId deduplication contract.
 * Recover a lost local-hop receipt without replaying arbitrary writes or paid API calls. */
export async function forwardNativeRequest(url:string,options:RequestInit,onRetry:()=>void=()=>{}) {
 let prompt:any;try{const b=JSON.parse(String(options.body??''));prompt=b.method==='session/prompt'?b.payload?.args?.request:undefined;}catch{}
 const u=new URL(url),retryable=u.hostname==='127.0.0.1'&&u.pathname==='/api/session/prompt'&&options.method==='POST'&&typeof prompt?.sessionId==='string'&&typeof prompt?.requestId==='string'&&prompt.requestId.length>0&&prompt.requestId.length<=200;
 try{return await fetch(url,options);}catch(error:any){
  const code=error?.cause?.code??error?.code;
  if(!retryable||options.signal?.aborted||!['UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','ECONNRESET','EPIPE','ETIMEDOUT'].includes(code))throw error;
  onRetry();await delay(150,undefined,{signal:options.signal??undefined});return fetch(url,options);
 }
}
import {NATIVE_IMAGE} from './native-version.ts';
export {NATIVE_IMAGE} from './native-version.ts';
export const NATIVE_FEATURES=[{id:'shell',name:'终端与后台命令'},{id:'files',name:'文件读取、搜索、编辑与交付'},{id:'web',name:'网页搜索与读取'},{id:'skills',name:'技能加载'},{id:'subagents',name:'子智能体与分支'},{id:'workflows',name:'工作流与多轮协作'},{id:'goals',name:'目标任务'},{id:'plugins',name:'动态插件与代码运行'},{id:'questions',name:'交互提问'},{id:'plan',name:'计划与待办'},{id:'compact',name:'上下文压缩'},{id:'schedule',name:'定时提醒'},{id:'attachments',name:'附件与图片'},{id:'search',name:'会话全文搜索'},{id:'export',name:'会话导出'},{id:'models',name:'模型与推理档位切换'},{id:'permissions',name:'原生权限模式'},{id:'feedback',name:'反馈与评价'},{id:'settings',name:'个人设置'}];
export type Instance={privateSkillCalls?:boolean;key:string;owner:string;project:string;root:string;work:string;name:string;port:number;cookie:string;token:string;starting?:Promise<void>;active:number;closed:boolean;lastActivity?:number;clients?:number;stopping?:Promise<void>;sleepReason?:string;modelDigest?:string;tail?:Promise<unknown>;startup?:{startedAt:number;phase:string;phaseAt:number;steps:Record<string,number>;readyAt?:number}};
type Spec={user:Doc;viewer?:Doc;scope?:string;project:string;csrf:string;authorized?:()=>boolean};
async function bytes(req:IncomingMessage,max=300*1024*1024){const chunks:Buffer[]=[];let size=0;for await(const b of req){size+=b.length;requireThat(size<=max,'原生请求过大',413);chunks.push(b);}return Buffer.concat(chunks);}
export class NativeHarness {
 projectSurface=false;
 team=new NativeTeam(this);
 history:NativeHistory;
 private staticCache=new NativeStaticCache();
 private routing?:ModelRouting;
 private opens=new Map<string,Promise<Instance>>();
 private runtimeChecks=new NativeProbeCache<NativeHealth>(value=>value.healthy?5000:1000);
 private imageChecks=new NativeProbeCache<boolean>(value=>value?30000:1000);
 phase(i:Instance,phase:string){const t=Date.now();if(!i.startup)i.startup={startedAt:t,phase,phaseAt:t,steps:{}};else{i.startup.steps[i.startup.phase]=(i.startup.steps[i.startup.phase]??0)+t-i.startup.phaseAt;i.startup.phase=phase;i.startup.phaseAt=t;}if(phase==='ready')i.startup.readyAt=t;}
 async runtimeHealth(i:Instance){
  const generation=String(i.startup?.startedAt??i.token);
  return this.runtimeChecks.get(i.key,()=>probeNativeHealth({
   request:()=>fetch(`http://127.0.0.1:${i.port}/`,{method:'HEAD',headers:{Cookie:i.cookie},redirect:'manual',signal:AbortSignal.timeout(2000)}),
   inspect:async()=>{const state=await exec(DOCKER,['inspect','--format','{{.State.Running}}',i.name],{timeout:3000});const value=state.stdout.trim();if(!['true','false'].includes(value))throw Error('运行状态待确认');return value==='true';}
  }),generation);
 }
 async open(user:Doc,project:string){const i=this.instances.get(this.key(user,project));if(i&&!i.closed&&!i.starting){const health=await this.runtimeHealth(i);if(!health.running&&!i.active)i.closed=true;}const opened=await this.get(user,project);this.touch(opened);return opened;}
 async connection(user:Doc,project:string){
  const i=this.instances.get(this.key(user,project));if(!i||i.closed)return {state:i?.startup?.phase==='failed'?'failed':'idle'};
  const health=i.starting?undefined:await this.runtimeHealth(i);return {state:i.starting?'starting':health?.healthy?'ready':health?.running?'degraded':'unavailable',...(health?{health:{checkedAt:health.checkedAt,reason:health.reason,runtimeConfirmed:health.runtimeConfirmed}}:{}),generation:String(i.startup?.startedAt??''),phase:i.startup?.phase??'ready',elapsedMs:i.startup?(i.startup.readyAt??Date.now())-i.startup.startedAt:0,steps:i.startup?.steps??{}};
 }
 private closing=false;instances=new Map<string,Instance>(); private modelServer=createServer((req,res)=>void this.model(req,res).catch(e=>{if(res.headersSent){res.destroy();return;}res.writeHead(e.status??502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:e.message,type:'team_policy'}}));}));
 private modelPort=0;private startingModel?:Promise<void>;private socketServer=new WebSocketServer({noServer:true,maxPayload:32*1024*1024});private sockets=new Set<WebSocket>();
 constructor(public store:Store,public catalog:ChatCatalog,public workspace:(project:string)=>{projects:Projects;store:Store;pickups:Pickups;images:ImageGeneration;content?:ProjectContent;assembly?:EpisodeAssembly;attachments?:NativeAttachments;links?:ProjectLinks},public codeRoot=fileURLToPath(new URL('..',import.meta.url)),public queue=new FairQueue(4)){this.history=new NativeHistory(store,codeRoot);this.idleTimer=setInterval(()=>void this.reapIdle(),30000);this.idleTimer.unref();}
 private idleTimer:ReturnType<typeof setInterval>;private reaping=false;
 settings(){return this.store.get('native-runtime-policy','active')??{id:'active',idleMinutes:30};}
 private modelFingerprint(user:Doc,project:string){const skills=(this.catalog as any).skills?.public?.(user,project)??[];return hash(JSON.stringify({models:this.catalog.available(user,project).map(m=>({...m,profile:nativeCatalogProfile(this.store,this.catalog,project,m)})),skills:skills.map((s:Doc)=>({id:s.id,version:s.version}))}));}
 touch(i:Instance){i.lastActivity=Date.now();}
 activity(i:Instance){try{const v=JSON.parse(readFileSync(join(i.root,'state/team-activity.json'),'utf8'));return v.version===1&&v.at>=(i.startup?.startedAt??0)&&Date.now()-v.at<15000?v:undefined;}catch{return undefined;}}
 sleepBlock(i:Instance){if(i.closed||i.starting||i.stopping||i.active)return '执行或启动中';if(i.clients)return '聊天页面仍连接';const a=this.activity(i);if(!a||a.error)return '等待运行状态确认';if(a.agents||a.queued||a.jobs||a.schedules)return '聊天、后台命令或定时任务未完成';if(Date.now()-a.idleSince<60000)return '等待连续空闲';if(['video-job','image-job'].some(kind=>this.store.all(kind,i.owner).some(j=>(j.project??'shared')===i.project&&['queued','preparing','submitting','submission_unknown','running','downloading','checking'].includes(j.state))))return '生成任务未完成';return ''; }
 async quietProcesses(i:Instance){try{const {stdout}=await exec(DOCKER,['top',i.name,'-eo','pid,comm'],{timeout:5000});const processes=stdout.trim().split('\n').slice(1).map(s=>s.trim().split(/\s+/).slice(1).join(' '));return processes.length<=2&&processes.every(p=>['docker-init','node','MainThread'].includes(p));}catch{return false;}}
 async reapIdle(){if(this.closing||this.reaping)return;this.reaping=true;try{const minutes=this.settings().idleMinutes;if(!minutes)return;for(const i of this.instances.values()){if(this.closing)break;if(Date.now()-(i.lastActivity??Date.now())<minutes*60000)continue;i.sleepReason=this.sleepBlock(i);if(i.sleepReason)continue;if(!await this.quietProcesses(i)){i.sleepReason='后台进程尚未结束或状态未确认';continue;}if(this.sleepBlock(i)||Date.now()-(i.lastActivity??Date.now())<minutes*60000)continue;const user=this.store.get('user',i.owner);if(user)try{await this.stop(user,i.project,i.key);this.store.audit('server','native.idle_sleep',i.key,{project:i.project,minutes});}catch{i.sleepReason='休眠未完成，将稍后重试';}}}finally{this.reaping=false;}}
 policy(project:string){const p=this.store.get('native-policy',project);return {id:project,enabled:true,permissions:['workspace-write','danger-full-access'],features:Object.fromEntries(NATIVE_FEATURES.map(f=>[f.id,true]))};}
 async savePolicy(user:Doc,project:string,b:Doc){requireThat(user.role==='admin','仅超级管理员可设置',403);requireThat(typeof b.enabled==='boolean'&&b.features&&NATIVE_FEATURES.every(f=>typeof b.features[f.id]==='boolean'),'功能开关不完整');requireThat(!b.permissions||Array.isArray(b.permissions)&&b.permissions.every((v:unknown)=>['workspace-write','danger-full-access'].includes(String(v))),'权限范围无效');const p={id:project,enabled:true,permissions:['workspace-write','danger-full-access'],features:Object.fromEntries(NATIVE_FEATURES.map(f=>[f.id,true])),updated:now()};this.store.put('native-policy',p);this.store.audit(user.id,'native.policy.update',project,p);for(const i of this.instances.values())if(i.project===project)this.writePolicy(i);if(!p.enabled)await Promise.allSettled([...this.instances.values()].filter(i=>i.project===project&&!i.closed).map(async i=>{i.closed=true;await exec(DOCKER,['stop','--time','5',i.name],{timeout:10000});}));return p;}
 key(user:Doc,project:string){return hash(JSON.stringify([user.id,project])).slice(0,24);}
 writePolicy(i:Instance){const p=this.policy(i.project);writeFileSync(join(i.root,'control','policy.json'),JSON.stringify(p),{mode:0o644});}
 list(project:string){return [...this.instances.values()].filter(i=>i.project===project).map(i=>({key:i.key,owner:i.owner,name:this.store.get('user',i.owner)?.name??'账号',active:i.active,starting:!!i.starting,state:i.closed?'sleeping':i.starting?'starting':'ready',lastActivity:i.lastActivity,clients:i.clients??0,sleepReason:i.closed?'':this.sleepBlock(i)}));}
 async stop(user:Doc,project:string,key:string){const i=this.instances.get(key);requireThat(i&&i.project===project&&(user.role==='admin'||i.owner===user.id),'原生环境不存在或无权限',404);requireThat(!i.active&&!i.starting,'请先停止运行中的原生任务',409);if(i.stopping)return i.stopping;const a=this.activity(i);requireThat(!a||!(a.agents||a.jobs||a.queued||a.schedules),'原生后台任务或定时任务尚未完成',409);i.stopping=(async()=>{await exec(DOCKER,['stop','--time','10',i.name],{timeout:15000});i.closed=true;this.runtimeChecks.delete(i.key);this.store.audit(user.id,'native.stopped',key,{project});})();try{await i.stopping;}finally{i.stopping=undefined;}}
 async available(){return this.imageChecks.get(NATIVE_IMAGE,async()=>{for(let attempt=0;attempt<2;attempt++){try{await exec(DOCKER,['image','inspect',NATIVE_IMAGE,'--format','{{.Id}}'],{timeout:5000});return true;}catch(error:any){if(!attempt&&(error?.killed||error?.signal||['ETIMEDOUT','ECONNRESET','EPIPE'].includes(error?.code))){await delay(100);continue;}return false;}}return false;});}
 async get(user:Doc,project:string){const key=this.key(user,project),pending=this.opens.get(key);if(pending)return pending;const request=this.getInstance(user,project).finally(()=>{if(this.opens.get(key)===request)this.opens.delete(key);});this.opens.set(key,request);return request;}
 private async getInstance(user:Doc,project:string){requireThat(!this.closing,'原生环境正在停止',503);requireThat(this.store.get('user',user.id)?.active,'账号不可用',403);requireThat(this.policy(project).enabled,'超级管理员已关闭原生 Harness',403);const key=this.key(user,project);let i=this.instances.get(key);if(i?.stopping)await i.stopping;if(i?.starting){await i.starting;return i;}if(i&&!i.closed){const digest=this.modelFingerprint(user,project);const activity=this.activity(i);if(!i.modelDigest||i.modelDigest===digest||i.active||activity&&(activity.agents||activity.queued||activity.jobs||activity.schedules))return i;await this.stop(user,project,key);}
  // Each account/project keeps its own environment; there is no fixed count cap.
  const root=join(this.store.root,'native-harness',key);i={key,owner:user.id,project,root,work:join(root,'workspace'),name:'team-dsh-'+key,port:0,cookie:'',token:randomBytes(32).toString('hex'),active:0,closed:false,lastActivity:Date.now(),clients:0};this.instances.set(key,i);const instance=i;i.starting=this.start(instance,user).catch(async e=>{const clean=storeRedactor(this.store);const safeError=Object.assign(new Error(clean.text(e?.message??'原生环境启动失败')),{name:e?.name??'Error',code:e?.code});safeError.stack=clean.text(e?.stack??safeError.stack??'');instance.closed=true;const failurePhase=instance.startup?.phase;this.phase(instance,'failed');mkdirSync(instance.root,{recursive:true,mode:0o700});writeFileSync(join(instance.root,'startup-error.json'),JSON.stringify(storeRedactor(this.store).clean({at:now(),phase:failurePhase,elapsedMs:Date.now()-(instance.startup?.startedAt??Date.now()),name:e?.name,code:e?.code,message:e?.message,stack:e?.stack})),{mode:0o600});const logs=await exec(DOCKER,['logs','--tail','100',instance.name],{timeout:5000}).catch(()=>({stdout:'',stderr:''}));writeFileSync(join(instance.root,'startup.log'),(logs.stdout+logs.stderr).replace(/token=[^\s]+/g,'token=[redacted]'),{mode:0o600});await exec(DOCKER,['rm','-f',instance.name],{timeout:15000}).catch(()=>{});throw safeError;}).finally(()=>{instance.starting=undefined;});await i.starting;return i;
 }
 legacySessions(i:Instance,privateHistory:Doc[]=[]){
  const {store}=this.workspace(i.project);const items=store.all('session',i.owner).filter(s=>!s.nativeSession).flatMap(s=>{const saved=store.get('harness',s.id);if(!saved?.events?.length)return [];const sessionId='session-team-'+s.id,events=[...saved.events,{seq:saved.events.length,time:Date.now(),type:'session/title',data:{title:s.title||'项目历史聊天',messageSeqs:[],source:{kind:'user'}}}];return [{header:{...saved.header,id:sessionId,cwd:'/workspace',agentPreset:'standard'},events}];});
  const merged=[...new Map([...items,...privateHistory].map(v=>[v.header.id,v])).values()],clean=privateSkillRedactor(this.codeRoot,this.store.root).redact(merged);if(clean.redactedStrings)this.store.audit(i.owner,'private.skill.legacy_projection',i.key,{project:i.project,redactedStrings:clean.redactedStrings,originalHostRecordsPreserved:true});
  writeFileSync(join(i.root,'control/legacy-sessions.json'),JSON.stringify(clean.value),{mode:0o644});return items.map(v=>v.header.id);
 }
 async ensureModelServer(){if(this.modelPort)return;if(!this.startingModel)this.startingModel=new Promise<void>((done,reject)=>{this.modelServer.once('error',reject);this.modelServer.listen(0,'127.0.0.1',()=>{this.modelPort=(this.modelServer.address() as any).port;done();});});await this.startingModel;}
 async start(i:Instance,user:Doc){
  this.phase(i,'environment');requireThat(await this.available(),'暂时无法确认原生运行环境，请确认 Docker 已启动或稍后重试',503);await this.ensureModelServer();
  assertStoragePath(i.root);
  for(const p of [i.root,i.work,join(i.root,'state'),join(i.root,'control'),join(i.root,'state/profiles/web')])mkdirSync(p,{recursive:true,mode:0o700});
  // Docker Desktop bind mounts preserve host ownership. Match the host uid/gid.
  await removeNativeContainer(i.name,args=>exec(DOCKER,args,{timeout:15000}));
  this.phase(i,'project');const startupSync=this.sync(i,user,true);this.writePolicy(i);
  const models=this.catalog.available(user,i.project);i.modelDigest=this.modelFingerprint(user,i.project);requireThat(models.length,'当前项目没有可用模型',403);
  const control=join(i.root,'control');for(const file of ['team-guard.mjs','prompt-admission.mjs']){copyFileSync(join(this.codeRoot,'native-harness',file),join(control,file));chmodSync(join(control,file),0o644);}
  mkdirSync(join(control,'team-project'),{recursive:true});for(const file of ['package.json','index.mjs','client.js','submissions.mjs','legacy-import.mjs','model-trace.mjs']){copyFileSync(join(this.codeRoot,'native-harness/team-project',file),join(control,'team-project',file));chmodSync(join(control,'team-project',file),0o644);}
  if(this.projectSurface)prepareStudioPlugin(this.codeRoot,control);
  // Only public call descriptors enter the member runtime. Private instructions
  // stay on the host; preserve ordinary native/user Skill discovery.
  const oldSkills=join(control,'video-skills');if(existsSync(oldSkills)){const archive=join(this.store.root,'private-skills','legacy');mkdirSync(archive,{recursive:true,mode:0o700});renameSync(oldSkills,join(archive,i.key+'-'+id()));}
  rmSync(join(control,'skill-stubs'),{recursive:true,force:true});cpSync(join(this.codeRoot,'native-harness/skill-stubs'),join(control,'skill-stubs'),{recursive:true});i.privateSkillCalls=true;
  const privateHistory=await preparePrivateSkillHistory(this,i),legacySessionIds=this.legacySessions(i,privateHistory);
  const patch:Doc[]=[{id:'compaction-basic',config:{modelPolicies:nativeContextPolicies(this.store,models,id=>this.catalog.modelConnection(id,i.project),m=>nativeCatalogProfile(this.store,this.catalog,i.project,m))}},{id:'skill-filesystem',disabled:false,config:{providerName:'team-host-skill-calls',includeDefaultRoots:true,bundledSkillDir:'/team/skill-stubs'}},{id:'ui-settings-models',disabled:true},{id:'permission',config:{defaultPreset:'workspace-write'}},{id:'webserver',config:{host:'0.0.0.0',port:3080}},{id:'web-runtime',config:{openBrowser:false,printUrl:true,surfaceContext:true,trustedHosts:[]}},{id:'session-query-sqlite',config:{path:':memory:',openAt:'first-search'}},{id:'llm-deepseek',disabled:true},{id:'llm-deepseek-account',disabled:true},{id:'llm-pi-ai',config:{providers:{'deepseek-official':{displayName:'团队模型',api:'openai-completions',apiKeyEnv:'TEAM_NATIVE_KEY',baseURL:`http://host.docker.internal:${this.modelPort}/native-model/${i.key}`,reasoning:'high',compat:{thinkingFormat:'deepseek',maxTokensField:'max_tokens',supportsDeveloperRole:false,supportsStore:false},models:models.map(m=>nativeCatalogProfile(this.store,this.catalog,i.project,m)),retryPolicy:{mode:'normal',maxRetries:2,retryableCodes:['TRANSPORT','TIMEOUT','EMPTY_RESPONSE','SERVER'],backoff:{initialDelayMs:500,maxDelayMs:5000,jitterRatio:0.1}}}}}},{id:'agent-default-model',config:{provider:'deepseek-official',model:models[0].id}},{id:'ui-schedule',disabled:false},{insert:[{id:'team-project',name:'/team/team-project/index.mjs',config:{baseURL:`http://host.docker.internal:${this.modelPort}/native-model/${i.key}/team`,legacyImport:'/team/legacy-sessions.json',privateSkillCalls:true,projectContentSearch:true,videoAssembly:true,nativeAttachmentSearch:true,projectLinks:true,projectAssignments:true}},{id:'team-policy',name:'/team/team-guard.mjs',config:{policy:'/team/policy.json'}}]}];
  const profilePath=join(i.root,'state/profiles/web/package.json');
  const profile=existsSync(profilePath)?JSON.parse(readFileSync(profilePath,'utf8')):{name:'team-harness-profile',private:true};
  profile.dsh??={};profile.dsh.profile??={};
  profile.dsh.profile.bundles=[...new Set([...(profile.dsh.profile.bundles??[]),'@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@deepseek-ai/dsh-experimental-schedule-bundle'])];
  profile.dsh.profile.patchReload='startup';writeFileSync(profilePath,JSON.stringify(profile));
  const storedProfilePatch=join(i.root,'state/profiles/web/cordis.patch.yml');
  if(!existsSync(storedProfilePatch))writeFileSync(storedProfilePatch,'[]');
  patch.push(...nativeContextPresetPatch(this.codeRoot,readFileSync(storedProfilePatch,'utf8'),nativeContextPolicies(this.store,models,id=>this.catalog.modelConnection(id,i.project),m=>nativeCatalogProfile(this.store,this.catalog,i.project,m))));
  writeFileSync(join(control,'overlay.yml'),JSON.stringify(patch),{mode:0o644});
  this.phase(i,'runtime');
  await exec(DOCKER,['run','-d','--name',i.name,'--label','team.harness.owner='+i.owner,'--label','team.harness.project='+i.project,'--init','--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,'--cap-drop=ALL','--security-opt','no-new-privileges','--pids-limit','512','--memory','1536m','--cpus','2','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=512m','--tmpfs','/home/node:rw,nosuid,nodev,size=128m','--publish','127.0.0.1::3080','--mount',`type=bind,src=${i.work},dst=/workspace`,'--mount',`type=bind,src=${join(i.root,'state')},dst=/state`,'--mount',`type=bind,src=${control},dst=/team,readonly`,'--env','SHELL=/bin/bash','--env','TEAM_NATIVE_KEY='+i.token,NATIVE_IMAGE,'--patch','/team/overlay.yml','--no-open'],{timeout:20000,maxBuffer:1024*1024});
  const port=await exec(DOCKER,['port',i.name,'3080/tcp'],{timeout:5000});i.port=Number(port.stdout.trim().split(':').at(-1));requireThat(Number.isInteger(i.port)&&i.port>0,'原生端口未就绪',503);
  const token=await waitNativeStartupToken({readLogs:async()=>{const logs=await exec(DOCKER,['logs','--tail','30',i.name],{timeout:5000});return logs.stdout+logs.stderr;}});
  requireThat(token,'原生 Harness 启动失败，请检查独立运行日志',503);const r=await fetch(`http://127.0.0.1:${i.port}/?token=${token}`,{redirect:'manual',headers:{}});i.cookie=r.headers.get('set-cookie')?.split(';')[0]??'';requireThat(i.cookie,'原生会话认证未就绪',503);
  this.phase(i,'sessions');const ws=await this.rpc(i,'workspace/create',{path:'/workspace'});if(ws?.workspace?.workspaceId)await this.rpc(i,'workspace/rename',{workspaceId:ws.workspace.workspaceId,title:this.workspace(i.project).projects.current().name});
  const migrationFile=join(i.root,'legacy-native-ready.json');const migrated:string[]=existsSync(migrationFile)?JSON.parse(readFileSync(migrationFile,'utf8')):[];
  for(const sessionId of legacySessionIds){if(migrated.includes(sessionId))continue;
   await this.rpc(i,'session/create',{sessionId,workspaceId:ws.workspace.workspaceId});
   const original=this.workspace(i.project).store.get('session',sessionId.replace(/^session-team-/,''));const selected=models.find(m=>m.id===original?.modelId)??models[0];
   await this.rpc(i,'session/selectModel',{sessionId,provider:'deepseek-official',model:selected.id,reasoningEffort:'high'});
   migrated.push(sessionId);writeFileSync(migrationFile,JSON.stringify(migrated),{mode:0o600});
  }
  await this.migrateModels(i);
  await verifyPrivateSkillHistory(this,i);
  this.phase(i,'ready');this.store.audit(user.id,'native.started',i.key,{project:i.project,image:NATIVE_IMAGE,startupMs:i.startup!.readyAt!-i.startup!.startedAt,steps:i.startup!.steps,sync:startupSync.metrics});
 }
 async migrateModels(i:Instance){
  if(!existsSync(join(this.store.root,'chat-model-route-aliases.json')))return;
  const listed=await this.rpc(i,'session/list',{_request:{}},true);
  for(const session of listed?.items??[]){
   const selection=session.projections?.values?.modelSelection?.next??session.projections?.values?.modelSelection?.current;
   const target=this.catalog.migrationModel(selection?.model??'');
   if(!target||target===selection.model)continue;
   await this.rpc(i,'session/selectModel',{sessionId:session.sessionId,provider:'deepseek-official',model:target,reasoningEffort:selection.reasoningEffort??'high'});
   this.store.audit(i.owner,'native.model.route_migrated',session.sessionId,{previousModel:selection.model,model:target,historyPreserved:true});
  }
 }
 async rpc(i:Instance,method:string,args:Doc={},rawArgs=false){const r=await fetch(`http://127.0.0.1:${i.port}/api/${method}`,{method:'POST',headers:{Origin:`http://127.0.0.1:${i.port}`,Cookie:i.cookie,'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:id(),method,payload:{args:rawArgs?args:{request:args}}})});const raw=await r.text();requireThat(r.ok,'原生接口响应失败 ('+r.status+')',502);const v=JSON.parse(raw) as any;requireThat(r.ok&&v.result?.ok!==false,'原生接口请求失败：'+JSON.stringify(v).slice(0,600),502);return v.result?.value??v.value;}
 safePath(i:Instance,path:string){validPath(path);let cursor=i.work;for(const part of path.split('/')){cursor=join(cursor,part);try{const st=lstatSync(cursor);if(st.isSymbolicLink())return false;}catch(e:any){if(e.code==='ENOENT')break;throw e;}}return true;}
 async frozen<T>(i:Instance,fn:()=>T):Promise<T>{const run=(i.tail??Promise.resolve()).catch(()=>{}).then(async()=>{requireThat(!i.closed,'原生环境已关闭',409);await exec(DOCKER,['pause',i.name],{timeout:10000});try{return fn();}finally{await exec(DOCKER,['unpause',i.name],{timeout:10000});}});i.tail=run;return run;}
 sync(i:Instance,user:Doc,startup=false){const {projects}=this.workspace(i.project),baseFile=join(i.root,'base.json'),previous=existsSync(baseFile)?JSON.parse(readFileSync(baseFile,'utf8')):{manifest:{}};const revision=projects.current().revision,manifest=projects.revision(revision).manifest;const conflicts:string[]=[],metrics={unchanged:0,hashedFiles:0,hashedBytes:0,copied:0};
  for(const p of new Set([...Object.keys(previous.manifest),...Object.keys(manifest)])){
   validPath(p);
   // No upstream change means there is nothing to merge on startup. Keep the
   // member's edits/deletions and the previous baseline; explicit sync and
   // publication still hash the workspace and report conflicts as before.
   if(startup&&previous.manifest[p]===manifest[p]){metrics.unchanged++;continue;}
   const dest=join(i.work,p);if(!this.safePath(i,p)){conflicts.push(p);continue;}let current:string|undefined;if(existsSync(dest)){const st=lstatSync(dest);if(!st.isFile()||st.isSymbolicLink()){conflicts.push(p);continue;}current=fileHash(dest);metrics.hashedFiles++;metrics.hashedBytes+=st.size;}if(current!==previous.manifest[p]&&current!==manifest[p]){conflicts.push(p);continue;}if(current===manifest[p])continue;assertStoragePath(dest);if(!manifest[p]){if(existsSync(dest))unlinkSync(dest);continue;}mkdirSync(dirname(dest),{recursive:true});cloneFileSync(objectPath(this.store.root,manifest[p]),dest);chmodSync(dest,0o600);metrics.copied++;
  }
  const next={revision,manifest:{...manifest}};for(const p of conflicts){if(previous.manifest[p])next.manifest[p]=previous.manifest[p];else delete next.manifest[p];}writeFileSync(baseFile,JSON.stringify(next),{mode:0o600});return {revision,conflicts,metrics};
 }
 files(i:Instance){const found:Record<string,string>={};const scan=(dir:string)=>{for(const f of readdirSync(dir,{withFileTypes:true})){if(f.name.startsWith('.')||['node_modules','__pycache__'].includes(f.name)||f.isSymbolicLink())continue;const p=join(dir,f.name);if(f.isDirectory())scan(p);else if(f.isFile()){const path=relative(i.work,p);try{validPath(path);}catch{continue;}requireThat(Object.keys(found).length<10000,'工作目录文件过多，请排除构建产物',413);found[path]=fileHash(p);}}};scan(i.work);return found;}
 changes(i:Instance){const base=JSON.parse(readFileSync(join(i.root,'base.json'),'utf8')),files=this.files(i);return {base:base.revision,files:[...new Set([...Object.keys(base.manifest),...Object.keys(files)])].filter(p=>base.manifest[p]!==files[p]).map(path=>({path,before:base.manifest[path]??null,after:files[path]??null}))};}
 submit(i:Instance,user:Doc,paths:string[]){requireThat(Array.isArray(paths)&&paths.length>0&&paths.length<=32,'每次选择 1–32 个文件提交审核');const diff=this.changes(i),writes:Doc={},reads:Doc={};for(const p of paths){validPath(p);const f=diff.files.find(f=>f.path===p);requireThat(f,'文件已改变，请刷新差异',409);writes[p]=f.after?storeFile(this.store.root,join(i.work,p)):null;if(f.before)reads[p]=f.before;}
  const {projects}=this.workspace(i.project);return projects.candidateObjects(user,diff.base,writes,reads,{source:'native-harness',nativeWorkspace:i.key});}
 async checkRoute(user:Doc,i:Instance,path:string,body?:Buffer){const method=path.split('?')[0].replace(/^\/api\//,'');const p=this.policy(i.project);requireThat(p.enabled,'超级管理员已关闭原生 Harness',403);
  let wire:Doc={};try{wire=JSON.parse(body?.toString()??'{}');}catch{}
  if(wire?.type==='client-request')requireThat(wire.method===method,'原生请求方法与路径不一致',400);
  const args:Doc=wire?.payload?.args??{};
  const groups:Record<string,RegExp>={files:/^(workspaceFiles|fileReferences)\//,shell:/^jobs\//,skills:/^skills\//,subagents:/^subagents\//,goals:/^goals\//,plugins:/^(dynamicCordisRunner|agentPresets)\/(?!list$|read$|inventory$)/,schedule:/^schedule\//,attachments:/^(fileUploads|files\/upload|session\/(attachment|uploadFileBinary))/,search:/^session\/search$/,export:/^session\.export$/,models:/^session\/selectModel$/,feedback:/^(messageFeedback|sessionFeedback)\//,settings:/^settings\/(update|replace|mutate)$/};
  for(const [key,pattern] of Object.entries(groups))requireThat(p.features[key]!==false||!pattern.test(method),'超级管理员已关闭此功能：'+key,403);
  if(method==='commands/execute'){const command=String(args.line??'').trim().replace(/^\//,'').split(/\s+/);const key=({goal:'goals',compact:'compact',plan:'plan',permission:'permissions',model:'models',export:'export',feedback:'feedback'} as Doc)[command[0]];requireThat(!key||p.features[key]!==false,'超级管理员已关闭此功能',403);if(command[0]==='permission'&&command[1])requireThat(p.permissions.includes(command[1]),'此权限模式未开放',403);}
  const request=args.request??args;
  if(['workspace/create','session/create','session/fork'].includes(method)){const path=request.path??request.cwd;if(path!==undefined)requireThat(path==='/workspace'||typeof path==='string'&&path.startsWith('/workspace/')&&this.safePath(i,path.slice(11)),'项目会话只能使用当前工作区',403);}
  if(method==='session/selectModel')this.catalog.select(user,i.project,args.request?.model);
  if(user.role!=='admin'&&/^(settings|credentials)\//.test(method)&&!['settings/describe','credentials/list','credentials/status','credentials/describe'].includes(method))requireThat(method.startsWith('settings/')&&!/^(llm-|agent-default-model|webserver|web-runtime)/.test(String(args.ns??'')),'模型连接和项目边界由管理员管理',403);


 }
 bootstrap(prefix:string,csrf:string){return `${this.projectSurface?'window.__TEAM_STUDIO_MODE__=true;':''}(()=>{const p=${JSON.stringify(prefix)},csrf=${JSON.stringify(csrf)};const url=v=>{const u=new URL(v instanceof Request?v.url:String(v),location.href);if(u.origin===location.origin&&!u.pathname.startsWith(p+'/'))u.pathname=p+u.pathname;return u.href;};window.__TEAM_WORKSPACE_DOWNLOAD_URL__=path=>p+'/api/team/workspace-download?path='+encodeURIComponent(path);const f=window.fetch.bind(window);${this.projectSurface?`window.__TEAM_HOST_FETCH__=(path,options={})=>{const u=new URL(path,location.origin);if(u.origin!==location.origin||!['/api/projects','/api/native/open','/api/logout'].includes(u.pathname))throw Error('主机入口不在当前工作台范围');const bridge=window.teamDesktop;if(bridge?.projectRequest)return bridge.projectRequest(u.pathname+u.search,options.method||'GET',typeof options.body==='string'?JSON.parse(options.body):options.body).then(r=>{if(!r.ok)throw Error(r.error||'主机入口未确认');return new Response(JSON.stringify(r.value.data),{status:r.value.status,headers:{'Content-Type':'application/json'}});});const headers=new Headers(options.headers);headers.set('X-CSRF-Token',csrf);return f(u.href,{...options,headers,redirect:'error'});};`:''}window.fetch=(v,o={})=>{const h=new Headers(o.headers||(v instanceof Request?v.headers:undefined));if(new URL(url(v)).origin===location.origin)h.set('X-CSRF-Token',csrf);return f(v instanceof Request?new Request(url(v),v):url(v),{...o,headers:h});};const K=window.Worker;window.Worker=class extends K{postMessage(m,t){if(m&&typeof m.url==='string'&&new URL(m.url,location.href).origin===location.origin)m={...m,url:url(m.url),headers:{...m.headers,'X-CSRF-Token':csrf}};super.postMessage(m,t);}};const W=window.WebSocket;window.WebSocket=class extends W{constructor(v,protocols){const u=new URL(v,location.href);if(u.host===location.host&&!u.pathname.startsWith(p+'/'))u.pathname=p+u.pathname;super(u.href,protocols);}};const E=window.EventSource;window.EventSource=class extends E{constructor(v,o){super(url(v),o)}};})();`;}
 async proxy(req:IncomingMessage,res:ServerResponse,spec:Spec,upstreamPath:string,prefix:string){
  const download=new URL(upstreamPath,'http://native.local');
  // Persisted originals and previews use the authenticated project boundary;
  // serving them must not depend on starting or reconnecting an agent container.
  if(await this.team.serveMedia(spec.project,spec.user,req,res,upstreamPath))return;
  if(['/api/team/workspace-download','/api/team/workspace-bundle'].includes(download.pathname)){
   const root=join(this.store.root,'native-harness',this.key(spec.user,spec.project)),path=conversationFilePath(download.searchParams.get('path'),{root,work:join(root,'workspace')});
   const files=hostFiles(this.store).scoped(value=>{conversationFilePath(value,{root,work:join(root,'workspace')});});
   if(download.pathname==='/api/team/workspace-bundle')return files.bundle(spec.user,[path],res,()=>requireThat(!!this.store.get('user',spec.user.id)?.active&&(!spec.authorized||spec.authorized()),'当前项目访问权限已失效',403),req.method==='HEAD');
   return files.stream(spec.user,path,req,res,()=>!!this.store.get('user',spec.user.id)?.active&&(!spec.authorized||spec.authorized()),true);
  }
  const i=await this.get(spec.user,spec.project);this.touch(i);const body=['GET','HEAD'].includes(req.method??'GET')?undefined:await bytes(req);await this.checkRoute(spec.user,i,upstreamPath,body);const controller=new AbortController();const timer=setInterval(()=>{if(this.closing||!this.store.get('user',spec.user.id)?.active||!this.policy(spec.project).enabled||spec.authorized&&!spec.authorized())controller.abort();},2000);timer.unref();const abort=()=>{clearInterval(timer);controller.abort();};req.once('aborted',abort);res.once('close',abort);
  if(download.pathname==='/api/team/model-route'&&req.method==='GET'){clearInterval(timer);const session=download.searchParams.get('session')??'';requireThat(/^[a-zA-Z0-9_-]{1,200}$/.test(session),'原生会话编号无效');res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(publicModelRoute(this.store,i.key,session)));return;}
  if(upstreamPath.startsWith('/api/team/')){clearInterval(timer);return this.team.route(i,spec.user,req,res,upstreamPath,body);}
  const cacheable=nativeStaticPath(req.method??'GET',upstreamPath),cacheKey=i.key+':'+(i.startup?.startedAt??i.token)+':'+prefix+':'+upstreamPath;
  const sendAsset=(asset:{body:Buffer;type:string;etag:string})=>{clearInterval(timer);res.setHeader('Content-Type',asset.type);res.setHeader('Cache-Control','private, no-cache');res.setHeader('ETag',asset.etag);res.setHeader('X-Content-Type-Options','nosniff');if(req.headers['if-none-match']?.split(/,\s*/).includes(asset.etag)){res.statusCode=304;res.end();}else res.end(asset.body);};
  const cached=cacheable?this.staticCache.get(cacheKey):undefined;if(cached)return sendAsset(cached);
  const upstream=await forwardNativeRequest(`http://127.0.0.1:${i.port}${upstreamPath}`,{method:req.method,headers:{Origin:`http://127.0.0.1:${i.port}`,Cookie:i.cookie,...(req.headers['content-type']?{'Content-Type':req.headers['content-type']}:{}),...(req.headers.range?{Range:req.headers.range}:{})},body,redirect:'manual',signal:controller.signal},()=>this.store.audit(spec.user.id,'native.prompt.receipt_retry',i.key,{project:i.project}));
  if(spec.viewer&&spec.viewer.id!==spec.user.id&&req.method==='POST'&&/^\/api\/session\/(prompt|interrupt)(?:\?|$)/.test(upstreamPath)){let request:Doc={};try{request=JSON.parse(body?.toString()??'{}').payload?.args?.request??{};}catch{}this.store.audit(spec.viewer.id,'admin.native_chat.forward',spec.user.id,{project:i.project,method:upstreamPath.split('?')[0],session:request.sessionId,requestId:request.requestId,status:upstream.status});}
  res.removeHeader('X-Frame-Options');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-ancestors 'self' team:; base-uri 'self'; object-src 'none'");
  const ct=upstream.headers.get('content-type')??'application/octet-stream';res.statusCode=upstream.status;res.setHeader('Content-Type',ct);for(const h of ['content-disposition','content-range','accept-ranges']){const value=upstream.headers.get(h);if(value)res.setHeader(h,value);}if(upstream.headers.get('location'))res.setHeader('Location',prefix+upstream.headers.get('location'));
  if(req.method==='HEAD')return res.end();
  if(ct.includes('text/html')||ct.includes('javascript')||ct.includes('text/css')){let text=scopeNativeAsset(await upstream.text(),prefix);if(this.projectSurface&&ct.includes('javascript'))text=adaptStudioSource(text);if(ct.includes('text/html'))text=credentialedManifestLinks(text,prefix).replace('<head>',`<head><script>${this.bootstrap(prefix,spec.csrf)+nativePageBridge(spec.scope??spec.user.id+':'+spec.project,{project:spec.project,admin:(spec.viewer??spec.user).role==='admin',user:spec.user.id,viewer:(spec.viewer??spec.user).id,ownerName:spec.user.name??spec.user.username},this.projectSurface)}</script>${this.projectSurface?'<style>'+studioStyle(this.codeRoot)+'</style>':''}`);if(cacheable&&upstream.ok)return sendAsset(this.staticCache.put(cacheKey,Buffer.from(text),ct));return res.end(text);}
  if(cacheable&&upstream.ok)return sendAsset(this.staticCache.put(cacheKey,Buffer.from(await upstream.arrayBuffer()),ct));
  if(upstream.body){for await(const chunk of upstream.body as any){if(res.destroyed)break;if(!res.write(Buffer.from(chunk)))await new Promise(r=>res.once('drain',r));}}res.end();
 }
 async upgrade(req:IncomingMessage,socket:any,head:Buffer,spec:Spec,path:string,prefix:string,stillAuthorized:()=>boolean){const i=await this.get(spec.user,spec.project);requireThat(path==='/api/remote.mux','未知原生流',404);this.socketServer.handleUpgrade(req,socket,head,client=>{this.sockets.add(client);i.clients=(i.clients??0)+1;this.touch(i);const upstream=new WebSocket(`ws://127.0.0.1:${i.port}${path}`,{headers:{Origin:`http://127.0.0.1:${i.port}`,Cookie:i.cookie}});const pending:any[]=[];client.on('message',(b,binary)=>{if(!stillAuthorized()||!this.policy(i.project).enabled){client.close(1008);return;}if(upstream.readyState===WebSocket.OPEN)upstream.send(b,{binary});else if(pending.length<100)pending.push([b,binary]);else client.close(1009);});upstream.on('open',()=>{for(const [b,binary] of pending)upstream.send(b,{binary});pending.length=0;});upstream.on('message',(b,binary)=>{if(client.readyState===WebSocket.OPEN)client.send(b,{binary});});const timer=setInterval(()=>{if(!stillAuthorized()||!this.policy(i.project).enabled)client.close(1008);},2000);client.on('close',()=>{clearInterval(timer);upstream.close();this.sockets.delete(client);i.clients=Math.max(0,(i.clients??1)-1);this.touch(i);});upstream.on('close',()=>client.close());client.on('error',()=>upstream.close());upstream.on('error',()=>client.close(1011));});}
 async model(req:IncomingMessage,res:ServerResponse){
  const key=req.url?.match(/^\/native-model\/([a-f0-9]{24})\//)?.[1],i=key?this.instances.get(key):undefined;
  requireThat(i&&!i.closed&&req.headers.authorization==='Bearer '+i.token,'模型代理认证失败',403);
  const user=this.store.get('user',i.owner);requireThat(user?.active&&this.policy(i.project).enabled,'账号或能力已停用',403);
  if(req.method==='POST'&&req.url?.endsWith('/team')){
   const b=JSON.parse((await bytes(req,1024*1024)).toString());this.touch(i);i.active++;let value;
   const controller=new AbortController(),abort=()=>{if(!res.writableEnded)controller.abort();};res.once('close',abort);try{value=await this.team.tool(i,user,b,controller.signal);}finally{res.off('close',abort);i.active--;this.touch(i);}
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));return;
  }
  requireThat(req.method==='POST'&&req.url?.endsWith('/chat/completions'),'此模型接口未接入',404);
  const original=JSON.parse((await bytes(req,8*1024*1024)).toString()),selected=this.catalog.select(user,i.project,original.model);
  // The public native LLM hook binds this metadata to one asynchronous stream
  // on the authenticated local hop. Never forward it to cloud providers.
  const nativeSession=typeof req.headers['x-team-native-session']==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(req.headers['x-team-native-session'])?req.headers['x-team-native-session']:undefined,modelScope=nativeSession?i.key+':'+nativeSession:i.key,nativePurpose=['compaction','session-title'].includes(String(req.headers['x-team-native-purpose']))?String(req.headers['x-team-native-purpose']):undefined;
  let c=this.catalog.connection((selected as any).configId);requireThat(c,'当前模型未配置',503);
  const b=structuredClone(original),routePolicy=routingPolicy(this.store,i.project),routed=routePolicy.enabled||routePolicy.engine==='magpie';
  b.model=c.model;const outputLimit=nativeModelProfile(this.store,{},c).maxTokens;
  b.max_tokens=Math.min(b.max_tokens??4096,outputLimit,c.limits?.maxTokens??outputLimit);adaptChatRequest(c,b);
  let pricing=modelPricing(c),reservation=estimateUsd(pricing,Buffer.byteLength(JSON.stringify(b))+8192,0,b.max_tokens*2);
  const day=new Date().toISOString().slice(0,10),call={id:id(),configId:c.configId,connectionEvidenceId:connectionEvidenceId(c),pricing,day,reservedUsd:reservation,fixture:!!c.fixture,owner:user.id,project:i.project,native:true,nativeWorkspace:i.key,nativeSession,nativePurpose,provider:c.provider,model:c.model,requestedModelId:selected.modelId,routingLogical:routed,state:'pending',created:now(),requestBytes:Buffer.byteLength(JSON.stringify(b))};
  this.store.put('model-call',{...call,state:'queued',reservedUsd:0});i.active++;this.touch(i);
  let release:(()=>void)|undefined,dispatched=false,actualCommitted=false,completed=false,toolCallsObserved=false,providerStatus:number|undefined,usage:any,pending='',routeId:string|undefined;
  const decoder=new TextDecoder(),controller=new AbortController(),stop=()=>{if(!res.writableEnded)controller.abort();};res.on('close',stop);
  try{
   release=await this.queue.acquire(i.owner,controller.signal,call.id);controller.signal.throwIfAborted();
   const allowed=()=>!this.closing&&!i.closed&&!!this.store.get('user',i.owner)?.active&&!!this.policy(i.project).enabled;
   requireThat(allowed(),'账号或环境已停用',403);
   const current=this.catalog.select(this.store.get('user',i.owner)!,i.project,selected.modelId);
   requireThat(current.configId===c.configId,'排队期间模型配置已改变，本次请求尚未发送',409);
   dispatched=true;this.store.put('model-call',{...call,state:'pending',started:now(),queueMs:Date.now()-Date.parse(call.created)});
   const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(600000)]);let r:Response;
   if(routed){
    const result=await(this.routing??=new ModelRouting(this.store,this.catalog)).fetch(i.project,selected.modelId,original,signal,modelScope,call.id,allowed,(failure,connection)=>{
     // Each sent-but-unconfirmed attempt is retained for reconciliation. The
     // logical parent is not a second bill when all candidate attempts fail.
     const price=modelPricing(connection);
     this.store.put('model-call',{id:id(),parentCallId:call.id,routingAttempt:true,day,owner:user.id,project:i.project,native:true,nativeWorkspace:i.key,nativeSession,nativePurpose,configId:connection.configId,connectionEvidenceId:connectionEvidenceId(connection),fixture:!!connection.fixture,provider:connection.provider,model:connection.model,pricing:price,state:failure.possiblyBilled?'unconfirmed':'failed',reservedUsd:failure.possiblyBilled?estimateUsd(price,failure.requestBytes+8192,0,failure.maxOutputTokens*2):0,created:failure.started,started:failure.started,finished:failure.finished,providerStatus:failure.status,stage:failure.stage,requestBytes:failure.requestBytes,completed:false,billing:failure.possiblyBilled?'usage_unknown_pending_reconciliation':'not_sent'});
    },nativeSession&&!nativePurpose?nativeContextPressure(req.headers):undefined);
    r=result.response;routeId=result.routeId;actualCommitted=!!result.connection;
    if(result.connection){c=result.connection;pricing=modelPricing(c);reservation=estimateUsd(pricing,result.requestBytes!+8192,0,result.maxOutputTokens!*2);
     this.store.put('model-call',{...this.store.get('model-call',call.id),configId:c.configId,connectionEvidenceId:connectionEvidenceId(c),provider:c.provider,model:c.model,fixture:!!c.fixture,pricing,routeId,requestBytes:result.requestBytes,maxOutputTokens:result.maxOutputTokens,actualModelId:result.modelId,fallbackCount:result.failures.length});
    }
    for(const header of ['X-Team-Route-Id','X-Team-Actual-Model','X-Team-Fallbacks']){const value=r.headers.get(header);if(value)res.setHeader(header,value);}
   }else{actualCommitted=true;r=await fetchModel(c,b,signal,this.store,modelScope);}
   providerStatus=r.status;res.writeHead(r.status,{'Content-Type':r.headers.get('content-type')??'text/event-stream','Cache-Control':'no-store'});
   if(r.body)for await(const chunk of r.body as any){
    if(res.destroyed)break;pending+=decoder.decode(chunk,{stream:true});let at;
    while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);if(line.startsWith('data:'))try{
     const row=JSON.parse(line.slice(5).trim());if(row.usage)usage=row.usage;if(row.choices?.some((v:any)=>v.delta?.tool_calls?.length))toolCallsObserved=true;if(row.choices?.some((v:any)=>v.finish_reason))completed=true;
    }catch{}}
    if(pending.length>1048576)pending='';res.write(Buffer.from(chunk));
   }
   if(r.ok&&!completed)throw Error('供应商响应中断，未收到完成事件');
   completed=r.ok&&completed;res.end();
  }finally{
   release?.();i.active--;this.touch(i);res.off('close',stop);
   const recordedUsage=chatAccountingUsage(usage),valid=!!recordedUsage;
   const billable=dispatched&&(!routed||actualCommitted);
   this.store.put('model-call',{...this.store.get('model-call',call.id),state:!dispatched?'cancelled_before_send':routed&&!actualCommitted?'routing_failed':valid?'usage_recorded':'unconfirmed',reservedUsd:billable?reservation:0,providerStatus,completed,toolCallsObserved,routeId,finished:now(),...(valid?{usage:recordedUsage,estimatedUsd:estimateUsd(pricing,recordedUsage!.inputTokens,recordedUsage!.cacheReadTokens??0,recordedUsage!.outputTokens),billing:c.provider==='zhipu-coding'?'subscription_usage_pending_reconciliation':'peak_rate_estimate_not_final_bill'}:{billing:billable?'usage_unknown_pending_reconciliation':'not_dispatched_logical_request'})});
   if(routed&&actualCommitted&&!completed&&!controller.signal.aborted&&providerStatus&&providerStatus>=200&&providerStatus<300)this.store.put('model-route-health',{id:connectionEvidenceId(c),configId:c.configId,state:'cooldown',stage:'stream_interrupted',retryAt:Date.now()+routingPolicy(this.store,i.project).cooldownMs,checked:now()});
   if(routeId){const route=this.store.get('model-route',routeId);if(route)this.store.put('model-route',{...route,state:completed?'completed':actualCommitted?'interrupted':route.state,updated:now(),finished:now()});}
  }
 }

 async close(){this.closing=true;await this.team.codex?.close();await this.history.close(true);clearInterval(this.idleTimer);this.queue.close();for(const s of this.sockets)s.terminate();await Promise.allSettled([...this.instances.values()].map(async i=>{if(i.starting)await i.starting.catch(()=>{});if(!i.closed){i.closed=true;await exec(DOCKER,['stop','--time','15',i.name],{timeout:20000});}}));if(this.modelPort){await new Promise<void>(r=>{this.modelServer.close(()=>r());this.modelServer.closeAllConnections();});}}
}
