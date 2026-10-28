/** The pinned native controller checks its inbox and journal for requestId.
 * Between consuming an idle inbox and appending user/message, neither contains
 * the admitted message. Keep only this admission bridge; the native controller,
 * inbox, journal, attachments, Queue and Steer remain the authoritative path. */
export function installPromptAdmissionGuard(ctx){
 const commands=ctx.sessionController?.commands,original=commands?.prompt;
 if(typeof original!=='function')throw Error('原生消息接收接口变化，无法安装重复提交保护');
 const admitted=new Map(),key=(session,request)=>JSON.stringify([session,request]);
 const wrapped=function(request,...rest){
  const id=key(request.sessionId,request.requestId),old=admitted.get(id);
  if(old)return old;
  // Install before entering the asynchronous native admission path, so two
  // concurrent requests cannot each pass the controller's pre-admission check.
  const promise=Promise.resolve().then(()=>original.call(this,request,...rest)).catch(error=>{
   if(admitted.get(id)===promise)admitted.delete(id);throw error;
  });
  admitted.set(id,promise);return promise;
 };
 commands.prompt=wrapped;
 const offEvent=ctx.on('session/event',(session,event)=>{
  if(event.type==='user/message'&&event.data?.source?.kind==='user'&&typeof event.data.source.rpcId==='string')admitted.delete(key(session.id,event.data.source.rpcId));
 });
 const offDispose=ctx.on('session/disposed',session=>{
  for(const id of admitted.keys())if(JSON.parse(id)[0]===session.id)admitted.delete(id);
 });
 return ()=>{offEvent?.();offDispose?.();admitted.clear();if(commands.prompt===wrapped)commands.prompt=original;};
}
