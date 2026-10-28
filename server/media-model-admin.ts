import { Store, hash, id, now, requireThat, type Doc } from './store.ts';
import { VideoCatalog, fields, text } from './video-catalog.ts';
import { imagePayload } from './image-generation.ts';
import { ImageSelection } from './image-selection.ts';

export const exclusionId=(channelId:string,remoteModel:string,kind:string)=>hash(JSON.stringify([channelId,remoteModel,kind]));
export class MediaModelAdmin{
  constructor(public store:Store,public catalog:VideoCatalog){}
  list(user:Doc){this.catalog.admin(user);return ['video','image'].flatMap(kind=>(kind==='image'?new ImageSelection(this.store,this.catalog).ordered(this.store.all('image-model')):this.store.all('video-model')).map((m:Doc):Doc=>({...m,kind,channelName:this.store.get('video-channel',m.channelId)?.name})));}
  remove(user:Doc,kind:string,modelId:string){
    this.catalog.admin(user);requireThat(['video','image'].includes(kind),'模型类型无效');const m=this.store.get(kind+'-model',modelId);
    if(!m){requireThat(this.store.all('media-model-exclusion').some(e=>e.kind===kind&&e.removedModelIds?.includes(modelId)),'模型不存在',404);return {removed:true};}
    this.store.tx(()=>{this.store.db.prepare('DELETE FROM docs WHERE kind=? AND id=?').run(kind+'-model',modelId);
      const key=exclusionId(m.channelId,m.remoteModel,kind),previous=this.store.get('media-model-exclusion',key);
      this.store.put('media-model-exclusion',{id:key,kind,channelId:m.channelId,remoteModel:m.remoteModel,removedModelIds:[...new Set([...(previous?.removedModelIds??[]),modelId])],removedBy:user.id,removedAt:now()});
      this.store.audit(user.id,'media.model.remove',modelId,{kind,remoteModel:m.remoteModel,historyRetained:true});
    });return {removed:true};
  }
  saveImage(user:Doc,b:Doc){
    this.catalog.admin(user);fields(b,['id','name','aliases','channelId','remoteModel','params','defaults','imageRoute','maxReferences','capabilityEvidence','status']);
    const previous=b.id?this.store.get('image-model',b.id):undefined;requireThat(!b.id||previous,'模型不存在',404);
    const c=this.store.get('video-channel',b.channelId);requireThat(c?.enabled&&c.verified&&['xiaopei','ruiyun'].includes(c.adapter),'请先接入并验证图片渠道',409);
    const remoteModel=text(b.remoteModel,'模型ID',240);requireThat(c.reachableModels?.includes(remoteModel),'该账号目录中没有此模型，请先同步目录',409);
    const name=text(b.name,'展示名称',100);requireThat(!this.store.all('image-model').some(m=>m.id!==b.id&&(m.name===name||m.channelId===c.id&&m.remoteModel===remoteModel)),'已有该名称或型号，请编辑原配置',409);
    requireThat(Array.isArray(b.aliases)&&b.aliases.length<=20&&b.aliases.every((a:unknown)=>typeof a==='string'&&a.trim()&&a.length<=100),'别名格式无效');
    requireThat(['multipart-edits','url-generations','url-edits'].includes(b.imageRoute),'当前尚未实现此图片协议');requireThat(['available','disabled'].includes(b.status),'模型状态无效');
    fields(b.params,['resolution','aspect_ratio']);fields(b.defaults,['resolution','aspect_ratio']);
    for(const key of ['resolution','aspect_ratio'])requireThat(Array.isArray(b.params[key])&&b.params[key].length>0&&b.params[key].length<=20&&b.params[key].every((v:unknown)=>typeof v==='string'&&v.length<=20)&&b.params[key].includes(b.defaults[key]),'图片参数或默认值无效');
    for(const resolution of b.params.resolution)for(const aspect_ratio of b.params.aspect_ratio)imagePayload({remoteModel,imageRoute:'multipart-edits'},'schema-check',{resolution,aspect_ratio});
    requireThat(Number.isInteger(b.maxReferences)&&b.maxReferences>=0&&b.maxReferences<=16,'参考原图上限须为0至16');const capabilityEvidence=text(b.capabilityEvidence,'协议核对依据',8000);
    const m={id:previous?.id??hash(JSON.stringify([c.id,remoteModel])),revision:id(),name,aliases:b.aliases.map((a:string)=>a.trim()),remoteModel,channelId:c.id,channelRevision:c.revision,params:b.params,defaults:b.defaults,imageRoute:b.imageRoute,maxReferences:b.maxReferences,status:b.status,capabilityEvidence,configuredBy:user.id,realValidation:'not_tested',updated:now(),managedBy:'admin'};
    this.store.tx(()=>{this.store.put('image-model',m);this.store.db.prepare('DELETE FROM docs WHERE kind=? AND id=?').run('media-model-exclusion',exclusionId(c.id,remoteModel,'image'));this.store.audit(user.id,'image.model.save',m.id,{remoteModel,revision:m.revision});});return m;
  }
}
