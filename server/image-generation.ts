import {freezeGenerationInput,dispatchInputIntent} from './generation-input-provenance.ts';
import {chatImagePayload,chatImageReceipt} from './chat-image.ts';
import {executionActive,claimExecution,releaseExecution} from './media-execution.ts';
import {deliveryStatus} from './delivery-status.ts';
import {withImageDownload} from './media-check-slots.ts';
import {FairQueue} from './fair-queue.ts';
import {providerFailure} from './provider-failure.ts';
import {imageCapacity} from './concurrency.ts';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { get as httpsGet } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, requireThat, id, now, hash, Problem, type Doc } from './store.ts';
import { fields, text, VideoCatalog,apiOrigin,apiEndpoint } from './video-catalog.ts';
import { MediaStore } from './media.ts';
import { VideoStorage } from './video-storage.ts';
import { XiaopeiDirectory } from './xiaopei-directory.ts';
import {memberModelAllowed} from './member-models.ts';
import {ImageSelection,ImageModelUnavailable,modelUnavailable} from './image-selection.ts';
import { parsePickup, modelMatches } from './pickup-input.ts';
import type { Projects } from './project.ts';

const run=promisify(execFile), MAX_IMAGE=24*1024*1024;
const imageSizes:Record<string,string[]>={
  '1:1':['1024x1024','2048x2048','2880x2880'],'16:9':['1536x864','2048x1152','3840x2160'],'9:16':['864x1536','1152x2048','2160x3840'],
  '4:3':['1365x1024','2048x1536','3840x2880'],'3:4':['1024x1365','1536x2048','2880x3840'],'3:2':['1536x1024','2048x1365','3840x2560'],
  '2:3':['1024x1536','1365x2048','2560x3840'],'4:5':['1024x1280','1638x2048','3072x3840'],'5:4':['1280x1024','2048x1638','3840x3072'],'21:9':['1792x768','2048x878','3840x1646']};
