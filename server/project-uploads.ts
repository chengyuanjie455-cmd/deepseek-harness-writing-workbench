import {receiveChunk} from './upload-chunk.ts';
import {mkdirSync,existsSync,statSync,openSync,closeSync,readSync,writeSync,fsyncSync,readFileSync,unlinkSync,createReadStream,constants} from 'node:fs';import {join,basename} from 'node:path';import type {IncomingMessage,ServerResponse} from 'node:http';
import {Store,requireThat,id,hash,now,type Doc} from './store.ts';import {Projects,validPath} from './project.ts';import {MAX_FILE_BYTES,storeFile,objectInfo,objectPath,diskSpace} from './file-objects.ts';import type {MediaStore} from './media.ts';
import {previewSourceFile} from './media-preview.ts';import {serveFileDownload} from './native-download.ts';
export class ProjectUploads{
 root:string;busy=new Set<string>();
 constructor(public store:Store,public projects:Projects,public media:MediaStore){this.root=join(store.root,'uploads');mkdirSync(this.root,{recursive:true,mode:0o700});}
 active(user:Doc){requireThat(this.store.get('user',user.id)?.active,'账号已停用',403);}
 owned(user:Doc,uploadId:string){this.active(user);const u=this.store.get('file-upload',uploadId);requireThat(u&&u.owner===user.id,'上传不存在或不属于本人当前项目',404);return u;}
 temp(u:Doc){return join(this.root,u.id+'.partial');}
 public(u:Doc){return {id:u.id,name:u.name,bytes:u.bytes,received:u.state==='receiving'&&existsSync(this.temp(u))?statSync(this.temp(u)).size:u.received,state:u.state,path:u.path,sha256:u.sha256,revision:u.revision,mediaId:u.mediaId,created:u.created};}
 start(user:Doc,b:Doc){
  this.active(user);requireThat(typeof b.requestId==='string'&&/^[a-f0-9-]{32,36}$/.test(b.requestId),'上传请求编号无效');requireThat(typeof b.name==='string'&&b.name.length<=180&&b.name===basename(b.name),'文件名无效');const name=b.name.normalize('NFC');validPath(name);requireThat(Number.isSafeInteger(b.bytes)&&b.bytes>=0&&b.bytes<=MAX_FILE_BYTES,'单个附件最多256 MiB',413);
  const session=this.store.get('session',b.session);requireThat(session&&session.owner===user.id,'只能上传到本人当前项目聊天',404);const fixed=this.store.get('member-chat',`${this.projects.projectId}:${user.id}`)?.session===b.session;requireThat(!(session.archived??(!fixed&&!session.multichat)),'请先恢复已归档的会话',409);const uploadId=hash(JSON.stringify([this.projects.projectId,user.id,b.requestId])).slice(0,32),old=this.store.get('file-upload',uploadId);
  if(old){requireThat(old.name===name&&old.bytes===b.bytes&&old.session===b.session,'同一上传编号用于不同附件',409);return this.public(old);}
  const all=this.store.global.all('file-upload').filter(u=>u.state==='receiving');requireThat(all.length<64&&all.filter(u=>u.owner===user.id).length<8,'有未完成上传，请先完成或取消',429);diskSpace(this.store.root,b.bytes+all.reduce((n,u)=>n+u.bytes-(u.received??0),0));
  const u={id:uploadId,owner:user.id,project:this.projects.projectId,session:b.session,requestId:b.requestId,name,bytes:b.bytes,received:0,state:'receiving',created:now(),path:`成员附件/${uploadId}/${name}`};const fd=openSync(this.temp(u),'wx',0o600);closeSync(fd);this.store.put('file-upload',u);return this.public(u);
 }
 chunk(user:Doc,uploadId:string,b:Doc){
  const u=this.owned(user,uploadId);requireThat(u.state==='receiving'&&!this.busy.has(u.id),'附件状态已改变',409);receiveChunk(this.temp(u),u.bytes,b,this.store.root);
  const next={...u,received:statSync(this.temp(u)).size,updated:now()};this.store.put('file-upload',next);return this.public(next);
 }
 async reference(user:Doc,path:string,revision?:string){
  this.active(user);const info=this.projects.fileInfo(path,revision);requireThat(info.mime.startsWith('image/'),'仅PNG/JPEG/WebP可直接作为图片参考',422);
  if(this.store.global.all('media').some(m=>m.generated&&m.sha256===info.sha256))return undefined;
  const existing=this.store.all('media').find(m=>m.attachmentPath===path&&m.sha256===info.sha256);if(existing)return existing;
  const m=await this.media.ingest(createReadStream(objectPath(this.store.root,info.sha256)),user.id,'private',basename(path));this.active(user);requireThat(this.projects.revision().manifest[path]===info.sha256,'图片已从当前项目移除或改变',409);
  const next={...m,scope:'project',provenance:'member_original',attachmentPath:path};this.store.put('media',next);return next;
 }
 async finish(user:Doc,uploadId:string){
  let u=this.owned(user,uploadId);if(u.state==='published')return this.public(u);requireThat(u.state==='receiving'&&!this.busy.has(u.id),'原上传正在处理，请查询状态',409);this.busy.add(u.id);
  try{requireThat(statSync(this.temp(u)).size===u.bytes,'文件尚未完整上传',409);const digest=storeFile(this.store.root,this.temp(u));this.active(user);const change=this.projects.addAttachment(user,u.path,digest,u.id);u={...u,state:'published',sha256:digest,received:u.bytes,revision:change.revision,publishedAt:now()};this.store.tx(()=>{this.store.put('file-upload',u);if(!this.store.get('message',u.id))this.store.put('message',{id:u.id,session:u.session,role:'user',text:`已上传附件：${u.name}`,attachments:[{path:u.path,name:u.name,sha256:digest,revision:change.revision,bytes:u.bytes}],created:now(),base:change.revision},u.session);this.store.event(user.id,'file.uploaded',{id:u.id,path:u.path});this.store.audit(user.id,'file.upload',u.id,{path:u.path,sha256:digest,bytes:u.bytes});});
   if(objectInfo(this.store.root,digest).mime.startsWith('image/')){try{const m=await this.reference(user,u.path,change.revision);if(m){u={...u,mediaId:m.id};this.store.put('file-upload',u);}}catch{/* The original is already published; reference preparation can be resumed separately. */}}
   if(existsSync(this.temp(u)))unlinkSync(this.temp(u));return this.public(u);
  }finally{this.busy.delete(u.id);}
 }
 cancel(user:Doc,uploadId:string){const u=this.owned(user,uploadId);requireThat(u.state==='receiving'&&!this.busy.has(u.id),'已发布附件只能申请管理员删除',409);if(existsSync(this.temp(u)))unlinkSync(this.temp(u));this.store.put('file-upload',{...u,state:'cancelled'});return {cancelled:true};}
 async serveThumbnail(req:IncomingMessage,res:ServerResponse,path:string,revision:string|undefined,user:Doc){
  this.active(user);const info=this.projects.fileInfo(path,revision);
  requireThat(['image/png','image/jpeg','image/webp','video/mp4','video/quicktime','video/webm'].includes(info.mime),'此格式不提供缩略图，请查看或下载原件',415);
  const authorized=()=>!!this.store.global.get('user',user.id)?.active;
  const file=await previewSourceFile({root:this.store.root,sha256:info.sha256,mime:info.mime,path:objectPath(this.store.root,info.sha256),owner:user.id,capacity:()=>diskSpace(this.store.root,Math.min(info.bytes,64*1024*1024)),verify:()=>{objectInfo(this.store.root,info.sha256);}},'thumb');
  requireThat(authorized(),'登录身份已变更',401);res.setHeader('X-Media-Derivative','preview-only');res.setHeader('X-Original-SHA256',info.sha256);
  return serveFileDownload(file,req,res,{authorized,inline:true,mime:'image/jpeg'});
 }
 serve(req:IncomingMessage,res:ServerResponse,path:string,revision?:string){
  const info=this.projects.fileInfo(path,revision),file=objectPath(this.store.root,info.digest);let start=0,end=info.bytes-1;const range=req.headers.range;if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);requireThat(m,'读取范围无效',416);start=Number(m[1]);end=m[2]?Number(m[2]):end;requireThat(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start<=end&&start<info.bytes,'读取范围无效',416);end=Math.min(end,info.bytes-1);}
  // Project SVGs are inert image previews, never HTML or trusted documents.
  // Keep the global file/media MIME catalogue unchanged: this does not broaden
  // the PNG/JPEG/WebP reference formats accepted by generation providers.
  let mime=info.mime;if(mime==='application/octet-stream'&&info.text&&/\.svg$/i.test(path)){
   const text=readFileSync(file,'utf8'),root=text.replace(/^\uFEFF/,'').replace(/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*/,'');
   if(!/<!DOCTYPE|<!ENTITY/i.test(text)&&/^<svg\b[^>]*\sxmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1(?:\s|\/?>)/.test(root))mime='image/svg+xml';
  }
  const inline=(mime.startsWith('image/')||mime.startsWith('video/'))&&!new URL(req.url??'/', 'http://local').searchParams.has('download');res.writeHead(range?206:200,{'Content-Type':inline?mime:'application/octet-stream','Content-Length':Math.max(0,end-start+1),'Accept-Ranges':'bytes','X-Content-SHA256':info.sha256,'Content-Disposition':`${inline?'inline':'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(basename(path)).replace(/'/g,'%27')}`,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; sandbox",...(range?{'Content-Range':`bytes ${start}-${end}/${info.bytes}`}:{})});if(req.method==='HEAD'||!info.bytes)return res.end();const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
 }
}
