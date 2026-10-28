import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
/** Observe the public llm/stream waterfall without changing request content or
 * adapter behavior. Only the authenticated, exact host-model HTTP hop receives
 * this metadata; it is stripped at the host and never sent to cloud providers.
 * AsyncLocalStorage binds concurrent iterator steps to their real session. */
export function registerNativeModelTrace(ctx,config){
 const scope=new AsyncLocalStorage(),endpoint=new URL(config.baseURL);endpoint.pathname=endpoint.pathname.replace(/\/team$/,'/chat/completions');
 let enabled=true;
 ctx.on('llm/stream',(options,next)=>{
  const trace={session:options.sessionId,purpose:options.purpose,attempt:randomUUID()};
  // Reuse Harness pressure, including its usage anchor and routed attachment
  // projection. Serialized JSON/base64 bytes are not context-window tokens.
  if(!['compaction','session-title'].includes(options.purpose))try{
   const agent=ctx.agents?.get(options.sessionId),meter=agent?.ctx?.get?.('tokenMeter')??ctx.get?.('tokenMeter');
   const value=agent&&meter?.measure(agent.session);
   if(Number.isSafeInteger(value?.totalTokens)&&value.totalTokens>=0&&Number.isSafeInteger(value?.logRevision)&&['estimated','usage'].includes(value?.baseline?.kind))trace.pressure={tokens:value.totalTokens,revision:value.logRevision,basis:value.baseline.kind};
  }catch{/* Older runtimes retain the conservative compatibility path. */}
  return {[Symbol.asyncIterator](){
   const iterator=scope.run(trace,()=>next()[Symbol.asyncIterator]());
   return {next:value=>scope.run(trace,()=>iterator.next(value)),return:value=>scope.run(trace,()=>iterator.return?iterator.return(value):Promise.resolve({done:true,value})),throw:error=>scope.run(trace,()=>iterator.throw?iterator.throw(error):Promise.reject(error))};
  }};
 });
 ctx.effect(()=>{
  const original=globalThis.fetch;
  const tracedFetch=function(input,init){
   const trace=enabled&&scope.getStore();if(!trace)return original(input,init);
   const url=new URL(input instanceof Request?input.url:String(input));
   const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
   if(trace&&url.href===endpoint.href&&(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase()==='POST'&&headers.get('authorization')==='Bearer '+process.env.TEAM_NATIVE_KEY){
    if(typeof trace.session==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(trace.session))headers.set('X-Team-Native-Session',trace.session);
    if(['compaction','session-title'].includes(trace.purpose))headers.set('X-Team-Native-Purpose',trace.purpose);
    headers.set('X-Team-Native-Attempt',trace.attempt);
    if(trace.pressure){headers.set('X-Team-Native-Context-Tokens',String(trace.pressure.tokens));headers.set('X-Team-Native-Context-Revision',String(trace.pressure.revision));headers.set('X-Team-Native-Context-Basis',trace.pressure.basis);}
    return original(input,{...init,headers});
   }
   return original(input,init);
  };
  globalThis.fetch=tracedFetch;
  return ()=>{enabled=false;if(globalThis.fetch===tracedFetch)globalThis.fetch=original;scope.disable();};
 },'team.model-trace');
}
