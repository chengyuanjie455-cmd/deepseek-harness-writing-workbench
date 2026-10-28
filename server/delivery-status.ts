import type {Doc,Store} from './store.ts';
const elapsed=(a:unknown,b:unknown)=>{const x=Date.parse(String(a??'')),y=Date.parse(String(b??''));return Number.isFinite(x)&&Number.isFinite(y)&&y>=x?y-x:null;};
export function deliveryStatus(job:Doc){
 const state=job.state,available=['ready','adopted'].includes(state)&&!!job.mediaId;
 const stage=available?'available':state==='download_failed'&&job.mediaId?'checking_failed':state==='submission_unknown'?'unconfirmed':state==='queued'?'queued':state==='preparing'?'preparing':state==='submitting'?'submitting':state==='running'?'generating':state==='downloading'||state==='download_failed'?'downloading':state==='checking'||state==='qa_failed'?'checking':state;
 const labels:Record<string,string>={available:'原件已保存，可查看下载',checking_failed:'原件已保存，核验未通过',unconfirmed:'提交结果待核对',queued:'等待执行',preparing:'准备素材',submitting:'正在发送供应商',generating:'供应商生成中',downloading:'正在下载原件',checking:'正在检查原件',failed:'生成失败',blocked:'提交未完成',cancelled:'已取消'};
 return {stage,label:labels[stage]??stage,providerCompleted:!!(job.remoteCompletedAt||job.responseReceivedAt||job.receipt?.data),originalSaved:!!job.mediaId,available,availableAt:available?job.finished??null:null,checkedAt:job.updated??job.created,deliveryLagMs:elapsed(job.remoteCompletedAt??job.responseReceivedAt,available?job.finished:undefined),totalMs:elapsed(job.created,available?job.finished:undefined),error:job.error??null};
}
export function deliveryMetrics(store:Store,clock=Date.now()){
 const since=new Date(clock-86400000).toISOString();
 const jobs=[...store.select('video-job',{states:['running','submitting','submission_unknown','downloading','checking','download_failed']}),...store.select('image-job',{states:['submitting','submission_unknown','downloading','checking','download_failed']})];
 const delivered=[...store.select('video-job',{states:['ready','adopted'],since}),...store.select('image-job',{states:['ready'],since})].filter(j=>deliveryStatus(j).available),lags=delivered.map(j=>deliveryStatus(j).deliveryLagMs).filter((n):n is number=>n!==null).sort((a,b)=>a-b);
 return {windowHours:24,delivered:delivered.length,deliveryP95Ms:lags.length?lags[Math.ceil(lags.length*.95)-1]:null,awaitingDownload:jobs.filter(j=>!deliveryStatus(j).available&&!!(j.remoteCompletedAt||j.receipt?.data)).length,unknownSubmissions:jobs.filter(j=>j.state==='submission_unknown').length,generatedButNotDelivered:jobs.filter(j=>!deliveryStatus(j).available&&!!(j.remoteCompletedAt||j.responseReceivedAt)).length};
}
export function productionRecord(store:Store,kind:string,job:Doc){
 const plan=job.planId?store.get(kind==='video-job'?'pickup':'image-plan',job.planId):undefined;if(!plan)return null;
 const shots=kind==='video-job'?(plan.shots??[]).filter((s:Doc)=>s.source?.id===job.sourceId):[plan];
 return {planId:plan.id,previousPlanId:plan.previousPlanId??null,session:plan.nativeSession??plan.session,script:plan.parsed?.script??null,notes:plan.parsed?.notes??plan.originalInput??null,skill:plan.skill??null,model:{id:plan.model?.id,name:plan.model?.name,remoteModel:plan.model?.remoteModel,revision:plan.model?.revision,channelRevision:plan.channelRevision},shots:shots.map((s:Doc)=>({sourceId:s.source?.id,prompt:s.prompt,params:s.params,assets:(s.assets??[]).map((a:Doc)=>({id:a.id,mediaId:a.mediaId,name:a.name,role:a.role,sha256:a.sha256,bytes:a.bytes})),source:s.source?{scriptQuote:s.source.scriptQuote,storyboardQuote:s.source.storyboardQuote}:undefined})),result:{mediaId:job.mediaId,sha256:job.mediaSHA256,seconds:job.technicalQA?.duration},delivery:deliveryStatus(job)};
}
