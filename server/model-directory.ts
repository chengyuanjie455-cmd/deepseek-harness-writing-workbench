import {ruiyunKind,ruiyunPricing} from './ruiyun-directory.ts';
import {chatProvider} from '../shared/chat-providers.ts';
import {requireThat} from './store.ts';
export type ModelProtocol='chat'|'responses'|'messages'|'google'|'systemone';
export type DirectoryModel={id:string;name:string;protocol:ModelProtocol;selectable:boolean;reason?:string;contextWindow?:number;maxTokens?:number;inputModalities?:string[];supportsTools?:boolean;efforts:string[]};
export function modelProtocol(provider:string,id:string):ModelProtocol {
 if(provider!=='opencode-zen'||id==='qwen3.8-max')return 'chat';
 if(/^(gpt-|grok-|muse-)/.test(id))return 'responses';
 if(/^(claude-|qwen)/.test(id))return 'messages';
 if(id.startsWith('gemini-'))return 'google';
 if(id.startsWith('jev-'))return 'systemone';
 return 'chat';
}
export async function discoverModels(provider:string,key:string,fetcher:typeof fetch=fetch){
 const preset=chatProvider(provider);requireThat(preset,'未知模型渠道');
 const response=await fetcher(preset.baseURL+'/models',{headers:{Authorization:'Bearer '+key,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(20000)});
 requireThat(response.ok,'模型目录获取失败（HTTP '+response.status+'）；请检查密钥、套餐额度或稍后刷新',502);
 const raw=await response.text();requireThat(raw.length<2*1024*1024,'模型目录响应过大',502);
 let body:any;try{body=JSON.parse(raw);}catch{throw new Error('供应商未返回有效模型目录');}
 requireThat(Array.isArray(body.data)&&body.data.length>0,'供应商模型目录为空',502);
 const pricing=provider==='ruiyun'?await ruiyunPricing(preset.baseURL.replace(/\/v1$/,''),fetcher):undefined;
 const kinds=new Map((pricing?.data??[]).map((m:any)=>[m.model_name,ruiyunKind(m)]));
 const seen=new Set<string>(),models:DirectoryModel[]=[];
 for(const m of body.data){if(typeof m.id!=='string'||!m.id.length||m.id.length>160||(provider==='ruiyun'?/[\x00-\x1f\x7f]/.test(m.id):!/^[-\w.:/]+$/.test(m.id))||seen.has(m.id))continue;seen.add(m.id);
  if(provider==='ruiyun'&&kinds.get(m.id)!=='chat')continue;
  const protocol=modelProtocol(provider,m.id),nonchat=protocol==='systemone';
  models.push({id:m.id,name:typeof m.name==='string'?m.name.slice(0,160):m.id,protocol,selectable:!nonchat,...(nonchat?{reason:'结构化判断模型，不提供聊天和工具调用'}:{}),...(Number.isFinite(m.context_window)&&m.context_window>0?{contextWindow:m.context_window}:{}),...(Number.isFinite(m.max_output_tokens)&&m.max_output_tokens>0?{maxTokens:m.max_output_tokens}:{}),...(Array.isArray(m.input_modalities)?{inputModalities:m.input_modalities.filter((s:any)=>['text','image'].includes(s))}:{}),...(typeof m.supports_tools==='boolean'?{supportsTools:m.supports_tools}:{}),efforts:provider==='ruiyun'?['off','low','high','max']:provider==='deepseek-official'?['off',...(m.effort?.supported_levels??['low','high','max']).filter((s:any)=>['low','high','max'].includes(s))]:['low','high','max']});
 }
 requireThat(models.length>0,'供应商没有返回有效模型 ID',502);
 return {models,source:preset.baseURL+'/models',fetchedAt:new Date().toISOString(),accessNote:'供应商目录不等于逐个调用授权；余额、套餐和供应商模型限制以实际调用为准。'};
}
