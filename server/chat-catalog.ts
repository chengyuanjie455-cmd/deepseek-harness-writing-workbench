import {existsSync,readFileSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {Store,requireThat,hash,id,now,type Doc} from './store.ts';
import {modelPolicy,type ModelConnection} from './model.ts';
import {chatProvider} from '../shared/chat-providers.ts';
import {discoverModels,modelProtocol} from './model-directory.ts';
import {AUTO_MODEL_ID,routingPolicy} from './model-routing.ts';
import {MagpieHost} from './magpie-host.ts';
import {SkillCatalog} from './skill-catalog.ts';

/** Administrator-owned model connections. Public projections never contain credentials. */
export class ChatCatalog {
  readonly magpie:MagpieHost;
  readonly skills:SkillCatalog;
  private records:Doc[]=[];
  private migrationAliases:Record<string,string>={};
  private removedProviders=new Set<string>();
  private connections=new Map<string,ModelConnection>();
  private file:string;
  constructor(private store:Store,private initial?:ModelConnection){
    this.skills=new SkillCatalog(store);
    this.magpie=new MagpieHost(store.root);
    this.file=join(store.root,'chat-model-connections.json');
    const aliases=join(store.root,'chat-model-route-aliases.json');
    if(existsSync(aliases)){
      const value=JSON.parse(readFileSync(aliases,'utf8'));
      requireThat(value&&typeof value==='object'&&!Array.isArray(value)&&Object.values(value).every(v=>typeof v==='string'),'模型迁移映射无效');
      this.migrationAliases=value;
    }
    const removals=join(store.root,'chat-provider-removals.json');
    if(existsSync(removals)){const providers=JSON.parse(readFileSync(removals,'utf8'));requireThat(Array.isArray(providers)&&providers.every(p=>typeof p==='string'),'已移除模型渠道配置无效');this.removedProviders=new Set(providers);}
    if(existsSync(this.file)){chmodSync(this.file,0o600);this.records=JSON.parse(readFileSync(this.file,'utf8'));}
    if(initial)this.connections.set(initial.configId,initial);
    for(const r of this.records)this.connections.set(r.connection.configId,r.connection);
  }
  removedProviderIds(){return [...this.removedProviders];}
  all(){return [{id:'default',name:this.initial?.model??'模拟模型',enabled:true,roles:['admin','member'],connection:this.initial},...this.records].filter(r=>!this.removedProviders.has(r.connection?.provider??''));}
  publicModels(){return this.all().map(r=>({id:r.id,name:r.name,enabled:r.enabled,roles:['admin','member'],provider:r.connection?.provider??'platform-mock',model:r.connection?.model??'foundation-v1',reasoningEffort:r.connection?.reasoningEffort??'off',baseURL:r.id==='default'?undefined:r.connection?.baseURL,hasKey:!!r.connection?.apiKey,protocol:r.connection?.protocol??modelProtocol(r.connection?.provider??'',r.connection?.model??'')}));}
  policy(project:string):Doc{return {...(this.store.get('chat-policy',project)??{id:project,modelIds:['default'],multipleSessions:true}),modelIds:this.publicModels().filter(m=>m.enabled).map(m=>m.id),permissions:['workspace-write']};}
  available(_user:Doc,project:string){const models=this.publicModels().filter(r=>r.enabled),policy=routingPolicy(this.store,project),primary=models.find(m=>m.id===policy.primaryModelId&&m.hasKey);return policy.enabled&&primary?[...models,{...primary,id:AUTO_MODEL_ID,name:'自动 · 首选与备用',model:'auto',provider:'platform-auto',baseURL:undefined}]:models;}
  modelConnection(modelId:string,project:string){const actual=modelId===AUTO_MODEL_ID?routingPolicy(this.store,project).primaryModelId:modelId;return this.all().find(r=>r.id===actual&&r.enabled)?.connection as ModelConnection|undefined;}
  options(user:Doc,project:string){return {models:this.available(user,project),permissions:this.policy(project).permissions,multipleSessions:this.policy(project).multipleSessions,skills:this.skills.public(user,project),defaultSkillId:this.skills.policy(project).defaultSkillId};}
  select(user:Doc,project:string,modelId?:string,permission?:string,skillId?:string){
    const allowed=this.available(user,project),model=allowed.find(r=>r.id===(this.migrationModel(modelId??'')??modelId??allowed[0]?.id));
    requireThat(model,'模型未启用或不存在，请从模型列表重新选择',403);
    const mode=permission??this.policy(project).permissions[0];
    requireThat(this.policy(project).permissions.includes(mode),'当前权限模式未获管理员开放',403);
    const connection=this.modelConnection(model.id,project);
    const skill=this.skills.select(user,project,skillId);
    return {modelId:model.id,permission:mode,skillId:skill.id,skillRevision:skill.version,skillHash:skill.sha256,...modelPolicy(connection)};
  }
  migrationModel(modelId:string){const target=this.migrationAliases[modelId];return target&&this.publicModels().some(m=>m.id===target&&m.enabled)?target:undefined;}
  connection(configId?:string){if(!configId)return undefined;const c=this.connections.get(configId);requireThat(c&&!this.removedProviders.has(c.provider),'原模型配置不可用，请重新选择模型',409);return c;}
  savePolicy(actor:Doc,project:string,b:Doc){
    requireThat(Array.isArray(b.modelIds)&&b.modelIds.length>0&&b.modelIds.every((v:any)=>typeof v==='string'&&this.publicModels().some(m=>m.id===v&&m.enabled)),'至少选择一个已启用模型');
    requireThat(Array.isArray(b.permissions)&&b.permissions.length===1&&b.permissions[0]==='workspace-write','项目权限固定为工作区内修改');
    requireThat(typeof b.multipleSessions==='boolean','多会话开关无效');
    const policy={id:project,modelIds:[...new Set(b.modelIds)],permissions:[...new Set(b.permissions)],multipleSessions:b.multipleSessions,updated:now()};
    this.store.tx(()=>{this.store.put('chat-policy',policy);this.store.audit(actor.id,'chat.policy.publish',project,{modelIds:policy.modelIds,permissions:policy.permissions,multipleSessions:policy.multipleSessions});});return policy;
  }
  private credential(b:Doc){
    requireThat(!this.removedProviders.has(b.provider),'此模型渠道已移除',409);
    const sourceId=b.sourceId??b.id;
    const source=sourceId?this.all().find(r=>r.id===sourceId):undefined;
    requireThat(!sourceId||source,'密钥来源不存在',404);
    requireThat(b.apiKey===undefined||typeof b.apiKey==='string','API 密钥格式无效');
    const reused=!b.apiKey?.trim()&&source?.connection?.provider===b.provider;
    const apiKey=b.apiKey?.trim()||(reused?source!.connection!.apiKey:undefined);
    requireThat(typeof apiKey==='string'&&apiKey.length>10&&apiKey.length<4096&&!/[\r\n]/.test(apiKey),'请输入有效 API 密钥，或选择本渠道已保存的密钥');
    return {apiKey,source,reused};
  }
  async directory(actor:Doc,b:Doc,fetcher:typeof fetch=fetch){
    const {apiKey}=this.credential(b),scope=hash(JSON.stringify([b.provider,hash(apiKey)]));
    const cached=this.store.get('model-directory',scope);
    if(cached&&!b.refresh)return cached;
    try{const result={id:scope,provider:b.provider,...await discoverModels(b.provider,apiKey,fetcher)};this.store.put('model-directory',result);this.store.audit(actor.id,'chat.models.sync',b.provider,{count:result.models.length});return result;}
    catch(e){if(cached)return {...cached,stale:true,warning:'刷新失败，显示上次成功获取的目录（'+cached.fetchedAt+'）；现有配置未变。'};throw e;}
  }
  saveModel(actor:Doc,b:Doc){
    requireThat(typeof b.name==='string'&&b.name.trim()&&b.name.length<=80,'请输入模型显示名称');
    const previous=b.id&&this.records.find(r=>r.id===b.id);requireThat(!b.id||previous,'模型不存在',404);
    const {apiKey,source}=this.credential(b);
    const preset=chatProvider(b.provider);requireThat(preset&&preset.baseURL===b.baseURL,'模型与渠道地址不匹配');
    const directory=this.store.get('model-directory',hash(JSON.stringify([b.provider,hash(apiKey)])));
    const metadata=directory?.models.find((m:Doc)=>m.id===b.model);
    requireThat(metadata?.selectable||b.enabled===false&&previous?.connection.model===b.model||!directory&&(preset.models as readonly string[]).includes(b.model),'请刷新 API 模型目录，并选择可用于聊天的模型');
    requireThat((metadata?.efforts??preset.efforts).includes(b.reasoningEffort),'此模型不支持该推理档位');
    // Keep legacy ownership as provenance only; it no longer restricts selection.
    const accountUserId=previous?.accountUserId??source?.accountUserId;
    requireThat(typeof b.enabled==='boolean','请选择启用状态');
    const connection:ModelConnection={provider:b.provider,model:b.model,reasoningEffort:b.reasoningEffort,baseURL:b.baseURL,apiKey,protocol:metadata?.protocol??modelProtocol(b.provider,b.model),metadata,configId:hash(JSON.stringify([b.provider,b.model,b.reasoningEffort,b.baseURL,hash(apiKey)]))};
    const record={id:previous?.id??id(),name:b.name.trim(),enabled:b.enabled,roles:['admin','member'],accountUserId,connection};
    const next=[...this.records.filter(r=>r.id!==record.id),record];
    const tmp=this.file+'.tmp';writeFileSync(tmp,JSON.stringify(next),{mode:0o600});renameSync(tmp,this.file);this.records=next;this.connections.set(connection.configId,connection);
    this.store.audit(actor.id,'chat.model.save',record.id,{name:record.name,provider:connection.provider,enabled:record.enabled});
    return this.publicModels().find(r=>r.id===record.id);
  }
}
