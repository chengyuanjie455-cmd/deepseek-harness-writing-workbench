/** Parent commands use the native input facade, never DOM/textContent or submit. */
export function createNativeReferenceBridge({scope,project,storage,currentSession,insert}){
 const pending=new Map(),saved=new Set();
 const key='team-reference-receipts:v1:'+scope;
 try{for(const id of JSON.parse(storage?.getItem(key)??'[]'))if(typeof id==='string')saved.add(id);}catch{}
 const remember=id=>{saved.add(id);try{storage?.setItem(key,JSON.stringify([...saved].slice(-1000)));}catch{}};
 return {async receive(request){
  const reply={type:'team-native-reference-receipt',protocolVersion:1,version:request.version,requestId:request.requestId,session:request.session,project};
  if(request.protocolVersion!==1||request.project!==project||typeof request.requestId!=='string'||request.requestId.length>200||typeof request.session!=='string'||typeof request.text!=='string'||!request.text||request.text.length>32000)return {...reply,state:'rejected',error:'引用请求无效'};
  if(request.session!==currentSession())return {...reply,state:'waiting',error:'引用保留在原会话，等待该会话就绪'};
  const id=request.session+':'+request.requestId;
  if(saved.has(id))return {...reply,state:'inserted'};
  if(pending.has(id))return pending.get(id);
  const attempt=(async()=>{
   try{
    if(!await insert(request.session,request.text))return {...reply,state:'waiting',error:'原生编辑器暂不可编辑，引用已保留'};
    remember(id);return {...reply,state:'inserted'};
   }catch{return {...reply,state:'waiting',error:'原生引用尚未写入，引用已保留'};}
   finally{pending.delete(id);}
  })();
  pending.set(id,attempt);return attempt;
 }};
}
