import {verifiedDocumentOriginal} from './document-text.ts';
import {projectHistory,pageHistory} from '../native-harness/history-view.mjs';
import {privateSkillRedactor} from './private-skill-content.ts';
import {generationLinks,nativeSessionFor} from './generation-links.ts';
import {deriveEventMessage} from '@deepseek-ai/dsh-session';
import {NATIVE_IMAGE} from './native-version.ts';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync,mkdirSync,realpathSync,lstatSync,createReadStream,openSync,readSync,closeSync,statSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {Store,hash,requireThat,type Doc} from './store.ts';
import {fileByteRange} from './native-download.ts';
const DOCKER=['/opt/homebrew/bin/docker','/usr/local/bin/docker'].find(existsSync)??'docker';
/** Reads native logs without creating a member runtime, taking write ownership or loading an agent. */
export class NativeHistory {
 private navigationCache=new Map<string,{at:number;value:Promise<any>;last?:any}>();
 private submissionCache=new Map<string,{at:number;value:Promise<any>}>();
 private galleryCache=new Map<string,{at:number;value:Promise<any>}>();
 private closing=false;private child?:ChildProcessWithoutNullStreams;private serial=0;private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();private inflight=new Map<string,Promise<any>>();private audited=new Map<string,number>();
 constructor(public store:Store,public codeRoot:string){}
 // Sidebar summaries only. Reading projects never starts their agent runtimes.
 async navigation(user:Doc){
  const verify=()=>{const u=this.store.get('user',user.id);requireThat(u?.active&&u.role===user.role,'登录身份已变更',403);};verify();
  const owners=this.store.all('user').filter(u=>u.active&&(user.role==='admin'||u.id===user.id)),projects=[];
  for(const project of this.store.all('project')){
   const members=[];
   for(const owner of owners){
    const key=hash(JSON.stringify([owner.id,project.id])).slice(0,24);let items:Doc[]=[],error;
    if(existsSync(join(this.store.root,'native-harness',key,'state/sessions'))){
     let cached=this.navigationCache.get(key);
     if(!cached||Date.now()-cached.at>5000){cached={at:Date.now(),value:this.read(key),last:cached?.last};this.navigationCache.set(key,cached);if(this.navigationCache.size>1000)this.navigationCache.delete(this.navigationCache.keys().next().value!);}
     try{const data=await cached.value;items=[...(data.items??[])];error=data.error;if(!error)cached.last=data;else if(cached.last)items=[...cached.last.items];}catch{items=[...(cached.last?.items??[])];cached.at=0;error='聊天暂未读取，请重试';}
    }
    verify();
    for(const legacy of this.legacy(owner.id,project.id))if(!items.some(s=>s.id===legacy.id)){const {rows,...meta}=legacy;items.push({...meta,messageCount:rows.filter((r:Doc)=>r.role).length});}
    if(!items.some(s=>s.messageCount>0))continue;
    members.push({id:owner.id,name:owner.name||owner.username,active:owner.active,self:owner.id===user.id,error,sessions:items.sort((a,b)=>(b.updated??0)-(a.updated??0))});
   }
   projects.push({id:project.id,name:project.name,members});
  }
  verify();
  // Account status can change while another member's history is being read.
  for(const project of projects)project.members=project.members.filter(m=>this.store.get('user',m.id)?.active);
  return {projects};
 }
 private start(){if(this.child)return this.child;const root=join(this.store.root,'native-harness');mkdirSync(root,{recursive:true,mode:0o700});
  const child=spawn(DOCKER,['run','--rm','-i','--network','none','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--memory','512m','--cpus','1','--pids-limit','64','--user',`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,'--mount',`type=bind,src=${root},dst=/history,readonly`,'--mount',`type=bind,src=${join(this.codeRoot,'native-harness')},dst=/reader,readonly`,'--entrypoint','node',NATIVE_IMAGE,'/reader/history-reader.mjs'],{stdio:['pipe','pipe','pipe']});this.child=child;
  const fail=()=>{if(this.child!==child)return;this.child=undefined;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('原生历史读取服务暂不可用，请重试'));}this.pending.clear();};child.on('error',fail);child.on('exit',fail);child.stderr.resume();child.stdin.on('error',fail);
  createInterface({input:child.stdout}).on('line',line=>{try{const v=JSON.parse(line),p=this.pending.get(v.id);if(!p)return;this.pending.delete(v.id);clearTimeout(p.timer);v.error?p.reject(Error('原生聊天记录无法读取，请检查运行与审计')):p.resolve(v.data);}catch{fail();child.kill();}});return child;
 }
 async read(key:string,session?:string,window?:{before?:number;after?:number;limit:number},purpose?:'submissions'|'evidence'|'gallery'|'attachments'){requireThat(!this.closing,'历史读取服务正在关闭',503);const cacheKey=key+':'+(session??'')+JSON.stringify(window??{})+':'+(purpose??'');if(this.inflight.has(cacheKey))return this.inflight.get(cacheKey)!;
  requireThat(this.pending.size<128,'历史读取繁忙，请稍后重试',503);const child=this.start(),id=++this.serial;const promise=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('聊天历史读取超时，请重试'));},30000);this.pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,key,session,window,purpose})+'\n');}).finally(()=>this.inflight.delete(cacheKey));this.inflight.set(cacheKey,promise);return promise;
 }
 async gallery(key:string){let saved=this.galleryCache.get(key);if(!saved||Date.now()-saved.at>5000){saved={at:Date.now(),value:this.read(key,undefined,undefined,'gallery')};this.galleryCache.set(key,saved);if(this.galleryCache.size>128)this.galleryCache.delete(this.galleryCache.keys().next().value!);}try{return await saved.value;}catch(e){this.galleryCache.delete(key);throw e;}}
 galleryOwner(user:Doc,project:string,member:string){requireThat(this.store.get('user',user.id)?.active&&this.store.get('user',user.id)?.role===user.role,'登录身份已变更',403);requireThat(project==='shared'||this.store.get('project',project),'项目不存在',404);requireThat(member===user.id||user.role==='admin','无权查看此成员附件',403);requireThat(this.store.get('user',member),'成员不存在',404);return hash(JSON.stringify([member,project])).slice(0,24);}
 async galleryAttachment(user:Doc,params:URLSearchParams,req:IncomingMessage,res:ServerResponse){const project=params.get('project')??'shared',member=params.get('owner')??user.id,session=params.get('session')??'',attachmentId=params.get('attachmentId'),name=params.get('name')??'',key=this.galleryOwner(user,project,member);requireThat(/^session-[a-zA-Z0-9-]{1,160}$/.test(session),'聊天编号无效');const data=await this.read(key,session);this.galleryOwner(user,project,member);const block=data.rows?.flatMap((r:Doc)=>r.content??[]).find((b:Doc)=>['image','file'].includes(b.type)&&b.attachment?.attachmentId===attachmentId&&(b.attachment?.name??'')===name);return this.serveAttachment(key,block,req,res);}
 authorize(user:Doc,project:string,member?:string){requireThat(this.store.get('user',user.id)?.active&&this.store.get('user',user.id)?.role==='admin','仅管理员可查看成员聊天',403);requireThat(project==='shared'||this.store.get('project',project),'项目不存在',404);if(member){const owner=this.store.get('user',member);requireThat(owner,'成员不存在',404);return {owner,key:hash(JSON.stringify([member,project])).slice(0,24)};}}
 legacy(member:string,project:string){const redactor=privateSkillRedactor(this.codeRoot,this.store.root);return this.store.all('session',member).filter(s=>(s.project??'shared')===project&&!s.nativeSession).flatMap(s=>{const saved=this.store.get('harness',s.id);if(!saved?.events?.length)return [];const events=redactor.redact(saved.events).value,v=projectHistory({...saved.header,id:'session-team-'+s.id},events,0,hash(JSON.stringify(events)),deriveEventMessage);return [{...v,title:v.title==='未命名聊天'?s.title||v.title:v.title,archived:!!s.archived}];});}
 async list(user:Doc,project:string){this.authorize(user,project);const members=[];for(const u of this.store.all('user').filter(u=>u.id!==user.id)){const key=hash(JSON.stringify([u.id,project])).slice(0,24);let data;try{data=await this.read(key);}catch{data={items:[],error:'历史读取失败，请重试'};}this.authorize(user,project);for(const legacy of this.legacy(u.id,project)){if(!data.items.some((s:Doc)=>s.id===legacy.id)){const {rows,...meta}=legacy;data.items.push({...meta,messageCount:rows.filter((r:Doc)=>r.role).length});}}members.push({id:u.id,name:u.name||u.username,active:u.active,role:u.role,error:data.error,sessions:data.items.sort((a:Doc,b:Doc)=>(b.updated??0)-(a.updated??0))});}return {project,members};}
 async snapshot(user:Doc,project:string,member:string,session:string,window?:{before?:number;after?:number;limit:number}){const {key}=this.authorize(user,project,member)!;requireThat(/^session-[a-zA-Z0-9-]{1,160}$/.test(session),'聊天编号无效',400);let data=await this.read(key,session,window);if(data.missing)data=this.legacy(member,project).find(s=>s.id===session)??data;this.authorize(user,project,member);requireThat(!data.missing,'当前成员在此项目下没有这个聊天',404);return {key,data:privateSkillRedactor(this.codeRoot,this.store.root).redact(data).value};}
 async page(user:Doc,project:string,member:string,session:string,params:URLSearchParams){const number=(key:string)=>{const v=params.get(key);if(v===null)return;requireThat(/^\d+$/.test(v)&&Number.isSafeInteger(Number(v)),'分页位置无效',400);return Number(v);};const window={before:number('before'),after:number('after'),limit:Math.min(100,Math.max(1,number('limit')??50))};requireThat(window.before===undefined||window.after===undefined,'分页方向无效');const {data}=await this.snapshot(user,project,member,session,window);const page=data.paged?data:pageHistory(data,window);
 const k=[user.id,project,member,session].join(':');if(Date.now()-(this.audited.get(k)??0)>300000){this.audited.set(k,Date.now());if(this.audited.size>1000)this.audited.delete(this.audited.keys().next().value!);this.store.audit(user.id,'admin.native_chat.read',session,{project,member});}
 return {...page,member,project,rows:page.rows.map((r:Doc)=>publicRow(r)),results:this.results(project,member,session)};
 }

 results(project:string,member:string,session:string){const links=generationLinks(this.store);const plans=new Set(links.plans.filter(p=>p.owner===member&&(p.project??'shared')===project&&nativeSessionFor(this.store,p)===session).map(p=>p.id));
  for(const a of links.audits)if(a.owner===member&&a.project===project&&a.session===session)plans.add(a.planId);
  const jobs=links.jobs.filter(j=>j.owner===member&&(j.project??'shared')===project&&plans.has(j.plan??j.planId??j.pickup));
  return jobs.filter(j=>j.mediaId).map(j=>{const m=this.store.get('media',j.mediaId);return {id:j.id,planId:j.planId,mediaId:j.mediaId,mime:m?.mime,name:m?.name,state:j.state,round:j.round};});
 }
 async submissions(user:Doc){
  const verify=()=>{const current=this.store.get('user',user.id);requireThat(current?.active&&current.role===user.role,'登录身份已变更',403);};verify();
  const users=this.store.all('user').filter(u=>user.role==='admin'||u.id===user.id),items:Doc[]=[],warnings:string[]=[];
  for(const owner of users)for(const project of this.store.all('project')){
   const key=hash(JSON.stringify([owner.id,project.id])).slice(0,24);
   if(!existsSync(join(this.store.root,'native-harness',key,'state/sessions')))continue;
   let cached=this.submissionCache.get(key);
   if(!cached||Date.now()-cached.at>2500){cached={at:Date.now(),value:this.read(key,undefined,undefined,'submissions')};this.submissionCache.set(key,cached);if(this.submissionCache.size>128)this.submissionCache.delete(this.submissionCache.keys().next().value!);}
   try{const data=await cached.value;verify();for(const t of data.items)items.push({...t,messageId:t.id,owner:owner.id,project:project.id});if(data.errors?.length)warnings.push((owner.name??'成员')+' 的部分聊天暂未计入，请稍后刷新。');}
   catch(error){verify();this.submissionCache.delete(key);warnings.push((owner.name??'成员')+' 的聊天统计暂不可读取，已保留现有记录。');}
  }
  verify();return {items,warnings};
 }
 async attachment(user:Doc,project:string,member:string,session:string,seq:number,index:number,req:IncomingMessage,res:ServerResponse){const {key,data}=await this.snapshot(user,project,member,session,{before:seq+1,after:seq-1,limit:1});const row=data.rows.find((r:Doc)=>r.seq===seq),block=row?.content?.[index];this.authorize(user,project,member);return this.serveAttachment(key,block,req,res);}
 attachmentOriginal(key:string,block:Doc|undefined){const ref=block?.attachment;requireThat(['image','file'].includes(block?.type)&&ref&&(!ref.name||typeof ref.name==='string'&&!/[\\/]/.test(ref.name)&&ref.name!=='.'&&ref.name!=='..')&&/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId),'附件不存在',404);const digest=ref.attachmentId.slice(7),root=join(this.store.root,'native-harness',key,'state/attachments/v1'),candidate=block.type==='image'?join(root,'objects',digest.slice(0,2),digest):join(root,'files',digest.slice(0,2),digest,ref.name);
  requireThat(existsSync(candidate)&&realpathSync(candidate).startsWith(resolve(root)+sep)&&!lstatSync(candidate).isSymbolicLink()&&statSync(candidate).isFile(),'附件原件不存在',404);return {path:candidate,bytes:statSync(candidate).size,sha256:digest,name:ref.name};
 }
 private serveAttachment(key:string,block:Doc|undefined,req:IncomingMessage,res:ServerResponse){const original=this.attachmentOriginal(key,block),candidate=original.path,ref=block!.attachment;const size=verifiedDocumentOriginal(candidate,original.sha256).size,head=Buffer.alloc(16),fd=openSync(candidate,'r');try{readSync(fd,head,0,16,0);}finally{closeSync(fd);}const mime=head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':head[0]===255&&head[1]===216?'image/jpeg':head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='WEBP'?'image/webp':head.toString('ascii',4,8)==='ftyp'?'video/mp4':'application/octet-stream';const etag='"sha256-'+original.sha256+'"',{start,end,partial}=fileByteRange(req,res,size,{etag});
  res.writeHead(partial?206:200,{'X-Content-SHA256':original.sha256,'ETag':etag,'Content-Type':mime,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':`${mime==='application/octet-stream'||new URL(req.url??'/','http://local').searchParams.has('download')?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(ref.name??'附件')}`,...(partial?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});if(req.method==='HEAD'||size===0)return res.end();const stream=createReadStream(candidate,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
 }
 async close(permanent=false){if(permanent)this.closing=true;const child=this.child;if(!child)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},3000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.stdin.end();});}
}
// Only native display messages are exposed; provider requests, system prompts and credentials stay host-side.
export function publicRow(row:Doc){if(row.content)return {seq:row.seq,time:row.time,role:row.role,kind:row.kind,sourceKind:row.source?.kind,content:row.content};return {seq:row.seq,time:row.time,kind:row.kind,data:row.kind==='turn/end'?{reason:row.data?.reason}:row.data};}
