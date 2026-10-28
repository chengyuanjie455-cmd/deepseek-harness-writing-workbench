import {readFileSync,writeFileSync} from 'node:fs';
import {Store} from '../server/store.ts';import {loadModel} from '../server/model.ts';import {ChatCatalog} from '../server/chat-catalog.ts';import {VideoCatalog} from '../server/video-catalog.ts';import {XiaopeiDirectory} from '../server/xiaopei-directory.ts';import {ImageSelection} from '../server/image-selection.ts';
const [profilePath,resultPath]=process.argv.slice(2),profile=JSON.parse(readFileSync(profilePath,'utf8')),store=new Store(profile.data);
try{
 const admin=store.all('user').find(u=>u.active&&u.role==='admin');if(!admin)throw Error('Active administrator missing');
 const initial=loadModel(profile.live.textConfig),chats=new ChatCatalog(store,initial),directory=await chats.directory(admin,{provider:'ruiyun',apiKey:initial.apiKey,refresh:true});
 for(const m of directory.models.filter(m=>m.selectable))if(!chats.all().some(r=>r.enabled&&r.connection.provider==='ruiyun'&&r.connection.model===m.id))chats.saveModel(admin,{name:'瑞云 · '+m.id,provider:'ruiyun',model:m.id,reasoningEffort:'high',baseURL:initial.baseURL,apiKey:initial.apiKey,enabled:true});
 const c=store.all('video-channel').find(c=>c.enabled&&c.adapter==='ruiyun');if(!c)throw Error('Active Ruiyun media channel missing');
 const videos=new VideoCatalog(store,500),media=new XiaopeiDirectory(store,videos),receipt=await media.sync(admin,c.id),images=media.images(),selection=new ImageSelection(store,videos);await selection.refresh(images,true);
 const currentVideos=store.all('video-model').filter(m=>m.channelId===c.id&&m.memberAccess&&m.status!=='disabled');
 // Existing policy explicitly opened all Ruiyun models. Extend that same scope
 // without modifying original jobs/plans or disabling other credentials.
 store.tx(()=>{for(const p of store.all('member-model-policy'))store.put('member-model-policy',{...p,video:currentVideos.map(m=>m.id),image:images.map(m=>m.id)});});
 const token=images.filter(m=>m.billingMode==='token'),videoIds=new Set(currentVideos.map(m=>m.remoteModel)),imageIds=new Set(images.map(m=>m.remoteModel)),chatIds=new Set(directory.models.map(m=>m.id));
 const all=c.reachableModels??[],missing=all.filter((n:string)=>!videoIds.has(n)&&!imageIds.has(n)&&!chatIds.has(n));
 if(missing.length)throw Error('Models missing from native catalog: '+missing.join(','));
 if(receipt.callableVideo!==83||receipt.callableImage!==67||receipt.needsAdapter!==0||selection.sorted(images).length!==67)throw Error('Unexpected model inventory');
 const result={status:'configured',version:'2026.10.08-ruiyun-all-models-02',chatModels:chatIds.size,includesAuxiliary3D:chatIds.has('豆姐3d'),videoModels:videoIds.size,imageModels:imageIds.size,total:all.length,missing,tokenPricedImages:token.map(m=>m.remoteModel),media:receipt,paidCreationRequests:0};store.audit(admin.id,'ruiyun.models.refresh','20261008-all',result);writeFileSync(resultPath,JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
}finally{store.close();}
