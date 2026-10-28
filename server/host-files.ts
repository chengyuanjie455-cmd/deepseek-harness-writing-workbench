import {constants,createReadStream,realpathSync} from 'node:fs';
import {realpath,lstat,stat,readdir,open,mkdir,copyFile,rename,link,unlink,writeFile,chmod} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve,relative,dirname,basename,extname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {Store,Problem,requireThat,id,hash,now,type Doc} from './store.ts';
import {serveFileDownload} from './native-download.ts';
import {serveFileBundle,bundleName,type BundleFile} from './media-bundle.ts';
import {diskSpace} from './file-objects.ts';
import {receiveChunk} from './upload-chunk.ts';
const mimeFor=(p:string)=>({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif','.heic':'image/heic','.mp4':'video/mp4','.mov':'video/quicktime','.m4v':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.pdf':'application/pdf'} as Record<string,string>)[extname(p).toLowerCase()]??'application/octet-stream';
const version=(s:any)=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
const fail=(e:any):never=>{if(e instanceof Problem)throw e;throw new Problem(['ENOENT','ENOTDIR'].includes(e.code)?404:['EACCES','EPERM','EROFS'].includes(e.code)?403:e.code==='EEXIST'?409:500,['EACCES','EPERM','EROFS'].includes(e.code)?'macOS 无权访问或磁盘只读':e.code==='EEXIST'?'目标已存在，原文件未覆盖':['ENOENT','ENOTDIR'].includes(e.code)?'文件不存在或磁盘未连接':'文件操作未完成，请刷新核对');};
const within=(a:string,b:string)=>a===b||a.startsWith(b+sep);
/** A conversation can resolve its own project workspace and uploaded attachments. */
export function conversationFilePath(value:unknown,i:{work:string;root:string}){
 requireThat(typeof value==='string'&&value.startsWith('/'),'请填写文件的绝对路径');
 for(const [prefix,base] of [['/workspace',i.work],['/state/attachments/v1',join(i.root,'state/attachments/v1')]]){
  const lexicalRoot=resolve(base),logical=value===prefix||value.startsWith(prefix+'/');
  let root:string;try{root=realpathSync(lexicalRoot);}catch(e:any){if(['ENOENT','ENOTDIR'].includes(e.code)){if(logical)throw new Problem(404,'当前项目目录不存在或磁盘未连接');continue;}throw e;}
  // macOS /var and /tmp are aliases of /private/var and /private/tmp.
  // Normalize the explicit workspace binding, then check child links against it.
  let target=logical?resolve(lexicalRoot,value.slice(prefix.length+1)):resolve(value);
  if(within(target,lexicalRoot))target=resolve(root,relative(lexicalRoot,target));
  if(!within(target,root))continue;
  // Check the nearest existing ancestor as well, including a missing write target.
  let current=target;while(true){try{requireThat(within(realpathSync(current),root),'路径通过符号链接超出当前项目',403);break;}catch(e:any){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;const parent=dirname(current);requireThat(parent!==current&&within(parent,root),'当前项目目录不存在',403);current=parent;}}
  return target;
 }
 throw new Problem(403,'聊天只能访问当前项目工作区及本聊天上传附件；项目资料请使用 team_project_files');
}

