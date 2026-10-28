import {hash,requireThat,type Doc} from './store.ts';
export type BillingPeriod={from:string;to:string};
const day=86400000;
export function billingPeriod(from:unknown='',to:unknown=''):BillingPeriod {
 const valid=(v:unknown)=>typeof v==='string'&&(v===''||/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v);
 requireThat(valid(from)&&valid(to),'日期格式无效');requireThat(!from||!to||String(from)<=String(to),'结束日期不能早于开始日期');return {from:from as string,to:to as string};
}
export function withinPeriod(entry:Doc,p:BillingPeriod){const time=Date.parse(entry.created);return (!p.from||time>=Date.parse(p.from+'T00:00:00+08:00'))&&(!p.to||time<Date.parse(p.to+'T00:00:00+08:00')+day);}
const amount=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const round=(n:number)=>Number(n.toFixed(12));
/** Group immutable execution facts, never price all history with today's unit price. */
export function summarizeBilling(entries:Doc[],period:BillingPeriod,review:(key:string)=>Doc|undefined){
 const buckets=new Map<string,Doc[]>();
 for(const e of entries){if(!withinPeriod(e,period))continue;const key=hash(JSON.stringify([e.category,e.providerKey,e.modelKey,e.estimate.currency,e.billingMode,!!e.simulated,period.from,period.to]));const rows=buckets.get(key)??[];rows.push(e);buckets.set(key,rows);}
 return [...buckets].map(([key,rows])=>{
  rows.sort((a,b)=>a.key.localeCompare(b.key));const first=rows[0],known=rows.filter(e=>amount(e.estimate.amount)),legacy=rows.filter(e=>e.reconciliation),members=new Set(rows.map(e=>e.owner)),projects=new Set(rows.map(e=>e.project));
  const usage:Doc={inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,seconds:0,images:0,unknownCalls:0};
  for(const e of rows){if(e.category==='text'){if(!e.usage||!amount(e.usage.inputTokens)||!amount(e.usage.outputTokens)){if(e.submitted)usage.unknownCalls++;continue;}for(const k of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'])if(amount(e.usage[k]))usage[k]+=e.usage[k];}else if(e.submitted){if(e.category==='video'){if(amount(e.quantity))usage.seconds+=e.quantity;else usage.unknownCalls++;}else if(amount(e.quantity))usage.images+=e.quantity;else usage.unknownCalls++;}}
  usage.seconds=round(usage.seconds);
  const fingerprint=hash(JSON.stringify(rows.map(e=>[e.key,e.state,e.submitted,e.quantity,e.usage,e.estimate,e.pricing,e.reconciliation])));
  const saved=review(key),reconciliation:Doc|null=saved?{...saved,stale:saved.fingerprint!==fingerprint}:null;
  const legacyAmounts:Record<string,number>={};for(const e of legacy){const r=e.reconciliation;if(amount(r.amount))legacyAmounts[r.currency]=round((legacyAmounts[r.currency]??0)+r.amount);}
  const legacyComplete=legacy.length===rows.length&&Object.keys(legacyAmounts).length===1&&amount(legacyAmounts[first.estimate.currency]);
  return {key,kind:first.category,model:first.modelKey,name:first.model,provider:first.providerName,currency:first.estimate.currency,billingMode:first.billingMode,simulated:!!first.simulated,period,requestCount:rows.length,submittedCount:rows.filter(e=>e.submitted).length,memberCount:members.size,projectCount:projects.size,usage,estimate:{amount:known.length?round(known.reduce((s,e)=>s+e.estimate.amount,0)):null,knownCount:known.length,unknownCount:rows.length-known.length},legacy:{count:legacy.length,amounts:legacyAmounts,complete:legacyComplete},reconciliation,reviewVersion:saved?.revision??null,fingerprint,actualAmount:reconciliation&&!reconciliation.stale?reconciliation.amount:!reconciliation&&legacyComplete?legacyAmounts[first.estimate.currency]:null,firstAt:rows.map(e=>e.created).filter(Boolean).sort()[0],lastAt:rows.map(e=>e.created).filter(Boolean).sort().at(-1)};
 }).sort((a,b)=>['text','video','image'].indexOf(a.kind)-['text','video','image'].indexOf(b.kind)||a.provider.localeCompare(b.provider)||a.model.localeCompare(b.model));
}
export function billingTotals(groups:Doc[]){
 return ['text','video','image'].map(kind=>{const rows=groups.filter(g=>g.kind===kind&&!g.simulated),currencies=[...new Set(rows.map(g=>g.currency))];return {kind,modelCount:rows.length,requestCount:rows.reduce((s,g)=>s+g.requestCount,0),amounts:currencies.map(currency=>{const gs=rows.filter(g=>g.currency===currency),known=gs.filter(g=>amount(g.estimate.amount)),actual=gs.filter(g=>amount(g.actualAmount));return {currency,estimated:known.length?round(known.reduce((s,g)=>s+g.estimate.amount,0)):null,actual:actual.length?round(actual.reduce((s,g)=>s+g.actualAmount,0)):null,pendingModels:gs.length-actual.length,unknownEstimateCalls:gs.reduce((s,g)=>s+g.estimate.unknownCount,0)};})};});
}
