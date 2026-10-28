import {Store,requireThat,now,type Doc} from './store.ts';
import type {ImageSelection} from './image-selection.ts';

export function memberModelAllowed(store:Store,user:Doc,kind:'video'|'image',modelId:string){
 const policy=store.get('member-model-policy',store.projectId??'shared');
 return user.role==='admin'||policy?.[kind]===undefined||policy[kind].includes(modelId);
}
export class MemberModels {
 constructor(public store:Store,public selection?:ImageSelection){}
 list(user:Doc){requireThat(user.role==='admin','仅管理员可配置模型',403);const id=this.store.projectId??'shared',policy=this.store.get('member-model-policy',id);const models=['video','image'].flatMap(kind=>(kind==='image'&&this.selection?this.selection.ordered(this.store.all('image-model')):this.store.all(kind+'-model')).map(m=>({id:m.id,name:m.name,kind,status:m.status})));return {models,policy:{video:policy?.video??models.filter(m=>m.kind==='video').map(m=>m.id),image:policy?.image??models.filter(m=>m.kind==='image').map(m=>m.id)}};}
 save(user:Doc,b:Doc){requireThat(user.role==='admin','仅管理员可配置模型',403);requireThat(Object.keys(b).every(k=>['video','image'].includes(k)),'模型范围字段无效');for(const kind of ['video','image'])requireThat(Array.isArray(b[kind])&&b[kind].every((v:unknown)=>typeof v==='string'&&this.store.get(kind+'-model',v)),'请选择目录中的模型');const p={id:this.store.projectId??'shared',video:[...new Set(b.video)],image:[...new Set(b.image)],updated:now()};this.store.put('member-model-policy',p);this.store.audit(user.id,'member.models.update',p.id,{video:p.video,image:p.image});return p;}
}
