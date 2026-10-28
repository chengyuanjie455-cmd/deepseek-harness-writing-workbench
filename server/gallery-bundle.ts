import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Platform} from './app.ts';
import {mediaGallery} from './media-gallery.ts';
import {objectPath} from './file-objects.ts';
import {bundleName,serveFileBundle,type BundleFile} from './media-bundle.ts';
import {id,requireThat,type Doc} from './store.ts';

// Small, expiring selection receipts keep large selections out of download URLs.
// Receipts never grant access: the requesting login and catalogue are checked again.
type Receipt={auth:string;scope:string;ids:string[];expires:number};
const receipts=new WeakMap<Platform,Map<string,Receipt>>();
const scope=(params:URLSearchParams)=>JSON.stringify(['project','owner','session','kind','q'].map(k=>params.get(k)??''));
function receiptStore(app:Platform){let entries=receipts.get(app);if(!entries){entries=new Map();receipts.set(app,entries);}for(const [key,value] of entries)if(value.expires<Date.now())entries.delete(key);return entries;}
export async function prepareGalleryBundle(app:Platform,user:Doc,params:URLSearchParams,req:IncomingMessage,selection:Doc){
 requireThat(selection&&['include','exclude'].includes(selection.mode)&&Array.isArray(selection.ids)&&selection.ids.every((v:unknown)=>typeof v==='string'),'打包选择格式无效');
 const data=await mediaGallery(app,user,params,{all:true}),auth=app.authenticate(req).auth.token;
 requireThat(!data.warnings.length,'部分聊天附件暂未读取，请稍后重试',503);
 const wanted=new Set<string>(selection.ids),known=new Set(data.items.map(v=>v.id));
 requireThat([...wanted].every(v=>known.has(v)),'所选文件已变更或不在当前画廊，请刷新后重新选择',422);
 const ids=data.items.filter(v=>selection.mode==='exclude'?!wanted.has(v.id):wanted.has(v.id)).map(v=>v.id);
 requireThat(ids.length>0,'请先选择要打包的图片或视频',422);
 const entries=receiptStore(app);while(entries.size>=200)entries.delete(entries.keys().next().value!);
 const token=id();entries.set(token,{auth,scope:scope(params),ids,expires:Date.now()+5*60000});return {token,count:ids.length};
}

/** Resolve only the existing authenticated catalogue, never client-supplied paths. */
export async function serveGalleryBundle(app:Platform,user:Doc,params:URLSearchParams,req:IncomingMessage,res:ServerResponse){
 const verify=()=>{const current=app.authenticate(req).user;requireThat(current.id===user.id&&current.role===user.role,'登录身份已变更',403);};
 verify();const data=await mediaGallery(app,user,params,{all:true});verify();
 const token=params.get('selection');let items=data.items;
 if(token){const receipt=receiptStore(app).get(token);requireThat(receipt&&receipt.auth===app.authenticate(req).auth.token&&receipt.scope===scope(params),'打包选择已过期，请重新点击打包下载',410);
  const selected=new Set(receipt.ids);items=items.filter(v=>selected.has(v.id));requireThat(items.length===selected.size,'所选文件已变更，请刷新后重新选择',422);
 }
 requireThat(!data.warnings.length,'部分聊天附件暂未读取，尚不能完整打包，请稍后重试',503);
 const ws=app.workspace(data.project),files:BundleFile[]=[],sessions=new Map<string,Promise<any>>();
 for(const item of items){
  verify();requireThat(!res.destroyed,'下载已取消',499);let file:Omit<BundleFile,'name'>&{name:string};
  if(item.mediaId){
   const media=ws.pickups.media,m=media.get(item.mediaId);requireThat(media.canRead(m,user),'媒体不存在或无权限',404);
   file={path:media.path(m.id),bytes:m.bytes,sha256:m.sha256,name:m.name??item.name};
  }else if(item.id.startsWith('file:')){
   const url=new URL(item.download,'http://local'),info=ws.projects.fileInfo(item.path,url.searchParams.get('revision')??undefined);
   file={path:objectPath(ws.store.root,info.sha256),bytes:info.bytes,sha256:info.sha256,name:item.name};
  }else{
   const p=new URL(item.download,'http://local').searchParams,owner=p.get('owner')!,session=p.get('session')!,key=app.native.history.galleryOwner(user,data.project,owner),cacheKey=key+':'+session;
   // Read each chat once, even when it contains hundreds of attachments.
   if(!sessions.has(cacheKey))sessions.set(cacheKey,app.native.history.read(key,session));
   const snapshot=await sessions.get(cacheKey);verify();app.native.history.galleryOwner(user,data.project,owner);
   const block=snapshot.rows?.flatMap((r:Doc)=>r.content??[]).find((b:Doc)=>['image','file'].includes(b.type)&&b.attachment?.attachmentId===p.get('attachmentId')&&(b.attachment?.name??'')===(p.get('name')??''));
   const original=app.native.history.attachmentOriginal(key,block);file={...original,name:original.name||item.name+(item.kind==='video'?'.mp4':'.png')};
  }
  // Prefixes retain duplicate filenames without overwriting files on extraction.
  files.push({...file,name:`${item.kind==='video'?'视频':'图片'}/${String(files.length+1).padStart(6,'0')}_${bundleName(file.name)}`});
 }
 const project=app.store.get('project',data.project)?.name??'项目',label=params.get('session')?'聊天画廊':data.kind==='image'?'图片画廊':data.kind==='video'?'视频画廊':'媒体画廊';
 await serveFileBundle(files,res,`${[...bundleName(project)].slice(0,50).join('')}_${label}_${new Date().toISOString().slice(0,10)}.zip`,{head:req.method==='HEAD',authorize:verify});
 if(req.method!=='HEAD')app.store.audit(user.id,'gallery.download',data.project,{kind:data.kind,owner:params.get('owner')??undefined,session:params.get('session')??undefined,files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0)});
}
