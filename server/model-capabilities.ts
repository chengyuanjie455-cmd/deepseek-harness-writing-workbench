import {hash,type Store,type Doc} from './store.ts';
export const connectionEvidenceId=(c:Doc)=>hash(JSON.stringify([c.configId,c.baseURL,hash(c.apiKey??'')]));
import type {ChatCatalog} from './chat-catalog.ts';
/** Observation is tied to the current immutable connection, never inferred from a model name. */
export function connectionMetadata(store:Store,c:Doc){return c.metadata??store.all('model-directory').find(d=>d.provider===c.provider&&d.id===hash(JSON.stringify([c.provider,hash(c.apiKey??'')])) )?.models.find((m:Doc)=>m.id===c.model);}
export function connectionModalities(store:Store,c:Doc){return connectionMetadata(store,c)?.inputModalities??[];}
/** The pinned native catalog receives this connection's actual declarations.
 * Unknown values keep the existing fallback; they are not verification claims. */
export function nativeModelProfile(store:Store,model:Doc,c:Doc={}){
 const metadata=connectionMetadata(store,c),positive=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
 const efforts=metadata?.efforts?.filter((v:string)=>['off','minimal','low','medium','high','xhigh','max'].includes(v));
 return {id:model.id,name:model.name,input:connectionModalities(store,c).length?connectionModalities(store,c):['text'],
  maxTokens:Math.min(positive(metadata?.maxTokens)?metadata.maxTokens:32768,positive(c.limits?.maxTokens)?c.limits.maxTokens:Infinity),
  ...(positive(metadata?.contextWindow)?{contextWindow:metadata.contextWindow}:{}),
  reasoningEfforts:efforts?.length?Object.fromEntries(efforts.map((v:string)=>[v,v==='off'?null:v])):{off:null,low:'low',medium:'medium',high:'high'}};
}
/** Auto is a logical model. Its input UI and compaction window must represent
 * all configured candidates, rather than falsely inheriting only the primary.
 * Per-request routing still checks the actual selected connection and never
 * removes images, tools or history to make a candidate fit. */
export function nativeCatalogProfile(store:Store,catalog:ChatCatalog,project:string,model:Doc){
 const primary=catalog.modelConnection(model.id,project)??{},base=nativeModelProfile(store,model,primary);
 if(model.id!=='team-auto')return base;
 const policy=store.get('model-routing-policy',project);if(!policy?.enabled)return base;
 const ids=[policy.primaryModelId,...(policy.fallbackModelIds??[])],seen=new Set<string>();
 const candidates=ids.flatMap(id=>{const c=catalog.modelConnection(id,project);if(!c)return [];const key=connectionEvidenceId(c);if(seen.has(key))return [];seen.add(key);return [c];});
 const profiles=candidates.map(c=>({profile:nativeModelProfile(store,model,c),metadata:connectionMetadata(store,c)})).filter(v=>v.profile.contextWindow);
 if(!profiles.length)return base;
 const efforts=Object.fromEntries(profiles.flatMap(v=>(v.metadata?.efforts??[]).filter((e:string)=>['off','minimal','low','medium','high','xhigh','max'].includes(e)).map((e:string)=>[e,e==='off'?null:e])));
 return {...base,input:[...new Set(profiles.flatMap(v=>v.profile.input))],contextWindow:Math.max(...profiles.map(v=>v.profile.contextWindow!)),maxTokens:Math.max(...profiles.map(v=>v.profile.maxTokens)),reasoningEfforts:Object.keys(efforts).length?efforts:{off:null}};
}
/** Keep the official compaction backend. Its 65,536-token default headroom
 * cannot fit small models. Only known capacities receive a per-model policy;
 * unknown capacities remain explicitly unverified in the model directory. */
export function nativeContextPolicies(store:Store,models:Doc[],connection:(id:string)=>Doc|undefined,profileFor?:(model:Doc)=>ReturnType<typeof nativeModelProfile>){
 return models.flatMap(model=>{const profile=profileFor?.(model)??nativeModelProfile(store,model,connection(model.id)??{}),window=profile.contextWindow;
  if(!window||window<=profile.maxTokens)return [];
  const available=window-profile.maxTokens;
  return [{provider:'deepseek-official',model:model.id,thresholdRatio:0.8,retainRatio:0.16,headroomTokens:Math.min(65536,Math.floor(available*0.08)),maxTokens:Math.max(1,Math.min(profile.maxTokens,4096,Math.floor(available*0.1)))}];
 });
}
export function chatCapabilities(store:Store,catalog:ChatCatalog){
 const records=catalog.all(),calls=store.all('model-call').filter(c=>!c.fixture&&!c.simulated);
 return catalog.publicModels().map(m=>{const connection=records.find(r=>r.id===m.id)?.connection;
 const current=connection?calls.filter(c=>c.connectionEvidenceId===connectionEvidenceId(connection)).sort((a,b)=>String(b.finished??b.created).localeCompare(String(a.finished??a.created))):[];
 const success=current.find(c=>c.completed&&c.providerStatus>=200&&c.providerStatus<300),failure=current.find(c=>c.providerStatus>=400),tools=current.find(c=>c.completed&&c.toolCallsObserved);
 return {...m,capabilities:{contextWindow:connection?.metadata?.contextWindow??null,maxOutputTokens:connection?.metadata?.maxTokens??null,inputModalities:connection?connectionModalities(store,connection):null,toolCalls:tools?'observed':'unverified',lastSuccess:success?.finished??null,lastFailure:failure?{at:failure.finished,status:failure.providerStatus}:null,scope:'current_connection',note:'目录参数来自供应商；调用验证仅统计当前连接的真实记录，旧记录未绑定连接时不计入。'}};
 });
}
