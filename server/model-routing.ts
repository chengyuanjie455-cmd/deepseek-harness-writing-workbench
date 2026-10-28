import {Store,requireThat,hash,id,now,type Doc} from './store.ts';
import type {ChatCatalog} from './chat-catalog.ts';
import type {ModelConnection} from './model.ts';
import {connectionEvidenceId,connectionMetadata,connectionModalities,nativeModelProfile} from './model-capabilities.ts';
import {fetchModel} from './model-transport.ts';
import {adaptChatRequest} from './chat-wire.ts';
import {modelProtocol} from './model-directory.ts';

export const AUTO_MODEL_ID='team-auto';
export type RoutingPolicy={id:string;engine:'native'|'magpie';enabled:boolean;primaryModelId:string;fallbackModelIds:string[];maxAttempts:number;firstOutputTimeoutMs:number;cooldownMs:number;revision:string};
const defaultPolicy=(project:string):RoutingPolicy=>({id:project,engine:'native',enabled:false,primaryModelId:'default',fallbackModelIds:[],maxAttempts:3,firstOutputTimeoutMs:60000,cooldownMs:30000,revision:'unconfigured'});
export function routingPolicy(store:Store,project:string):RoutingPolicy{return {...defaultPolicy(project),...store.get('model-routing-policy',project)};}
/** Whitelisted member readback; never returns credentials, another session,
 * request content, prices, or raw provider errors. */
export function publicModelRoute(store:Store,workspace:string,session:string){
 const scope=workspace+':'+session,row=store.db.prepare("SELECT body FROM docs WHERE kind='model-route' AND json_extract(body,'$.scope')=? ORDER BY rowid DESC LIMIT 1").get(scope) as any;
 const r=row?JSON.parse(row.body):undefined;if(!r)return {route:null};
 return {route:{id:r.id,engine:r.engine??'native',requested:r.requested,state:r.state,actualModel:r.actualModel,actualProvider:r.actualProvider,attempted:r.attempted,updated:r.updated,error:r.error,events:r.events.map((e:Doc)=>({modelId:e.modelId,state:e.state,reason:e.reason,status:e.status,stage:e.stage,at:e.at}))}};
}
export function saveRoutingPolicy(store:Store,catalog:ChatCatalog,actor:Doc,project:string,input:Doc){
 requireThat(actor.role==='admin','仅超级管理员可配置备用',403);
 requireThat(Object.keys(input).every(k=>['engine','enabled','primaryModelId','fallbackModelIds','maxAttempts','firstOutputTimeoutMs','cooldownMs'].includes(k)),'备用配置字段无效');
 const p={...defaultPolicy(project),engine:routingPolicy(store,project).engine,...input,id:project};
 requireThat(['native','magpie'].includes(p.engine),'模型调用引擎无效');
 requireThat(p.engine!=='magpie'||catalog.magpie.status().available,'内置 Magpie 尚未编译，请先构建主机运行模块',503);
 requireThat(typeof p.enabled==='boolean'&&typeof p.primaryModelId==='string'&&Array.isArray(p.fallbackModelIds)&&p.fallbackModelIds.every((v:unknown)=>typeof v==='string'),'备用配置无效');
 const available=catalog.all().filter(m=>m.enabled&&m.connection);
 requireThat(!p.enabled||available.some(m=>m.id===p.primaryModelId),'请选择已配置且启用的首选模型');
 requireThat(p.fallbackModelIds.every((v:string)=>available.some(m=>m.id===v)),'备用只能引用已配置且启用的连接');
 requireThat(new Set(p.fallbackModelIds).size===p.fallbackModelIds.length&&!p.fallbackModelIds.includes(p.primaryModelId),'备用顺序存在重复');
 requireThat(Number.isSafeInteger(p.maxAttempts)&&p.maxAttempts>=1&&p.maxAttempts<=16,'真实尝试次数须为1至16');
 requireThat(Number.isSafeInteger(p.firstOutputTimeoutMs)&&p.firstOutputTimeoutMs>=100&&p.firstOutputTimeoutMs<=300000,'首个有效输出超时范围无效');
 requireThat(Number.isSafeInteger(p.cooldownMs)&&p.cooldownMs>=0&&p.cooldownMs<=3600000,'故障冷却范围无效');
 const result={...p,revision:hash(JSON.stringify(p)),updated:now()};store.tx(()=>{store.put('model-routing-policy',result);store.audit(actor.id,'model.routing.publish',project,{...result});});return result;
}
type Candidate={id:string;connection:ModelConnection};
export type NativeContextPressure={tokens:number;revision:number;basis:'estimated'|'usage';source:'native-token-meter'};
export function nativeContextPressure(headers:Doc):NativeContextPressure|undefined{
 const raw=headers['x-team-native-context-tokens'],revision=headers['x-team-native-context-revision'],basis=headers['x-team-native-context-basis'];
 if(typeof raw!=='string'||!/^\d{1,10}$/.test(raw)||typeof revision!=='string'||!/^\d{1,10}$/.test(revision)||!['estimated','usage'].includes(basis))return;
 const tokens=Number(raw),seq=Number(revision);if(tokens>1e9||seq>1e9)return;
 return {tokens,revision:seq,basis,source:'native-token-meter'};
}
export type RouteFailureReceipt={modelId:string;configId:string;status?:number;stage:string;possiblyBilled:boolean;reason:string;started:string;finished:string;requestBytes:number;maxOutputTokens:number};
type Failure=RouteFailureReceipt;
export type RoutedResult={response:Response;connection?:ModelConnection;modelId?:string;routeId:string;failures:Failure[];attempted:number;requestBytes?:number;maxOutputTokens?:number};
class RouteFailure extends Error{constructor(public status:number,public stage:string,public retryable:boolean,public retryAfterMs=0){super(stage);}}
const retryable=(status:number)=>status===401||status===402||status===408||status===429||status>=500;
function retryAfter(value:string|null,clock:()=>number){if(!value)return 0;const seconds=Number(value);return Number.isFinite(seconds)?Math.max(0,seconds*1000):Math.max(0,Date.parse(value)-clock())||0;}
/** Read through role-only/heartbeat frames before committing any model output.
 * Once content, reasoning or tool parameters are visible, no fallback is allowed. */
