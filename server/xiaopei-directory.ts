import { readFileSync } from 'node:fs';
import { Store, id, now, hash, requireThat, type Doc } from './store.ts';
import { VideoCatalog, XiaopeiAdapter, RuiyunAdapter, boundedJSON } from './video-catalog.ts';

import {ruiyunKind,ruiyunPricing} from './ruiyun-directory.ts';
const ruiyunContracts=JSON.parse(readFileSync(new URL('./data/ruiyun-contracts.json',import.meta.url),'utf8'));
const contracts = JSON.parse(readFileSync(new URL('./data/xiaopei-contracts.json', import.meta.url), 'utf8'));
export function xiaopeiKind(name: string, endpoints: string[] = []): 'image'|'video'|undefined {
  // The provider tags several GPT image models as openai-video; names/docs take precedence.
  if (contracts.models[name]?.kind) return contracts.models[name].kind;
  if (/gpt-image|gpt本地版|香蕉|豆姐图片|seedream/i.test(name)) return 'image';
  if (endpoints.includes('image-generation')) return 'image';
  if (endpoints.includes('openai-video') || /happyhorse|wan-?3|wang3|sd[-2.]|seedance|grok.*(?:video|1\.5)|omni|tuoluo-grok/i.test(name)) return 'video';
}

export class XiaopeiDirectory {
  constructor(public store:Store,public catalog:VideoCatalog) {}
  async sync(user:Doc,channelId:string) {
    this.catalog.admin(user);const c=this.store.get('video-channel',channelId);
    requireThat(c?.enabled&&['xiaopei','ruiyun'].includes(c.adapter),'请选择已启用的媒体渠道',409);
    const definitions=c.adapter==='ruiyun'?ruiyunContracts:contracts;
    const pricing=c.adapter==='ruiyun'?await ruiyunPricing(c.origin):undefined;
    const classified=new Map((pricing?.data??[]).map((m:Doc)=>[m.model_name,ruiyunKind(m)]));
    const response=await (c.adapter==='ruiyun'?new RuiyunAdapter():new XiaopeiAdapter()).request(c,this.catalog.secret(c),'/v1/models',new AbortController().signal);
    const result=await boundedJSON(response);
    this.catalog.admin(user);requireThat(this.store.get('video-channel',c.id)?.revision===c.revision,'同步期间渠道已修改',409);
    requireThat(Array.isArray(result.data)&&result.data.length<=2000,'模型目录格式无效',502);
    const entries=result.data.filter((m:Doc)=>typeof m.id==='string'&&m.id.length>0&&m.id.length<=240);
    const refreshed={...c,verified:true,reachableModels:entries.map((m:Doc)=>m.id),checkedAt:now()};
    const counts={video:0,image:0,callableVideo:0,callableImage:0,needsAdapter:0};
    this.store.tx(()=>{
      this.store.put('video-channel',refreshed);this.store.put('video-channel-version',{...refreshed,id:c.revision,channelId:c.id});
      const observed=new Set<string>();
      for(const entry of entries){
        const kind=c.adapter==='ruiyun'?classified.get(entry.id):xiaopeiKind(entry.id,entry.supported_endpoint_types??[]);if(kind!=='image'&&kind!=='video')continue;
        counts[kind]++; const key=hash(JSON.stringify([c.id,entry.id]));observed.add(key);
        const contract=definitions.models[entry.id];const prev=this.store.get('xiaopei-directory',key);
        const adminVideo=kind==='video'?this.store.all('video-model').find(m=>m.channelId===c.id&&m.remoteModel===entry.id&&m.managedBy==='admin'):undefined;
        const configured=kind==='video'?this.store.all('video-model').find(m=>m.channelId===c.id&&m.remoteModel===entry.id&&['testing','published'].includes(m.status)&&m.channelRevision===c.revision):undefined;
        const excluded=this.store.get('media-model-exclusion',hash(JSON.stringify([c.id,entry.id,kind])));
        const configuredImage=kind==='image'?this.store.all('image-model').find(m=>m.channelId===c.id&&m.remoteModel===entry.id&&m.managedBy==='admin'):undefined;
        const supported=!!(adminVideo||configured||configuredImage||!excluded&&contract&&!contract.blockedReason);
        const row={id:key,channelId:c.id,channelName:c.name,remoteModel:entry.id,kind,available:true,supported,checkedAt:now(),blockedReason:supported?'':contract?.blockedReason??'当前账号提供此型号，但公开资料尚未明确该型号的参数／接口；需超管补充适配后才能提交',contractVersion:definitions.version};
        this.store.put('xiaopei-directory',row);
        if(!supported){counts.needsAdapter++;continue;}
        counts[kind==='video'?'callableVideo':'callableImage']++;
        if(kind==='image'&&configuredImage||kind==='video'&&adminVideo)continue;
        if(kind==='video'){
          if(configured&&!(c.adapter==='ruiyun'&&contract&&configured.directoryId)){for(const m of this.store.all('video-model').filter(m=>m.channelId===c.id&&m.remoteModel===entry.id&&['testing','published'].includes(m.status)&&m.channelRevision===c.revision)){const capabilityHash=m.directoryId?hash(JSON.stringify([m.channelRevision,m.remoteModel,m.params,m.defaults,m.secondsType,m.durations,m.referenceField,m.maxReferences,m.capabilityEvidence,...(m.unifiedMedia?[m.modes,m.maxVideoReferences,m.maxAudioReferences,m.durationPolicy,m.parameterPolicy]:[])])):m.capabilityHash;this.store.put('video-model',{...m,memberAccess:true,capabilityHash,...(capabilityHash!==m.capabilityHash?{revision:id()}: {})});}continue;}
          const previous=this.store.all('video-model').find(m=>m.directoryId===key);
          // An explicit admin disable survives subsequent catalogue refreshes.
          const m:Doc={id:previous?.id??id(),revision:previous?.revision??id(),directoryId:key,name:entry.id,aliases:[],channelId:c.id,channelRevision:c.revision,remoteModel:entry.id,status:previous?.status==='disabled'?'disabled':'testing',memberAccess:true,default:false,...contract,secondsType:c.adapter==='ruiyun'?'string':'number',referenceField:contract.maxReferences?'images':'none',capabilityEvidence:`${c.adapter==='ruiyun'?'瑞云':'小裴'}协议目录 ${definitions.checkedAt}；尚未逐型号真实出片验收`,pricePerSecond:null,currency:'CNY',created:previous?.created??now(),author:user.id};
          m.contractVersion=definitions.version;
          m.capabilityHash=hash(JSON.stringify([m.channelRevision,m.remoteModel,m.params,m.defaults,m.secondsType,m.durations,m.referenceField,m.maxReferences,m.capabilityEvidence,...(m.unifiedMedia?[m.modes,m.maxVideoReferences,m.maxAudioReferences,m.durationPolicy,m.parameterPolicy]:[])]));
          const changed=previous&&(previous.channelRevision!==m.channelRevision||JSON.stringify(previous.params)!==JSON.stringify(m.params)||c.adapter==='ruiyun'&&previous.contractVersion!==definitions.version);if(changed)m.revision=id();
          this.store.put('video-model',m);
        }else{
          const previous=this.store.get('image-model',key);
          const identity=hash(JSON.stringify([c.revision,entry.id,contract]));
          this.store.put('image-model',{id:key,revision:previous?.identity===identity?previous.revision:id(),identity,name:entry.id,aliases:[],remoteModel:entry.id,channelId:c.id,channelRevision:c.revision,status:previous?.status==='disabled'?'disabled':'available',...contract,realValidation:'not_tested',checkedAt:now()});
        }
      }
      for(const previous of this.store.all('xiaopei-directory').filter(d=>d.channelId===c.id&&!observed.has(d.id))){this.store.put('xiaopei-directory',{...previous,available:false,supported:false,blockedReason:'此账号最新目录已不再提供该模型',checkedAt:now()});}
      this.store.audit(user.id,'xiaopei.directory.sync',c.id,counts);
    });
    return {checkedAt:now(),...counts};
  }
  list(){return this.store.all('xiaopei-directory').filter(d=>this.store.get('video-channel',d.channelId)?.enabled&&(!this.store.get('media-model-exclusion',hash(JSON.stringify([d.channelId,d.remoteModel,d.kind])))||this.store.all(d.kind+'-model').some(m=>m.channelId===d.channelId&&m.remoteModel===d.remoteModel)));}
  images():Doc[]{return this.store.all('image-model').filter(m=>m.status==='available'&&this.store.get('video-channel',m.channelId)?.enabled&&this.store.get('video-channel',m.channelId)?.verified&&this.store.get('video-channel',m.channelId)?.revision===m.channelRevision&&this.store.get('video-channel',m.channelId)?.reachableModels?.includes(m.remoteModel)).map(m=>{const {capabilityEvidence,...safe}=m;return {...safe,channelName:this.store.get('video-channel',m.channelId)?.name};});}
}
