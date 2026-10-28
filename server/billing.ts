import {Store,hash,id,now,requireThat,type Doc} from './store.ts';
import {modelPricing} from './model.ts';
import {estimateUsd} from './chat-wire.ts';
import {chatProvider} from '../shared/chat-providers.ts';
import {billingPeriod,withinPeriod,summarizeBilling,billingTotals,type BillingPeriod} from './billing-summary.ts';
import type {ChatCatalog} from './chat-catalog.ts';
import {fields,text} from './video-catalog.ts';

// All ordinary API responses, including those requested by an admin in chat,
// omit accounting. Stored execution snapshots and administrator routes retain it.
const financialFields=new Set(['pricing','pricePerSecond','pricePerImage','currency','estimate','cost','estimatedUsd','reservedUsd','usedEstimateUsd','dailyUsd','taskUsd','budget','budgetMode','onlineBudgetEnabled','pricingStale','billing','priceReview','reconciliation']);
export function publicResponse(_key:string,value:unknown){return financialFields.has(_key)?undefined:value;}

// Submission evidence takes precedence over a terminal UI state. Legacy records
// without sufficient evidence stay billable/pending reconciliation, never free.
function submitted(kind:string,j:Doc){
  if(kind==='model-call'&&j.routingLogical&&j.state==='routing_failed')return false;
  if(kind!=='model-call'){
    if(j.state==='cancelled'&&j.resolution?.outcome==='not_submitted'&&!j.remoteTaskId)return false;
    if(j.remoteTaskId||j.receipt||j.submissionDisposition==='sent'||['submitting','submission_unknown'].includes(j.state))return true;
    if(j.submissionDisposition==='not_sent')return false;
    if(j.createAttempts===0&&['preparing','blocked','failed','cancelled'].includes(j.state))return false;
  }
  return !['queued','cancelled_before_send'].includes(j.state)&&!(j.state==='cancelled'&&!j.remoteTaskId&&!j.createAttempts);
}