async function firstOutput(response:Response,signal:AbortSignal):Promise<Response>{
 if(!response.body)throw new RouteFailure(502,'empty_stream',true);
 if(!response.headers.get('content-type')?.includes('text/event-stream'))throw new RouteFailure(502,'stream_protocol',false);
 const reader=response.body.getReader(),buffers:Uint8Array[]=[],decoder=new TextDecoder();let pending='',size=0;
 const abort=()=>void reader.cancel().catch(()=>{});signal.addEventListener('abort',abort,{once:true});
 try{
  while(true){signal.throwIfAborted();const value=await reader.read();signal.throwIfAborted();if(value.done)throw new RouteFailure(502,'empty_stream',true);
   buffers.push(value.value);size+=value.value.byteLength;if(size>1024*1024)throw new RouteFailure(502,'first_output_too_large',false);
   pending+=decoder.decode(value.value,{stream:true});let index;let committed=false;
   while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index).trim();pending=pending.slice(index+1);if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();
    if(data==='[DONE]')throw new RouteFailure(502,'empty_stream',true);
    let event:any;try{event=JSON.parse(data);}catch{continue;}
    if(event.error){const status=Number(event.error.status??event.error.statusCode??502),rejected=/content[_-]?(filter|policy)|safety|invalid[_-]?prompt/i.test(String(event.error.code??event.error.type??''));throw new RouteFailure(rejected?422:status,rejected?'provider_content_rejected':'upstream_stream_error',!rejected&&retryable(status));}
    if(event.choices?.some((c:any)=>c.delta?.refusal||c.finish_reason==='content_filter'))throw new RouteFailure(422,'provider_content_rejected',false);
    if(event.choices?.some((c:any)=>c.delta?.content||c.delta?.reasoning_content||c.delta?.tool_calls?.length)){committed=true;break;}
    if(event.choices?.some((c:any)=>c.finish_reason))throw new RouteFailure(502,'empty_stream',true);
   }
   if(committed)break;
  }
 }catch(e){await reader.cancel().catch(()=>{});throw e;}finally{signal.removeEventListener('abort',abort);}
 return new Response(new ReadableStream<Uint8Array>({start(controller){for(const b of buffers)controller.enqueue(b);},async pull(controller){try{signal.throwIfAborted();const v=await reader.read();signal.throwIfAborted();if(v.done)controller.close();else controller.enqueue(v.value);}catch(e){controller.error(e);}},cancel:()=>reader.cancel()}),{status:response.status,headers:response.headers});
}
export class ModelRouting {
 private probes=new Set<string>();
 constructor(private store:Store,private catalog:ChatCatalog,private transport=fetchModel,private clock:()=>number=Date.now){}
 policy(project:string){return routingPolicy(this.store,project);}
 private candidates(project:string,requested:string){
  const policy=this.policy(project),automatic=requested===AUTO_MODEL_ID,primary=automatic?policy.primaryModelId:requested;
  const rows=this.catalog.all().filter(m=>m.enabled&&m.connection),first=rows.find(m=>m.id===primary);
  requireThat(first,'当前首选模型已停用或未配置',503);
  const ids=policy.enabled?[primary,...policy.fallbackModelIds]:[primary];
  const seen=new Set<string>(),candidates:Candidate[]=[];
  for(const id of ids){const row=rows.find(m=>m.id===id);if(!row||!automatic&&row.connection.model!==first.connection.model)continue;const key=connectionEvidenceId(row.connection);if(seen.has(key))continue;seen.add(key);candidates.push({id,connection:structuredClone(row.connection)});}
  return {policy:structuredClone(policy),automatic,candidates};
 }
 private compatible(candidate:Candidate,body:Doc,first:boolean,pressure?:NativeContextPressure){
  if(first)return undefined;
  const c=candidate.connection,metadata=connectionMetadata(this.store,c);
  const images=(body.messages??[]).some((m:Doc)=>Array.isArray(m.content)&&m.content.some((p:Doc)=>p.type==='image_url'));
  if(images&&!connectionModalities(this.store,c).includes('image'))return 'image_capability_unverified';
  const tools=body.tools?.length;
  if(tools&&!metadata?.supportsTools&&!this.store.all('model-call').some(v=>v.connectionEvidenceId===connectionEvidenceId(c)&&v.completed&&v.toolCallsObserved))return 'tool_capability_unverified';
  if(body.reasoning_effort&&(!metadata?.efforts?.includes(body.reasoning_effort)))return 'reasoning_effort_unsupported';
  if(body.response_format&&body.response_format.type!=='text'&&(c.protocol??modelProtocol(c.provider,c.model))!=='chat')return 'structured_output_unverified';
  // Native compaction owns the token measurement, usage anchor and attachments.
  // Old/non-native callers keep the conservative byte bound; never trim input
  // or tool pairs to make a smaller route fit. Provider usage is authoritative.
  if(!metadata?.contextWindow)return 'context_window_unverified';
  const output=Math.min(body.max_tokens??4096,nativeModelProfile(this.store,{},c).maxTokens,c.limits?.maxTokens??Infinity),bytes=Buffer.byteLength(JSON.stringify({messages:body.messages,tools:body.tools}));
  if((pressure?.tokens??bytes)+output>metadata.contextWindow)return 'context_window_insufficient';
  return undefined;
 }
 async fetch(project:string,requested:string,body:Doc,signal:AbortSignal,scope:string,callId:string,stillAllowed:()=>boolean,onFailure:(receipt:Failure,connection:ModelConnection)=>void=()=>{},pressure?:NativeContextPressure):Promise<RoutedResult>{
  const {policy,automatic,candidates}=this.candidates(project,requested),routeId=id(),failures:Failure[]=[],events:Doc[]=[];let attempted=0,rejected=false;
  const save=(state:string,extra:Doc={})=>this.store.put('model-route',{id:routeId,project,scope,callId,requested,engine:policy.engine,mode:automatic?'automatic':'fixed_model',policyRevision:policy.revision,state,attempted,events,...(pressure?{contextPressure:pressure}:{}),created:this.store.get('model-route',routeId)?.created??now(),updated:now(),...extra});
  save('selecting');
  for(const [index,candidate] of candidates.entries()){
   signal.throwIfAborted();requireThat(stillAllowed(),'账号或项目已停用',403);
   if(attempted>=policy.maxAttempts)break;
   const c=candidate.connection,reason=this.compatible(candidate,body,index===0&&!automatic,pressure);
   const healthKey=connectionEvidenceId(c),health=this.store.get('model-route-health',healthKey);
   if(reason||health?.retryAt>this.clock()||this.probes.has(healthKey)){events.push({modelId:candidate.id,state:'skipped',reason:reason??(this.probes.has(healthKey)?'recovery_probe_in_progress':'cooldown')});save('selecting');continue;}
   const live=this.catalog.all().find(m=>m.id===candidate.id&&m.enabled&&m.connection&&connectionEvidenceId(m.connection)===healthKey);if(!live){events.push({modelId:candidate.id,state:'skipped',reason:'configuration_changed'});save('selecting');continue;}
   // After a cooldown only one in-process request probes the failed connection.
   // Other members immediately try their next compatible candidate.
   const probing=health?.state==='cooldown';if(probing)this.probes.add(healthKey);
   const input=structuredClone(body),limit=nativeModelProfile(this.store,{},c).maxTokens;
   input.model=c.model;input.max_tokens=Math.min(input.max_tokens??4096,limit,c.limits?.maxTokens??limit);adaptChatRequest(c,input);
   const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
   const timer=setTimeout(()=>controller.abort(new Error('first_output_timeout')),policy.firstOutputTimeoutMs),started=now();attempted++;
   events.push({modelId:candidate.id,configId:c.configId,state:'started',at:started});save('requesting');
   try{
    const response=await (policy.engine==='magpie'?this.catalog.magpie.fetch.bind(this.catalog.magpie):this.transport)(c,input,combined,this.store,scope);
    if(!response.ok){const delay=retryAfter(response.headers.get('retry-after'),this.clock);await response.body?.cancel().catch(()=>{});throw new RouteFailure(response.status,'upstream_http',retryable(response.status),delay);}
    const output=await firstOutput(response,combined);clearTimeout(timer);signal.throwIfAborted();requireThat(stillAllowed(),'账号或项目已停用',403);
    this.store.put('model-route-health',{id:healthKey,configId:c.configId,state:'healthy',retryAt:0,checked:now()});
    events.push({modelId:candidate.id,state:'committed',at:now()});save('streaming',{actualModelId:candidate.id,actualModel:c.model,actualProvider:c.provider});
    const headers=new Headers(output.headers);headers.set('X-Team-Route-Id',routeId);headers.set('X-Team-Actual-Model',encodeURIComponent(c.model));headers.set('X-Team-Fallbacks',String(failures.length));
    return {response:new Response(output.body,{status:output.status,headers}),connection:c,modelId:candidate.id,routeId,failures,attempted,requestBytes:Buffer.byteLength(JSON.stringify(input)),maxOutputTokens:input.max_tokens};
   }catch(error){clearTimeout(timer);controller.abort();
    const engineUnavailable=(error as Doc)?.code==='MAGPIE_UNAVAILABLE';
    const failure=error instanceof RouteFailure?error:engineUnavailable?new RouteFailure(503,'host_engine_unavailable',false):(error as Doc)?.code==='PROVIDER_CONTENT_REJECTED'?new RouteFailure(422,'provider_content_rejected',false):new RouteFailure(502,'connection_or_first_output_failure',true);
    const receipt:Failure={modelId:candidate.id,configId:c.configId,status:failure.status,stage:signal.aborted?'cancelled_after_send':failure.stage,possiblyBilled:!engineUnavailable,reason:failure.stage,started,finished:now(),requestBytes:Buffer.byteLength(JSON.stringify(input)),maxOutputTokens:input.max_tokens};
    failures.push(receipt);onFailure(receipt,c);
    events.push({modelId:candidate.id,state:'failed',status:failure.status,stage:failure.stage,at:now()});
    if(signal.aborted){save('cancelled');throw error;}
    if(!stillAllowed()){save('revoked');requireThat(false,'账号或项目已停用',403);}
    if(failure.retryable)this.store.put('model-route-health',{id:healthKey,configId:c.configId,state:'cooldown',status:failure.status,retryAt:this.clock()+Math.max(policy.cooldownMs,failure.retryAfterMs),checked:now()});
    save('selecting');if(!failure.retryable){rejected=true;break;}
   }finally{if(probing)this.probes.delete(healthKey);}
  }
  const stage=failures.at(-1)?.stage??'no_compatible_route',code=rejected?'MODEL_REQUEST_REJECTED':attempted?'MODEL_ROUTES_EXHAUSTED':'NO_COMPATIBLE_MODEL',message=rejected?'供应商未接受本次请求，请检查输入和模型参数；没有切换模型继续尝试。':attempted?'当前模型连接不可用，草稿和原任务已保留；可手动选择模型。':'没有满足本次图片、工具或上下文要求的可用线路；原始内容已保留。';
  save('failed',{error:{code,stage,message}});return {response:Response.json({error:{code,message,stage,requestId:callId,routeId,retryable:!rejected&&attempted>0}},{status:rejected?failures.at(-1)!.status??422:attempted?503:422}),routeId,failures,attempted};
 }
}
