import {projectSharedMedia} from './media.ts';
import {HostCodex} from './codex-host.ts';
import {PrivateSkills} from './private-skills.ts';
import {PrivateScreenwriterSkills} from './private-screenwriter.ts';
import {serveMediaPreview} from './media-preview.ts';
import {resubmissionStatus} from './generation-resubmission.ts';
import {hostFiles,conversationFilePath} from './host-files.ts';
import {createReadStream,lstatSync,realpathSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {join,resolve,basename,relative} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {hash,now,requireThat,type Doc} from './store.ts';
import {publicResponse} from './billing.ts';
import {serveMediaBundle} from './media-bundle.ts';
import {planPage} from './plan-history.ts';
import {fileHash,objectPath} from './file-objects.ts';
import {serveFileDownload} from './native-download.ts';
import {prepareConversation} from './conversation-pickup.ts';
import {ProjectChatFiles} from './project-chat.ts';
import {videoFamily,STORYBOARD_SKILL} from './video-storyboard.ts';
import type {NativeHarness,Instance} from './native-harness.ts';

const stable=(value:any):any=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;

/** Authenticated project tools execute member requests through the durable host queue. */
export class NativeTeam {
 codex?:HostCodex;
 skills?:PrivateSkills;
 screenwriter?:PrivateScreenwriterSkills;
 skillService(){return this.skills??=new PrivateSkills(this.native);}
 screenwriterService(){return this.screenwriter??=new PrivateScreenwriterSkills(this.native);}
 codexService(){return this.codex??=new HostCodex(this.native);}
 issueReporter?: (user:Doc,project:string,body:Doc)=>Doc;
 constructor(public native:NativeHarness){}
 safe(value:unknown){return JSON.parse(JSON.stringify(value,publicResponse));}
 session(i:Instance,nativeSession:string){
  requireThat(typeof nativeSession==='string'&&nativeSession.length>0&&nativeSession.length<200,'原生会话编号无效');
  const {store}=this.native.workspace(i.project),session=hash(JSON.stringify([i.key,nativeSession]));
  if(!store.get('session',session))store.put('session',{id:session,owner:i.owner,project:i.project,nativeSession,title:'项目聊天',permission:'workspace-write',created:now()});
  return session;
 }
 plan(i:Instance,kind:string,planId:string){const {store,pickups,images}=this.native.workspace(i.project),user=store.get('user',i.owner)!;
  const p=kind==='video'?pickups.get(planId,user):images.get(planId,user);requireThat(p.owner===i.owner,'方案不属于当前成员',404);return p;
 }
 card(i:Instance,kind:string,p:Doc){return this.safe({kind,plan:p,resubmission:resubmissionStatus(p),sessionId:p.nativeSession??this.native.workspace(i.project).store.get('session',p.session)?.nativeSession});}
 async tool(i:Instance,user:Doc,b:Doc,signal?:AbortSignal,identity?:Doc):Promise<Doc>{
  const {store,projects,pickups,images}=this.native.workspace(i.project),session=this.session(i,b.sessionId);let args={...b.args};
  if(['video_prepare','video_generate'].includes(b.action)&&args.model&&!args.model_id){
   const matches=pickups.catalog.models(user).filter(m=>m.id===args.model||m.name===args.model||(m.aliases??[]).includes(args.model));
   requireThat(matches.length===1,'模型名称不唯一或未开放，请使用目录中的 model_id',422);args.model_id=matches[0].id;delete args.model;
  }
  requireThat(user.id===i.owner&&user.active,'账号不可用',403);
  if(['video_assemble','video_assembly_status','video_assembly_resume','video_assembly_cancel'].includes(b.action)){
   const service=this.native.workspace(i.project).assembly;requireThat(service,'本机拼接功能尚未更新',503);
   if(b.action==='video_assemble'){const source=b.sourceMessageId??b.callId;requireThat(typeof source==='string'&&source.length>0,'缺少本次成员提交编号');return {kind:'assembly',job:service.submit(user,b.sessionId,args,source+':'+String(args.assembly_key??'default'))};}
   if(!args.job_id)return {kind:'assemblies',items:service.list(user,b.sessionId)};
   const job=service.get(user,args.job_id);requireThat(job.owner===i.owner,'拼接记录不属于当前成员',404);
   return {kind:'assembly',job:b.action==='video_assembly_resume'?service.resume(user,args.job_id):b.action==='video_assembly_cancel'?service.cancel(user,args.job_id):job};
  }
  if(b.action==='private_skill_execute'){
   const requested=String(args.skill_id??'');
   if(requested==='screenwriter'||(!requested&&this.native.catalog.skills.policy(i.project).defaultSkillId==='screenwriter'))return this.screenwriterService().execute(i,user,b,signal);
   return this.skillService().execute(i,user,b,signal);
  }
  if(b.action==='project_links'){
   const links=this.native.workspace(i.project).links;requireThat(links,'项目关联编辑尚未更新',503);if(args.operation==='read')return links.read(user,args);
   const source=b.sourceMessageId??b.callId;requireThat(typeof source==='string'&&source.length>0,'关联修改缺少当前聊天请求编号');const {request_key,...change}=args,result=await links.update(user,change,hash(JSON.stringify([i.key,b.sessionId,source,request_key??args.shot_id??args.shot?.id??args.assignment_id??args.assignment?.id??args.assignment?.reference?.entityId??args.assignment?.reference?.path??args.assignment?.reference?.mediaId??args.assignment?.reference?.attachmentKey])));
   if(i.root&&existsSync(join(i.root,'base.json')))try{const sync=await this.native.frozen(i,()=>this.native.sync(i,user));return {...result,workspaceConflicts:sync.conflicts};}catch{return {...result,workspaceSyncPending:true,note:result.note+' 当前工作区同步未完成，核对改动后可沿用原生同步工具；不要重复新建关联修改。'};}return result;
  }
  if(b.action==='project_files'){
   const base=args.revision??projects.current().revision;if(args.revision!==undefined)projects.revision(base);
   const task={id:hash(JSON.stringify([i.key,b.sessionId,b.callId??'project-context'])),owner:user.id,project:i.project,session,base};
   const files=new ProjectChatFiles(store,projects,task);
   if(args.attachment_ids){const content=this.native.workspace(i.project).content;requireThat(content,'附件检索尚未就绪',503);if(args.operation==='read')return content.readAttachments(user,args);if(args.operation==='attach'){const result=await content.attachOriginals(user,args);return {...result,files:result.files.map(f=>({...f,download:'/api/team/native-attachment/'+f.nativeAttachmentKey+'?download=1',preview:'/api/team/native-attachment/'+f.nativeAttachmentKey}))};}requireThat(false,'附件编号仅用于读取或返回原件');}
   if(args.operation==='search'){const content=this.native.workspace(i.project).content;requireThat(content,'项目正文检索尚未就绪',503);return content.search(user,args);}
   if(args.operation==='list')return {...JSON.parse(files.list(args)),name:projects.current().name};
   if(args.operation==='read')return {project:i.project,revision:task.base,content:await files.read(args)};
   if(args.operation==='attach'){const value=JSON.parse(files.attach(args));return {...value,files:value.files.map((f:Doc)=>({...f,download:'/api/team/project-file?'+new URLSearchParams({path:f.path,revision:f.revision,download:'1'}),preview:'/api/team/project-file?'+new URLSearchParams({path:f.path,revision:f.revision})}))};}
   requireThat(false,'项目资料操作无效',400);
  }
  if(b.action==='codex_run')return this.codexService().start(i,b);
  if(b.action==='codex_status')return args.run_id?this.codexService().card(i,args.run_id):this.codexService().list(i,b.sessionId);
  if(b.action==='codex_cancel')return this.codexService().cancel(i,args.run_id);
  if(b.action==='host_files'){
   const files=hostFiles(this.native.store).scoped(path=>{conversationFilePath(path,i);});
   args.path=conversationFilePath(args.path??'/workspace',i);
   if(args.destination)args.destination=conversationFilePath(args.destination,i);
   const virtual=(path:string)=>path===i.work||path.startsWith(i.work+'/')?'/workspace'+path.slice(i.work.length):'/state/attachments/v1'+path.slice(join(i.root,'state/attachments/v1').length);
   if(args.operation==='list'){const result=await files.list(user,args);return {...result,path:virtual(result.path),parent:result.path===i.work||result.path===join(i.root,'state/attachments/v1')?null:result.parent?virtual(result.parent):null,shortcuts:[{name:'当前项目工作区',path:'/workspace'}],items:result.items.filter((v:Doc)=>{try{conversationFilePath(v.path,i);return true;}catch{return false;}}).map((v:Doc)=>({...v,path:virtual(v.path)}))};}
   if(args.operation==='read')return files.text(user,args.path);
   if(args.operation==='download'){const info=await files.info(args.path),url='/api/team/workspace-'+(info.directory?'bundle':'download')+'?path='+encodeURIComponent(virtual(info.path));return {...info,path:virtual(info.path),download:url,note:'返回当前项目或本聊天附件的原件下载链接。'};}
   if(args.operation==='history')return {items:await files.revisions(user,args.path)};
   if(args.operation==='restore'){const original=this.native.store.get('host-file-revision',args.revision);requireThat(original,'文件版本不存在',404);conversationFilePath(original.path,i);}
   return files.action(user,{...args,action:args.operation});
  }
  if(b.action==='issue_report'){requireThat(this.issueReporter,'报障入口尚未配置',503);requireThat(typeof args.description==='string','请说明具体问题');const report=this.issueReporter(user,i.project,{requestId:hash(JSON.stringify([i.key,b.sessionId,b.sourceMessageId??b.callId,args.description])),session:b.sessionId,description:args.description,client:{source:'native-agent',sourceMessageId:b.sourceMessageId}});return {kind:'incident',report};}
  const generate=['video_generate','image_generate','resubmit'].includes(b.action);
  if(generate)requireThat(typeof b.sourceMessageId==='string'&&b.sourceMessageId.length>0&&typeof b.sourceText==='string'&&b.sourceText.length>0,'生成操作缺少当前成员消息',422);
  const legacyId=hash(JSON.stringify([i.key,b.sessionId,generate?[b.action,b.sourceMessageId,b.args??{}]:b.callId]));
  const requestId=generate&&(store.get('pickup',legacyId)||store.get('image-plan',legacyId))?legacyId:hash(JSON.stringify([i.key,b.sessionId,generate?[b.action,b.sourceMessageId,stable(identity??args)]:identity?.private_skill_node!==undefined?[b.callId,identity.private_skill_node]:b.callId]));
  // One host-side Skill invocation inside the existing agent tool, not a new
  // member workflow. Existing plans and uncertain submissions are never rebuilt.
  if(i.privateSkillCalls&&['video_generate','video_prepare'].includes(b.action)&&!args.plan_id&&videoFamily(pickups.catalog.models(user).find(m=>m.id===args.model_id)??{})&&!store.get('pickup',requestId)){
   if(!args.skill_run_id){
    // Pre-binding releases stored multi-node plans under node-specific IDs.
    // Recover their original compiler receipt without rewriting those plans.
    const firstNodeId=hash(JSON.stringify([i.key,b.sessionId,generate?[b.action,b.sourceMessageId,stable({...args,private_skill_node:0})]:[b.callId,0]])),legacyFirst=store.get('pickup',firstNodeId);
    const result=legacyFirst?.skillExecution?.id?this.skillService().public(i,legacyFirst.skillExecution.id):await this.skillService().execute(i,user,{...b,args:{...args,skill_id:STORYBOARD_SKILL}},signal,requestId);
    if(result.state!=='completed'||result.needsInput)return result;
    const items=[];for(const [index,node] of result.nodes.entries()){signal?.throwIfAborted();items.push(await this.tool(i,user,{...b,args:{...args,final_prompt:node.prompt,params:node.params,reference_media_ids:node.referenceMediaIds,reference_video_ids:node.referenceVideoIds,reference_audio_ids:node.referenceAudioIds,...(node.referenceMode?{reference_mode:node.referenceMode}:{}),skill_run_id:result.id,skill_node:index}},signal,result.nodes.length===1?args:{...args,private_skill_node:index}));}
    return items.length===1?items[0]:{kind:'plans',items};
   }
   this.skillService().verifyNode(i,b.sessionId,args);
  }
  const task={id:requestId,owner:i.owner,project:i.project,session,nativeSession:b.sessionId,base:projects.current().revision,prompt:JSON.stringify(args),sourceText:b.sourceText};
  if(b.action==='resubmit'){
   requireThat(['video','image'].includes(args.kind)&&typeof args.plan_id==='string','请选择要再次提交的图片或视频任务',422);
   const kind=args.kind,previous=this.plan(i,kind,args.plan_id),docKind=kind==='video'?'pickup':'image-plan',engine=kind==='video'?pickups:images;
   let repeated=store.get(docKind,requestId);
   // Replaying the same member message returns its recorded submission even if
   // the original has completed since then. A new request gets a new plan ID.
   if(!repeated){
    const eligibility=resubmissionStatus(previous);requireThat(eligibility.eligible,eligibility.reason,409);
    if(kind==='video')pickups.validatePlan(previous,user);else images.validate(previous,user);
    const {jobs,quotas,confirmedAt,digest,...frozen}=previous;
    const draft={...frozen,...(kind==='image'&&previous.imageSelection?{imageSelection:{requestedModel:previous.model.id,params:previous.params}}:{}),id:requestId,task:requestId,session,nativeSession:b.sessionId,created:now(),state:'awaiting_confirmation',previousPlanId:previous.id,resubmissionOf:previous.id,requestedByMessage:b.sourceMessageId};
    repeated={...draft,digest:hash(JSON.stringify(draft))};store.put(docKind,repeated);
   }
   const result=engine.confirm(repeated.id,user,{digest:repeated.digest});
   store.audit(user.id,'native.'+kind+'.resubmit',repeated.id,{previousPlanId:previous.id,sourceMessageId:b.sourceMessageId,sourceText:b.sourceText,session:b.sessionId});
   return this.card(i,kind,result);
  }
  let imageModelError:string|undefined;
  if(b.action==='catalog')try{await images.refreshModels(user);}catch(error){imageModelError=error instanceof Error?error.message:'图片目录暂时不可用';}
  if(b.action==='catalog')return this.safe({project:projects.current().name,permission:'workspace-write',skills:this.native.catalog.skills.public(user,i.project),defaultSkillId:this.native.catalog.skills.policy(i.project).defaultSkillId,videoModels:pickups.catalog.models(user).filter(m=>m.status==='published'||m.status==='testing'&&(user.role==='admin'||m.memberAccess)).map(m=>({id:m.id,name:m.name,family:videoFamily(m),storyboardSkill:videoFamily(m)?STORYBOARD_SKILL:undefined,aliases:m.aliases??[],durations:m.durations,params:m.params,defaults:m.defaults,minReferences:m.minReferences??0,maxReferences:m.maxReferences,referenceMode:m.referenceMode,modes:m.modes,maxVideoReferences:m.maxVideoReferences,maxAudioReferences:m.maxAudioReferences,minVideoReferences:m.minVideoReferences,requiresReference:m.requiresReference,durationPolicy:m.durationPolicy,parameterPolicy:m.parameterPolicy,contractConfidence:m.contractConfidence})),imageModelStatus:imageModelError??'ready',imageModels:(imageModelError?[]:images.models(user)).map(m=>({id:m.id,name:m.name,params:m.params,defaults:m.defaults,maxReferences:m.maxReferences})),referenceMedia:store.all('media').filter(m=>(projectSharedMedia(store,m)||m.owner===user.id)&&/^(video|audio)\//.test(m.mime)).map(m=>({id:m.id,name:m.name,mime:m.mime})),originals:images.references(user).map(m=>({id:m.id,name:m.name,mime:m.mime})),help:'成员要求生成时调用 team_video_generate / team_image_generate 自动提交；编剧任务调用 team_skill_execute 的 screenwriter；视频分镜仍使用 video-storyboard。技能只能调用，正文保留在主机；仅要求讨论或准备时不创建生成任务。'});
  if(['video_prepare','video_generate'].includes(b.action)){
   let p:Doc;
   if(args.plan_id)p=this.plan(i,'video',String(args.plan_id));
   else p=prepareConversation(pickups,task,args);
   if(generate){const result=pickups.confirm(p.id,user,{digest:p.digest});store.audit(user.id,'native.video.generate',p.id,{sourceMessageId:b.sourceMessageId,sourceText:b.sourceText,session:b.sessionId});return this.card(i,'video',result);}
   return this.card(i,'video',pickups.get(p.id,user));
  }
  if(['image_prepare','image_generate'].includes(b.action)){
   requireThat(typeof args.prompt==='string'&&(args.model===undefined||typeof args.model==='string'),'图片描述必填，模型名称须为文本');
   if(args.previous_plan_id){const previous=this.plan(i,'image',String(args.previous_plan_id));args={...args,reference_media_ids:args.reference_media_ids??previous.jobs.filter((j:Doc)=>j.mediaId).slice(-1).map((j:Doc)=>j.mediaId)};}
   const p=await images.prepareNative(task,args);if(generate&&p.state==='awaiting_confirmation')images.confirm(p.id,user,{digest:p.digest});if(generate)store.audit(user.id,'native.image.generate',p.id,{sourceMessageId:b.sourceMessageId,sourceText:b.sourceText,session:b.sessionId});return this.card(i,'image',images.get(p.id,user));
  }
  if(b.action==='status'){
   if(args.plan_id)return this.card(i,args.kind??'video',this.plan(i,args.kind??'video',args.plan_id));
   return planPage([...store.all('pickup',i.owner).map(p=>this.card(i,'video',pickups.get(p.id,user))),...store.all('image-plan',i.owner).map(p=>this.card(i,'image',images.get(p.id,user)))].filter(c=>args.scope==='project'||c.sessionId===b.sessionId),args);
  }
  if(b.action==='reference_open'){
   requireThat(Array.isArray(args.media_ids)&&args.media_ids.length>0&&args.media_ids.length<=12,'请选择 1–12 张参考原图',422);
   // Pause this member's native processes while resolving/copying workspace paths.
   return this.native.frozen(i,()=>{const files=[];
   for(const mediaId of args.media_ids){const m=pickups.media.get(mediaId);requireThat((m.scope==='project'||m.owner===user.id)&&m.mime.startsWith('image/'),'参考图不属于当前项目或本人',403);
    const ext=({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif'} as Record<string,string>)[m.mime];requireThat(ext,'当前原生看图工具不支持此图片格式',422);
    const path='参考原图/'+hash(m.id)+ext;requireThat(this.native.safePath(i,path),'参考图目录不安全',409);mkdirSync(join(i.work,'参考原图'),{recursive:true});copyFileSync(pickups.media.path(m.id),join(i.work,path));
    requireThat(fileHash(join(i.work,path))===m.sha256,'参考原图发生改变，请重新读取',409);files.push({mediaId:m.id,name:m.name,sha256:m.sha256,path:'/workspace/'+path});
   }return {files,next:'使用原生 read_image 查看实际图片；这些文件是原图副本，生成时仍传原 media ID。'};});
  }
  if(b.action==='reference_import'){
   requireThat(Array.isArray(args.paths)&&args.paths.length>0&&args.paths.length<=12,'请选择 1–12 张原图');
   const originals=[];
   for(const path of args.paths){
    const host=await hostFiles(this.native.store).path(conversationFilePath(path,i));requireThat(lstatSync(host).isFile(),'参考图必须是普通文件',422);
    requireThat(lstatSync(host).size<=1024*1024*1024,'参考媒体超过 1 GiB');
    const {fileHash}=await import('./file-objects.ts');const digest=fileHash(host);
    let m=store.all('media').filter(m=>m.scope==='project'||m.owner===user.id).find(m=>m.sha256===digest);
    if(!m){m=await pickups.media.ingest(createReadStream(host),i.owner,'private',basename(path));requireThat(/^(image|video|audio)\//.test(m.mime),'参考文件不是支持的图片、视频或音频',422);requireThat(m.sha256===digest,'原图在导入期间改变，请重试',409);m={...m,provenance:'member_original',nativeWorkspace:i.key};store.put('media',m);}
    originals.push({id:m.id,name:m.name,mime:m.mime,sha256:m.sha256});
   }return {originals};
  }
  if(b.action==='workspace'){
   requireThat(['sync','changes','submit','publish'].includes(args.operation),'工作区操作无效');
   return this.native.frozen(i,()=>args.operation==='sync'?this.native.sync(i,user):args.operation==='changes'?this.native.changes(i):(()=>{const candidate=this.native.submit(i,user,args.paths);const result=projects.publishNative(candidate,user);this.native.sync(i,user);return result;})());
  }
  requireThat(false,'未知项目工具',404);
 }
 history(i:Instance,kind:string,planId:string,args:Doc={}){
  this.plan(i,kind,planId);const {store}=this.native.workspace(i.project),rows=store.all(kind==='video'?'pickup':'image-plan',i.owner);
  const byId=new Map(rows.map(p=>[p.id,p]));let root=planId;const seen=new Set<string>();
  while(byId.get(root)?.previousPlanId&&!seen.has(root)){seen.add(root);const previous=byId.get(root)!.previousPlanId;if(!byId.has(previous))break;root=previous;}
  const lineage=new Set([root]);for(let n=0;n<rows.length;n++){let changed=false;for(const p of rows)if(lineage.has(p.previousPlanId)&&!lineage.has(p.id)){lineage.add(p.id);changed=true;}if(!changed)break;}
  const all=rows.filter(p=>lineage.has(p.id)).sort((a,b)=>String(a.created).localeCompare(String(b.created))||a.id.localeCompare(b.id));
  const page=planPage(all.map((p,n)=>({kind,plan:{id:p.id,created:p.created},versionNumber:n+1})),{cursor:args.cursor,limit:args.limit??50});
  return {items:page.items.map(c=>({...this.card(i,kind,this.plan(i,kind,c.plan.id)),versionNumber:c.versionNumber})).reverse(),total:page.total,nextCursor:page.nextCursor,truncated:!!page.nextCursor};
 }
 async serveMedia(project:string,user:Doc,req:IncomingMessage,res:ServerResponse,path:string){
  const url=new URL(path,'http://native.local'),match=url.pathname.match(/^\/api\/team\/media\/([a-f0-9-]{36})(\/preview)?$/);
  if(!match||!['GET','HEAD'].includes(req.method??'GET'))return false;
  requireThat(this.native.policy(project).enabled,'超级管理员已关闭原生 Harness',403);
  const media=this.native.workspace(project).pickups.media,m=media.get(match[1]);requireThat(media.canRead(m,user),'媒体不属于当前项目成员',404);
  if(match[2])await serveMediaPreview(media,req,res,m.id,user,url.searchParams.get('variant')??'thumb');else media.serve(req,res,m.id,user);
  return true;
 }
 async route(i:Instance,user:Doc,req:IncomingMessage,res:ServerResponse,path:string,body?:Buffer){
  const {pickups,images,projects}=this.native.workspace(i.project),url=new URL(path,'http://native.local'),method=req.method??'GET';
  if(url.pathname==='/api/team/project-file'&&['GET','HEAD'].includes(method)){
   const file=projects.fileInfo(url.searchParams.get('path')??'',url.searchParams.get('revision')??undefined);
   return serveFileDownload(objectPath(projects.store.root,file.digest),req,res,{authorized:()=>!!this.native.store.get('user',user.id)?.active&&user.id===i.owner&&this.native.policy(i.project).enabled,mime:file.mime,filename:file.path,inline:url.searchParams.get('download')!=='1'&&/^(image|video|audio)\//.test(file.mime)});
  }
  const send=(v:unknown)=>{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(v,publicResponse));};
  const codex=url.pathname.match(/^\/api\/team\/codex\/([a-f0-9]{64})(?:\/(cancel))?$/);
  if(codex){requireThat(method==='GET'&&!codex[2]||method==='POST'&&codex[2]==='cancel','请求方法无效',405);return send(codex[2]?this.codexService().cancel(i,codex[1]):this.codexService().card(i,codex[1]));}
  const attachment=url.pathname.match(/^\/api\/team\/native-attachment\/([a-f0-9]{64})$/);if(attachment&&['GET','HEAD'].includes(method)){const service=this.native.workspace(i.project).attachments;requireThat(service,'附件读取尚未更新',503);const v=await service.original(user,attachment[1]);return this.native.history.galleryAttachment(user,new URLSearchParams({project:i.project,owner:v.item.owner,session:v.item.nativeSession,attachmentId:v.item.attachmentId,name:v.item.attachmentName,...(url.searchParams.has('download')?{download:'1'}:{})}),req,res);}
  const assembly=url.pathname.match(/^\/api\/team\/assembly\/([a-f0-9-]{36})(?:\/(resume|cancel))?$/);if(assembly&&(method==='GET'&&!assembly[2]||method==='POST'&&assembly[2])){const service=this.native.workspace(i.project).assembly;requireThat(service,'拼接功能未更新',503);const job=service.get(user,assembly[1]);requireThat(job.owner===i.owner,'拼接记录不属于当前成员',404);return send({kind:'assembly',job:assembly[2]==='resume'?service.resume(user,job.id):assembly[2]==='cancel'?service.cancel(user,job.id):job});}
  if(url.pathname==='/api/team/status'&&method==='GET'){
   const keys=(url.searchParams.get('plans')??'').split(',');requireThat(keys.length>0&&keys.length<=50,'每次最多查询 50 个方案');
   const items:Doc[]=[],errors:Doc={};for(const key of keys){const match=/^(video|image)\/([a-f0-9-]+)$/.exec(key);requireThat(match,'方案编号无效');try{items.push(this.card(i,match[1],this.plan(i,match[1],match[2])));}catch{errors[key]='方案不存在或无权限';}}return send({items,errors});
  }
  if(await this.serveMedia(i.project,user,req,res,path))return;
  const m=url.pathname.match(/^\/api\/team\/(video|image)\/([a-f0-9-]+)(?:\/(confirm|adopt|recover|cancel|history|bundle))?$/);
  requireThat(m,'项目聊天接口不存在',404);const [,kind,planId,action]=m,p=this.plan(i,kind,planId);
  if(method==='GET'&&action==='bundle')return serveMediaBundle(pickups.media,p.jobs.filter((j:Doc)=>j.mediaId).map((j:Doc)=>j.mediaId),res);
  if(method==='GET'&&action==='history')return send(this.history(i,kind,planId,{cursor:url.searchParams.get('cursor')??undefined,limit:Number(url.searchParams.get('limit')??50)}));
  if(method==='GET'&&!action)return send(this.card(i,kind,p));
  requireThat(method==='POST'&&!!action,'请求方法无效',405);const b=JSON.parse(body?.toString()??'{}');
  if(action==='cancel'){requireThat(p.jobs.some((j:Doc)=>j.id===b.jobId),'任务不存在',404);if(kind==='video')pickups.cancel(b.jobId,user);else images.cancel(b.jobId,user);return send(this.card(i,kind,this.plan(i,kind,planId)));}
  if(action==='confirm'){const updated=kind==='video'?pickups.confirm(planId,user,{digest:b.digest}):images.confirm(planId,user,{digest:b.digest});return send(this.card(i,kind,updated));}
  if(action==='adopt'){requireThat(kind==='video'&&p.jobs.some((j:Doc)=>j.id===b.jobId),'视频轮次不存在',404);pickups.adopt(b.jobId,user,{digest:b.digest,humanAccepted:b.humanAccepted});return send(this.card(i,kind,this.plan(i,kind,planId)));}
  if(action==='recover'){requireThat(kind==='image'&&p.jobs.some((j:Doc)=>j.id===b.jobId),'图片任务不存在',404);images.recover(b.jobId,user);return send(this.card(i,kind,this.plan(i,kind,planId)));}
 }
}
