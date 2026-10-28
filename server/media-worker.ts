import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store,id,now,type Doc} from './store.ts';
import {Projects} from './project.ts';
import {Pickups} from './pickups.ts';
import {ImageGeneration} from './image-generation.ts';
import {mediaSlots} from './media-check-slots.ts';
import {MEDIA_WORKER_PROTOCOL,mediaWorkerDigest,atomicWorkerFile} from './media-worker-manager.ts';
import {watchExternalStorage,assertStoragePath} from './external-storage.ts';

const root=resolve(process.argv[2]),simulated=process.argv.includes('--simulated'),fixtureIndex=process.argv.indexOf('--fixture');
if(fixtureIndex>=0&&!simulated)throw Error('正式执行器不能加载模拟适配器');
const fixture=fixtureIndex>=0?await import(pathToFileURL(resolve(process.argv[fixtureIndex+1])).href):{};
const store=new Store(root,undefined,undefined,'media-worker'),instance=id(),started=now(),codeDigest=mediaWorkerDigest();
const workspaces=new Map<string,{pickups:Pickups;images:ImageGeneration}>();let closing=false;
function status(state:string){try{atomicWorkerFile(root,'media-worker-status.json',{protocol:MEDIA_WORKER_PROTOCOL,instance,pid:process.pid,codeDigest,started,heartbeat:now(),state,projects:workspaces.size,slots:mediaSlots(),videoActive:[...workspaces.values()].reduce((n,w)=>n+w.pickups.active.size,0),imageActive:[...workspaces.values()].reduce((n,w)=>n+w.images.active.size,0),simulated});}catch{/* An unavailable bound disk must never cause an internal fallback write. */}}
function sync(){assertStoragePath(root);for(const p of store.all('project'))if(!workspaces.has(p.id)){
 const scoped=store.scoped(p.id),projects=new Projects(scoped,p.id,undefined,false),pickups=new Pickups(scoped,projects,fixture.videoAdapter,simulated,store.get('runtime-concurrency','active')?.video??2),images=new ImageGeneration(scoped,projects,pickups.catalog,pickups.media,pickups.storage,fixture.imageAdapter,simulated);
 workspaces.set(p.id,{pickups,images});pickups.start();images.start();
}status('ready');}
async function stop(){if(closing)return;closing=true;clearInterval(timer);status('stopping');for(const w of workspaces.values()){await w.images.close();await w.pickups.close();}status('stopped');store.close();process.exit(0);}
sync();const timer=setInterval(()=>{try{
 const stopFile=join(root,'media-worker-stop.json');if(existsSync(stopFile)&&JSON.parse(readFileSync(stopFile,'utf8')).instance===instance){void stop();return;}sync();
}catch{status('storage_or_project_unavailable');void stop();}},2000);
watchExternalStorage();process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
