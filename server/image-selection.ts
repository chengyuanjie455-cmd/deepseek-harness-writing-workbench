import {Store,Problem,requireThat,now,type Doc} from './store.ts';
import {VideoCatalog,XiaopeiAdapter,RuiyunAdapter,apiEndpoint,boundedJSON} from './video-catalog.ts';

const ORIGIN='https://api.aicopy.top',MAX_PRICE=.1,MAX_AGE=5*60_000;
const refreshes=new WeakMap<Store,Map<string,Promise<void>>>();

/** Only an explicit pre-generation model rejection permits another paid POST. */
export class ImageModelUnavailable extends Problem {
  constructor(){super(409,'供应商确认图片型号当前不可用');}
}
export function modelUnavailable(status:number,body:Doc){
  return [400,404,503].includes(status)&&!body?.id&&!body?.task_id&&!body?.data&&
    ['model_not_found','model_not_available','model_unavailable','no_available_channels'].includes(body?.error?.code);
}

/** Provider list prices are estimates, never administrator-attested invoices. */
export class ImageSelection {
  constructor(public store:Store,public catalog:VideoCatalog,public enabled=true){}
  managed(m:Doc){const c=this.store.get('video-channel',m.channelId);return this.enabled&&(c?.adapter==='xiaopei'&&c.origin===ORIGIN||c?.adapter==='ruiyun');}
  snapshot(m:Doc){const s=this.store.get('image-price-directory',m.channelId);return s?.channelRevision===m.channelRevision?s:undefined;}
  quote(m:Doc){const s=this.snapshot(m);return s?.models.includes(m.remoteModel)&&Object.hasOwn(s.prices,m.remoteModel)?s.prices[m.remoteModel] as number:undefined;}
  ordered(models:Doc[]){
    if(!this.enabled)return models;
    return models.map(m=>!this.managed(m)?m:{...m,defaults:{...m.defaults,...(m.params.resolution.includes('2k')?{resolution:'2k'}:{})},pricePerImage:this.snapshot(m)?.prices[m.remoteModel],currency:'CNY'})
      .sort((a,b)=>Number(a.status!=='available')-Number(b.status!=='available')||Number(!a.params.resolution.includes('2k'))-Number(!b.params.resolution.includes('2k'))||(a.pricePerImage??Infinity)-(b.pricePerImage??Infinity)||String(a.remoteModel).localeCompare(String(b.remoteModel))||a.id.localeCompare(b.id));
  }
  sorted(models:Doc[]){
    if(!this.enabled)return models;
    return this.ordered(models.filter(m=>!this.managed(m)||(this.quote(m)!==undefined||m.billingMode==='token')&&(this.store.get('video-channel',m.channelId)?.adapter==='ruiyun'||/^gpt-image/i.test(m.remoteModel)&&this.quote(m)!<=MAX_PRICE)));
  }
  async refresh(models:Doc[],force=false){
    const channels=[...new Set(models.filter(m=>this.managed(m)).map(m=>m.channelId))];
    const pending=refreshes.get(this.store.global)??new Map<string,Promise<void>>();refreshes.set(this.store.global,pending);
    await Promise.all(channels.map(async channelId=>{
      const c=this.store.get('video-channel',channelId),saved=this.store.get('image-price-directory',channelId);
      requireThat(c?.enabled&&c.verified,'图片渠道尚未启用',409);
      if(!force&&saved&&saved.channelRevision===c.revision&&Date.now()-Date.parse(saved.checkedAt)<MAX_AGE)return;
      let job=pending.get(channelId);
      if(!job){job=this.fetch(c).finally(()=>pending.delete(channelId));pending.set(channelId,job);}
      await job;
    }));
  }
  private async fetch(c:Doc){
    const signal=AbortSignal.timeout(15000);
    const [directory,pricing,status]=await Promise.all([
      (c.adapter==='ruiyun'?new RuiyunAdapter():new XiaopeiAdapter()).request(c,this.catalog.secret(c),'/v1/models',signal).then(boundedJSON),
      fetch(apiEndpoint(c.origin,'/api/pricing'),{signal,redirect:'error'}).then(boundedJSON),
      fetch(apiEndpoint(c.origin,'/api/status'),{signal,redirect:'error'}).then(boundedJSON)
    ]);
    requireThat(Array.isArray(directory.data)&&directory.data.length<=2000&&pricing.success===true&&Array.isArray(pricing.data),'暂时无法核对生图目录与单价，本轮未生成',502);
    const rate=status.data?.usd_exchange_rate;
    requireThat(status.data?.quota_display_type==='CNY'&&typeof rate==='number'&&Number.isFinite(rate)&&rate>0,'生图目录人民币计价信息无效，本轮未生成',502);
    const prices:Record<string,number>={};
    for(const row of pricing.data)if(typeof row.model_name==='string'&&(c.adapter==='ruiyun'||/^gpt-image/i.test(row.model_name))&&row.quota_type===1&&typeof row.model_price==='number'&&Number.isFinite(row.model_price)&&row.model_price>=0)prices[row.model_name]=row.model_price*rate;
    const current=this.store.get('video-channel',c.id);requireThat(current&&current.revision===c.revision&&current.enabled&&current.verified,'查价期间渠道已改变，请重试',409);
    this.store.put('image-price-directory',{id:c.id,channelRevision:c.revision,checkedAt:now(),pricingVersion:pricing.pricing_version,currency:'CNY',prices,models:directory.data.filter((m:Doc)=>typeof m.id==='string').map((m:Doc)=>m.id)});
  }
  pick(models:Doc[],requested:string|undefined,params:Doc={},references=0,excluded:string[]=[]){
    const compatible=this.sorted(models).filter(m=>this.managed(m)&&(this.quote(m)!==undefined||m.billingMode==='token')&&(this.store.get('video-channel',m.channelId)?.adapter==='ruiyun'||this.quote(m)!<=MAX_PRICE)&&!excluded.includes(m.id)&&references>=(m.minReferences??0)&&references<=m.maxReferences&&Object.entries(params).every(([key,value])=>m.params[key]?.includes(value)));
    if(params.resolution)compatible.sort((a,b)=>a.pricePerImage-b.pricePerImage||String(a.remoteModel).localeCompare(String(b.remoteModel))||a.id.localeCompare(b.id));
    const exact=requested&&requested!=='auto'?compatible.find(m=>m.id===requested||m.name===requested||m.remoteModel===requested||(m.aliases??[]).includes(requested)):undefined;
    if(requested&&requested!=='auto'&&!exact&&models.some(m=>this.store.get('video-channel',m.channelId)?.adapter==='ruiyun'))throw new Problem(409,'指定的瑞云图片型号或参数当前不可用，请重新选择；本轮未提交');
    const model=exact??compatible.find(m=>m.billingMode!=='token');
    requireThat(model,'当前没有符合项目要求的可用生图型号；已重新核对目录',409);
    return {model,params:{...model.defaults,...params}};
  }
}
