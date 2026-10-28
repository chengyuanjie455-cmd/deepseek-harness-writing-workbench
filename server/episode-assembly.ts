import {assemblyGenerationInputs} from './generation-input-provenance.ts';
import {createReadStream,existsSync,mkdirSync,statSync,renameSync,unlinkSync,lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {Store,id,hash,now,requireThat,Problem,type Doc} from './store.ts';
import {MediaStore} from './media.ts';
import {cloneFileSync} from './clone-file.ts';
import {assertStoragePath} from './external-storage.ts';
import {withMediaCheck} from './media-check-slots.ts';
import type {Projects} from './project.ts';
import {AssemblySourceProvenance} from './assembly-source-provenance.ts';
import {privateSkillDefinitionStatus} from './private-skill-definition.ts';

const exec=promisify(execFile),version=1,maximumBytes=1024*1024*1024;
type Clip={mediaId?:string;sha256?:string;bytes?:number;jobId?:string;jobOwner?:string;jobPlan?:string;start:number;end?:number};
type Settings={width?:number;height?:number;fps?:number};
async function facts(path:string,signal?:AbortSignal){
 requireThat(!lstatSync(path).isSymbolicLink()&&realpathSync(path)===path,'拼接文件路径身份改变',409);const before=statSync(path),sha=createHash('sha256');requireThat(before.isFile()&&before.size<=maximumBytes,'拼接文件超过媒体容量或不是普通文件',413);
 for await(const chunk of createReadStream(path,{signal}))sha.update(chunk);
 const after=statSync(path);requireThat(before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs,'拼接原件在读取时发生变化',409);
 return {sha256:sha.digest('hex'),bytes:after.size};
}
async function probe(path:string,signal?:AbortSignal){
 const {stdout}=await exec('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,width,height,avg_frame_rate:stream_tags=rotate:stream_side_data=rotation','-of','json',path],{signal,timeout:30000,maxBuffer:1024*1024});
 const data=JSON.parse(stdout),video=data.streams?.find((v:Doc)=>v.codec_type==='video'),duration=Number(data.format?.duration);requireThat(video&&Number.isFinite(duration)&&duration>0,'片段缺少有效视频流或时长',422);
 const rotation=Number(video.side_data_list?.find((s:Doc)=>Number.isFinite(s.rotation))?.rotation??video.tags?.rotate??0),swapped=Math.abs(rotation)%180===90,ratio=String(video.avg_frame_rate??'24/1').split('/').map(Number),fps=ratio[0]/ratio[1];
 return {duration,width:Number(swapped?video.height:video.width),height:Number(swapped?video.width:video.height),fps:Number.isFinite(fps)&&fps>=1&&fps<=120?fps:24,hasAudio:data.streams.some((v:Doc)=>v.codec_type==='audio')};
}

/** Optional chat capability, not a second agent workflow. Original clips are
 * immutable inputs; every normalized part and delivered result has a receipt.
 * Rendering shares the existing local decoder pool, never provider capacity. */
