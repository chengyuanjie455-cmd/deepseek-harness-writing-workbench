import {createOpenAI} from '@ai-sdk/openai';
import {createAnthropic} from '@ai-sdk/anthropic';
import {createGoogle} from '@ai-sdk/google';
import type {LanguageModelV4CallOptions} from '@ai-sdk/provider';
import type {ModelConnection} from './model.ts';
import {modelProtocol} from './model-directory.ts';
import {hash,type Store,requireThat} from './store.ts';
type Row=Record<string,any>;
/** Keep provider tool signatures on the host, scoped to this exact credential/model. */
function replayKey(c:ModelConnection,id:string,scope:string){return hash(JSON.stringify([c.configId,scope,id]));}
export function sdkPrompt(c:ModelConnection,b:Row,store?:Store,scope=''){
 const names=new Map<string,string>();for(const m of b.messages??[])for(const t of m.tool_calls??[])names.set(t.id,t.function.name);
 return (b.messages??[]).map((m:Row)=>{
  if(m.role==='system'||m.role==='developer')return {role:'system',content:typeof m.content==='string'?m.content:(m.content??[]).map((p:Row)=>p.text??'').join('\n')};
  if(m.role==='tool')return {role:'tool',content:[{type:'tool-result',toolCallId:m.tool_call_id,toolName:names.get(m.tool_call_id)??m.name??'tool',output:{type:'text',value:typeof m.content==='string'?m.content:JSON.stringify(m.content)}}]};
  const content:Row[]=typeof m.content==='string'?(m.content?[{type:'text',text:m.content}]:[]):(m.content??[]).map((p:Row)=>{
   if(p.type==='text')return {type:'text',text:p.text};
   if(p.type==='image_url'){const u=p.image_url.url,match=/^data:([^;]+);base64,(.*)$/s.exec(u);return {type:'file',mediaType:match?.[1]??'image/*',data:match?{type:'data',data:match[2]}:{type:'url',url:new URL(u)}};}
   throw new Error('当前模型不支持此附件格式，请使用文本或图片');
  });
  for(const t of m.tool_calls??[])content.push({type:'tool-call',toolCallId:t.id,toolName:t.function.name,input:JSON.parse(t.function.arguments||'{}'),providerOptions:store?.get('model-replay',replayKey(c,t.id,scope))?.metadata});
  return {role:m.role,content};
 }) as LanguageModelV4CallOptions['prompt'];
}
export async function fetchModel(c:ModelConnection,b:Row,signal:AbortSignal,store?:Store,scope='',fetcher:typeof fetch=fetch):Promise<Response>{
 const protocol=c.protocol??modelProtocol(c.provider,c.model),baseURL=c.baseURL.replace(/\/$/,'');
 if(protocol==='chat')return fetcher(baseURL+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+c.apiKey,'Content-Type':'application/json'},body:JSON.stringify(b),signal,redirect:'error'});
 requireThat(protocol!=='systemone','此模型是结构化判断模型，不能作为聊天模型',422);
 // SDK transports perform exactly one request. They never retry or change provider.
 const secureFetch:typeof fetch=(url,options)=>fetcher(url,{...options,redirect:'error',signal});
 const model=protocol==='responses'?createOpenAI({baseURL,apiKey:c.apiKey,fetch:secureFetch}).responses(c.model):protocol==='messages'?createAnthropic({baseURL,apiKey:c.apiKey,fetch:secureFetch,headers:{Authorization:'Bearer '+c.apiKey}})(c.model):createGoogle({baseURL,apiKey:c.apiKey,fetch:secureFetch,headers:{Authorization:'Bearer '+c.apiKey}})(c.model);
 const opts:LanguageModelV4CallOptions={prompt:sdkPrompt(c,b,store,scope),maxOutputTokens:b.max_tokens,abortSignal:signal,tools:(b.tools??[]).map((t:Row)=>({type:'function',name:t.function.name,description:t.function.description,inputSchema:t.function.parameters})),toolChoice:typeof b.tool_choice==='string'?{type:b.tool_choice as 'auto'|'none'|'required'}:b.tool_choice?.function?{type:'tool',toolName:b.tool_choice.function.name}:undefined,providerOptions:protocol==='responses'?{openai:{store:false}}:undefined};
 // Default model reasoning avoids sending an unsupported DeepSeek effort to a different protocol.
 try{
  const result=await model.doStream(opts),reader=result.stream.getReader(),encoder=new TextEncoder();let toolIndex=0,finished=false;
  const id='chatcmpl-'+hash(c.configId+Date.now()).slice(0,24);
  const frame=(delta:Row,finish:string|null=null,usage?:Row)=>encoder.encode('data: '+JSON.stringify({id,object:'chat.completion.chunk',model:c.model,choices:[{index:0,delta,finish_reason:finish}],...(usage?{usage}:{})})+'\n\n');
  const stream=new ReadableStream<Uint8Array>({async pull(controller){try{while(true){const {value:p,done}=await reader.read();if(done){if(!finished)throw Error('供应商响应中断，未收到完成事件');controller.enqueue(encoder.encode('data: [DONE]\n\n'));controller.close();return;}
    if(p.type==='error')throw Error('供应商流式响应失败');
    if(p.type==='text-delta'||p.type==='reasoning-delta'){controller.enqueue(frame({[p.type==='text-delta'?'content':'reasoning_content']:p.delta}));return;}
    if(p.type==='tool-call'){if(p.providerMetadata&&store)store.put('model-replay',{id:replayKey(c,p.toolCallId,scope),metadata:p.providerMetadata});controller.enqueue(frame({tool_calls:[{index:toolIndex++,id:p.toolCallId,type:'function',function:{name:p.toolName,arguments:p.input}}]}));return;}
    if(p.type==='finish'){const u=p.usage,reason=p.finishReason.unified;if(reason==='content-filter')throw Object.assign(Error('供应商内容审核未通过'),{code:'PROVIDER_CONTENT_REJECTED'});if(['error','other'].includes(reason))throw Error('供应商未正常完成响应');finished=true;controller.enqueue(frame({},reason==='tool-calls'?'tool_calls':reason==='length'?'length':'stop',{prompt_tokens:u.inputTokens.total,completion_tokens:u.outputTokens.total,prompt_tokens_details:{cached_tokens:u.inputTokens.cacheRead??0},completion_tokens_details:{reasoning_tokens:u.outputTokens.reasoning??0}}));return;}
   }}catch(e){await reader.cancel().catch(()=>{});controller.error(e);}},async cancel(){await reader.cancel();}});
  return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
 }catch(e:any){if(signal.aborted)throw e;const status=Number.isInteger(e.statusCode)?e.statusCode:502;return Response.json({error:{message:'供应商模型调用失败（HTTP '+status+'），请检查模型权限和额度。'}},{status});}
}