export class HostFiles {
 constructor(public store:Store,private scopeGuard?:(path:string)=>void,private locks=new Set<string>()){}
 scoped(guard:(path:string)=>void){return new HostFiles(this.store,guard,this.locks);}
 active(user:Doc){requireThat(this.store.get('user',user.id)?.active,'账号已停用',401);}
 async path(value:unknown){requireThat(typeof value==='string'&&value.startsWith('/')&&value.length<=4096&&!/[\x00-\x1f]/.test(value),'请填写主机绝对路径');try{const path=await realpath(resolve(value));this.scopeGuard?.(path);return path;}catch(e){return fail(e);}}
 async target(value:unknown){requireThat(typeof value==='string'&&value.startsWith('/')&&value.length<=4096&&!/[\x00-\x1f]/.test(value)&&!['.','..',''].includes(basename(value)),'目标路径无效');const target=join(await this.path(dirname(value)),basename(value));this.scopeGuard?.(target);return target;}
 async info(value:unknown){const p=await this.path(value);try{const s=await stat(p),mime=mimeFor(p);return {path:p,name:basename(p)||'主机磁盘',directory:s.isDirectory(),regular:s.isFile(),bytes:s.size,modified:s.mtime.toISOString(),etag:version(s),mime,kind:s.isDirectory()?'folder':mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':'document'};}catch(e){return fail(e);}}
 async list(user:Doc,q:Doc={}){
  this.active(user);const path=await this.path(q.path||homedir()),query=String(q.q??'').toLocaleLowerCase(),kind=q.kind??'all',offset=Number(q.offset??0);
  requireThat(Number.isSafeInteger(offset)&&offset>=0&&['all','image','video','document'].includes(kind),'浏览参数无效');
  try{const rows=(await readdir(path,{withFileTypes:true})).filter(x=>(q.hidden==='1'||!x.name.startsWith('.'))&&x.name.toLocaleLowerCase().includes(query)&&(x.isDirectory()||x.isSymbolicLink()||kind==='all'||(kind==='image'?mimeFor(x.name).startsWith('image/'):kind==='video'?mimeFor(x.name).startsWith('video/'):!/^image|^video/.test(mimeFor(x.name))))).sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
   const items=await Promise.all(rows.slice(offset,offset+200).map(async x=>{try{return {...await this.info(join(path,x.name)),name:x.name,link:x.isSymbolicLink()};}catch{return {path:join(path,x.name),name:x.name,directory:x.isDirectory(),unavailable:true};}}));
   this.active(user);const shortcuts=[{name:'个人文件夹',path:homedir()},{name:'主机磁盘',path:'/'},{name:'外接磁盘',path:'/Volumes'},...this.store.all('project').filter(p=>p.directory).map(p=>({name:p.name,path:p.directory}))];
   return {path,parent:path==='/'?null:dirname(path),items,total:rows.length,offset,nextOffset:offset+items.length<rows.length?offset+items.length:null,shortcuts:[...new Map(shortcuts.map(s=>[s.path,s])).values()]};
  }catch(e){return fail(e);}
 }
 async text(user:Doc,value:unknown){this.active(user);const info=await this.info(value);requireThat(info.regular,'请选择普通文件');const file=await open(info.path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const head=Buffer.alloc(Math.min(info.bytes,512*1024));await file.read(head,0,head.length,0);let content:string;try{requireThat(!head.includes(0),'此文件请下载后查看',415);content=new TextDecoder('utf-8',{fatal:true}).decode(head,{stream:info.bytes>head.length});}catch(e){if(e instanceof Problem)throw e;throw new Problem(415,'此格式请预览或下载原件');}this.active(user);return {...info,content,truncated:info.bytes>head.length,editable:info.bytes<=head.length};}finally{await file.close();}}
 async stream(user:Doc,value:unknown,req:IncomingMessage,res:ServerResponse,authorize:()=>boolean,download:boolean){this.active(user);const info=await this.info(value);requireThat(info.regular,'文件夹请打包下载',400);return serveFileDownload(info.path,req,res,{authorized:authorize,mime:info.mime,inline:!download&&/^(image|video|audio)\//.test(info.mime)});}
 async digest(path:string){const before=await stat(path),sha=createHash('sha256');for await(const chunk of createReadStream(path))sha.update(chunk);requireThat(version(before)===version(await stat(path)),'文件正被修改，请刷新后重试',409);return sha.digest('hex');}
 async bundle(user:Doc,paths:unknown,res:ServerResponse,authorize:()=>void,head=false){
  this.active(user);requireThat(Array.isArray(paths)&&paths.length>0&&paths.every(p=>typeof p==='string'),'请选择文件或文件夹');const files:BundleFile[]=[];
  const add=async(p:string,name:string,parents:Set<string>)=>{authorize();const info=await this.info(p);if(info.directory){requireThat(!parents.has(info.path),'文件夹包含循环链接，请单独选择需要的文件',409);const next=new Set([...parents,info.path]);for(const d of await readdir(info.path))await add(join(info.path,d),name+'/'+bundleName(d),next);}else{requireThat(info.regular,'所选目录包含设备或特殊文件，请单独选择普通文件',422);files.push({path:info.path,name,bytes:info.bytes,sha256:await this.digest(info.path)});}};
  for(const [i,p] of [...new Set(paths)].entries())await add(p,`${String(i+1).padStart(3,'0')}_${bundleName(basename(p))}`,new Set());
  authorize();await serveFileBundle(files,res,'主机文件.zip',{head,authorize});this.store.audit(user.id,'host.files.download','bundle',{files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0)});
 }
 async locked<T>(path:string,fn:()=>Promise<T>){requireThat(!this.locks.has(path),'文件正在保存，请稍后重试',409);this.locks.add(path);try{return await fn();}catch(e){return fail(e);}finally{this.locks.delete(path);}}
 async preserve(user:Doc,path:string,expected:unknown){
  const s=await stat(path);requireThat(s.isFile()&&typeof expected==='string'&&version(s)===expected,'文件已被修改，请重新读取后保存',409);
  const revision=id(),folder=join(this.store.root,'host-file-revisions',revision);await mkdir(folder,{recursive:true,mode:0o700});await copyFile(path,join(folder,'original'),constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);requireThat(version(await stat(path))===expected,'备份期间文件发生变化，未覆盖',409);
   const meta={id:revision,path,actor:user.id,etag:expected,bytes:s.size,sha256:await this.digest(join(folder,'original')),created:now()};await writeFile(join(folder,'metadata.json'),JSON.stringify(meta),{mode:0o600});this.store.put('host-file-revision',meta);return revision;
 }
 async install(user:Doc,source:string,target:string,expected:unknown){
  return this.locked(target,async()=>{this.active(user);let existing:any;try{existing=await lstat(target);}catch(e:any){if(e.code!=='ENOENT')throw e;}
   requireThat(!existing||existing.isFile()&&!existing.isSymbolicLink(),'目标不是普通文件',409);requireThat(existing?typeof expected==='string':expected===undefined||expected===null,'目标已变化，请刷新',409);
   const revision=existing?await this.preserve(user,target,expected):undefined,stage=join(dirname(target),'.wawu-save-'+id());
   try{diskSpace(dirname(target),(await stat(source)).size);await copyFile(source,stage,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);if(existing)await chmod(stage,existing.mode&0o777);this.active(user);
    if(existing){requireThat(await this.path(target)===target&&version(await stat(target))===expected,'文件已被修改，未覆盖',409);await rename(stage,target);}else{await link(stage,target);await unlink(stage);}
   }catch(e){await unlink(stage).catch(()=>{});throw e;}
   this.store.audit(user.id,'host.file.save',target,{revision,bytes:(await stat(target)).size});return {...await this.info(target),revision};
  });
 }
 async revisions(user:Doc,value:unknown):Promise<Doc[]>{this.active(user);const path=await this.target(value);return this.store.all('host-file-revision').filter(r=>r.path===path).sort((a,b)=>b.created.localeCompare(a.created)).map(r=>({...r,integrity:r.sha256?'recorded':'legacy_no_digest'}));}
 async restore(user:Doc,b:Doc){
  this.active(user);requireThat(typeof b.revision==='string'&&/^[a-f0-9-]{36}$/.test(b.revision),'版本编号无效');const revision=this.store.get('host-file-revision',b.revision);requireThat(revision,'文件版本不存在',404);
  const file=join(this.store.root,'host-file-revisions',revision.id,'original'),source=await realpath(file);requireThat(source===file,'版本原件路径无效',409);this.scopeGuard?.(revision.path);const st=await stat(file);requireThat(st.isFile()&&st.size===revision.bytes,'版本原件不完整',409);if(revision.sha256)requireThat(await this.digest(file)===revision.sha256,'版本原件哈希不符，未覆盖当前文件',409);
  const target=await this.target(b.path??revision.path),result=await this.install(user,file,target,b.etag);this.store.audit(user.id,'host.file.restore',target,{fromRevision:revision.id,preservedRevision:result.revision});return result;
 }
 async action(user:Doc,b:Doc){this.active(user);requireThat(['mkdir','rename','copy','write','restore'].includes(b.action),'成员不能删除主机文件',403);
  if(b.action==='restore')return this.restore(user,b);
  if(b.action==='mkdir'){const target=await this.target(b.path);return this.locked(target,async()=>{await mkdir(target,{mode:0o755});this.store.audit(user.id,'host.folder.create',target);return this.info(target);});}
  if(b.action==='write'){requireThat(typeof b.content==='string','文本内容无效');const target=await this.target(b.path),tempDir=join(this.store.root,'host-transfers');await mkdir(tempDir,{recursive:true,mode:0o700});const source=join(tempDir,id());await writeFile(source,b.content,{mode:0o600});try{return await this.install(user,source,target,b.etag);}finally{await unlink(source).catch(()=>{});}}
  const source=await this.path(b.path),target=await this.target(b.destination);requireThat(source!==target&&!within(target,source),'目标不能位于原文件夹内部',409);
  return this.locked(target,async()=>{let exists=false;try{await lstat(target);exists=true;}catch(e:any){if(e.code!=='ENOENT')throw e;}requireThat(!exists,'目标已存在，不能通过重命名或复制覆盖原件',409);
   if(b.action==='rename'){requireThat(b.etag===version(await stat(source)),'文件已变化，请刷新后重命名',409);await rename(source,target);}
   else{const copy=async(from:string,to:string,parents:Set<string>)=>{const p=await this.path(from),s=await stat(p);requireThat(!parents.has(p),'文件夹包含循环链接',409);if(s.isDirectory()){await mkdir(to,{mode:0o755});for(const child of await readdir(p))await copy(join(p,child),join(to,child),new Set([...parents,p]));}else{requireThat(s.isFile(),'仅复制普通文件和文件夹');await copyFile(p,to,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);}};await copy(source,target,new Set());}
   this.store.audit(user.id,'host.file.'+b.action,source,{destination:target});return this.info(target);
  });
 }
 async upload(user:Doc,b:Doc){this.active(user);requireThat(typeof b.requestId==='string'&&/^[a-f0-9-]{32,36}$/.test(b.requestId)&&Number.isSafeInteger(b.bytes)&&b.bytes>=0,'上传信息无效');const path=await this.target(b.path),key=hash(JSON.stringify([user.id,b.requestId])),old=this.store.get('host-upload',key);if(old){requireThat(old.path===path&&old.bytes===b.bytes,'上传编号已用于其他文件',409);return old;}
  diskSpace(this.store.root,b.bytes);const folder=join(this.store.root,'host-transfers');await mkdir(folder,{recursive:true,mode:0o700});await writeFile(join(folder,key),Buffer.alloc(0),{flag:'wx',mode:0o600});const u={id:key,owner:user.id,path,name:basename(path),bytes:b.bytes,etag:b.etag,received:0,state:'receiving',created:now()};this.store.put('host-upload',u);return u;
 }
 owned(user:Doc,key:string){this.active(user);const u=this.store.get('host-upload',key);requireThat(u&&u.owner===user.id,'上传记录不存在',404);return u;}
 async chunk(user:Doc,key:string,b:Doc){const u=this.owned(user,key);requireThat(u.state==='receiving','上传状态已变化',409);const received=receiveChunk(join(this.store.root,'host-transfers',key),u.bytes,b,this.store.root);const next={...u,received};this.store.put('host-upload',next);return next;}
 async finish(user:Doc,key:string){const u=this.owned(user,key);if(u.state==='completed')return u;return this.locked('upload:'+key,async()=>{const source=join(this.store.root,'host-transfers',key);requireThat((await stat(source)).size===u.bytes,'文件未上传完整',409);const result=await this.install(user,source,u.path,u.etag);const next={...u,state:'completed',received:u.bytes,result};this.store.put('host-upload',next);await unlink(source);return next;});}
}

const services=new WeakMap<Store,HostFiles>();
export function hostFiles(store:Store){const root=store.global;let service=services.get(root);if(!service){service=new HostFiles(root);services.set(root,service);}return service;}
