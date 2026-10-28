import {executionActive} from './media-execution.ts';
import {deliveryMetrics} from './delivery-status.ts';
import {imageCapacity} from './concurrency.ts';
import {videoCapacity,channelCapacity} from './concurrency.ts';
import {operationalHealth} from './operational-health.ts';
import {now,requireThat,hash,type Doc} from './store.ts';
import {Billing} from './billing.ts';
import {operationStates,operationKinds} from '../shared/operations.ts';
import {safeAuditDetail} from './audit-log.ts';
import type {Platform} from './app.ts';
const key=(s:string)=>s.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();
const aliases:Record<string,string[]>={
 '【api调用】wan-3.0-720p':['wan3.0 720p','万相3.0 720p'],
 '官方wang3.0-480p':['wan3.0 480p','万相3.0 480p'],
 '【官方稳定版】sd2.0-480p-mini':['seedance mini 480p','seedanc mini 480p'],
 '【官方稳定版】sd2.0-720p-mini':['seedance mini 720p','seedanc mini 720p'],
 '官方h3-720p':['minimax h3 720p','海螺h3 720p']
};
/** Only presentation metadata is normalized; wire contracts, prices and history stay frozen. */
export function catalogPlan(app:Pick<Platform,'store'>){
 const all=app.store.all('video-model');const defaults=all.filter(m=>m.default&&['published','testing'].includes(m.status));const preferred=defaults.find(m=>m.status==='published')??defaults[0];
 const picked=new Set<string>();const desired:Doc[]=all.map(m=>{const additions=(!picked.has(m.remoteModel)&&['published','testing'].includes(m.status))?(aliases[m.remoteModel]??[]):[];if(additions.length)picked.add(m.remoteModel);const seen=new Set<string>([key(m.name)]);return {...m,default:m.id===preferred?.id,aliases:[...(m.aliases??[]),...additions].filter(a=>{const k=key(a);if(!k||seen.has(k))return false;seen.add(k);return true;})};});
 const claimed=new Map<string,Set<string>>();for(const m of desired)for(const a of [m.name,...m.aliases]){const k=key(a);if(!claimed.has(k))claimed.set(k,new Set());claimed.get(k)!.add(m.id);}
 const conflicts=[...claimed].filter(([,ids])=>ids.size>1).map(([alias,ids])=>({alias,models:[...ids]}));
 for(const m of desired)m.aliases=m.aliases.filter((a:string)=>claimed.get(key(a))!.size===1);
 const changes=desired.flatMap(m=>{const old=all.find(o=>o.id===m.id)!;return old.default!==m.default||JSON.stringify(old.aliases)!==JSON.stringify(m.aliases)?[{id:m.id,name:m.name,before:{default:old.default,aliases:old.aliases},after:{default:m.default,aliases:m.aliases}}]:[];});
 return {fingerprint:hash(JSON.stringify(all)),changes,conflicts,defaultModel:preferred?.name??null,missingAliasTargets:Object.keys(aliases).filter(v=>!all.some(m=>m.remoteModel===v))};
}
export function normalizeCatalog(app:Platform,user:Doc,fingerprint:string){const plan=catalogPlan(app);requireThat(plan.fingerprint===fingerprint,'模型目录已变化，请刷新后整理',409);app.store.tx(()=>{for(const c of plan.changes){const m=app.store.get('video-model',c.id)!;app.store.put('video-model',{...m,...c.after});app.store.audit(user.id,'catalog.presentation.normalize',m.id,c);} });return catalogPlan(app);}
export function operations(app:Platform,query=new URLSearchParams()){
 const store=app.store,at=Date.now(),users=store.all('user'),projects=store.all('project'),items:Doc[]=[];
 for(const kind of ['video-job','image-job','model-call','task'])for(const j of store.all(kind)){
  const task=kind==='model-call'&&j.task?store.get('task',j.task):undefined,project=j.project??task?.project??'shared',owner=j.owner??task?.owner;
  const ageMs=Math.max(0,at-Date.parse(j.updated??j.finished??j.started??j.created??now()))||0;let reason='',group='active';
  if(j.resolution&&['cancelled','failed'].includes(j.state)){if(query.get('taskStatus')!=='completed')continue;reason='已核对结案';group='completed';}
  else if(j.state==='queued'){reason='等待执行槽位';group='queued';}
  else if(j.state==='submission_unknown'){reason='提交结果不明，请先核对供应商原任务';group='attention';}
  else if(['blocked','failed','download_failed','qa_failed','interrupted','termination_unconfirmed'].includes(j.state)){reason=j.error??'任务异常';group='attention';}
  else if(kind==='model-call'&&(j.state==='unconfirmed'||j.completed===false&&j.providerStatus>=400)){group='attention';reason=j.providerStatus===402?'供应商余额或计费异常':j.providerStatus===429?'供应商限流':j.providerStatus===401||j.providerStatus===403?'供应商认证或模型权限异常':j.providerStatus>=500?'供应商服务异常':'调用已结束，供应商未返回完整用量';}
  else if(['preparing','running','submitting','pending','downloading','checking','cancel_requested','awaiting_candidate'].includes(j.state))reason=j.error??(j.state==='running'?'供应商正在处理，请等待返回结果':operationStates[j.state]);
  if(!reason&&query.get('taskStatus')==='completed'&&(['ready','adopted','cancelled','completed','cancelled_before_send'].includes(j.state)||j.completed)){reason='已结束，可查看完整记录';group='completed';}if(!reason)continue;
  const processing=executionActive(store,kind,j.id)||!!(kind==='image-job'?app.workspaces.get(project)?.images.active.has(j.id):app.workspaces.get(project)?.pickups.active.has(j.id));
  const action=kind==='video-job'&&!processing?(j.state==='submission_unknown'?'resolve_video':j.remoteTaskId&&['running','downloading','checking','qa_failed'].includes(j.state)?'resume':j.state==='blocked'&&j.submissionDisposition==='not_sent'&&j.createAttempts===0?'retry_before_send':null):kind==='image-job'&&!processing?(j.state==='submission_unknown'?'resolve_image':j.state==='download_failed'&&j.receipt?'resume':null):null;
  items.push({id:j.id,kind,kindName:operationKinds[kind],project,projectName:projects.find(p=>p.id===project)?.name??project,owner,member:users.find(u=>u.id===owner)?.name??'历史账号',state:j.state,stateLabel:operationStates[j.state]??(group==='attention'?'请求异常':j.state),group,model:j.modelName??j.model??'—',reason:safeAuditDetail(String(reason)),ageMs,remoteTaskId:j.remoteTaskId,action,processing,consecutiveErrors:j.consecutiveErrors??0,created:j.created,updated:j.updated??j.finished??j.started??j.created,createAttempts:j.createAttempts??0,pollAttempts:j.pollAttempts??0,downloadAttempts:j.downloadAttempts??0,providerStatus:j.providerStatus??null});
 }
 items.sort((a,b)=>['attention','queued','active'].indexOf(a.group)-['attention','queued','active'].indexOf(b.group)||b.ageMs-a.ageMs||a.id.localeCompare(b.id));
 const status=query.get('taskStatus')??'all',kind=query.get('taskKind')??'',owner=query.get('taskOwner')??'',project=query.get('taskProject')??'',search=(query.get('taskSearch')??'').trim().toLowerCase(),rawPage=query.get('taskPage')??'1';
 requireThat(['all','attention','queued','active','completed'].includes(status)&&(!kind||kind==='media'||kind in operationKinds),'任务筛选无效');requireThat(search.length<=200&&owner.length<=100&&project.length<=100,'任务筛选内容过长');requireThat(/^\d+$/.test(rawPage)&&Number.isSafeInteger(Number(rawPage))&&Number(rawPage)>0,'任务分页无效');
 const filtered=items.filter(j=>(status==='all'||j.group===status)&&(!kind||kind==='media'&&['video-job','image-job'].includes(j.kind)||kind===j.kind)&&(!owner||owner===j.owner)&&(!project||project===j.project)&&(!search||[j.id,j.remoteTaskId,j.member,j.model,j.projectName,j.reason].some(v=>String(v??'').toLowerCase().includes(search))));
 const pages=Math.max(1,Math.ceil(filtered.length/30)),page=Math.min(Number(rawPage),pages),environments=projects.flatMap(p=>app.native.list(p.id).map(i=>({...i,project:p.id,projectName:p.name}))),queue=app.textQueue.snapshot(),prices=new Billing(store,app.catalog).prices();
 return {delivery:deliveryMetrics(store),mediaWorker:app.mediaWorker?.snapshot()??{mode:'in_process'},health:operationalHealth(store,at,undefined,app.operationsMonitor.snapshot(at)),image:imageCapacity(store),checkedAt:now(),scope:'all_projects',service:{uptimeSeconds:Math.floor(process.uptime()),serverId:app.serverId,mode:app.options.model?'online':'mock',projectCount:projects.length,publicationIssues:[...app.workspaces.values()].filter(w=>w.projects.publication().state==='recovery_required').length},summary:{attention:items.filter(j=>j.group==='attention').length,queued:items.filter(j=>j.group==='queued').length,active:items.filter(j=>j.group==='active').length,mediaActive:items.filter(j=>['video-job','image-job'].includes(j.kind)&&j.group==='active').length,mediaQueued:items.filter(j=>['video-job','image-job'].includes(j.kind)&&j.group==='queued').length,environmentReady:environments.filter(i=>i.state==='ready').length,environmentSleeping:environments.filter(i=>i.state==='sleeping').length,connectedMembers:new Set(environments.filter(i=>i.clients>0&&i.state==='ready').map(i=>i.owner)).size},queue:{...queue,members:queue.members.map(m=>({...m,name:users.find(u=>u.id===m.owner)?.name??'历史账号'}))},configuredText:app.options.concurrency,testedText:store.get('runtime-concurrency','active')?.testedText??96,video:app.options.videoConcurrency,...videoCapacity(store,app.options.videoConcurrency!),channels:store.all('video-channel').map(c=>({id:c.id,name:c.name,...channelCapacity(store,c.id)})),idle:app.native.settings(),environments,items:filtered.slice((page-1)*30,page*30),pagination:{page,pages,total:filtered.length,limit:30},filters:{members:users.map(u=>({id:u.id,name:u.name??u.username,active:u.active})),projects:projects.map(p=>({id:p.id,name:p.name}))},catalog:catalogPlan(app),prices:{missing:prices.filter(p=>p.pricing.billingMode==='unpriced'||p.kind!=='text'&&p.pricing.amount===null).length,unreviewed:prices.filter(p=>!p.priceReview).length,stale:prices.filter(p=>p.priceReview?.stale).length},restore:store.get('runtime','latest-restore-drill')??null};
}
export async function recoverOperation(app:Platform,user:Doc,b:Doc){
 requireThat(['video-job','image-job'].includes(b.kind),'不支持此恢复对象');const j=app.store.get(b.kind,b.id);requireThat(j,'任务不存在',404);const ws=app.workspace(j.project??'shared');
 if(b.kind==='image-job'){if(b.action==='resolve_image')return ws.images.resolveUnknown(j.id,user,b);requireThat(b.action==='resume','恢复操作无效');const result=ws.images.recover(j.id,user);app.store.audit(user.id,'operations.recover',j.id,{kind:b.kind,action:b.action,project:j.project??'shared'});return result;}
 if(b.action==='resolve_video')return ws.pickups.resolveUnknown(j.id,user,{outcome:b.outcome,evidence:b.evidence});
 if(b.action==='associate')return ws.pickups.recover(user,j.id,{remoteTaskId:b.remoteTaskId,evidence:b.evidence});
 requireThat(!ws.pickups.active.has(j.id)&&!executionActive(app.store,'video-job',j.id),'此任务正在处理，请稍后核对',409);
 if(b.action==='retry_before_send'){requireThat(j.state==='blocked'&&j.submissionDisposition==='not_sent'&&j.createAttempts===0&&!j.remoteTaskId,'仅能重试已确认尚未发送的请求',409);ws.pickups.update(j,{state:'queued',retryAt:0,error:null,finished:null});}
 else {requireThat(b.action==='resume'&&j.remoteTaskId&&['running','downloading','checking','qa_failed'].includes(j.state),'仅能恢复原任务轮询、下载或检查',409);requireThat(j.state!=='qa_failed'||j.mediaId,'没有可重新检查的本地原片',409);ws.pickups.update(j,{state:j.mediaId?'checking':j.remoteCompletedAt?'downloading':'running',nextPoll:0,error:null});}
 app.store.audit(user.id,'operations.recover',j.id,{kind:b.kind,action:b.action,remoteTaskId:j.remoteTaskId,project:j.project??'shared'});ws.pickups.pump();return {resumed:true,id:j.id};
}