export function imagePayload(model:Doc,prompt:string,params:Doc,references:string[]=[]):Doc{
  if(model.providerDefaults)return {model:model.remoteModel,prompt,n:1,...(references.length?{image:references.length===1?references[0]:references}:{})};
  const common={model:model.remoteModel,prompt,aspect_ratio:params.aspect_ratio.replace(':','x'),resolution:params.resolution};
  if(model.imageRoute==='url-generations')return {...common,sequential_image_generation:'disabled',response_format:'url',stream:false,...(references.length?{image:references.length===1?references[0]:references}:{})};
  const size=imageSizes[params.aspect_ratio]?.[['1k','2k','4k'].indexOf(params.resolution)];requireThat(size,'图片尺寸不受支持');
  return {...common,n:1,size,...(references.length?{image:references.length===1?references[0]:references}:{})};
}
export interface ImageAdapter{
  create(channel:Doc,key:string,plan:Doc,media:MediaStore,urls:string[],signal:AbortSignal):Promise<Doc>;
  download(url:string,signal:AbortSignal):Promise<Readable>;
}
export class ImageRequestFailure extends Problem{
 constructor(public httpStatus:number,public receipt:Doc){super(502,`图片接口返回 HTTP ${httpStatus}；${providerFailure(receipt).error}`);}
}
export function retryImageDownload(job:Doc,error:unknown){
  if(job.mediaId||!job.receipt?.data?.[0]?.url)return false;
  if(error instanceof Problem)return error.status===429||error.status===507||error.status>=500&&/HTTP (?:429|5\d\d)|下载字节数不完整|连续60秒/.test(error.message);
  return error instanceof Error;
}
export function publicIPv4(address:string){const n=address.split('.').map(Number);return n.length===4&&n.every(x=>Number.isInteger(x)&&x>=0&&x<=255)&&![0,10,127].includes(n[0])&&n[0]<224&&!(n[0]===169&&n[1]===254)&&!(n[0]===172&&n[1]>=16&&n[1]<=31)&&!(n[0]===192&&(n[1]===168||n[1]===0))&&!(n[0]===100&&n[1]>=64&&n[1]<=127)&&!(n[0]===198&&[18,19,51].includes(n[1]))&&!(n[0]===203&&n[1]===0&&n[2]===113);}
// Do not attach a data listener before handing off the response: it would put
// the HTTP body into flowing mode and discard its first chunk before ingest.
export function originalImageStream(source:Readable,expectedBytes?:number,maxBytes=MAX_IMAGE):Readable{
  const observeError=()=>{};source.on('error',observeError);
  const output=Readable.from((async function*(){let bytes=0;try{
    for await(const chunk of source){bytes+=chunk.length;requireThat(bytes<=maxBytes,'图片超过24 MiB上限',502);yield chunk;}
    requireThat(expectedBytes===undefined||bytes===expectedBytes,'原图下载字节数不完整',502);
  }catch(error){throw Object.assign(error instanceof Error?error:Error('原图传输失败'),{downloadBytes:bytes,downloadExpectedBytes:expectedBytes});}
  finally{source.destroy();}})());
  output.once('close',()=>{source.destroy();source.once('close',()=>source.off('error',observeError));});return output;
}
export class XiaopeiImageAdapter implements ImageAdapter{
  async create(c:Doc,key:string,p:Doc,media:MediaStore,urls:string[],signal:AbortSignal){
    requireThat(c.adapter==='xiaopei'&&c.origin==='https://api.aicopy.top'||c.adapter==='ruiyun','图片渠道适配器无效');
    apiOrigin(c.origin,c.allowLocalHTTP===true,c.adapter==='ruiyun');
    const payload=p.model.imageRoute==='chat-images'?chatImagePayload(p.model,p.prompt,p.assets.map((a:Doc)=>{const m=media.get(a.mediaId);return `data:${m.mime};base64,${readFileSync(media.path(m.id)).toString('base64')}`;})):imagePayload(p.model,p.prompt,p.params,urls);let body:BodyInit=JSON.stringify(payload),headers:Record<string,string>={Authorization:`Bearer ${key}`,'Content-Type':'application/json'},path=p.model.imageRoute==='chat-images'?'/v1/chat/completions':'/v1/images/generations';
    if(p.assets.length&&p.model.imageRoute==='multipart-edits'){
      const form=new FormData();for(const [k,v] of Object.entries(payload))form.append(k,String(v));
      for(const a of p.assets){const m=media.get(a.mediaId);form.append('image',new Blob([readFileSync(media.path(m.id))],{type:m.mime}),`reference.${m.mime.split('/')[1]}`);}
      body=form;headers={Authorization:`Bearer ${key}`};path='/v1/images/edits';
    }else if(p.assets.length&&p.model.imageRoute==='url-edits')path='/v1/images/edits';
    const response=await fetch(apiEndpoint(c.origin,path),{method:'POST',headers,body,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(900000)])});
    requireThat(response.body,'图片接口返回空响应',502);const chunks:Buffer[]=[];let bytes=0;
    for await(const part of response.body as any){bytes+=part.length;requireThat(bytes<=40*1024*1024,'图片回执超过限制',502);chunks.push(Buffer.from(part));}
    if(!response.ok){let rejected:Doc={};try{rejected=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
      if(modelUnavailable(response.status,rejected))throw new ImageModelUnavailable();throw new ImageRequestFailure(response.status,rejected);}
    // Other HTTP failures remain uncertain; never treat a timeout as free work.
    requireThat(response.ok,`图片接口返回 HTTP ${response.status}，需核对原请求`,502);
    return p.model.imageRoute==='chat-images'?chatImageReceipt(Buffer.concat(chunks).toString('utf8'),c.origin):JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async download(address:string,signal:AbortSignal){
    const url=new URL(address,'https://api.aicopy.top');requireThat(url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443'),'原图下载地址无效',502);
    const addresses=await lookup(url.hostname,{family:4,all:true});requireThat(addresses.length&&addresses.every(a=>publicIPv4(a.address)),'原图下载地址不得指向本机或内网',502);
    // Pin the resolved public address. No redirects and no credentials are forwarded to image hosts.
    return await new Promise<Readable>((resolve,reject)=>{
      const request=httpsGet(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(900000)]),lookup:((_host:any,opts:any,cb:any)=>opts?.all?cb(null,[addresses[0]]):cb(null,addresses[0].address,4)) as any},response=>{
        if(response.statusCode!==200){response.destroy();reject(new Problem(502,`原图下载返回 HTTP ${response.statusCode}，保留已有回执`));return;}
        const length=response.headers['content-length'],expected=length===undefined?undefined:Number(length);
        if(expected!==undefined&&(!Number.isSafeInteger(expected)||expected<=0||expected>MAX_IMAGE)){response.destroy();reject(new Problem(502,'原图大小无效或超过24 MiB上限'));return;}
        resolve(originalImageStream(response,expected));
      });
      // A slow but progressing download may exceed three minutes. Still bound
      // stalled connections and the overall lifetime; never resubmit generation.
      request.setTimeout(60000,()=>request.destroy(Object.assign(Error('原图下载连续60秒未收到数据'),{code:'IMAGE_DOWNLOAD_IDLE'})));
      request.on('error',reject);
    });
  }
}

