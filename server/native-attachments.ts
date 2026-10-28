import {existsSync,statSync} from 'node:fs';import {join,relative} from 'node:path';import {fileURLToPath} from 'node:url';
import {Store,hash,requireThat,type Doc} from './store.ts';import type {NativeHistory} from './native-history.ts';
import {nativeDocumentText} from './document-text.ts';import {assertStoragePath} from './external-storage.ts';import {privateSkillRedactor} from './private-skill-content.ts';
import {episodeKey,projectSection,assetType} from '../shared/project-studio.ts';
export const nativeAttachmentKey=(project:string,owner:string,session:string,attachmentId:string,name='')=>hash(JSON.stringify([project,owner,session,attachmentId,name]));
export type AttachmentSnapshot={owner:string;complete:boolean;items:Doc[];warnings:string[]};
const textCache=new Map<string,Doc>(),textFlights=new Map<string,Promise<Doc>>();let textBytes=0;
/** Native session logs and native attachment objects remain authoritative.
 * This adapter never publishes an upload or copies it to project blobs. */
export class NativeAttachments {
 constructor(public store:Store,private history:()=>NativeHistory,private extract:typeof nativeDocumentText=nativeDocumentText){}
 check(user:Doc){const current=this.store.get('user',user.id);requireThat(current?.active&&current.role===user.role,'附件访问身份已变化',403);assertStoragePath(this.store.root);}
 private owners(user:Doc){this.check(user);return this.store.all('user').filter(u=>user.role==='admin'||u.id===user.id);}
 private item(owner:Doc,ref:Doc){
  ref={...ref,name:ref.name??(ref.blockType==='image'?'':undefined)};
  requireThat(/^session-[a-zA-Z0-9-]{1,160}$/.test(ref.session)&&/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId)&&typeof ref.name==='string'&&!/[\\/]/.test(ref.name)&&!['.','..'].includes(ref.name)&&['file','image'].includes(ref.blockType),'附件引用无效',409);
  const project=this.store.projectId??'shared',key=nativeAttachmentKey(project,owner.id,ref.session,ref.attachmentId,ref.name),nativeKey=hash(JSON.stringify([owner.id,project])).slice(0,24),block={type:ref.blockType,attachment:{attachmentId:ref.attachmentId,name:ref.name}},name=ref.name||'聊天图片',kind=ref.blockType==='image'||/\.(png|jpe?g|webp|gif)$/i.test(name)?'image':/\.(mp4|mov|m4v|webm|mkv)$/i.test(name)?'video':'document',ep=episodeKey(name),src='/api/native-attachments/'+key+'/content';
  let original:Doc|undefined,fileStamp='unavailable';try{original=this.history().attachmentOriginal(nativeKey,block);const s=statSync(original.path);fileStamp=[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');}catch{}
  const item:Doc={id:'attachment:'+key,entityId:'attachment:'+key,nativeAttachmentKey:key,versionId:ref.attachmentId,sha256:ref.attachmentId.slice(7),name,kind,mime:ref.mime??(ref.blockType==='image'?'image/png':'application/octet-stream'),section:projectSection({name,kind}),episodes:ep?[ep]:[],episodeEvidence:ep?'filename_hint':'unassigned',assetType:assetType(name),scope:'private',owner:owner.id,ownerName:owner.name,nativeSession:ref.session,project,attachmentId:ref.attachmentId,attachmentName:ref.name,attachmentType:ref.blockType,bytes:original?.bytes??ref.bytes,source:'聊天附件',sourceType:'native_attachment',uploadedAt:ref.time,src,download:src+'?download=1',galleryId:'attachment:'+owner.id+':'+ref.session+':'+ref.attachmentId+':'+ref.name,relationships:[]};
  item.displayName=[ep??'公共',owner.name,'聊天附件',name].join(' · ');return {item,block,nativeKey,original,fileStamp};
 }
 async snapshots(user:Doc):Promise<AttachmentSnapshot[]>{
  const owners=this.owners(user),project=this.store.projectId??'shared',result:AttachmentSnapshot[]=[];
  for(const owner of owners){this.check(user);const key=this.history().galleryOwner(user,project,owner.id),root=join(this.store.root,'native-harness',key,'state/sessions');
   if(!existsSync(root)){const old=this.store.get('native-attachment-index',hash(JSON.stringify([project,owner.id])));result.push({owner:owner.id,complete:!old?.items,items:[],warnings:old?.items?['部分原生附件目录暂不可读取，保留上次索引，不能据此判断附件为空。']:[]});continue;}
   try{const data=await this.history().read(key,undefined,undefined,'attachments');this.check(user);requireThat(Array.isArray(data.items),'附件目录暂不可读取',503);const refs=new Map<string,Doc>(),warnings:string[]=[];for(const ref of data.items){try{const v=this.item(owner,ref);refs.set(v.item.id,{...v.item,fileStamp:v.fileStamp});}catch{warnings.push('有附件引用未能核对，原会话和原件未改动。');}}
    const complete=!data.errors?.length&&!warnings.length;if(data.errors?.length)warnings.push('部分会话附件未能读取，保留上次索引；可稍后重试。');result.push({owner:owner.id,complete,items:[...refs.values()],warnings});
   }catch{this.check(user);result.push({owner:owner.id,complete:false,items:[],warnings:['原生附件历史暂不可读取，保留已有索引，不将其视为附件为空。']});}
  }this.check(user);return result;
 }
 async resolve(user:Doc,raw:string,located?:Doc){
  this.check(user);const key=String(raw).replace(/^attachment:/,'');requireThat(/^[a-f0-9]{64}$/.test(key),'附件编号无效');const project=this.store.projectId??'shared';
  // A derived search row locates a reference, but never grants access. Confirm
  // the current session reference through native persistence on every read.
  let row:Doc|undefined;if(!located){requireThat(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_content_entities'").get(),'附件尚未检索，请先按文件名或正文查找',404);row=this.store.db.prepare('SELECT metadata FROM project_content_entities WHERE project=? AND id=?').get(project,'attachment:'+key) as Doc|undefined;}requireThat(located||row,'附件不存在或尚未检索',404);const m=located??JSON.parse(row!.metadata);requireThat(m.project===project&&nativeAttachmentKey(project,m.owner,m.nativeSession,m.attachmentId,m.attachmentName)===key,'附件引用身份已改变',409);requireThat(m.owner===user.id||user.role==='admin','附件不存在或无权限',404);const owner=this.store.get('user',m.owner);requireThat(owner,'附件成员不存在',404);const nativeKey=this.history().galleryOwner(user,project,m.owner);let data:Doc;try{data=await this.history().read(nativeKey,m.nativeSession);}catch{this.check(user);requireThat(false,'原生附件会话暂不可读取，请稍后重试',503);}this.check(user);this.history().galleryOwner(user,project,m.owner);
  const block=data.rows?.flatMap((r:Doc)=>r.content??[]).find((b:Doc)=>b.type===m.attachmentType&&b.attachment?.attachmentId===m.attachmentId&&(b.attachment?.name??'')===m.attachmentName);requireThat(block,'此附件不再属于原会话，未读取旧索引原件',404);const v=this.item(owner,{session:m.nativeSession,attachmentId:m.attachmentId,name:m.attachmentName,blockType:m.attachmentType,time:m.uploadedAt});requireThat(v.item.nativeAttachmentKey===key&&v.original,'附件原件不存在或引用已变化',404);return {...v,block};
 }
 async text(user:Doc,key:string,located?:Doc):Promise<Doc>{
  const v=await this.resolve(user,key,located),redactor=privateSkillRedactor(fileURLToPath(new URL('..',import.meta.url)),this.store.root),cacheKey=[v.original!.path,v.item.sha256,v.fileStamp,...redactor.sourceDigests].join(':');
  const first=await this.extract(v.original!.path,v.item.sha256,v.item.attachmentName,0,32000);this.check(user);let result=textCache.get(cacheKey);
  if(!result){let flight=textFlights.get(cacheKey);if(!flight){flight=(async()=>{const parts=[first];let at=first.nextOffset;while(at!==null){const d=await this.extract(v.original!.path,v.item.sha256,v.item.attachmentName,at,32000);this.check(user);parts.push(d);requireThat(d.nextOffset===null||d.nextOffset>at,'附件正文分页未前进');at=d.nextOffset;}const redacted=redactor.redact(parts.map(p=>p.content).join('')),value={content:redacted.value,extraction:first.extraction,note:first.note,...(redacted.redactedStrings?{privateSkillRedacted:true}:{})},bytes=Buffer.byteLength(value.content);if(first.extraction!=='unavailable'&&bytes<=64*1024*1024){while(textCache.size&&(textBytes+bytes>64*1024*1024||textCache.size>=100)){const old=textCache.keys().next().value!;textBytes-=Buffer.byteLength(textCache.get(old)!.content);textCache.delete(old);}textCache.set(cacheKey,value);textBytes+=bytes;}return value;})();textFlights.set(cacheKey,flight);}try{result=await flight;}finally{if(textFlights.get(cacheKey)===flight)textFlights.delete(cacheKey);}}
  this.check(user);return {...v.item,...result};
 }
 async read(user:Doc,key:string,offset=0,limit=8000):Promise<Doc>{
  requireThat(Number.isInteger(offset)&&offset>=0&&Number.isInteger(limit)&&limit>=1&&limit<=32000,'附件读取范围无效');const value=await this.text(user,key),text=value.content.slice(offset,offset+limit);this.check(user);return {...value,content:text,offset,nextOffset:offset+text.length<value.content.length?offset+text.length:null,totalCharacters:value.content.length};
 }
 async original(user:Doc,key:string){const v=await this.resolve(user,key);const {verifiedDocumentOriginal}=await import('./document-text.ts');verifiedDocumentOriginal(v.original!.path,v.item.sha256);this.check(user);return v;}
 async preview(user:Doc,key:string):Promise<Doc>{const v=await this.resolve(user,key);return {...v.item,...(v.item.owner===user.id?{nativePath:'/state/attachments/v1/'+relative(join(this.store.root,'native-harness',v.nativeKey,'state/attachments/v1'),v.original!.path)}:{})};}
}