/** Human reconciliation only: estimates and provider bills remain separate. */
export class Billing {
  constructor(private store:Store,private catalog:ChatCatalog){}
  private admin(user:Doc){requireThat(this.store.get('user',user.id)?.active&&this.store.get('user',user.id)?.role==='admin','仅管理员可查看和核对计费',403);}
  prices():Doc[]{
    const models:Doc[]=[...this.catalog.all().filter(m=>m.connection).map(m=>({key:'text:'+m.id,kind:'text',name:m.name,model:m.connection!.model,pricing:modelPricing(m.connection!),unit:m.connection!.provider==='zhipu-coding'?'套餐额度（非按量单价）':'每百万 token',version:m.connection!.configId})),
      ...['video','image'].flatMap(kind=>this.store.all(kind+'-model').map(m=>({key:kind+':'+m.id,kind,name:m.name,model:m.remoteModel,channel:m.channelId?this.store.get('video-channel',m.channelId)?.name:undefined,unit:kind==='video'?'每秒':'每张',pricing:{currency:m.currency??'CNY',amount:kind==='video'?(m.pricePerSecond??null):(m.pricePerImage??null)},version:m.revision})))];
    return models.map(m=>{const fingerprint=hash(JSON.stringify(m)),review=this.store.get('billing-price-review',m.key);return {...m,fingerprint,priceReview:review?{...review,stale:review.fingerprint!==fingerprint}:null};});
  }
  private entries(){
    return ['model-call','video-job','image-job'].flatMap(kind=>this.store.all(kind).filter(j=>!(kind==='model-call'&&j.routingLogical&&j.state==='routing_failed')).map(j=>{
      const task=kind==='model-call'&&j.task?this.store.get('task',j.task):undefined;
      const project=j.project??task?.project??'shared';
      const plan=j.planId?(kind==='video-job'?this.store.get('pickup',j.planId):kind==='image-job'?this.store.get('image-plan',j.planId):undefined):undefined;
      const shot=plan?.shots?.find((s:Doc)=>s.source.id===j.sourceId);
      const category=kind==='model-call'?'text':kind==='video-job'?'video':'image';
      const model=plan?.model??this.store.get(category+'-model',j.modelId??'');
      const providerKey=category==='text'?(j.provider??'unknown'):(j.channelId??model?.channelId??'unknown');
      const providerName=category==='text'?(chatProvider(providerKey)?.name??providerKey):(this.store.get('video-channel',providerKey)?.name??model?.channelName??'历史供应商');
      const modelKey=category==='text'?(j.model??'unknown'):(j.payload?.model??model?.remoteModel??j.modelId??j.modelName??'unknown');
      const wasSubmitted=submitted(kind,j);
      const quantity=category==='video'?(j.payload?.seconds??shot?.params?.seconds):category==='image'?(j.payload?.n??plan?.payload?.n??1):undefined;
      const historical=plan?.model;
      const pricing=j.pricing??(historical?{pricePerSecond:historical.pricePerSecond??null,pricePerImage:historical.pricePerImage??null,currency:historical.currency??'CNY'}:undefined);
      const valid=(n:any)=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
      let estimate=kind==='model-call'?{amount:j.estimatedUsd??(j.usage&&pricing?estimateUsd(pricing,j.usage.inputTokens+(j.usage.cacheWriteTokens??0),j.usage.cacheReadTokens??0,j.usage.outputTokens):undefined)??null,currency:j.pricing?.currency??'USD'}:category==='video'?{amount:valid(historical?.pricePerSecond)&&valid(quantity)?historical.pricePerSecond*quantity:shot?.estimate?.amount??null,currency:shot?.estimate?.currency??j.cost?.currency??model?.currency??'CNY'}:{amount:valid(historical?.pricePerImage)&&valid(quantity)?historical.pricePerImage*quantity:plan?.estimate?.amount??null,currency:plan?.estimate?.currency??j.cost?.currency??model?.currency??'CNY'};
      if(pricing?.billingMode==='subscription')estimate={...estimate,amount:null};
      if(!wasSubmitted)estimate={...estimate,amount:0};

      const key=kind+':'+j.id, reconciliation=this.store.get('billing-reconciliation',key);
      return {key,kind,category,providerKey,providerName,modelKey,submitted:wasSubmitted,quantity,billingMode:pricing?.billingMode==='subscription'?'subscription':'usage',simulated:!!(j.simulated||j.fixture),id:j.id,project,projectName:this.store.get('project',project)?.name??project,owner:j.owner,member:this.store.get('user',j.owner)?.name??j.owner,model:j.modelName??model?.name??j.model??'历史未分类模型',state:j.state,created:j.created,remoteTaskId:j.remoteTaskId,sourceId:j.sourceId,usage:j.usage,pricing,estimate,reservedUsd:j.reservedUsd,reconciliation:reconciliation??null,reviewVersion:reconciliation?.revision??null};
    })).sort((a,b)=>String(b.created??'').localeCompare(String(a.created??'')));
  }
  list(user:Doc,options:Doc={}){this.admin(user);const period=billingPeriod(options.from??'',options.to??''),entries=this.entries(),groups=summarizeBilling(entries,period,key=>this.store.get('billing-model-reconciliation',key));return {scope:'all_projects',period,timezone:'Asia/Shanghai',prices:this.prices(),groups,totals:billingTotals(groups),...(options.details?{entries:entries.filter(e=>withinPeriod(e,period))}:{})};}
  reconcileModel(user:Doc,b:Doc){
    this.admin(user);fields(b,['key','fingerprint','reviewVersion','amount','currency','evidence','from','to']);
    const period=billingPeriod(b.from??'',b.to??''),group=this.list(user,period).groups.find(g=>g.key===b.key);requireThat(group,'模型汇总不存在，请刷新列表',404);
    requireThat(group.fingerprint===b.fingerprint,'模型用量或费用记录已变化，请刷新后核对新的汇总',409);
    requireThat(group.reviewVersion===b.reviewVersion,'核对记录已被更新，请刷新后再保存',409);
    requireThat(typeof b.amount==='number'&&Number.isFinite(b.amount)&&b.amount>=0&&b.amount<=1e9,'请输入有效的模型账单总额');requireThat(b.currency===group.currency&&['CNY','USD'].includes(b.currency),'核对币种必须与模型汇总一致');
    const evidence=text(b.evidence,'模型账单核对依据',2000),review={id:b.key,revision:id(),key:b.key,fingerprint:group.fingerprint,period,kind:group.kind,model:group.model,provider:group.provider,requestCount:group.requestCount,usage:group.usage,estimate:group.estimate,amount:b.amount,currency:b.currency,evidence,verifiedBy:user.id,verifiedByName:user.name,verifiedAt:now()};
    this.store.tx(()=>{this.store.put('billing-model-reconciliation',review);this.store.audit(user.id,'billing.model.verify',b.key,{...review,previous:group.reconciliation});});return review;
  }
  reviewPrice(user:Doc,b:Doc){
    this.admin(user);fields(b,['key','fingerprint','evidence']);const model=this.prices().find(m=>m.key===b.key);requireThat(model,'模型不存在',404);requireThat(model.fingerprint===b.fingerprint,'单价或模型配置已改变，请刷新后重新核对',409);
    requireThat(model.pricing.billingMode!=='unpriced','此模型尚无已核对单价，请按实际供应商账单核对调用记录',409);
    requireThat(model.pricing.billingMode!=='subscription','套餐用量按供应商核对，不适用按量单价确认',409);
    requireThat(model.kind==='text'||model.pricing.amount!==null,'单价尚未配置，请先在后台模型配置中填写已核对单价',409);
    const evidence=text(b.evidence,'价格核对依据（供应商价格页、账单或合同）',2000);
    const review={id:model.key,fingerprint:model.fingerprint,pricing:model.pricing,evidence,verifiedBy:user.id,verifiedByName:user.name,verifiedAt:now()};
    this.store.tx(()=>{this.store.put('billing-price-review',review);this.store.audit(user.id,'billing.price.verify',model.key,{...review});});return review;
  }
  reconcile(user:Doc,b:Doc){
    this.admin(user);fields(b,['key','reviewVersion','amount','currency','evidence']);
    const entry=this.entries().find(j=>j.key===b.key);requireThat(entry,'计费记录不存在',404);
    requireThat(entry.reviewVersion===b.reviewVersion,'核对记录已被更新，请刷新后再保存',409);
    requireThat(typeof b.amount==='number'&&Number.isFinite(b.amount)&&b.amount>=0&&b.amount<=1e9,'请输入有效的实际账单金额');requireThat(['CNY','USD'].includes(b.currency),'币种无效');
    const evidence=text(b.evidence,'账单核对依据',2000),review={id:id(),key:b.key,amount:b.amount,currency:b.currency,evidence,verifiedBy:user.id,verifiedByName:user.name,verifiedAt:now()};
    this.store.tx(()=>{this.store.put('billing-reconciliation',{...review,id:b.key,revision:review.id});this.store.audit(user.id,'billing.bill.verify',b.key,{...review,previous:entry.reconciliation});});
    return review;
  }
}
