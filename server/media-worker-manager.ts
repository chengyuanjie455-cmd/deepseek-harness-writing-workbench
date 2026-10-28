import {existsSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,readdirSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertStoragePath} from './external-storage.ts';
import {spawn} from 'node:child_process';
import {hash,requireThat,type Store,type Doc} from './store.ts';
export const MEDIA_WORKER_PROTOCOL=1;
const codeRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function mediaWorkerDigest(root=codeRoot){return hash([...readdirSync(join(root,'server')).filter(p=>p.endsWith('.ts')).sort().map(p=>'server/'+p),'package-lock.json'].map(p=>p+'\n'+readFileSync(join(root,p),'utf8')).join('\n'));}
export function livePID(pid:unknown){if(!Number.isSafeInteger(pid)||Number(pid)<=0)return false;try{process.kill(Number(pid),0);return true;}catch(e:any){return e.code!=='ESRCH';}}
export function mediaWorkerStatus(root:string):Doc|undefined{try{return JSON.parse(readFileSync(join(root,'media-worker-status.json'),'utf8'));}catch{return;}}
export function activeMediaWorker(root:string){try{return livePID(JSON.parse(readFileSync(join(root,'media-worker.lock'),'utf8')).pid);}catch{return false;}}
export function atomicWorkerFile(root:string,name:string,data:Doc){assertStoragePath(root);const file=join(root,name),tmp=file+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(data),{mode:0o600});renameSync(tmp,file);}
export class MediaWorkerManager{
 timer?:ReturnType<typeof setInterval>;starting?:Promise<void>;closed=false;lastError?:string;
 constructor(public store:Store,public options:{simulated?:boolean;fixtureModule?:string;root?:string}={}){}
 async start(){await this.ensure();this.timer=setInterval(()=>{void this.ensure().catch(()=>{});},5000);this.timer.unref();}
 async ensure(){if(this.closed)return;if(this.starting)return this.starting;this.starting=this.launch().catch(e=>{this.lastError=e instanceof Error?e.message:'媒体执行器不可用';throw e;}).finally(()=>{this.starting=undefined;});return this.starting;}
 private async launch(){
  const root=this.options.root??codeRoot,digest=mediaWorkerDigest(root),status=mediaWorkerStatus(this.store.root);
  if(activeMediaWorker(this.store.root)){
   requireThat(status?.protocol===MEDIA_WORKER_PROTOCOL&&status.codeDigest===digest&&livePID(status.pid),'后台媒体执行器版本或身份尚未核对，保留原进程',409);
   requireThat(status.state==='ready'&&Date.now()-Date.parse(status.heartbeat)<30000,'后台媒体执行器未就绪，保留原任务',503);this.lastError=undefined;return;
  }
  requireThat(!this.options.fixtureModule||this.options.simulated,'模拟适配器不能用于正式执行器');
  const log=openSync(join(this.store.root,'media-worker.log'),'a',0o600);
  try{
   const child=spawn(process.execPath,['--import',join(root,'node_modules/tsx/dist/loader.mjs'),join(root,'server/media-worker.ts'),this.store.root,...(this.options.simulated?['--simulated']:[]),...(this.options.fixtureModule?['--fixture',resolve(this.options.fixtureModule)]:[])],{cwd:root,detached:true,stdio:['ignore',log,log],env:{...process.env,PLATFORM_DATA:this.store.root}});
   child.on('error',()=>{});child.unref();
   const deadline=Date.now()+15000;
   while(Date.now()<deadline){const current=mediaWorkerStatus(this.store.root);if(current&&current.pid===child.pid&&current.codeDigest===digest&&current.state==='ready'){this.lastError=undefined;return;}if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,100));}
   throw Error('后台媒体执行器启动未确认，请核对执行器日志');
  }finally{closeSync(log);}
 }
 snapshot(){const status=mediaWorkerStatus(this.store.root);return {mode:'independent',...status,alive:activeMediaWorker(this.store.root),error:this.lastError};}
 async close(keepRunning=false){this.closed=true;clearInterval(this.timer);if(this.starting)await this.starting.catch(()=>{});if(keepRunning)return;
  const status=mediaWorkerStatus(this.store.root);if(!activeMediaWorker(this.store.root))return;
  requireThat(status?.protocol===MEDIA_WORKER_PROTOCOL,'媒体执行器身份不明，未终止',409);
  atomicWorkerFile(this.store.root,'media-worker-stop.json',{instance:status.instance});
  const end=Date.now()+20000;while(activeMediaWorker(this.store.root)&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
  requireThat(!activeMediaWorker(this.store.root),'媒体执行器尚未结束，不能进入离线备份',409);
 }
}
