import {readFileSync,writeFileSync,renameSync,existsSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {Store,hash,id,type Doc} from '../server/store.ts';
import {ChatCatalog} from '../server/chat-catalog.ts';
import {chatProvider} from '../shared/chat-providers.ts';
import {VideoCatalog} from '../server/video-catalog.ts';
import {XiaopeiDirectory} from '../server/xiaopei-directory.ts';
import {VideoStorage} from '../server/video-storage.ts';
import {loadModel} from '../server/model.ts';
import {ImageSelection} from '../server/image-selection.ts';
const [profilePath,credentialPath,resultPath]=process.argv.slice(2);
const profile=JSON.parse(readFileSync(profilePath,'utf8')),credentials=JSON.parse(readFileSync(credentialPath,'utf8'));
const root=profile.data,key=credentials.apiKey,preset=chatProvider('ruiyun')!;
const atomic=(p:string,v:unknown)=>{mkdirSync(dirname(p),{recursive:true,mode:0o700});const tmp=p+'.ruiyun-new';writeFileSync(tmp,JSON.stringify(v,null,2)+'\n',{mode:0o600});renameSync(tmp,p);};
const originalFile=join(root,'chat-model-connections.json'),original:Doc[]=existsSync(originalFile)?JSON.parse(readFileSync(originalFile,'utf8')):[];
const store=new Store(root);
try{
 const admin=store.all('user').find(u=>u.role==='admin'&&u.active);if(!admin)throw Error('No active owner administrator');
 const initial={provider:'ruiyun',model:'gpt-6-luna',reasoningEffort:'high',baseURL:preset.baseURL,apiKey:key,metadata:{id:'gpt-6-luna',name:'gpt-6-luna',protocol:'chat',selectable:true,inputModalities:['text','image'],efforts:['off','low','high','max'],source:'Synthetic red-image and tool-continuation probe 2026-10-08'}};
 // Existing credential snapshots survive in the deployment backup. Historical
 // media channel versions retain their original credentials for polling.
 atomic(join(profile.live.textConfig,'model-connection.json'),initial);
 atomic(originalFile,original.map(r=>({...r,enabled:false})));
 const catalog=new ChatCatalog(store,loadModel(profile.live.textConfig));
 const directory=await catalog.directory(admin,{provider:'ruiyun',apiKey:key,refresh:true});
 const names=new Map<string,string>([['gpt-6-luna','default']]);
 for(const m of directory.models.filter((m:Doc)=>m.selectable&&m.id!=='gpt-6-luna')){
  const previous=original.find(r=>r.connection.model===m.id);
  const saved=catalog.saveModel(admin,{...(previous?{id:previous.id}:{}),name:'瑞云 · '+m.id,provider:'ruiyun',model:m.id,reasoningEffort:'high',baseURL:preset.baseURL,apiKey:key,enabled:true})!;
  names.set(m.id,saved.id);
 }
 const aliases:Record<string,string>={};
 for(const r of original){
  const model=r.connection.model==='deepseek-flash'?'deepseek-v4.1-flash':r.connection.model;
  aliases[r.id]=names.get(model)??'default';
 }
 atomic(join(root,'chat-model-route-aliases.json'),aliases);
 const videos=new VideoCatalog(store,500);
 const oldChannels=store.all('video-channel').filter(c=>c.adapter!=='ruiyun'||c.origin!==credentials.origin);
 const oldModels=store.all('video-model').filter(m=>oldChannels.some(c=>c.id===m.channelId));
 const current=store.all('video-channel').find(c=>c.adapter==='ruiyun'&&c.origin===credentials.origin);
 const c=current?videos.publicChannel(current):videos.saveChannel(admin,{name:'瑞云 API 中转站',origin:credentials.origin,adapter:'ruiyun',apiKey:key,enabled:true,concurrency:500,noRetryEvidence:'Configured Ruiyun transport performs one creation POST; uncertain submissions are never automatically replayed.'});
 await videos.probe(admin,c.id);
 const media=new XiaopeiDirectory(store,videos),mediaReceipt=await media.sync(admin,c.id);
 const images=media.images(),selection=new ImageSelection(store,videos);await selection.refresh(images,true);
 for(const old of oldChannels){
  if(old.enabled)videos.saveChannel(admin,{id:old.id,name:old.name,origin:old.origin,adapter:old.adapter,enabled:false,concurrency:old.concurrency,noRetryEvidence:old.noRetryEvidence,allowLocalHTTP:old.allowLocalHTTP===true});
 }
 // Hide superseded choices; frozen plans/jobs and immutable channel versions
 // remain unchanged and can still retrieve supplier results.
 store.tx(()=>{
  for(const m of oldModels)store.put('video-model',{...m,status:'disabled',default:false});
  for(const m of store.all('image-model').filter(m=>oldChannels.some(c=>c.id===m.channelId)))store.put('image-model',{...m,status:'disabled'});
  for(const policy of store.all('member-model-policy'))store.put('member-model-policy',{...policy,video:store.all('video-model').filter(m=>m.channelId===c.id&&m.memberAccess).map(m=>m.id),image:images.map(m=>m.id)});
 });
 if(!store.get('video-storage','active')){
  const c={id:'active',revision:id(),mode:'host-reference',origin:credentials.publicOrigin,enabled:true,created:new Date().toISOString()};
  store.put('video-storage',c);store.put('video-storage-version',{...c,id:c.revision});
  store.audit(admin.id,'video.storage.host_reference',c.revision,{origin:c.origin,expiryHours:48});
 }
 const receipt={status:'configured',provider:'ruiyun',defaultModel:'gpt-6-luna',origin:credentials.origin,chatModels:directory.models.length,selectableChatModels:catalog.publicModels().filter(m=>m.enabled&&m.provider==='ruiyun').length,media:mediaReceipt,availableImageModels:selection.sorted(images).length,legacySessionRoutes:Object.keys(aliases).length,legacyChannelsDisabled:oldChannels.length,oldMediaJobsRecreated:0,storageEnabled:store.get('video-storage','active')?.enabled===true};
 store.audit(admin.id,'provider.migration.ruiyun','20261008',receipt);atomic(resultPath,receipt);console.log(JSON.stringify(receipt));
}finally{store.close();}
