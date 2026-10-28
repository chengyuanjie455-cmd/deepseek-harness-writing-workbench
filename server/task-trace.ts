import {deliveryStatus,productionRecord} from './delivery-status.ts';
import {requireThat,type Store,type Doc} from './store.ts';
import {safeAuditDetail} from './audit-log.ts';
import {operationStates} from '../shared/operations.ts';
export function taskTrace(store:Store,kind:string,id:string){
 requireThat(['video-job','image-job','model-call','task'].includes(kind),'任务类型无效');const j=store.get(kind,id);requireThat(j,'任务不存在',404);
 const plan=j.planId?store.get(kind==='video-job'?'pickup':'image-plan',j.planId):undefined;
 const audits=store.db.prepare('SELECT action,created,detail FROM audit WHERE target IN (?,?) ORDER BY seq DESC LIMIT 120').all(j.id,plan?.id??j.task??j.id) as any[];
 const source=audits.find(a=>a.action==='native.video.generate'||a.action==='native.image.generate');let input:any;try{input=source&&JSON.parse(source.detail);}catch{}
 const states:Record<string,string>={...operationStates,ready:'结果已返回',adopted:'已采用',cancelled:'已取消',completed:'完成'};
 const stages:Doc[]=[{at:j.created,label:'任务建立',state:'created'},...(j.timeline??[]).map((e:Doc)=>({at:e.at,label:states[e.state]??e.state,state:e.state})),
 ...[['submitIntentAt','向供应商提交'],['responseReceivedAt','收到供应商回执'],['remoteCompletedAt','供应商完成'],['downloadStartedAt','开始下载'],['downloadCompletedAt','原片下载完成'],['finished','本轮处理结束'],['adoptedAt','成员采用']].flatMap(([field,label])=>j[field]?[{at:j[field],label,state:field}]:[])];
 return safeAuditDetail({delivery:deliveryStatus(j),production:productionRecord(store,kind,j),id,kind,project:j.project??plan?.project??'shared',owner:j.owner,model:j.modelName??j.model,source:input?{messageId:input.sourceMessageId,session:input.session,text:input.sourceText}:null,planId:plan?.id,previousPlanId:plan?.previousPlanId,template:plan?.promptTemplate??plan?.template,remoteTaskId:j.remoteTaskId,mediaId:j.mediaId,state:j.state,attempts:{submit:j.createAttempts??0,poll:j.pollAttempts??0,download:j.downloadAttempts??0},resolution:j.resolution,stages:stages.filter(s=>s.at).sort((a,b)=>a.at.localeCompare(b.at)),audit:audits.reverse().map(a=>({action:a.action,at:a.created}))});
}