const imageWorkers=new WeakMap<Store,{active:Set<string>,clients:Set<ImageGeneration>,checks:FairQueue}>();
export class ImageGeneration{
  workers:{active:Set<string>,clients:Set<ImageGeneration>,checks:FairQueue};
  directory:XiaopeiDirectory;selection:ImageSelection;active=new Map<string,AbortController>();closing=false;timer?:ReturnType<typeof setInterval>;lastOwner='';
  constructor(public store:Store,public projects:Projects,public catalog:VideoCatalog,public media:MediaStore,public storage:VideoStorage,public adapter:ImageAdapter=new XiaopeiImageAdapter(),public simulated=false,public executes=true){
    this.workers=imageWorkers.get(store.global)??{active:new Set(),clients:new Set(),checks:new FairQueue(4)};imageWorkers.set(store.global,this.workers);this.workers.clients.add(this);
    this.directory=new XiaopeiDirectory(store,catalog);
    this.selection=new ImageSelection(store,catalog,!simulated);
    for(const j of executes?store.select('image-job',{states:['submitting','preparing']}):[])if(j.state==='submitting')this.update(j,{state:'submission_unknown',error:'主机在提交期间重启，需核对原请求；不会自动重新生成'});else if(j.state==='preparing')this.update(j,{state:'queued'});
  }
  start(){if(!this.executes||this.timer)return;this.timer=setInterval(()=>this.pump(),2000);this.timer.unref();this.pump();}
  async close(){this.closing=true;this.workers.clients.delete(this);clearInterval(this.timer);for(const c of this.active.values())c.abort();while(this.active.size)await new Promise(r=>setTimeout(r,20));}
  update(j:Doc,patch:Doc){return this.store.tx(()=>{const previous=this.store.get('image-job',j.id)!;requireThat(previous,'图片任务不存在',404);if(patch.state==='cancelled')requireThat(previous.state==='queued'&&!previous.createAttempts&&!executionActive(this.store,'image-job',previous.id),'任务已开始执行，不能取消未发送任务',409);if(patch.state==='preparing')requireThat(previous.state==='queued'||previous.state==='submitting'&&patch.submissionDisposition==='not_sent','任务状态已改变',409);const next:Doc={...previous,...patch,updated:now()};if(patch.state&&patch.state!==previous.state)next.timeline=[...(previous.timeline??[]),{state:patch.state,at:next.updated}].slice(-200);this.store.put('image-job',next);this.store.event(next.owner,'image.updated',{id:next.planId,state:next.state});return next;});}
  publicJob(j:Doc):Doc{const {receipt,payload,resolution,providerReceipt,...safe}=j;return {...safe,delivery:deliveryStatus(j)};}
  get(planId:string,user:Doc):Doc{const p=this.store.get('image-plan',planId);requireThat(p&&(p.owner===user.id||user.role==='admin'),'图片方案不存在或无权限',404);if(p.owner!==user.id)this.store.audit(user.id,'admin.image.read',p.id);return {...p,jobs:this.store.select('image-job',{owner:p.owner,planId:p.id}).map(j=>this.publicJob(j))};}
  references(user:Doc){return this.store.all('media').filter(m=>m.mime.startsWith('image/')&&(m.scope==='project'||m.owner===user.id)&&(!m.attachmentPath||this.projects.revision().manifest[m.attachmentPath]===m.sha256));}
  originals(user:Doc){return this.store.all('media').filter(m=>m.mime.startsWith('image/')&&(!m.attachmentPath||this.projects.revision().manifest[m.attachmentPath]===m.sha256)&&(m.scope==='project'||m.owner===user.id&&m.provenance==='member_original')&&!m.generated);}
  async upload(user:Doc,b:Doc){
    fields(b,['name','base64','requestId']);requireThat(typeof b.requestId==='string'&&/^[a-f0-9-]{32,36}$/.test(b.requestId),'上传请求编号无效');
    requireThat(typeof b.base64==='string'&&b.base64.length<=Math.ceil(MAX_IMAGE/3)*4&&/^[A-Za-z0-9+/]+={0,2}$/.test(b.base64),'原图格式或大小无效');const bytes=Buffer.from(b.base64,'base64');requireThat(bytes.length<=MAX_IMAGE,'原图超过24 MiB');const digest=hash(bytes);requireThat(!this.store.global.all('media').some(m=>m.generated&&m.sha256===digest),'生成图不能重新上传为原件，请使用最初原图',409);
    const existing=this.store.all('media',user.id).find(m=>m.uploadRequestId===b.requestId);if(existing){requireThat(existing.sha256===digest,'同一上传编号的原图已改变',409);return existing;}
    const m=await this.media.ingest(Readable.from([bytes]),user.id,'private',text(b.name,'原图文件名',160));requireThat(m.mime.startsWith('image/'),'仅接受PNG/JPEG/WebP原图');requireThat(this.store.get('user',user.id)?.active,'账号已停用',403);
    const result={...m,provenance:'member_original',uploadRequestId:b.requestId};this.store.put('media',result);this.store.audit(user.id,'image.original.upload',m.id,{sha256:m.sha256,bytes:m.bytes});return result;
  }
  prepare(t:Doc){
    const existing=this.store.get('image-plan',t.id);if(existing)return existing;
    const base:Doc={id:t.id,owner:t.owner,session:t.session,project:this.projects.projectId,base:t.base,originalInput:t.prompt,created:now(),state:'needs_input',issues:[]};
    try{
      let refs='';const input=t.prompt.split('\n').filter((line:string)=>{if(/^参考图\s*[:：]/.test(line)){requireThat(!refs,'参考图字段重复');refs=line.replace(/^参考图\s*[:：]\s*/,'');return false;}return true;}).join('\n').replace(/^(?:图片描述|提示词)\s*[:：]/m,'补抽意见：').replace(/^图片模型\s*[:：]/m,'视频模型：');
      const parsed=parsePickup(input);const prompt=text(parsed.notes??parsed.freeform,'图片描述',12000);
      const models=this.models(this.store.get('user',t.owner)!),matches=modelMatches(text(parsed.model,'图片模型',240),models);requireThat(matches.length===1,'图片模型未找到或名称有歧义，请从可用图片模型目录选择',422);const model=matches[0];
      const params={...model.defaults,...parsed.params};requireThat(Object.keys(params).every(k=>Object.hasOwn(model.params,k)),'包含此图片模型不支持的参数',422);
      for(const [k,v] of Object.entries(params))requireThat(model.params[k].includes(v),`${k}参数不受支持`,422);
      const refIds=refs.split(/[,，\s]+/).filter(Boolean);requireThat(new Set(refIds).size===refIds.length&&refIds.length>=(model.minReferences??0)&&refIds.length<=model.maxReferences,'参考原图数量无效');
      const available=t.nativeSession?this.references(this.store.get('user',t.owner)!):this.originals(this.store.get('user',t.owner)!);const assets=refIds.map(mediaId=>{const m=available.find(a=>a.id===mediaId);requireThat(m,'只能引用共享原件或本人上传的原图；生成图不能作为二次加工输入',404);return {mediaId:m.id,name:m.name,sha256:m.sha256,bytes:m.bytes};});
      const p={...base,state:'awaiting_confirmation',model,channelRevision:model.channelRevision,prompt,params,assets,storageRevision:this.store.get('video-storage','active')?.revision??null,payload:imagePayload(model,prompt,params),estimate:{amount:null,status:'unverified'}};
      if(assets.length&&!['multipart-edits','chat-images'].includes(model.imageRoute))requireThat(p.storageRevision&&this.store.get('video-storage','active')?.enabled,'此模型需要托管参考原图，请超管配置素材存储',409);
      this.store.put('image-plan',{...p,digest:hash(JSON.stringify(p))});
    }catch(e){this.store.put('image-plan',{...base,issues:[e instanceof Error?e.message:'无法形成图片方案']});}
    return this.store.get('image-plan',t.id)!;
  }
  baseModels(user:Doc){return this.store.all('image-model').filter(m=>{
    const c=this.store.get('video-channel',m.channelId);
    return m.status==='available'&&c?.enabled&&c.verified&&c.revision===m.channelRevision&&memberModelAllowed(this.store,user,'image',m.id)&&(this.selection.managed(m)||c.reachableModels?.includes(m.remoteModel));
  });}
  models(user:Doc){return this.selection.sorted(this.baseModels(user));}
  async refreshModels(user:Doc,force=false){await this.selection.refresh(this.baseModels(user),force);return this.models(user);}
  async prepareNative(t:Doc,args:Doc){
    const existing=this.store.get('image-plan',t.id);if(existing)return existing;
    const user=this.store.get('user',t.owner)!,base=this.baseModels(user),routing=base.some(m=>this.selection.managed(m));
    let model=args.model,params=args.params??{};
    if(routing){
      await this.refreshModels(user);
      if(model&&model!=='auto'&&!this.models(user).some(m=>m.id===model||m.name===model||m.remoteModel===model||(m.aliases??[]).includes(model)))await this.refreshModels(user,true);
      let selected;
      try{selected=this.selection.pick(this.baseModels(user),model,params,args.reference_media_ids?.length??0);}
      catch(e){if(!(e instanceof Problem&&e.status===409))throw e;await this.refreshModels(user,true);selected=this.selection.pick(this.baseModels(user),model,params,args.reference_media_ids?.length??0);}
      model=selected.model.name;params=selected.params;
    }
    requireThat(typeof model==='string','图片模型名称必填');
    const prompt=`图片描述：${args.prompt}\n图片模型：${model}\n模型参数：${JSON.stringify(params)}\n参考图：${(args.reference_media_ids??[]).join(',')}`;
    const p=this.prepare({...t,prompt}),saved:Doc={...p,nativeSession:t.nativeSession,previousPlanId:args.previous_plan_id??p.previousPlanId??null,
      ...(routing?{imageSelection:{requestedModel:args.model??'auto',params:args.params??{}}}:{})};
    this.store.put('image-plan',saved);return saved;
  }
  async selectQueued(p:Doc,j:Doc,excluded:string[]=[]){
    const user=this.store.get('user',j.owner)!;
    await this.refreshModels(user);
    if(!excluded.length&&!this.models(user).some(m=>m.id===p.model.id))await this.refreshModels(user,true);
    const params={...p.imageSelection.params,aspect_ratio:p.params.aspect_ratio};
    const selected=this.selection.pick(this.baseModels(user),p.imageSelection.requestedModel,params,p.assets.length,excluded);
    if(selected.model.id===p.model.id&&selected.model.revision===p.model.revision&&JSON.stringify(selected.params)===JSON.stringify(p.params))return p;
    const next:Doc={...p,model:selected.model,channelRevision:selected.model.channelRevision,params:selected.params,payload:imagePayload(selected.model,p.prompt,selected.params),
      modelSelections:[...(p.modelSelections??[]),{from:p.model.name,to:selected.model.name,at:now()}]};
    const requestHash=hash(JSON.stringify([next.channelRevision,next.payload,next.assets]));
    this.store.tx(()=>{this.store.put('image-plan',next);this.store.put('image-job',{...j,channelId:next.model.channelId,channelRevision:next.channelRevision,modelName:next.model.name,requestHash,updated:now()});this.store.audit(user.id,'image.model.select',j.id,{from:p.model.name,to:next.model.name,reason:'2k_then_lowest_verified_price'});});
    return next;
  }
  validate(p:Doc,user:Doc){
    requireThat(this.store.get('user',user.id)?.active&&p.owner===user.id,'只能确认本人的图片方案',403);
    // Native requests freeze their prompt and media IDs, not a published project
    // snapshot. Unrelated editor metadata and unpublished files are not inputs.
    if(p.nativeSession)this.projects.assertReady();else this.projects.assertClean();
    const m=this.models(user).find(m=>m.id===p.model.id);requireThat(m&&m.revision===p.model.revision,'模型目录已变更或停用，请重新形成方案',409);
    const c=this.store.get('video-channel',m.channelId);requireThat(c?.enabled&&c.verified&&c.revision===p.channelRevision,'渠道已修改或停用，请重新形成方案',409);
    requireThat(!this.simulated||c.origin==='https://synthetic.invalid','模拟服务不能连接真实图片渠道',409);
    for(const a of p.assets)requireThat((p.nativeSession?this.references(user):this.originals(user)).some(m=>m.id===a.mediaId&&m.sha256===a.sha256),'原图引用已失效',409);
  }
  confirm(planId:string,user:Doc,b:Doc){
    fields(b,['digest']);const p=this.get(planId,user);requireThat(p.owner===user.id&&p.digest===b.digest,'请确认本人的当前方案',409);if(p.state==='confirmed')return p;
    requireThat(p.state==='awaiting_confirmation','图片方案尚未准备好',409);this.validate(p,user);this.media.capacity();
    const pending=this.store.select('image-job',{states:['queued','preparing','submitting','submission_unknown','downloading']});requireThat(p.nativeSession?pending.length<2000:pending.length<64&&pending.filter(j=>j.owner===user.id).length<8,'图片队列已满',429);
    // Distinct authorized plans may share inputs; repeated confirmation of one plan is idempotent.
    const requestHash=hash(JSON.stringify([p.channelRevision,p.payload,p.assets]));
    this.store.tx(()=>{const job={id:id(),owner:user.id,session:p.session,planId:p.id,channelId:p.model.channelId,channelRevision:p.channelRevision,modelName:p.model.name,requestHash,createAttempts:0,state:'queued',created:now(),simulated:this.simulated,cost:{status:'unverified'}};this.store.put('image-job',{...job,authorizedInput:freezeGenerationInput(this.store,'image',p)});const {jobs,...saved}=p;this.store.put('image-plan',{...saved,state:'confirmed',confirmedAt:now()});this.store.audit(user.id,'image.authorize',job.id,{digest:p.digest,requestHash});});this.pump();return this.get(planId,user);
  }
  recover(jobId:string,user:Doc){const j=this.store.get('image-job',jobId);requireThat(j&&(j.owner===user.id||user.role==='admin'),'图片任务不存在',404);requireThat(j.receipt&&j.state==='download_failed'&&!executionActive(this.store,'image-job',jobId),'只有已取得回执的任务可恢复下载',409);this.update(j,{state:'downloading',error:null,nextRecoveryAt:null});this.pump();return this.publicJob(this.store.get('image-job',j.id)!);}
  cancel(jobId:string,user:Doc){
    const j=this.store.get('image-job',jobId);requireThat(j&&j.owner===user.id&&this.store.get('user',user.id)?.active,'只能取消本人的任务',403);
    if(j.state==='cancelled')return this.publicJob(j);
    requireThat(j.state==='queued'&&!j.createAttempts&&!this.active.has(jobId),'请求已开始执行，不能按未发送任务取消',409);
    this.update(j,{state:'cancelled',submissionDisposition:'not_sent',finished:now()});this.store.audit(user.id,'image.cancel',j.id);return this.publicJob(this.store.get('image-job',j.id)!);
  }
  resolveUnknown(jobId:string,user:Doc,b:Doc){
    requireThat(this.store.get('user',user.id)?.active&&this.store.get('user',user.id)?.role==='admin','仅管理员可核对回执',403);
    const j=this.store.get('image-job',jobId);requireThat(j&&j.state==='submission_unknown'&&!this.active.has(jobId)&&!executionActive(this.store,'image-job',jobId),'仅能核对已停止执行的未知请求',409);
    const evidence=text(b.evidence,'核对依据',8000);requireThat(['received','not_submitted','failed'].includes(b.outcome),'请选择核对结果');
    let receipt:Doc|undefined;
    if(b.outcome==='received'){
      receipt=b.receipt;requireThat(receipt&&JSON.stringify(receipt).length<=40*1024*1024&&Array.isArray(receipt.data)&&receipt.data.length===1,'请输入只有一张原图的原始回执');
      const item=receipt.data[0];requireThat(item&&typeof item==='object','回执无效');
      if(typeof item.url==='string'){const u=new URL(item.url);requireThat(u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443'),'原图回执须使用 HTTPS 地址');}
      else requireThat(typeof item.b64_json==='string'&&item.b64_json.length<=Math.ceil(MAX_IMAGE/3)*4&&/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json),'回执缺少有效原图');
      receipt={data:[typeof item.url==='string'?{url:item.url}:{b64_json:item.b64_json}]};
    }
    this.store.tx(()=>{
      const patch:Doc={state:receipt?'downloading':b.outcome==='not_submitted'?'cancelled':'failed',...(receipt?{receipt,responseReceivedAt:now()}:{finished:now()}),submissionDisposition:b.outcome==='not_submitted'?'not_sent':'sent',resolution:{outcome:b.outcome,evidence,by:user.id,at:now()},error:receipt?null:b.outcome==='not_submitted'?'管理员已核实供应商未收单':'管理员已核实供应商任务失败'};
      const at=now();this.store.put('image-job',{...j,...patch,updated:at,timeline:[...(j.timeline??[]),{state:patch.state,at}].slice(-200)});this.store.event(j.owner,'image.updated',{id:j.planId,state:patch.state});
      this.store.audit(user.id,'image.resolve_unknown',jobId,{outcome:b.outcome,evidence,receiptAttached:!!receipt});
    });this.pump();return this.publicJob(this.store.get('image-job',jobId)!);
  }
  pump(){if(this.closing||!this.executes)return;
    // Images have their own global capacity; video-channel test thresholds are not image limits.
    // Unknown submissions still reserve a slot until their supplier receipt is reconciled.
    const unknown=this.store.global.select('image-job',{states:['submission_unknown']}).filter(j=>!this.workers.active.has(j.id)).length;
    const limit=imageCapacity(this.store),publishing=this.projects.pending().length>0,jobs=[...this.store.select('image-job',{states:publishing?['downloading']:['queued','downloading']}),...this.store.select('image-job',{states:['download_failed'],due:{field:'nextRecoveryAt',at:Date.now(),missing:false}})].filter(j=>!this.active.has(j.id)).sort((a,b)=>Number(a.state==='queued')-Number(b.state==='queued')||Number(a.owner===this.lastOwner)-Number(b.owner===this.lastOwner));
    for(const j of jobs){if(this.workers.active.size>=limit)break;if(j.state==='queued'&&this.workers.active.size+unknown>=limit)continue;
      const token=claimExecution(this.store,'image-job',j.id,['queued','downloading','download_failed']);if(!token)continue;
      if(j.state==='download_failed')this.update(j,{state:'downloading',nextRecoveryAt:null});
      const ctrl=new AbortController();this.active.set(j.id,ctrl);this.workers.active.add(j.id);this.lastOwner=j.owner;
      void this.drive(j.id,ctrl.signal).finally(()=>{releaseExecution(this.store,'image-job',j.id,token);this.active.delete(j.id);this.workers.active.delete(j.id);for(const client of this.workers.clients)client.pump();});}
  }
  async drive(jobId:string,signal:AbortSignal){let j=this.store.get('image-job',jobId)!,p=this.store.get('image-plan',j.planId)!;
    try{
      if(j.state==='queued'){
        j=this.update(j,{state:'preparing'});const excluded:string[]=(j.modelRejections??[]).map((r:Doc)=>r.modelId).filter(Boolean);
        for(;;){
        if(p.imageSelection){p=await this.selectQueued(p,j,excluded);j=this.store.get('image-job',jobId)!;}
        const c=this.store.get('video-channel-version',j.channelRevision)!;
        this.validate(p,this.store.get('user',j.owner)!);const urls:string[]=[];
        for(const a of p.assets){await this.media.verify(a.mediaId,a.sha256,signal);if(!['multipart-edits','chat-images'].includes(p.model.imageRoute))urls.push(await this.storage.prepare(a,p.storageRevision,signal));}
        this.validate(p,this.store.get('user',j.owner)!);signal.throwIfAborted();const key=this.catalog.secret(c);
        j=this.update(j,{state:'submitting',createAttempts:(j.createAttempts??0)+1,submissionDisposition:'sent',submitIntentAt:now(),dispatchInputs:[...(j.dispatchInputs??[]),dispatchInputIntent(this.store,'image',j,p)]});
        try{const receipt=await this.adapter.create(c,key,p,this.media,urls,signal);j=this.update(j,{receipt,state:'downloading',responseReceivedAt:now()});break;}
        catch(error){
          if(!(error instanceof ImageModelUnavailable)||!p.imageSelection)throw error;
          excluded.push(p.model.id);j=this.update(j,{state:'preparing',submissionDisposition:'not_sent',modelRejections:[...(j.modelRejections??[]),{modelId:p.model.id,model:p.model.name,at:now()}]});
          await this.refreshModels(this.store.get('user',j.owner)!,true);
        }
        }
      }
      requireThat(Array.isArray(j.receipt?.data)&&j.receipt.data.length===1,'图片回执没有唯一原图，需核对已有响应',502);const item=j.receipt.data[0];let source:Readable;
      if(!j.mediaId){
        await withImageDownload(async()=>{
        j=this.update(j,{downloadAttempts:(j.downloadAttempts??0)+1,downloadStartedAt:now()});
        if(typeof item.b64_json==='string'){requireThat(item.b64_json.length<=Math.ceil(MAX_IMAGE/3)*4&&/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json),'原图编码或大小无效',502);source=Readable.from([Buffer.from(item.b64_json,'base64')]);}
        else {requireThat(typeof item.url==='string','回执缺少原图',502);source=await this.adapter.download(item.url,signal);}
        const m=await this.media.ingest(source,j.owner,'private','generated-original.png',signal);this.store.put('media',{...m,generated:true,provenance:'generated_image'});j=this.update(j,{mediaId:m.id,mediaSHA256:m.sha256,bytes:m.bytes,downloadCompletedAt:now()});
        },signal);
      }
      const m=this.media.get(j.mediaId);requireThat(m.mime.startsWith('image/'),'接口返回内容不是图片',422);await this.media.verify(j.mediaId,j.mediaSHA256,signal);
      // Generation can use 500 slots; expensive local decoders share the existing fair queue.
      const releaseCheck=await this.workers.checks.acquire(j.owner,signal,'image-validation');
      let size:any;try{
      const {stdout}=await run('ffprobe',['-v','error','-show_entries','stream=width,height','-of','json',this.media.path(j.mediaId)],{signal,timeout:30000});size=JSON.parse(stdout).streams?.[0];requireThat(size?.width>0&&size?.height>0,'原图尺寸检查失败',422);
      if(p.payload.size){
       const [w,h]=p.payload.size.split('x').map(Number);
       const aligned=Math.abs(size.width-w)<=16&&Math.abs(size.height-h)<=16&&Math.abs(size.width/size.height-w/h)<0.02;
       requireThat(p.payload.size===`${size.width}x${size.height}`||aligned,'原图尺寸与确认方案不符，保留原件待核对',422);
      }
      else if(!p.model.providerDefaults) {const [w,h]=p.params.aspect_ratio.split(':').map(Number);requireThat(Math.abs(size.width/size.height-w/h)<0.02,'原图画幅与方案不符',422);}
      await run('ffmpeg',['-nostdin','-v','error','-xerror','-threads','1','-i',this.media.path(j.mediaId),'-f','null','-'],{signal,timeout:60000});
      }finally{releaseCheck();}
      this.update(j,{state:'ready',error:null,downloadError:null,nextRecoveryAt:null,finished:now(),technicalQA:{passed:true,width:size.width,height:size.height,sha256:m.sha256,...(p.payload.size?{requestedSize:p.payload.size,exactSizeMatch:p.payload.size===`${size.width}x${size.height}`}:{})},humanAcceptance:'pending'});
    }catch(e){j=this.store.get('image-job',jobId)!;if(j.state==='cancelled')return;
      if(e instanceof ImageRequestFailure&&[400,401,403,404,413,415,422].includes(e.httpStatus)){
        this.update(j,{state:'failed',providerReceipt:e.receipt,providerStatus:e.httpStatus,...providerFailure(e.receipt),error:e.message,finished:now(),nextRecoveryAt:null});return;
      }
      const state=j.state==='submitting'?'submission_unknown':j.receipt?'download_failed':'blocked';const failure=e as Error&{code?:string;downloadBytes?:number;downloadExpectedBytes?:number};
      const code=/^[A-Z_0-9]{1,48}$/.test(failure?.code??'')?failure.code:failure?.name==='AbortError'?'ABORT_ERR':'IMAGE_RECOVERY_FAILED';
      const detail=state==='download_failed'?{stage:j.mediaId?'checking':'downloading',code,receivedBytes:failure?.downloadBytes,expectedBytes:failure?.downloadExpectedBytes,at:now()}:undefined;
      const retry=state==='download_failed'&&retryImageDownload(j,e),nextRecoveryAt=retry?Date.now()+Math.min(60000,5000*2**Math.min(j.downloadAttempts??1,4)):null;
      this.update(j,{state,nextRecoveryAt,...(e instanceof ImageRequestFailure?{providerReceipt:e.receipt,providerStatus:e.httpStatus,providerErrorCode:providerFailure(e.receipt).providerErrorCode}:{}),...(detail?{downloadError:detail}:{}),error:state==='submission_unknown'?(e instanceof ImageRequestFailure?e.message+'；':'')+'图片提交结果待核对；不会自动重新生成':state==='download_failed'?`已收到生成回执，${e instanceof Problem?e.message:(j.mediaId?'原图检查失败':'原图下载中断')+'（'+code+'）'}；${retry?'主机将自动重试下载原图':'可恢复已有结果'}`:e instanceof Problem?e.message:'提交前检查失败，本轮未生成'});}
  }
}