export class EpisodeAssembly {
 private started=false;private closing=false;private timer?:ReturnType<typeof setInterval>;
 private active=new Map<string,{controller:AbortController;promise:Promise<void>}>();
 private provenance?:AssemblySourceProvenance;
 constructor(public store:Store,public media:MediaStore,projects?:Projects,currentSkill:()=>Doc=privateSkillDefinitionStatus){if(projects)this.provenance=new AssemblySourceProvenance(store,projects,currentSkill);}
 private authorized(user:Doc){const fresh=this.store.get('user',user.id);requireThat(fresh?.active&&fresh.role===user.role,'账号状态已改变',403);return fresh;}
 private folder(job:Doc){requireThat(/^[a-f0-9-]{36}$/.test(job.id),'拼接记录无效');const base=join(this.store.root,'episode-assemblies');assertStoragePath(base);mkdirSync(base,{recursive:true,mode:0o700});requireThat(!lstatSync(base).isSymbolicLink()&&realpathSync(base)===base,'拼接目录身份改变',409);const p=join(base,job.id);mkdirSync(p,{mode:0o700,recursive:true});requireThat(!lstatSync(p).isSymbolicLink()&&realpathSync(p)===p,'拼接目录身份改变',409);return p;}
 private saved(job:Doc){const next:Doc={...job,updated:now()};this.store.tx(()=>{this.store.put('assembly-job',next);this.store.event(next.owner,'assembly.updated',{id:next.id,state:next.state,mediaId:next.mediaId});});return next;}
 get(user:Doc,jobId:string){this.authorized(user);const j=this.store.get('assembly-job',jobId);requireThat(j&&(j.owner===user.id||user.role==='admin'),'拼接记录不存在或无权限',404);return this.public(j);}
 list(user:Doc,session?:string){this.authorized(user);return this.store.all('assembly-job').filter(j=>(user.role==='admin'||j.owner===user.id)&&(!session||j.nativeSession===session)).map(j=>this.public(j));}
 private public(j:Doc){return {id:j.id,project:j.project??'shared',owner:j.owner,nativeSession:j.nativeSession,name:j.name,episode:j.episode,state:j.state,progress:j.progress,error:j.error,errorCode:j.errorCode,clips:j.clips,sourceClips:j.sourceClips,sourceProvenance:j.sourceProvenance,resolvedGenerationInputs:j.resolvedGenerationInputs,sourceStatus:this.provenance?.status(j.sourceProvenance,undefined,j.resolvedGenerationInputs)??{state:'unknown',summary:'项目来源核对暂未连接，原片保留。'},waitingSources:j.waitingSources,settings:j.settings,output:j.output,checkpoints:(j.checkpoints??[]).map((c:Doc)=>({index:c.index,sha256:c.sha256,bytes:c.bytes,duration:c.duration})),created:j.created,updated:j.updated,finished:j.finished,...(j.state==='ready'?{mediaId:j.mediaId,download:'/api/media/'+j.mediaId+'?download=1',preview:'/api/media/'+j.mediaId,technicalQA:j.technicalQA}:{}),humanAcceptance:'pending'};}
 submit(user:Doc,session:string,args:Doc,requestKey:string){
  this.authorized(user);requireThat(!this.closing,'拼接服务正在停止',503);requireThat(typeof session==='string'&&session.length>0&&session.length<=200&&typeof requestKey==='string'&&requestKey.length>0&&requestKey.length<=500,'拼接会话或提交编号无效');
  requireThat(Array.isArray(args.clips)&&args.clips.length>0&&args.clips.length<=1000,'请选择需要拼接的有序视频片段');
  const clips:Clip[]=args.clips.map((c:Doc)=>{requireThat(c&&typeof c==='object'&&(typeof c.media_id==='string')!==(typeof c.job_id==='string'),'每条片段需提供一个媒体编号或原视频任务编号');const start=c.start??0,end=c.end;requireThat(Number.isFinite(start)&&start>=0&&(end===undefined||Number.isFinite(end)&&end>start),'片段裁剪时间无效');const range={start,...(end===undefined?{}:{end})};
   if(c.job_id){const j=this.store.get('video-job',c.job_id);requireThat(j&&(j.owner===user.id||user.role==='admin'),'原视频任务不存在或不属于当前成员',404);return {jobId:j.id,jobOwner:j.owner,jobPlan:j.planId??j.plan??j.pickup,...range};}
   const m=this.media.get(c.media_id);requireThat(m.mime==='video/mp4'&&this.media.canRead(m,user),'片段不是当前项目或本人可用的视频',404);return {mediaId:m.id,sha256:m.sha256,bytes:m.bytes,...range};});
  const settings:Settings={};for(const k of ['width','height','fps'] as const)if(args[k]!==undefined){requireThat(Number.isInteger(args[k])&&args[k]>0&&(k==='fps'?args[k]<=120:args[k]<=7680&&args[k]%2===0),'输出尺寸需为偶数，帧率与尺寸需有效');settings[k]=args[k];}requireThat((settings.width===undefined)===(settings.height===undefined),'请同时指定输出宽高或使用首条片段尺寸');
  const name=typeof args.name==='string'&&args.name.trim()?args.name.trim().slice(0,100):'拼接成片',episode=typeof args.episode==='string'?args.episode.trim().slice(0,60):undefined,request=hash(JSON.stringify([this.store.projectId??'shared',user.id,session,requestKey])),digest=hash(JSON.stringify([version,clips,settings,name,episode]));
  const old=this.store.all('assembly-job').find(j=>j.request===request);if(old){requireThat(old.digest===digest,'同次拼接请求的内容已变化，请使用新的提交编号',409);return this.public(old);}
  const j=this.saved({id:id(),owner:user.id,project:this.store.projectId??'shared',nativeSession:session,name,episode,request,digest,version,clips,sourceClips:clips,sourceProvenance:this.provenance?.capture(clips,user),settings,state:'queued',progress:{completed:0,total:clips.length},checkpoints:[],mediaId:id(),created:now()});this.pump();return this.public(j);
 }
 start(){if(this.started)return;this.started=true;for(const j of this.store.all('assembly-job'))if(['normalizing','joining','delivering'].includes(j.state))this.saved({...j,state:'queued',recoveredAt:now()});this.timer=setInterval(()=>this.pump(),1000);this.timer.unref();this.pump();}
 resume(user:Doc,jobId:string){const view=this.get(user,jobId),j=this.store.get('assembly-job',view.id)!;requireThat(!this.closing,'拼接服务正在停止',503);if(['failed','cancelled'].includes(j.state))this.saved({...j,state:'queued',error:undefined,errorCode:undefined,finished:undefined});this.pump();return this.get(user,jobId);}
 cancel(user:Doc,jobId:string){const view=this.get(user,jobId);if(view.state==='ready')return view;const j=this.store.get('assembly-job',jobId)!;this.saved({...j,state:'cancelled',finished:now()});this.active.get(jobId)?.controller.abort();return this.get(user,jobId);}
 private pump(){if(!this.started||this.closing)return;for(const j of this.store.all('assembly-job')){if(!['queued','waiting_sources'].includes(j.state)||this.active.has(j.id))continue;const controller=new AbortController(),entry={controller,promise:Promise.resolve()};this.active.set(j.id,entry);entry.promise=this.render(j,controller.signal).catch(e=>{const current=this.store.get('assembly-job',j.id);if(!current||current.state==='ready'||current.state==='cancelled'||controller.signal.aborted&&!this.closing&&current.state==='queued')return;this.saved({...current,state:this.closing?'queued':'failed',error:this.closing?undefined:e instanceof Problem?e.message:e?.code==='ENOENT'?'主机缺少 ffmpeg 或 ffprobe，原片已保留':'拼接未完成，原片与已完成片段保留，可继续本条记录',errorCode:this.closing?undefined:String(e?.code??e?.status??'RENDER_FAILED').slice(0,80),diagnostic:this.closing?undefined:String(e?.stderr??e?.message??e).slice(-6000)});}).finally(()=>{this.active.delete(j.id);if(!this.closing&&this.store.get('assembly-job',j.id)?.state==='queued')queueMicrotask(()=>this.pump());});}}
 private sources(j:Doc,user:Doc){
  const clips:Clip[]=[],waiting:string[]=[];for(const [index,source]of (j.sourceClips??j.clips).entries()){
   let c=source;if(source.jobId){const job=this.store.get('video-job',source.jobId);requireThat(job&&job.owner===source.jobOwner&&(job.planId??job.plan??job.pickup)===source.jobPlan,'原视频任务身份改变，未替换片段或重提',409);requireThat(job.owner===user.id||user.role==='admin','原视频任务权限已改变',403);
    if(!job.mediaId||!['ready','adopted','qa_failed'].includes(job.state)){requireThat(!['failed','cancelled'].includes(job.state),'原视频任务失败或取消，拼接已停止；未重新提交生成',409);waiting.push(job.id);continue;}
    const m=this.media.get(job.mediaId);requireThat(m.mime==='video/mp4'&&this.media.canRead(m,user),'来源视频不可读取',404);const previous=j.clips[index];requireThat(!previous.sha256||previous.sha256===m.sha256&&previous.mediaId===m.id,'来源任务的原视频已改变，未替换已冻结输入',409);c={...source,mediaId:m.id,sha256:m.sha256,bytes:m.bytes};
   }clips.push(c);
  }return {clips,waiting};
 }
 private async render(initial:Doc,signal:AbortSignal){
  const jobId=initial.id,user=this.store.get('user',initial.owner)!;this.authorized(user);let j=this.store.get('assembly-job',jobId)!;const resolved=this.sources(j,user);signal.throwIfAborted();
  if(resolved.waiting.length){if(j.state!=='waiting_sources'||JSON.stringify(j.waitingSources)!==JSON.stringify(resolved.waiting))this.saved({...j,state:'waiting_sources',waitingSources:resolved.waiting});return;}
  j={...j,clips:resolved.clips,waitingSources:[],...(j.sourceClips?.some((c:Clip)=>c.jobId)&&!j.resolvedGenerationInputs?{resolvedGenerationInputs:assemblyGenerationInputs(this.store,resolved.clips,user)}:{})};const folder=this.folder(j);
  // A crash after output creation or media installation resumes delivery rather
  // than rerendering or allocating another media ID.
  if(j.output&&existsSync(join(folder,'output.mp4'))){const f=await facts(join(folder,'output.mp4'),signal);if(f.sha256===j.output.sha256&&f.bytes===j.output.bytes){await this.deliver(j,user,join(folder,'output.mp4'),signal);return;}}
  const infos=[];for(const c of j.clips){const m=this.media.get(c.mediaId!);requireThat(this.media.canRead(m,user)&&m.sha256===c.sha256,'来源视频权限或版本已变化',409);await this.media.verify(m.id,c.sha256,signal);const info=await withMediaCheck(()=>probe(this.media.path(m.id),signal),signal),end=c.end??info.duration;requireThat(end<=info.duration+0.001&&c.start<end,'裁剪区间超过原视频时长',422);infos.push({...info,start:c.start,end,duration:end-c.start});}
  const first=infos[0],settings={width:j.settings.width??Math.ceil(first.width/2)*2,height:j.settings.height??Math.ceil(first.height/2)*2,fps:j.settings.fps??Math.round(first.fps)};signal.throwIfAborted();j=this.saved({...j,state:'normalizing',resolvedSettings:settings});
  const checkpoints:Doc[]=[],priorCheckpoints:Doc[]=[...(j.checkpoints??[])];
  for(let index=0;index<j.clips.length;index++){
   signal.throwIfAborted();this.authorized(user);const clip=j.clips[index],info=infos[index],key=hash(JSON.stringify([version,clip,settings])),name=index+'-'+key+'.mp4',file=join(folder,name),prior=priorCheckpoints.find((c:Doc)=>c.index===index&&c.key===key);let checkpoint:Doc|undefined;
   if(prior&&existsSync(file)){const f=await facts(file,signal);if(f.sha256===prior.sha256&&f.bytes===prior.bytes)checkpoint=prior;}
   if(!checkpoint){await withMediaCheck(async()=>{
    this.authorized(user);await this.media.verify(clip.mediaId,clip.sha256,signal);const temp=join(folder,index+'-'+id()+'.partial.mp4'),duration=info.duration;
    const args=['-nostdin','-hide_banner','-v','error','-threads','1','-i',this.media.path(clip.mediaId),...(!info.hasAudio?['-f','lavfi','-i','anullsrc=r=48000:cl=stereo']:[]),'-filter_complex_threads','1','-filter_complex',`[0:v:0]trim=start=${info.start}:end=${info.end},setpts=PTS-STARTPTS,scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease,pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${settings.fps}[v];[${info.hasAudio?'0':'1'}:a:0]atrim=start=${info.hasAudio?info.start:0}:duration=${duration},asetpts=PTS-STARTPTS,aresample=48000,apad,atrim=duration=${duration}[a]`,'-map','[v]','-map','[a]','-c:v','libx264','-threads','1','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-ac','2','-t',String(duration),'-movflags','+faststart',temp];
    try{await exec('ffmpeg',args,{signal,timeout:30*60000,maxBuffer:1024*1024});await this.media.verify(clip.mediaId,clip.sha256,signal);const output=await probe(temp,signal);requireThat(Math.abs(output.duration-duration)<=Math.max(0.15,2/settings.fps),'转码片段时长不符',422);const f=await facts(temp,signal);renameSync(temp,file);checkpoint={index,key,file:name,...f,duration,addedSilentAudio:!info.hasAudio};}finally{if(existsSync(temp))unlinkSync(temp);}
   },signal);}
   signal.throwIfAborted();checkpoints.push(checkpoint!);j=this.saved({...this.store.get('assembly-job',jobId),state:'normalizing',checkpoints:[...checkpoints,...priorCheckpoints.filter(c=>c.index>index)],progress:{completed:index+1,total:j.clips.length}});
  }
  signal.throwIfAborted();this.authorized(user);j=this.saved({...j,state:'joining'});const list=join(folder,'concat.ffconcat');await writeFile(list,'ffconcat version 1.0\n'+checkpoints.map(c=>`file '${c.file}'\nduration ${c.duration}\n`).join(''),{mode:0o600});
  const temp=join(folder,'output-'+id()+'.partial.mp4');
  try{
   await withMediaCheck(async()=>{await exec('ffmpeg',['-nostdin','-hide_banner','-v','error','-f','concat','-safe','1','-protocol_whitelist','file,pipe','-i',list,'-map','0:v:0','-map','0:a:0','-c','copy','-movflags','+faststart',temp],{signal,timeout:30*60000,maxBuffer:1024*1024});await exec('ffmpeg',['-nostdin','-v','error','-xerror','-threads','1','-i',temp,'-f','null','-'],{signal,timeout:30*60000,maxBuffer:1024*1024});},signal);
   const qa=await probe(temp,signal),expected=infos.reduce((n,c)=>n+c.duration,0);requireThat(Math.abs(qa.duration-expected)<=Math.max(0.25,j.clips.length/settings.fps+0.05),'拼接总时长不符，原片已保留',422);const f=await facts(temp,signal);signal.throwIfAborted();renameSync(temp,join(folder,'output.mp4'));j=this.saved({...j,state:'delivering',output:{...f,...qa,expectedDuration:expected,settings,addedSilentAudio:checkpoints.some(c=>c.addedSilentAudio)},technicalQA:{passed:true,...qa,checkedAt:now(),humanAcceptance:'pending'}});await this.deliver(j,user,join(folder,'output.mp4'),signal);
  }finally{if(existsSync(temp))unlinkSync(temp);}
 }
 async deliver(job:Doc,user:Doc,file:string,signal?:AbortSignal){
  this.authorized(user);signal?.throwIfAborted();for(const c of job.clips){const m=this.media.get(c.mediaId!);requireThat(this.media.canRead(m,user)&&m.sha256===c.sha256,'交付前原片权限或版本已改变',409);}
  const f=await facts(file,signal);requireThat(f.sha256===job.output.sha256&&f.bytes===job.output.bytes,'拼接输出完整性检查失败',409);const target=this.media.path(job.mediaId),existing=this.store.get('media',job.mediaId);
  requireThat(!existing||existing.assemblyId===job.id&&existing.owner===job.owner&&existing.sha256===f.sha256,'拼接交付编号已有其他原件，未覆盖',409);
  if(existsSync(target)){const saved=await facts(target,signal);requireThat(saved.sha256===f.sha256&&saved.bytes===f.bytes,'拼接交付文件已变化，未覆盖',409);}else{this.media.capacity(f.bytes);const temp=target+'.assembly-'+id();try{cloneFileSync(file,temp);const saved=await facts(temp,signal);requireThat(saved.sha256===f.sha256,'拼接交付复制不完整',409);renameSync(temp,target);}finally{if(existsSync(temp))unlinkSync(temp);}}
  this.authorized(user);signal?.throwIfAborted();this.store.tx(()=>{
   this.store.put('media',{id:job.mediaId,owner:job.owner,scope:'private',name:[job.episode,job.name,'拼接成片.mp4'].filter(Boolean).join('_'),mime:'video/mp4',...f,project:job.project,nativeSession:job.nativeSession,assemblyId:job.id,episode:job.episode,sourceMediaIds:job.clips.map((c:Clip)=>c.mediaId!),created:existing?.created??now()});
   this.store.put('assembly-job',{...job,state:'ready',progress:{completed:job.clips.length,total:job.clips.length},error:undefined,errorCode:undefined,finished:now(),updated:now()});this.store.event(job.owner,'assembly.updated',{id:job.id,state:'ready',mediaId:job.mediaId});this.store.audit(job.owner,'video.assemble',job.id,{mediaId:job.mediaId,sources:job.clips.map((c:Clip)=>c.mediaId!),sha256:f.sha256});
  });
 }
 async close(){this.closing=true;clearInterval(this.timer);for(const task of this.active.values())task.controller.abort();await Promise.allSettled([...this.active.values()].map(task=>task.promise));}
}
