import {DeepSeekAdapter,type DeepSeekAdapterOptions} from '@deepseek-ai/dsh-llm-deepseek';
import type {GenerateOptions,StreamChunk} from '@deepseek-ai/dsh-llm';
import type {ModelConnection} from './model.ts';
import {fetchModel} from './model-transport.ts';
import type {Store} from './store.ts';
/** Legacy task runner shares the same protocol bridge as the native workbench. */
export class ProtocolAdapter extends DeepSeekAdapter {
 constructor(private connection:ModelConnection,private store:Store,private settings:DeepSeekAdapterOptions){super(settings);}
 override async *stream(o:GenerateOptions):AsyncIterable<StreamChunk>{
  const text=(parts:readonly any[])=>parts.filter(p=>p.type==='text').map(p=>p.text).join('\n');
  const messages:any[]=[];if(o.system)messages.push({role:'system',content:o.system});
  for(const m of o.messages){
   if(m.role==='tool'){messages.push({role:'tool',tool_call_id:m.toolCallId,content:text(m.content)});continue;}
   if(m.content.some(p=>p.type==='image'))throw Error('此任务入口请通过项目文件读取图片，或使用原生聊天附件');
   const calls=m.content.filter(p=>p.type==='tool-call');const t=text(m.content);
   if(t||calls.length)messages.push({role:m.role,content:t,...(calls.length?{tool_calls:calls.map(p=>({id:p.id,type:'function',function:{name:p.name,arguments:p.arguments}}))}:{})});
   for(const p of m.content as readonly any[])if(p.type==='tool-result')messages.push({role:'tool',tool_call_id:p.toolCallId,content:text(p.content)});
  }
  const body:any={model:this.connection.model,messages,tools:o.tools?.map(t=>({type:'function',function:t})),stream:true,max_tokens:o.maxTokens,reasoning_effort:o.reasoningEffort,thinking:{type:o.reasoningEffort==='off'?'disabled':'enabled'}};
  const signal=o.signal??AbortSignal.timeout(180000),extensions=await this.settings.prepareExtensions({body,signal,sessionId:String(o.sessionId)});
  const r=await fetchModel(this.connection,body,signal,this.store,String(o.sessionId));if(!r.ok)throw Error('模型请求失败（HTTP '+r.status+'）');await extensions.accept();if(!r.body)throw Error('供应商响应为空');
  let pending='',index=0,finished=false;const decoder=new TextDecoder(),blocks=new Map<string,{index:number,block:any}>();
  for await(const chunk of r.body as any){pending+=decoder.decode(chunk,{stream:true});let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);if(!line.startsWith('data: ')||line==='data: [DONE]')continue;const row=JSON.parse(line.slice(6)),choice=row.choices?.[0],delta=choice?.delta??{};
   for(const [field,type] of [['content','text'],['reasoning_content','reasoning']] as const)if(delta[field]){let b=blocks.get(type);if(!b){b={index:index++,block:{type,text:''}};blocks.set(type,b);yield {type:'block-start',index:b.index,blockType:type};}b.block.text+=delta[field];yield {type:type==='text'?'text-delta':'reasoning-delta',index:b.index,text:delta[field]};}
   for(const call of delta.tool_calls??[]){const key='tool:'+call.index;let b=blocks.get(key);if(!b){b={index:index++,block:{type:'tool-call',id:call.id,name:call.function?.name??'',arguments:''}};blocks.set(key,b);yield {type:'block-start',index:b.index,blockType:'tool-call'};}b.block.arguments+=call.function?.arguments??'';yield {type:'tool-call-delta',index:b.index,id:b.block.id,name:b.block.name,argumentsDelta:call.function?.arguments??''};}
   if(row.usage){const u=row.usage;if(Number.isFinite(u.prompt_tokens)&&Number.isFinite(u.completion_tokens)){const cache=Math.min(u.prompt_tokens,u.prompt_tokens_details?.cached_tokens??u.prompt_cache_hit_tokens??0);yield {type:'usage',usage:{inputTokens:u.prompt_tokens-cache,outputTokens:u.completion_tokens,cacheReadTokens:cache}};}}
   if(choice?.finish_reason){finished=true;for(const b of blocks.values())yield {type:'block-end',index:b.index,block:b.block};yield {type:'finish',reason:{kind:choice.finish_reason==='tool_calls'?'tool-calls':choice.finish_reason==='length'?'max-tokens':'stop'}};}
  }}if(!finished)throw Error('供应商未完整返回响应');
 }
}
