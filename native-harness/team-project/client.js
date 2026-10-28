// Only the native public input actions may edit a draft. This preserves chips,
// attachments, IME, undo and the native Queue/Steer admission contract.
function insertNativeReference(actions,input,text){
 if(!actions||!input||['adjudicating','submitting'].includes(input.phase))return false;
 const span=actions.captureInsertion();
 return actions.insertText((input.draft?'\n\n':'')+text,{...span,start:span.end});
}
// Model choices belong to a real native session; no selection means no prompt mutation.
function generationModelLines(choice={}){
 return ['image','video'].flatMap(kind=>choice[kind]?.id&&choice[kind]?.name?[`${kind==='image'?'图片':'视频'}生成模型：${choice[kind].name}`]:[]).concat(choice.skill?.id&&choice.skill?.name?[`编剧技能：${choice.skill.id}`]:[]);
}
function generationMenuModels(kind,models){return models.filter(m=>kind==='video'?['published','testing'].includes(m.status):m.status==='available'||m.status===undefined).map(m=>({id:m.id,name:m.name}));}
function createGenerationChoices(storage,scope){
 const cache=new Map(),listeners=new Set(),empty={};
 const key=id=>'team-generation-models:v2:'+scope+':'+id;
 const read=id=>{if(!id)return empty;if(!cache.has(id)){let v={};try{v=JSON.parse(storage?.getItem(key(id))??'{}');}catch{}cache.set(id,Object.fromEntries(['image','video','skill'].filter(k=>v?.[k]?.id&&typeof v[k].name==='string').map(k=>[k,{id:v[k].id,name:v[k].name}])));}return cache.get(id);};
 return {read,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},set(id,kind,model){if(!id||!['image','video','skill'].includes(kind))return;const v={...read(id)};if(model?.id&&model.id!=='auto')v[kind]={id:model.id,name:model.name};else delete v[kind];cache.set(id,v);try{storage?.setItem(key(id),JSON.stringify(v));}catch{}for(const fn of listeners)fn();},prompt(id,text){const lines=generationModelLines(read(id));return lines.length?text+(text?'\n\n':'')+lines.join('\n'):text;}};
}
function currentNativeSession(list){return list.current??Object.values(list.byId??{}).find(s=>(s?.retainedBy?.mainView??0)>0)?.id;}
// Display-only identities never enter the member or administrator Session Controller.
function teamMemberRowId(member,session,project){return 'team-observe:'+(project?project+':':'')+member+':'+session;}
function workspaceMemberVisible(member){return member.active!==false&&(member.sessions??[]).some(session=>session.messageCount>0);}
function projectMemberWorkspace(list,workspace,members,selected,project){
 const root=workspace.items.find(w=>w.path==='/workspace');
 if(!root)return {list,workspace,observed:new Map()};
 const observed=new Map(),byId={...list.byId},ids=[...list.ids],titles=new Set(Object.values(list.byId).map(s=>s?.displayTitle));
 for(const member of members.filter(workspaceMemberVisible))for(const session of member.sessions??[]){
  if(!/^session-[a-zA-Z0-9-]+$/.test(session.id))continue;
  const id=teamMemberRowId(member.id,session.id,project);if(observed.has(id))continue;
  observed.set(id,{project,self:!!member.self,active:member.active,member:member.id,name:member.name,session:session.id,title:(session.title||'未命名聊天')+(session.archived?' · 已归档':'')+(session.subagent?' · 子会话':'')});
  let title=member.name+' · '+(session.title||'未命名聊天')+(session.archived?' · 已归档':'')+(session.subagent?' · 子会话':'');const base=title;let suffix=1;while(titles.has(title))title=base+' · '+(++suffix);titles.add(title);
  byId[id]={id,displayTitle:title,cwd:root.path,blank:false,running:session.status==='running',completed:false,updatedAt:Number(session.updated)||0,createdAt:Number(session.created)||0,origin:'user',projectionValues:{},retainedBy:{}};
  ids.push(id);
 }
 const current=selected?teamMemberRowId(selected.member,selected.session,selected.project):currentNativeSession(list);
 return {list:{...list,ids,byId,current:byId[current]?current:currentNativeSession(list)},workspace:{...workspace,items:workspace.items.map(w=>w===root?{...w,sessionIds:[...w.sessionIds,...observed.keys()]}:w)},observed};
}
// Synthetic entries are navigation only; each project keeps its own native controller.
function allProjectWorkspace(list,workspace,projects,active,selected,owner){
 const root=workspace.items.find(w=>w.path==='/workspace');
 if(!root)return {list,workspace,observed:new Map(),groups:new Map(),foreign:new Map()};
 let merged=list;const items=[],observed=new Map(),groups=new Map(),foreign=new Map();
 for(const project of projects){
  const current=project.id===active;
  const members=(project.members??[]).filter(m=>workspaceMemberVisible(m)&&(!current||(owner?m.id!==owner:!m.self)));
  const entry=current?{...root,title:project.name}:{workspaceId:'team-project:'+project.id,path:'/workspace',title:project.name,createdAt:new Date(0).toISOString(),sessionIds:[]};
  const view=projectMemberWorkspace(merged,{...workspace,items:[entry]},members,null,project.id);
  merged=view.list;items.push({...view.workspace.items[0],path:current?root.path:'/team-project/'+project.id});
  for(const [id,pick] of view.observed)observed.set(id,pick);
  groups.set(entry.workspaceId,{project:project.id,members,own:current});
  if(!current)foreign.set(entry.workspaceId,project.id);
 }
 if(!projects.some(p=>p.id===active))items.unshift(root);
 // Native nested folders, menus and user-owned sessions remain available.
 items.push(...workspace.items.filter(w=>w!==root));
 const id=selected?teamMemberRowId(selected.member,selected.session,selected.project):currentNativeSession(list);
 return {list:{...merged,current:merged.byId[id]?id:currentNativeSession(list)},workspace:{...workspace,items},observed,groups,foreign};
}
// Only this idempotent read is retried; submissions and generation are never replayed.
async function fetchWorkspaceNavigation(url,signal,transport=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms))){
 for(let attempt=0;attempt<3;attempt++){
  signal?.throwIfAborted();
  try{
   const r=await transport(url,{signal:typeof AbortSignal==='undefined'?signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(12000)]),cache:'no-store',headers:{Accept:'application/json'}});
   if([401,403].includes(r.status))throw Object.assign(Error('登录已失效，请重新连接工作台'),{terminal:true});
   if([429,502,503,504].includes(r.status))throw Error('主机暂时未响应，正在重新读取项目列表');
   if(r.headers?.get&&!/application\/json/i.test(r.headers.get('content-type')??''))throw Error('连接暂时返回了非工作台内容，请稍后重试');
   const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error??'聊天列表读取失败'),{terminal:true});
   if(!data||!Array.isArray(data.projects)&&!Array.isArray(data.members))throw Error('项目列表响应不完整，请稍后重试');
   return data;
  }catch(e){if(signal?.aborted||e.terminal||attempt===2)throw e;if(attempt<2)await pause(400*(attempt+1));}
 }
}
function createMemberWorkspaceStore({fetchList,setTimer=setTimeout,clearTimer=clearTimeout}){
 let state={members:[],projects:[],selected:null,error:'',ready:false},timer,controller,disposed=false,flight;
 const listeners=new Set(),notify=patch=>{state={...state,...patch};for(const f of listeners)f();};
 async function refresh(){
  if(disposed)return;if(flight)return flight;clearTimer(timer);controller=new AbortController();
  flight=(async()=>{try{const value=await fetchList(controller.signal);if(!disposed)notify({members:value.members??[],projects:value.projects??[],error:'',ready:true});}
   catch(e){if(!disposed)notify({error:e.message});}
   finally{flight=undefined;if(!disposed)timer=setTimer(refresh,10000);}})();return flight;
 }
 return {getSnapshot:()=>state,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},refresh,select(selected){notify({selected});},dispose(){disposed=true;clearTimer(timer);controller?.abort();listeners.clear();}};
}
function adoptedLabel(job){return job.currentAdopted===true?'当前采用':job.currentAdopted===false?'曾经采用 · 已被替换或移除':'曾经采用 · 当前状态待核对';}
function teamVisibilityEvents(fn){
 if(typeof document==='undefined')return()=>{};
 document.addEventListener('visibilitychange',fn);window.addEventListener('online',fn);window.addEventListener('focus',fn);
 return()=>{document.removeEventListener('visibilitychange',fn);window.removeEventListener('online',fn);window.removeEventListener('focus',fn);};
}
function createTeamPlanPoller({fetchBatch,setTimer=setTimeout,clearTimer=clearTimeout,hidden=()=>document.visibilityState==='hidden',onVisible=teamVisibilityEvents,onChange=()=>{}}){
 const rows=new Map();let timer,flight=false,disposed=false;const terminal=new Set(['ready','adopted','cancelled','failed']);
 const reviewable=value=>value?.plan?.jobs?.some(j=>j.state==='adopted'||value.kind==='video'&&j.state==='ready');
 const finished=value=>{const p=value?.plan;return !!p&&(!p.jobs?.length&&['needs_input','awaiting_confirmation'].includes(p.state)||(p.jobs?.length>0&&p.jobs.every(j=>terminal.has(j.state))));};
 const pending=r=>r.due||!finished(r.value)||reviewable(r.value)||r.errors>0;
 const schedule=(ms=5000)=>{clearTimer(timer);if(!disposed&&rows.size)timer=setTimer(tick,ms);};
 const marker=v=>JSON.stringify(v?.plan?.jobs?.map(j=>[j.id,j.state,j.mediaId,j.currentAdopted])??[]);
 const notify=(r,value)=>{const previous=r.value;r.value=value;for(const cb of r.listeners)cb(value,'');if(marker(value)!==marker(previous))onChange(value,previous);};
 async function tick(){
  if(disposed||flight)return;clearTimer(timer);if(hidden()){schedule();return;}
  const wanted=[...rows].filter(([,r])=>r.due||pending(r)&&Date.now()>=r.next).map(([k])=>k);
  if(!wanted.length){if([...rows.values()].some(pending))schedule();return;}flight=true;
  try{for(let offset=0;offset<wanted.length&&!disposed;offset+=50){
   const batch=wanted.slice(offset,offset+50).flatMap(key=>{const row=rows.get(key);if(!row)return[];row.fetching=true;row.due=false;return[{key,row,revision:row.revision}];});
   if(!batch.length)continue;
   const current=entry=>!disposed&&rows.get(entry.key)===entry.row&&entry.row.revision===entry.revision;
   const failed=(entry,message)=>{if(!current(entry))return;const r=entry.row;r.errors++;r.next=Date.now()+Math.min(60000,5000*2**Math.min(r.errors,4));for(const cb of r.listeners)cb(undefined,message);};
   try{
    const result=await fetchBatch(batch.map(v=>v.key));const found=new Map(result.items.map(v=>[v.kind+'/'+v.plan.id,v]));
    for(const entry of batch){if(!current(entry))continue;const value=found.get(entry.key),r=entry.row;
     if(!value){failed(entry,result.errors?.[entry.key]??'任务状态返回不完整');continue;}
     const recovering=value.plan.jobs?.some(j=>j.state==='download_failed'&&Number.isFinite(j.nextRecoveryAt)&&j.nextRecoveryAt>0);
     r.errors=0;r.next=Date.now()+(!recovering&&(reviewable(value)||value.plan.jobs?.every(j=>['blocked','qa_failed','submission_unknown','download_failed'].includes(j.state)))?60000:5000);notify(r,value);
    }
   }catch(e){for(const entry of batch)failed(entry,e.message);}
   finally{for(const entry of batch)entry.row.fetching=false;}
  }}finally{flight=false;if(!disposed&&[...rows.values()].some(pending))schedule([...rows.values()].some(r=>r.due)?0:5000);}
 }
 const off=onVisible(()=>{if(!hidden()){for(const r of rows.values())r.due=true;schedule(0);}});
 return {subscribe(key,seed,cb){if(disposed)return()=>{};let r=rows.get(key);if(!r){r={value:seed,listeners:new Set(),due:true,fetching:false,errors:0,next:0,revision:0};rows.set(key,r);}r.listeners.add(cb);cb(r.value,'');schedule(0);return()=>{r.listeners.delete(cb);if(!r.listeners.size&&rows.get(key)===r)rows.delete(key);if(!rows.size)clearTimer(timer);};},
  refresh(key,value){const r=rows.get(key);if(r){r.revision++;r.due=true;if(value)notify(r,value);schedule(0);}},
  refreshAll(){for(const r of rows.values()){r.revision++;r.due=true;}schedule(0);},dispose(){disposed=true;clearTimer(timer);off();rows.clear();},size:()=>rows.size};
}
// A read-only feed; failed refreshes keep originals visible and never submit work.
function createChatGalleryFeed({fetchItems,emit,setTimer=setTimeout,clearTimer=clearTimeout,hidden=()=>document.visibilityState==='hidden',onVisible=teamVisibilityEvents}){
 let state={items:[],warnings:[],error:'',checkedAt:0,refreshing:false},timer,controller,deadline,flight,again=false,disposed=false;
 const publish=patch=>{if(!disposed){state={...state,...patch};emit(state);}};
 const schedule=()=>{clearTimer(timer);if(!disposed)timer=setTimer(()=>void refresh(),10000);};
 async function refresh(){
  if(disposed)return;if(flight){again=true;return flight;}clearTimer(timer);if(hidden()){schedule();return;}
  controller=new AbortController();const signal=controller.signal;deadline=setTimer(()=>controller.abort(),20000);publish({refreshing:true});
  flight=(async()=>{try{const data=await Promise.resolve().then(()=>fetchItems(signal));if(!signal.aborted)publish({...data,error:'',checkedAt:Date.now()});}
   catch(e){if(!disposed)publish({error:signal.aborted?'画廊同步超时，保留上次结果，正在重试。':e.message||'画廊暂未更新，保留上次结果。'});}
   finally{clearTimer(deadline);flight=undefined;publish({refreshing:false});if(!disposed){if(again){again=false;timer=setTimer(()=>void refresh(),0);}else schedule();}}
  })();return flight;
 }
 const off=onVisible(()=>{if(!hidden())void refresh();});
 return {refresh,getSnapshot:()=>state,dispose(){disposed=true;again=false;clearTimer(timer);clearTimer(deadline);controller?.abort();off();}};
}
function scopeChatGalleryItems(items,prefix){const url=v=>typeof v==='string'&&v.startsWith('/api'+'/')?prefix+'/team-settings'+v:v;return items.map(v=>({...v,src:url(v.src),download:url(v.download),poster:url(v.poster)}));}
// The mobile bridge submits both vision input and the original file. When their
// exact content IDs match, show the original once and retain its download URL.
function nativeGalleryReferences(images){
 const originals=new Set(images.filter(v=>v.file?.attachmentId).map(v=>v.file.attachmentId));
 return images.filter(v=>!v.attachment?.attachmentId||!originals.has(v.attachment.attachmentId));
}
// One visible gallery per native turn. The registry holds presentation data only.
function createImageTurnRegistry(){
 const groups=new Map(),empty={leader:null,rows:[]};
 function group(key){let g=groups.get(key);if(!g){g={mounts:new Map(),plans:new Map(),listeners:new Set(),snapshot:empty};groups.set(key,g);}return g;}
 function emit(g){const mounted=[...g.mounts].sort((a,b)=>a[1].order-b[1].order),rows=[...g.plans.values()].sort((a,b)=>a.order-b.order).map(v=>v.data);g.snapshot={leader:mounted[0]?.[0]??null,rows};for(const fn of g.listeners)fn();}
 return {get(key){return groups.get(key)?.snapshot??empty;},subscribe(key,fn){const g=group(key);g.listeners.add(fn);return()=>g.listeners.delete(fn);},mount(key,token,data,order){const g=group(key);g.mounts.set(token,{id:data.plan.id,order});const previous=g.plans.get(data.plan.id);g.plans.set(data.plan.id,{data:previous?.data??data,order:Math.min(order,previous?.order??order)});emit(g);return()=>{g.mounts.delete(token);emit(g);queueMicrotask(()=>{if(!g.mounts.size&&groups.get(key)===g){groups.delete(key);for(const fn of g.listeners)fn();}});};},update(key,data){const g=groups.get(key),prior=g?.plans.get(data.plan.id);if(prior&&prior.data!==data){g.plans.set(data.plan.id,{...prior,data});emit(g);}},size(){return groups.size;}};
}
function imageTurnKey(data,turn,prefix){return JSON.stringify([prefix,data.sessionId??data.plan.nativeSession??'',data.plan.owner??'',Number.isSafeInteger(turn)&&turn>0?turn:data.plan.id]);}
// Read the turn's native tool data, including folded PTC children. No tool needs
// to be mounted and no generation request is sent to rebuild the inline gallery.
function turnGenerationPlans(toolData){
 const plans=new Map(),visited=new Set();
 function visit(block){
  if(!block||visited.has(block))return;visited.add(block);
  const name=block.call?.name??block.name;
  if(['team_image_generate','team_image_prepare','team_video_generate','team_video_prepare','team_task_resubmit'].includes(name)&&!block.isError){
   try{const value=JSON.parse((block.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n'));
    if(['image','video'].includes(value?.kind)&&typeof value.plan?.id==='string')plans.set(value.kind+'/'+value.plan.id,value);
   }catch{}
  }
  for(const child of block.subCalls??[])visit(child);
 }
 for(const data of toolData??[])visit(data.root);
 return [...plans.values()];
}
function turnCodexRuns(toolData){
 const runs=new Map(),seen=new Set();function visit(block){if(!block||seen.has(block))return;seen.add(block);try{const value=JSON.parse((block.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n'));if(!block.isError){for(const v of value?.kind==='codex'?[value]:value?.items??[])if(v?.kind==='codex'&&v.run?.id)runs.set(v.run.id,v.run);}}catch{}for(const c of block.subCalls??[])visit(c);}for(const data of toolData??[])visit(data.root);return [...runs.values()];
}
function turnAssemblyJobs(toolData){
 const jobs=new Map(),seen=new Set();
 function visit(block){if(!block||seen.has(block))return;seen.add(block);
  if(!block.isError&&['team_video_assemble','team_video_assembly_status','team_video_assembly_resume','team_video_assembly_cancel'].includes(block.call?.name??block.name))try{
   const value=JSON.parse((block.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n'));
   for(const job of value?.kind==='assembly'?[value.job]:value?.kind==='assemblies'?value.items??[]:[])if(typeof job?.id==='string')jobs.set(job.id,job);
  }catch{}
  for(const child of block.subCalls??[])visit(child);
 }
 for(const data of toolData??[])visit(data.root);return [...jobs.values()];
}
window.__ModuleLoader__.load({id:'team-project-integration',factory:require=>{
 const React=require('react'),h=React.createElement;
 const MediaGallery=window.__TEAM_CREATE_GALLERY__?.(React,window.__TEAM_GALLERY_CSS__)??(()=>null);
 const prefix=location.pathname.match(/^\/harness\/[^/]+/)?.[0]??'';
 // Keep dynamically scoped URLs intact when the native proxy rewrites root asset literals.
 const teamUrl=path=>prefix+'/api'+'/team/'+path;
 const mediaUrl=id=>teamUrl('media/'+id);
 const styles={card:{border:'1px solid var(--dsw-alias-border-l1,#dedee5)',borderRadius:14,padding:16,margin:'10px 0',fontSize:13,lineHeight:1.7,color:'var(--dsw-alias-label-primary,inherit)',background:'var(--dsw-alias-bg-base,transparent)'},button:{border:'1px solid var(--dsw-alias-border-l1,#dedee5)',borderRadius:8,padding:'6px 12px',cursor:'pointer',background:'var(--dsw-alias-bg-base,transparent)',color:'inherit',margin:'6px 8px 0 0'},muted:{fontSize:12,color:'var(--dsw-alias-label-caption,#777)'},pre:{whiteSpace:'pre-wrap',wordBreak:'break-word',maxHeight:280,overflow:'auto',fontFamily:'inherit'},error:{color:'var(--dsw-alias-state-error-primary,#ba3434)'}};
 const labels={awaiting_confirmation:'待你确认',confirmed:'主机已接收',queued:'主机排队 · 尚未发送',preparing:'准备素材',submitting:'正在发送给供应商',running:'供应商生成中',downloading:'下载到主机',checking:'检查原片',ready:'原片已返回',adopted:'已采用',cancelled:'已取消',qa_failed:'原片参数需核对',failed:'供应商任务失败',blocked:'提交前检查未通过',submission_unknown:'提交结果待后台核对',download_failed:'已有回执，下载待恢复',needs_input:'请补充信息'};
 async function api(path,method='GET',body){const r=await fetch('/api/team/'+path,{method,cache:'no-store',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error??'操作未确认，请刷新状态');return data;}
 const planPoller=createTeamPlanPoller({fetchBatch:keys=>api('status?plans='+encodeURIComponent(keys.join(','))),onChange:value=>window.dispatchEvent(new CustomEvent('team-media-updated',{detail:{session:value.sessionId??value.plan.nativeSession,owner:value.plan.owner}}))});
 function ModelRoute({session,running}){
  const [value,setValue]=React.useState(),[error,setError]=React.useState('');
  React.useEffect(()=>{if(!session)return;let stopped=false,timer,controller;
   const tick=async()=>{controller=new AbortController();try{const r=await fetch(teamUrl('model-route?session='+encodeURIComponent(session)),{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])}),v=await r.json();if(!r.ok)throw Error('线路状态暂不可读');if(!stopped){setValue(v.route);setError('');}}catch(e){if(!stopped)setError(e.message);}if(!stopped&&running)timer=setTimeout(tick,3000);};void tick();return()=>{stopped=true;clearTimeout(timer);controller?.abort();};
  },[session,running]);
  if(!value)return null;
  const state={selecting:'选择备用',requesting:'连接模型',streaming:'正在回答',completed:'已完成',failed:'连接失败',interrupted:'回答中断',cancelled:'已停止',revoked:'访问已停用'}[value.state]??value.state;
  const reasons={cooldown:'线路冷却中',recovery_probe_in_progress:'正在恢复检测',configuration_changed:'配置已变化',image_capability_unverified:'图片能力未确认',tool_capability_unverified:'工具能力未确认',context_window_insufficient:'上下文容量不足',context_window_unverified:'上下文容量未确认',reasoning_effort_unsupported:'不支持本次推理档位',structured_output_unverified:'结构化输出能力未确认',upstream_http:'上游请求失败',empty_stream:'未返回有效内容',connection_or_first_output_failure:'连接或首个有效输出超时',provider_content_rejected:'供应商未接受内容'};
  return h('details',{className:'team-model-route','aria-label':'本次模型线路'},h('summary',{title:state+' · '+(value.actualModel??'尚未输出')},value.actualModel?'实际：'+value.actualModel:state),h('div',null,h('strong',null,value.requested==='team-auto'?'自动模式':'固定型号'),h('p',null,state+(value.actualProvider?' · '+value.actualProvider:'')+' · 已尝试 '+value.attempted+' 条线路'),...(value.events??[]).filter(e=>e.state==='failed'||e.state==='skipped').map((e,n)=>h('p',{key:n},e.modelId+' · '+(reasons[e.reason??e.stage]??e.reason??e.stage)+(e.status?' · HTTP '+e.status:''))),value.error&&h('p',{role:'alert'},value.error.message),error&&h('p',{role:'status'},error+'，显示上次读取结果')));
 }
 function NativeMessageGallery({images,loadImage}){
  const current=window.__TEAM_CURRENT_SESSION__;
  const items=nativeGalleryReferences(images).map((ref,n)=>{const a=ref.attachment??ref.file??{},name=ref.preview?.name??a.name??'聊天图片',kind=/\.(mp4|mov|m4v|webm|mkv)$/i.test(name)?'video':'image';
   const url=ref.file&&current?prefix+'/team-settings/api/gallery/attachment?'+new URLSearchParams({project:team.project,owner:team.user,session:current,attachmentId:a.attachmentId,name:a.name??''}):ref.preview?.url;
   return {id:(a.attachmentId??ref.preview?.url??'preview')+':'+n,name,kind,src:url,download:url?url+(url.includes('?')?'&':'?')+'download=1':undefined,attachment:ref.attachment,bytes:a.bytes,width:a.width,height:a.height};});
  const load=React.useCallback(item=>loadImage(item.attachment),[loadImage]);
  return h(MediaGallery,{items,load,title:'本次提交',compact:true});
 }

 function ChatGalleryLink({items=[],title='在聊天画廊中查看'}){
  return items.length?h('button',{type:'button',style:styles.button,onClick:()=>window.dispatchEvent(new CustomEvent('team-chat-gallery-open',{detail:{items,selected:items[0]?.id}}))},title+' · '+items.length+' 项'):null;
 }
 function ChatGallery({session,owner=team.user,header=false}){
  const [data,setData]=React.useState({items:[],warnings:[]}),[error,setError]=React.useState(''),[opened,setOpened]=React.useState(false),[extra,setExtra]=React.useState([]),[selected,setSelected]=React.useState();const feedRef=React.useRef();
  React.useEffect(()=>{setData({items:[],warnings:[]});setExtra([]);setSelected(undefined);setError('');setOpened(false);
   const feed=createChatGalleryFeed({emit:value=>{setData({items:value.items,warnings:value.warnings});setError(value.error);},fetchItems:async signal=>{
    const items=[],warnings=new Set();let pages=1;
    for(let page=1;page<=pages;page++){
     const query=new URLSearchParams({project:team.project,owner,session,kind:'all',page:String(page)}),r=await fetch(prefix+'/team-settings/api/gallery?'+query,{cache:'no-store',signal}),v=await r.json();
     if(!r.ok)throw Error(v.error??'聊天画廊暂不可读');
     if(!Array.isArray(v.items)||!Number.isSafeInteger(v.pagination?.pages)||v.pagination.pages<0)throw Error('聊天画廊返回不完整，正在重新读取。');
     items.push(...scopeChatGalleryItems(v.items,prefix));for(const w of v.warnings??[])warnings.add(w);pages=v.pagination.pages;
    }
    return {items:[...new Map(items.map(item=>[item.id,item])).values()],warnings:[...warnings]};
   }});
   const changed=e=>{if((!e.detail?.session||e.detail.session===session)&&(!e.detail?.owner||e.detail.owner===owner))void feed.refresh();};
   feedRef.current=feed;window.addEventListener('team-media-updated',changed);if(session)void feed.refresh();
   return()=>{if(feedRef.current===feed)feedRef.current=undefined;feed.dispose();window.removeEventListener('team-media-updated',changed);};
  },[session,owner]);
  React.useEffect(()=>{const open=e=>{setExtra(previous=>[...new Map([...previous,...(e.detail?.items??[])].map(v=>[v.id,v])).values()]);setSelected(e.detail?.selected);setOpened(true);};window.addEventListener('team-chat-gallery-open',open);return()=>window.removeEventListener('team-chat-gallery-open',open);},[session,owner]);
  const items=[...data.items];for(const v of extra){const existing=items.find(x=>x.id===v.id||v.attachment?.attachmentId&&x.id.includes(v.attachment.attachmentId));if(!existing)items.push({...v,bundleable:false});else if(selected===v.id&&selected!==existing.id)items[items.indexOf(existing)]={...existing,bundleId:existing.id,id:v.id};}
  const load=React.useCallback(item=>item.load?item.load(item):Promise.reject(Error('附件暂不可读')),[]);
  if(!session)return null;
  return h('section',{'aria-label':'本聊天全部媒体',style:header?{position:'relative'}:{padding:'8px 20px',borderBottom:'1px solid var(--dsw-alias-border-l1)',flexShrink:0}},h('button',{type:'button',style:{...styles.button,margin:0},'aria-expanded':opened,onClick:()=>setOpened(v=>!v)},'聊天画廊 · '+items.length+' 项 '+(opened?'收起':'展开')),opened&&h('div',{className:header?'team-chat-gallery-popover':undefined,style:header?{position:'fixed',top:100,left:'max(16px,calc((100vw - 920px)/2))',right:'max(16px,calc((100vw - 920px)/2))',zIndex:50,boxShadow:'0 12px 48px #0003',borderRadius:14}:{marginTop:8}},h(MediaGallery,{items,load,selectedId:selected,compact:true,title:'本聊天的图片与视频',bundleCount:data.items.length,bundleUrl:prefix+'/team-settings/api/gallery/bundle?'+new URLSearchParams({project:team.project,owner,session,kind:'all'})})),error&&h('span',{role:'alert',style:styles.error},error,' ',h('button',{type:'button',onClick:()=>void feedRef.current?.refresh()},'重试')),opened&&data.warnings.map(w=>h('p',{key:w,style:styles.muted},w)));
 }
 function PlanCard({data}){
  const [current,setCurrent]=React.useState(data),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[notes,setNotes]=React.useState(''),[notice,setNotice]=React.useState(''),[history,setHistory]=React.useState(null);
  const p=current.plan,kind=current.kind,key=kind+'/'+p.id;
  React.useEffect(()=>planPoller.subscribe(key,data,(value,message)=>{if(value)setCurrent(value);setError(message);}),[key]);
  async function action(fn){setBusy(true);setError('');try{await fn();planPoller.refresh(key);}catch(e){setError(e.message);}finally{setBusy(false);}}
  function button(label,fn,disabled=false){return h('button',{type:'button',style:styles.button,disabled:busy||disabled,onClick:()=>void action(fn)},label);}
  async function loadHistory(earlier=false){const page=await api(key+'/history'+(earlier&&history?.nextCursor?'?cursor='+encodeURIComponent(history.nextCursor):''));setHistory(previous=>({...page,updatedAt:new Date().toLocaleTimeString(),items:earlier?[...page.items,...(previous?.items??[])].filter((v,n,all)=>all.findIndex(x=>x.plan.id===v.plan.id)===n):page.items}));}
  const jobLabel=j=>j.state==='adopted'?adoptedLabel(j):(j.delivery?.label??labels[j.state]??j.state);
  const jobs=p.jobs??[],isVideo=kind==='video';
  const returned=jobs.filter(j=>j.mediaId).length;
  const state=jobs.length===1?jobs[0].state:p.state;
  const status=jobs.length>1&&returned===jobs.length?(jobs.some(j=>j.state==='qa_failed')?'原片已返回，参数需核对':'原片已返回'):(jobs.length===1?jobLabel(jobs[0]):labels[state]??state);
  return h('section',{style:styles.card,'aria-label':isVideo?'视频补抽方案':'图片生成方案'},
   h('div',{style:{display:'flex',justifyContent:'space-between',gap:12}},h('strong',null,isVideo?'视频补抽':'图片生成'),h('span',{role:'status'},status)),
   h('div',null,p.model?.name??'待选择模型'),
   p.previousPlanId&&h('div',{style:styles.muted},'接续上一轮 · 原片与修改记录保留'),
   (p.issues??[]).map((v,i)=>h('p',{key:i,style:styles.error},v)),
   (p.shots??[p]).map((shot,index)=>h('div',{key:index},h('div',{style:styles.muted},Object.entries(shot.params??{}).map(([k,v])=>`${({seconds:'时长',resolution:'分辨率',aspect_ratio:'画幅',audio:'音频',size:'尺寸'})[k]??k}：${v}${k==='seconds'?' 秒':''}`).join(' · ')),h('details',null,h('summary',null,'查看本轮提示词与参考图'),h('pre',{style:styles.pre},shot.prompt),(shot.assets??[]).length>0&&h(ChatGalleryLink,{title:'查看参考图片与视频',items:shot.assets.filter(a=>!a.mime?.startsWith('audio/')).map(a=>({id:'media:'+a.mediaId,name:a.role??a.name??'参考原件',kind:a.mime?.startsWith('video/')?'video':'image',bytes:a.bytes,src:mediaUrl(a.mediaId),download:mediaUrl(a.mediaId)+'?download=1'}))}),...(shot.assets??[]).filter(a=>a.mime?.startsWith('audio/')).map(a=>h('div',{key:a.mediaId},h('audio',{controls:true,preload:'none',src:mediaUrl(a.mediaId),style:{width:'100%'}}),h('a',{href:mediaUrl(a.mediaId)+'?download=1',download:true},a.name??a.role??'下载参考音频')))))),
   p.state==='awaiting_confirmation'&&button('确认并提交生成',async()=>setCurrent(await api(key+'/confirm','POST',{digest:p.digest}))),
   returned>0&&h(ChatGalleryLink,{title:isVideo?'查看生成视频':'查看生成图片',items:jobs.filter(j=>j.mediaId).map((j,n)=>({id:'media:'+j.mediaId,name:(j.round?'第 '+j.round+' 轮 · ':'')+(isVideo?'视频':'图片')+' '+(n+1),kind:isVideo?'video':'image',src:mediaUrl(j.mediaId),download:mediaUrl(j.mediaId)+'?download=1',poster:j.technicalQA?.frames?.[0]?.mediaId?mediaUrl(j.technicalQA.frames[0].mediaId):undefined,bytes:j.bytes??j.downloadTotalBytes,width:j.technicalQA?.width,height:j.technicalQA?.height,seconds:j.technicalQA?.duration,model:p.model?.name,source:'生成结果'}))}),
   jobs.map(j=>h('div',{key:j.id,style:{borderTop:'1px solid var(--dsw-alias-border-l1,#dedee5)',marginTop:12,paddingTop:10}},
    h('strong',null,`${j.round?'第 '+j.round+' 轮 · ':''}${jobLabel(j)}${j.remoteProgress!=null&&j.state==='running'?' '+j.remoteProgress+'%':''}`),
    j.safeRetryCount>0&&h('div',{style:styles.muted},'提交前临时失败已自动重试；已保留同一轮任务'),
    j.error&&h('p',{style:styles.error},j.error),
    j.technicalQA?.width&&j.technicalQA?.height&&h('div',{style:styles.muted},`原片尺寸：${j.technicalQA.width} × ${j.technicalQA.height}`),
    j.mediaId&&h('a',{href:mediaUrl(j.mediaId)+'?download=1',download:true,style:{...styles.button,display:'inline-block'}},isVideo?'下载原片':'下载原图'),
    j.state==='queued'&&button('取消尚未发送的任务',async()=>setCurrent(await api(key+'/cancel','POST',{jobId:j.id}))),
    j.state==='adopted'&&h('span',{style:styles.muted},adoptedLabel(j)),
    isVideo&&j.state==='ready'&&button('验收通过并采用',async()=>{setCurrent(await api(key+'/adopt','POST',{digest:p.digest,jobId:j.id,humanAccepted:true}));planPoller.refreshAll();if(history)await loadHistory();}),
    !isVideo&&j.state==='download_failed'&&button('恢复原图下载',async()=>setCurrent(await api(key+'/recover','POST',{jobId:j.id})))
   )),
   jobs.some(j=>j.mediaId)&&h('a',{href:teamUrl(key+'/bundle'),download:true,style:{...styles.button,display:'inline-block'}},'打包下载本轮原片'),
   button(history?'收起各轮对比':'查看各轮对比',async()=>{if(history)setHistory(null);else await loadHistory();}),
   history&&h('div',null,h('p',{style:styles.muted},'已显示 '+history.items.length+' / '+history.total+' 个版本 · 对比更新于 '+history.updatedAt),button('刷新对比',()=>loadHistory()),history.nextCursor&&button('载入更早版本',()=>loadHistory(true))),
   history&&h(ChatGalleryLink,{title:'查看各轮结果',items:history.items.flatMap(v=>(v.plan.jobs??[]).filter(j=>j.mediaId).map(j=>({id:'media:'+j.mediaId,name:'第 '+v.versionNumber+' 个版本 · '+(v.plan.model?.name??''),kind:isVideo?'video':'image',src:mediaUrl(j.mediaId),download:mediaUrl(j.mediaId)+'?download=1'})))}),
   history&&h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:12}},...history.items.map(v=>h('div',{key:v.plan.id,style:styles.card},h('strong',null,'第 '+v.versionNumber+' 个版本 · '+(v.plan.model?.name??'')),h('p',{style:styles.muted},v.plan.created?new Date(v.plan.created).toLocaleString():''),h('p',null,v.plan.parsed?.notes??v.plan.prompt),h('p',{style:styles.muted},v.plan.promptTemplate?'提示词：'+v.plan.promptTemplate.title+' · v'+v.plan.promptTemplate.version:''),...(v.plan.jobs??[]).map(j=>h('div',{key:j.id},h('span',null,jobLabel(j)),j.mediaId&&h('a',{href:mediaUrl(j.mediaId)+'?download=1',download:true},'下载原件')))))),
   isVideo&&jobs.length>0&&h('details',null,h('summary',null,'继续修改这一轮'),h('textarea',{'aria-label':'本轮修改意见',placeholder:'填写需要修正的动作、人物、服装或镜头；也可在下方聊天框继续发送意见和附件。',value:notes,onChange:e=>setNotes(e.target.value),rows:3,style:{width:'100%',boxSizing:'border-box',borderRadius:8,border:'1px solid var(--dsw-alias-border-l1,#ddd)',background:'inherit',color:'inherit',padding:10,marginTop:8}}),button('把修改意见发到当前聊天',async()=>{
    const request={sessionId:current.sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:`继续修正我的视频方案 ${p.id}。请直接使用 team_video_generate，并填 previous_plan_id=${p.id}，模型和未提及参数保持上一轮。我的修改意见：${notes}`} ]};
    const r=await fetch('/api/session/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'session/prompt',payload:{args:{request}}})});const result=await r.json();if(!r.ok||result.result?.ok===false)throw Error('修改意见未确认送达，请核对聊天记录');setNotes('');setNotice('修改意见已发到当前聊天。');
   },!notes.trim())),
   error&&h('p',{role:'alert',style:styles.error},error),notice&&h('p',{role:'status',style:styles.muted},notice),
   h('div',{style:styles.muted},'主机自动执行并返回原片。关闭页面也会继续；可随时在当前聊天提出修改。')
  );
 }
 const imageTurns=createImageTurnRegistry();
 function TurnGenerationGallery({turn,useChat,sessionId}){
  const nodes=useChat(s=>s.nodes),source=React.useMemo(()=>nodes.turnDataSource(turn.turn,'tool-call'),[nodes,turn.turn]);
  const toolData=React.useSyncExternalStore(source.subscribe,source.getSnapshot,source.getSnapshot),rows=turnGenerationPlans(toolData),codex=turnCodexRuns(toolData),assemblies=turnAssemblyJobs(toolData);
  return rows.length||codex.length||assemblies.length?h('div',{'data-team-turn-gallery':turn.turn,'data-team-gallery-session':sessionId},rows.length>0&&h(ImagePlanGallery,{rows}),...assemblies.map(job=>h(AssemblyCard,{key:job.id,initial:job})),...codex.map(run=>h(CodexCard,{key:run.id,initial:run}))):null;
 }
 function ImagePlanGallery({rows}){
  const [selected,setSelected]=React.useState(),[details,setDetails]=React.useState(false),[errors,setErrors]=React.useState({});
  const choose=React.useCallback(item=>setSelected(item.id),[]);
  // Status/list responses use this same gallery; reuse the existing batched poller.
  const ids=rows.map(v=>v.kind+'/'+v.plan.id).join(',');
  const [latest,setLatest]=React.useState({});
  React.useEffect(()=>{setLatest({});setErrors({});const stops=rows.map(seed=>planPoller.subscribe(seed.kind+'/'+seed.plan.id,seed,(value,error)=>{if(value)setLatest(old=>({...old,[seed.plan.id]:value}));setErrors(old=>({...old,[seed.plan.id]:error}));}));return()=>stops.forEach(stop=>stop());},[ids]);
  const values=rows.map(v=>latest[v.plan.id]??v),items=values.flatMap((v,n)=>{const p=v.plan,jobs=p.jobs?.length?p.jobs:[{id:'pending',state:p.state}];return jobs.map((j,k)=>({id:p.id+':'+j.id,planId:p.id,name:(v.kind==='video'?'视频 ':'图片 ')+String(n+1).padStart(2,'0')+(jobs.length>1?' · '+(k+1):''),kind:v.kind,src:j.mediaId?mediaUrl(j.mediaId):undefined,download:j.mediaId?mediaUrl(j.mediaId)+'?download=1':undefined,poster:j.technicalQA?.frames?.[0]?.mediaId?mediaUrl(j.technicalQA.frames[0].mediaId):undefined,seconds:j.technicalQA?.duration,status:j.delivery?.label??labels[j.state]??j.state??'等待提交',model:p.model?.name,error:j.error||(p.issues??[]).join('；'),bytes:j.bytes??j.downloadTotalBytes,width:j.technicalQA?.width,height:j.technicalQA?.height,source:'本轮生成',state:j.state}));});
  const item=items.find(v=>v.id===selected)??items[0],current=values.find(v=>v.plan.id===item?.planId),done=items.filter(v=>v.src).length,failed=items.filter(v=>!v.src&&['failed','blocked','qa_failed','submission_unknown','download_failed','needs_input','awaiting_confirmation'].includes(v.state)).length,cancelled=items.filter(v=>!v.src&&v.state==='cancelled').length,waiting=items.length-done-failed-cancelled,models=[...new Set(values.map(v=>v.plan.model?.name).filter(Boolean))];
  const imagesOnly=items.every(v=>v.kind==='image'),unit=imagesOnly?' 张':' 项';
  return h('section',{className:'team-image-batch','aria-label':imagesOnly?'本轮图片生成画廊':'本轮媒体生成画廊',style:{margin:'10px 0',minWidth:0}},
   h('div',{style:{display:'flex',alignItems:'center',flexWrap:'wrap',gap:10,marginBottom:10}},h('strong',null,imagesOnly?'图片生成':'本轮生成'),h('span',{role:'status',style:styles.muted},items.length+unit+' · '+done+unit+'已返回'+(waiting?' · '+waiting+unit+'处理中':'')+(failed?' · '+failed+unit+'需处理':'')+(cancelled?' · '+cancelled+unit+'已取消':'')),h('span',{style:{...styles.muted,marginLeft:'auto'}},models.length===1?models[0]:models.length?models.length+' 个模型':'模型待确认')),
   h(MediaGallery,{items,title:imagesOnly?'本轮图片':'本轮图片与视频',compact:true,selectedId:selected,onSelect:choose}),
   h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:8,marginTop:8}},h('button',{type:'button',style:{...styles.button,margin:0},'aria-expanded':details,onClick:()=>setDetails(v=>!v)},details?'收起单图详情':'查看单图详情 · 提示词 / 参考图 / 各轮对比'),h('span',{style:styles.muted},'关闭页面后继续生成')),
   Object.values(errors).some(Boolean)&&h('p',{role:'alert',style:styles.error},'部分状态暂未更新，正在重新连接。'),
   details&&current&&h(PlanCard,{key:current.plan.id,data:current}));
 }
 function ImagePlanSlot({data,turn,order,callId}){
  const token=React.useRef(Symbol(callId??data.plan.id)).current,key=imageTurnKey(data,turn,prefix);
  const subscribe=React.useCallback(fn=>imageTurns.subscribe(key,fn),[key]),snapshot=React.useCallback(()=>imageTurns.get(key),[key]);
  const group=React.useSyncExternalStore(subscribe,snapshot,snapshot);
  React.useEffect(()=>imageTurns.mount(key,token,data,Number.isFinite(order)?order:Date.parse(data.plan.created)||0),[key,token,data.plan.id]);
  React.useEffect(()=>imageTurns.update(key,data),[key,data]);
  // The first mounted card owns the gallery. Other calls retain their native
  // records and positions but do not repeat ten complete generation panels.
  return group.leader===token?h(ImagePlanGallery,{rows:group.rows}):null;
 }
 function AssemblyCard({initial}){
  const [job,setJob]=React.useState(initial),[error,setError]=React.useState(''),[pollEpoch,setPollEpoch]=React.useState(0);
  React.useEffect(()=>{let stopped=false,timer;const read=async()=>{let done=false;try{const v=await api('assembly/'+initial.id);if(!stopped){setJob(v.job);setError('');done=['ready','failed','cancelled'].includes(v.job.state);if(v.job.state==='ready')window.dispatchEvent(new CustomEvent('team-media-updated',{detail:{session:v.job.nativeSession,owner:v.job.owner}}));}}catch(e){if(!stopped)setError(e.message);}if(!stopped&&!done)timer=setTimeout(read,2000);};void read();return()=>{stopped=true;clearTimeout(timer);};},[initial.id,pollEpoch]);
  const action=async name=>{try{const v=await api('assembly/'+job.id+'/'+name,'POST',{});setJob(v.job);setError('');setPollEpoch(n=>n+1);if(name==='resume')window.dispatchEvent(new CustomEvent('team-media-updated'));}catch(e){setError(e.message);}};
  const state={queued:'等待本机处理',waiting_sources:'等待原视频完成',normalizing:'整理片段',joining:'拼接中',delivering:'保存成片',ready:'成片已保存',failed:'拼接未完成',cancelled:'已停止'}[job.state]??job.state;
  return h('section',{style:styles.card,'aria-label':'本机视频拼接'},h('strong',null,job.name+' · '+state),h('p',{style:styles.muted},(job.episode?job.episode+' · ':'')+'片段 '+(job.progress?.completed??0)+' / '+(job.progress?.total??job.clips?.length??0)),job.mediaId&&h(MediaGallery,{items:[{id:'media:'+job.mediaId,name:job.name,kind:'video',src:mediaUrl(job.mediaId),download:mediaUrl(job.mediaId)+'?download=1'}],compact:true,title:'拼接成片'}),job.output&&h('p',{style:styles.muted},job.output.duration.toFixed(2)+' 秒 · '+job.output.width+' × '+job.output.height+' · 源视频保留'),job.error&&h('p',{role:'alert',style:styles.error},job.error),['failed','cancelled'].includes(job.state)&&h('button',{type:'button',style:styles.button,onClick:()=>void action('resume')},'继续本次拼接'),!['ready','failed','cancelled'].includes(job.state)&&h('button',{type:'button',style:styles.button,onClick:()=>void action('cancel')},'停止拼接'),error&&h('p',{role:'alert',style:styles.error},error),h('p',{style:styles.muted},'主机本地处理，关闭页面也会继续。原片保留，成片仍需观看核对。'));
 }
 function ToolView({block,teamGalleryTurn,teamGalleryOrder,teamGallerySettled,callId}){let value;const text=(block.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');try{value=JSON.parse(text);}catch{}
  if(teamGallerySettled&&(value?.kind==='codex'||value?.items?.some(v=>v.kind==='codex')))return h('p',{style:styles.muted},'Codex 进度与回答显示在本轮对话下方。');
  if(teamGallerySettled&&['assembly','assemblies'].includes(value?.kind))return h('p',{style:styles.muted},'拼接进度、成片与恢复操作显示在本轮对话下方。');
  if(value?.kind==='codex')return h(CodexCard,{key:value.run.id,initial:value.run});
  if(value?.items?.some(v=>v.kind==='codex'))return h('div',null,...value.items.map(v=>h(CodexCard,{key:v.run.id,initial:v.run})));
  if(value?.kind==='assembly')return h(AssemblyCard,{key:value.job.id,initial:value.job});
  if(value?.kind==='assemblies')return h('div',null,...value.items.map(job=>h(AssemblyCard,{key:job.id,initial:job})));
  if(value?.kind==='incident')return h(IncidentCard,{initial:value.report});
  if(value?.kind==='screenwriter')return h('section',{style:styles.card,'aria-label':'编剧候选稿'},h('strong',null,value.needsInput?'请补充编剧资料':'编剧候选稿'),value.summary&&h('p',{style:styles.muted},value.summary),value.candidate&&h('pre',{style:styles.pre},value.candidate),...(value.issues??[]).map((issue,index)=>h('p',{key:index,style:styles.muted},issue)),value.scenes?.length&&h('details',null,h('summary',null,'场次与连续性'),h('pre',{style:styles.pre},JSON.stringify({characters:value.characters,scenes:value.scenes,continuity:value.continuity},null,2))),h('p',{style:styles.muted},'以上为候选稿，仅保留在当前聊天；需要写回项目请按现有审核流程提交。'));
  if(teamGallerySettled&&['image','video'].includes(value?.kind)&&value.plan)return h('p',{style:styles.muted},'生成进度与原件显示在本轮对话下方的画廊。');
  if(value?.kind==='image')return h(ImagePlanSlot,{key:value.plan.id,data:value,turn:teamGalleryTurn??block.turn,order:teamGalleryOrder??block.seq,callId});
  if(value?.kind==='private-skill')return h('section',{style:styles.card,'aria-label':'分镜整理结果'},h('strong',null,value.needsInput?'请补充具体素材':'分镜已整理'),...(value.issues??[]).map((issue,index)=>h('p',{key:index,style:styles.muted},issue)),...(value.nodes??[]).map((node,index)=>h('details',{key:index},h('summary',null,'节点 '+(index+1)+' · '+node.params.seconds+' 秒'),h('pre',{style:styles.pre},node.prompt))),h('p',{style:styles.muted},value.needsInput?'在当前聊天补充后即可继续。':'已要求生成时，智能体将继续提交；这里只展示本轮整理结果。'));
  if(value?.kind==='video')return h(PlanCard,{key:value.plan.id,data:value});
  if(value?.kind==='plans'){const images=value.items.filter(v=>v.kind==='image');return h('div',null,images.length>0&&h(ImagePlanGallery,{rows:images}),value.items.filter(v=>v.kind!=='image').map(item=>h(PlanCard,{key:item.plan.id,data:item})),!value.items.length&&h('p',{style:styles.muted},'当前会话暂无生成任务。'));}
  return h('div',{style:styles.card},h('strong',null,block.isError?'项目操作需要补充信息':'项目操作'),h('pre',{style:styles.pre},text||'正在连接团队项目…'));
 }
 function CodexCard({initial}){
  const [run,setRun]=React.useState(initial),[error,setError]=React.useState('');
  React.useEffect(()=>{let disposed=false,timer,controller;const tick=async()=>{let finished=false;controller=new AbortController();try{const response=await fetch(teamUrl('codex/'+initial.id),{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])}),v=await response.json();if(!response.ok)throw Error(v.error??'Codex 状态暂不可用');if(!disposed){setRun(v.run);setError('');finished=['completed','failed','interrupted','cancelled'].includes(v.run.state);}}catch(e){if(!disposed)setError(e.message);}if(!disposed&&!finished)timer=setTimeout(tick,2000);};void tick();return()=>{disposed=true;clearTimeout(timer);controller?.abort();};},[initial.id]);
  const state={queued:'等待本聊天上一项完成',running:'正在执行',completed:'已完成',failed:'执行失败',interrupted:'执行中断',cancelled:'已停止'}[run.state]??run.state;
  return h('section',{style:styles.card,'aria-label':'Codex 执行进度'},h('strong',null,'Codex · '+state),run.model&&h('span',{style:styles.muted},' · '+run.model),run.text&&h('div',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',marginTop:10}},run.text),...(run.steps??[]).filter(v=>v.type!=='agentMessage').slice(-4).map(v=>h('div',{key:v.id,style:styles.muted},v.name+' · '+v.state)),(run.error||error)&&h('p',{style:styles.error},run.error||error),h('p',{style:styles.muted},'可在当前聊天继续向 Codex 提问；图片与视频任务由主机独立跟踪。'),(run.results??[]).some(v=>v.kind==='image')&&h(ImagePlanGallery,{rows:run.results.filter(v=>v.kind==='image')}),...(run.results??[]).filter(v=>v.kind==='video').map(v=>h(PlanCard,{key:v.plan.id,data:v})));
 }
 function IncidentCard({initial}){
  const [report,setReport]=React.useState(initial),[error,setError]=React.useState('');
  React.useEffect(()=>{let stopped=false,timer;const tick=async()=>{try{const r=await fetch(prefix+'/team-settings/api/incidents/'+initial.id,{cache:'no-store'}),v=await r.json();if(!r.ok)throw Error(v.error??'问题状态暂不可读');if(!stopped){setReport(v);setError('');}}catch(e){if(!stopped)setError(e.message);}if(!stopped)timer=setTimeout(tick,5000);};void tick();return()=>{stopped=true;clearTimeout(timer);};},[initial.id]);
  const checked=React.useRef('');const probe=report.mediaProbe;const loaded=async(ok)=>{if(!probe||checked.current===probe.nonce)return;checked.current=probe.nonce;try{await fetch(prefix+'/team-settings/api/incidents/'+report.id+'/client-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:probe.nonce,loaded:ok})});}catch{checked.current='';}};
  return h('section',{style:styles.card,'aria-label':'问题处理进度'},probe&&team.viewer===report.owner&&h(probe.mime.startsWith('video/')?'video':'img',{key:probe.nonce,hidden:true,alt:'',preload:'auto',src:prefix+'/team-settings/api/media/'+probe.mediaId,onLoadedData:()=>void loaded(true),onLoad:()=>!probe.mime.startsWith('video/')&&void loaded(true),onError:()=>void loaded(false)}),h('strong',null,report.label),h('p',null,report.description),h('ol',null,report.updates.map(u=>h('li',{key:u.id},u.message))),error&&h('p',{style:styles.error},error));
 }
 const team=window.__TEAM_CONTEXT__??{admin:false,project:'shared'};
 let choiceStorage;try{choiceStorage=window.localStorage;}catch{}
 const generationChoices=createGenerationChoices(choiceStorage,prefix+':'+(team.user??'current'));
 function GenerationModels({session}){
  const choice=React.useSyncExternalStore(generationChoices.subscribe,()=>generationChoices.read(session),()=>generationChoices.read(session));
  const [catalog,setCatalog]=React.useState({image:[],video:[],skill:[]}),[error,setError]=React.useState(''),[loading,setLoading]=React.useState(true),[attempt,retry]=React.useState(0);
  React.useEffect(()=>{let live=true,busy=false;const controller=new AbortController();async function refresh(){if(busy||document.visibilityState==='hidden')return;busy=true;setLoading(true);try{const rows=await Promise.all(['image','video'].map(async kind=>{const r=await fetch(prefix+'/team-settings/api/'+kind+'-models',{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});const v=await r.json();if(!r.ok)throw Error(v.error??'生成模型目录暂不可读');if(!Array.isArray(v))throw Error('生成模型目录格式错误');return generationMenuModels(kind,v);}),fetch(prefix+'/team-settings/api/chat-options',{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])}).then(async r=>{const v=await r.json();if(!r.ok)throw Error(v.error??'技能目录暂不可读');return (v.skills??[]).filter(s=>s.status==='published'&&s.memberAccess).map(s=>({id:s.id,name:s.name}));}));if(live){setCatalog({image:rows[0],video:rows[1],skill:rows[2]});setError('');}}catch(e){if(live)setError(e.message);}finally{busy=false;if(live)setLoading(false);}}void refresh();window.addEventListener('focus',refresh);return()=>{live=false;controller.abort();window.removeEventListener('focus',refresh);};},[attempt]);
  if(!session)return null;
  const lines=generationModelLines(choice);
  return h('div',{className:'team-generation-models',role:'group','aria-label':'生成模型选择'},
   ...['image','video'].map(kind=>{const models=Array.isArray(catalog[kind])?catalog[kind]:[];return h('label',{key:kind,className:'team-generation-choice',title:choice[kind]?`${kind==='image'?'图片':'视频'}模型：${choice[kind].name} · 随提示词发送`:`未指定${kind==='image'?'图片':'视频'}模型，不追加模型要求`},
    h('svg',{viewBox:'0 0 20 20',width:16,height:16,fill:'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true},kind==='image'?[h('rect',{key:'frame',x:2.5,y:3,width:15,height:14,rx:2.5}),h('circle',{key:'sun',cx:7,cy:7,r:1.25}),h('path',{key:'land',d:'m3 14 4-4 3 3 3-4 4 5'})]:[h('rect',{key:'frame',x:2.5,y:4.5,width:10,height:11,rx:2.5}),h('path',{key:'lens',d:'m12.5 8 5-3v10l-5-3z'})]),
    h('select',{'aria-label':kind==='image'?'图片生成模型':'视频生成模型',value:choice[kind]?.id??'',onChange:e=>generationChoices.set(session,kind,models.find(m=>m.id===e.target.value))},
     h('option',{value:''},kind==='image'?'图片模型':'视频模型'),
     choice[kind]&&!models.some(m=>m.id===choice[kind].id)&&h('option',{value:choice[kind].id},choice[kind].name),
     models.map(m=>h('option',{key:m.id,value:m.id},m.name))))}),
   h('label',{className:'team-generation-choice',title:choice.skill?`技能：${choice.skill.name} · 随提示词发送`:'未指定技能，使用当前聊天默认技能'},(()=>{const skills=Array.isArray(catalog.skill)?catalog.skill:[];return h('select',{'aria-label':'选择技能',value:choice.skill?.id??'',onChange:e=>generationChoices.set(session,'skill',skills.find(m=>m.id===e.target.value))},h('option',{value:''},'技能'),choice.skill&&!skills.some(m=>m.id===choice.skill.id)&&h('option',{value:choice.skill.id},choice.skill.name),skills.map(m=>h('option',{key:m.id,value:m.id},m.name)));})()),
   h('button',{className:'team-generation-refresh',type:'button',disabled:loading,onClick:()=>void feedRef.current?.refresh(),'aria-label':loading?'正在同步生成模型目录':'刷新生成模型目录',title:loading?'正在同步目录…':'刷新生成模型目录'},'↻'),
   h('span',{className:'team-generation-announcement',role:'status'},lines.length?lines.join(' · ')+'，随本条提示词发送':'未指定生成模型，不追加模型要求'),
   error&&h('div',{className:'team-generation-error',role:'alert'},error,'，可点击刷新重试'));
 }

 let memberChatSelection=null,memberChatOpenError='';
 let memberWorkspace;
 const useMemberWorkspace=()=>React.useSyncExternalStore(memberWorkspace.subscribe,memberWorkspace.getSnapshot,memberWorkspace.getSnapshot);
 function SettingsFrame({section,panel=false,onDraft,autoSelectFolder=false,workspaceAction=false,onFolderResult,onProjectCreated}){
  const frame=React.useRef(null);
  React.useEffect(()=>{const receive=e=>{if(e.source!==frame.current?.contentWindow||e.origin!==location.origin)return;
   if(e.data?.type==='team-settings-project'&&/^(shared|[a-f0-9-]{36})$/.test(e.data.project)){onProjectCreated?.();window.__TEAM_SEND__?.('team-project-select',{project:e.data.project,panel:e.data.panel});}
   if(e.data?.type==='team-workspace-folder-result')onFolderResult?.(e.data);
   if(e.data?.type==='team-tools-draft'&&typeof e.data.text==='string'&&e.data.text.length<2000)onDraft?.(e.data.text);
   if(e.data?.type==='team-tools-session'&&/^(session-[a-zA-Z0-9-]+|[a-f0-9-]{36})$/.test(e.data.session)){window.dispatchEvent(new CustomEvent('team-close-settings'));const session=e.data.session.startsWith('session-')?e.data.session:'session-team-'+e.data.session;if(e.data.project===team.project)window.dispatchEvent(new CustomEvent('team-open-session',{detail:e.data.member?{session,member:e.data.member}:session}));else window.__TEAM_SEND__?.('team-project-select',{project:e.data.project,session,member:e.data.member});}
   if(e.data?.type==='team-settings-section'&&['models','tasks','workspaces','members','billing','operations','prompts'].includes(e.data.section))window.dispatchEvent(new CustomEvent('team-open-settings',{detail:e.data.section}));
  };window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);},[]);
  return h('iframe',{ref:frame,title:section==='tasks'?(team.admin?'任务中心':'我的统计'):(panel?'项目工具 · ':'团队设置 · ')+section,'data-team-settings':true,src:prefix+'/team-settings/?'+(panel?'view':'panel')+'='+section+(autoSelectFolder?'&selectFolder=1':'')+(workspaceAction?'&action=add-workspace':''),hidden:workspaceAction,style:workspaceAction?{display:'none'}:{width:'100%',height:'100%',minHeight:0,flex:1,border:0,display:'block',background:'transparent'}});
 }
 function MemberSessionGroups({group,renderRow,members,observed,current,t,includeOwn=true,sessionById}){
  const [collapsed,setCollapsed]=React.useState({});
  React.useEffect(()=>{const member=observed.get(current)?.member??'self';setCollapsed(state=>state[member]?{...state,[member]:false}:state);},[current]);
  if(!group.expanded)return null;
  const own=group.sessions.filter(node=>!observed.has(node.id));
  const groups=[...(!includeOwn||!own.some(node=>sessionById[node.id]?.blank===false)?[]:[{id:'self',name:team.user&&team.viewer&&team.user!==team.viewer?team.ownerName??'当前成员':team.admin?'我（管理员）':'我',rows:own}]),...members.filter(workspaceMemberVisible).map(m=>({...m,name:m.self?'我':m.name,rows:group.sessions.filter(node=>observed.get(node.id)?.member===m.id)}))].filter(member=>member.rows.length>0);
  return h('div',{role:'group',className:'team-project-members'},groups.map(member=>h('div',{key:member.id,role:'treeitem','aria-level':2,'aria-label':member.name,'aria-expanded':!collapsed[member.id],className:'team-project-member','data-member-id':member.id},
   h('button',{type:'button',className:'team-member-heading',onClick:()=>setCollapsed(state=>({...state,[member.id]:!state[member.id]}))},h('span',{'aria-hidden':true},collapsed[member.id]?'▸':'▾'),h('span',null,member.name),h('small',null,String(member.rows.length))),
   !collapsed[member.id]&&h('div',{role:'group',className:'team-member-sessions'},member.rows.length?member.rows.map(node=>{
    const observedRow=observed.get(node.id),row=renderRow(observedRow?{...node,title:observedRow.title}:node);
    return observedRow?React.cloneElement(row,{drag:undefined,t:(key,values)=>key==='actions.session.aria'?'成员聊天记录：'+observedRow.name+' · '+observedRow.title:t(key,values)}):row;
   }):h('p',{className:'team-member-empty'},member.error?'聊天暂未读取，请重试':'暂无聊天'))
  )));
 }
 // Reuse the shipped WorkspaceBrowser; merge member summaries only at its display boundary.
 function MemberWorkspaceBrowser({Original,...props}){
  const state=useMemberWorkspace(),ownList=props.useSessions(v=>v),ownWorkspace=props.useWorkspaces(v=>v);
  const active=props.usePanelInfo(v=>v.activePanelId==='team-member-chats');
  const view=React.useMemo(()=>state.projects.length?allProjectWorkspace(ownList,ownWorkspace,state.projects,team.project,active?state.selected:null,team.user):projectMemberWorkspace(ownList,ownWorkspace,state.members,active?state.selected:null),[ownList,ownWorkspace,state.members,state.projects,state.selected,active]);
  const navigate=selection=>window.__TEAM_SEND__?.('team-project-select',selection);
  const observerTitles=new Set([...view.observed.keys()].map(id=>view.list.byId[id].displayTitle));
  const own=fn=>(...args)=>{memberWorkspace.select(null);return fn(...args);};
  const guard=fn=>(id,...args)=>{if(view.observed.has(id))return Promise.reject(Error('正在查看成员聊天，请返回自己的聊天操作。'));return fn(id,...args);};
  return h('div',{className:'team-workspace-browser',onDragStartCapture:e=>{if(e.target.closest('[data-team-foreign-project]')||e.target.closest('[role="treeitem"]')?.querySelector('[aria-label^="成员聊天记录："]')){e.preventDefault();e.stopPropagation();}}},
   h(Original,{...props,renderMemberGroups:(group,renderRow)=>{const meta=view.groups?.get(group.workspaceId);return h(MemberSessionGroups,{key:group.key,group,renderRow,includeOwn:meta?.own!==false,members:meta?.members??(group.cwd==='/workspace'?state.members:[]),observed:view.observed,current:view.list.current,sessionById:ownList.byId,t:props.t});},renderSlot:props.renderSlot,useSessions:select=>select(view.list),useWorkspaces:select=>select(view.workspace),usePanelInfo:select=>props.usePanelInfo(info=>select(active?{...info,activePanelId:null}:info)),
    open:id=>{const selection=view.observed.get(id);if(selection&&(selection.active!==false||selection.project&&selection.project!==team.project)){navigate({project:selection.project??team.project,session:selection.session,member:selection.member,...(selection.active===false?{historyOnly:true}:{})});return;}if(selection){memberChatSelection=selection;memberChatOpenError='';memberWorkspace.select(selection);window.dispatchEvent(new CustomEvent('team-member-chat-select',{detail:selection}));}else own(props.open)(id);},
    startSession:id=>{const project=view.foreign?.get(id);return project?navigate({project,newChat:true}):own(props.startSession)(id);},
    insertWorkspaceBefore:(id,before)=>view.foreign?.has(id)||view.foreign?.has(before)?Promise.resolve():props.insertWorkspaceBefore(id,before),renameSession:guard(props.renameSession),forkSession:guard(props.forkSession),archiveSession:guard(props.archiveSession),
    insertSessionBefore:(workspaceId,id,before)=>view.observed.has(id)||view.observed.has(before)?Promise.reject(Error('成员聊天按最新时间显示')):props.insertSessionBefore(workspaceId,id,before),
    t:(key,values)=>key==='actions.session.aria'&&observerTitles.has(values?.name)?'成员聊天记录：'+values.name:props.t(key,values)}),
   state.error&&props.wide&&h('p',{className:'team-workspace-error',role:'alert'},'项目列表暂未更新：'+state.error,h('button',{onClick:()=>void memberWorkspace.refresh()},'重试')),
   [...state.members,...state.projects.flatMap(p=>p.members)].some(m=>m.error)&&props.wide&&h('p',{className:'team-workspace-error',role:'alert'},[...state.members,...state.projects.flatMap(p=>p.members)].filter(m=>m.error).map(m=>m.name+'：'+m.error).join('；')));
 }
 function MemberChatPanel(props){const {selected}=useMemberWorkspace();return h(MemberChats,{...props,key:selected?teamMemberRowId(selected.member,selected.session,selected.project):'empty'});}
 // The existing authorized history API remains the data source; native message renderers own bubbles and Markdown.
 function MemberChats({t,useNativeChatRenderers}){
  const nativeRenderers=Object.fromEntries(useNativeChatRenderers(v=>v).map(e=>[e.options.key,e.component]));
  const {MarkdownText}=require('@deepseek-ai/dsh-client-ui-primitives');
  const endpoint=prefix+'/team-settings/api/admin/native-chats';
  const state=useMemberWorkspace(),selected=state.selected;
  const [chat,setChat]=React.useState(null),[error,setError]=React.useState(memberChatOpenError),[busy,setBusy]=React.useState(false),[updated,setUpdated]=React.useState('');
  React.useEffect(()=>{const pick=e=>{if(e.detail?.error)setError(e.detail.error);};window.addEventListener('team-member-chat-select',pick);return()=>window.removeEventListener('team-member-chat-select',pick);},[]);
  const scroll=React.useRef(null),stick=React.useRef(true),epoch=React.useRef(0),snapshot=React.useRef(null);snapshot.current=chat;
  async function get(url,signal){const r=await fetch(url,{signal,cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error??'读取失败');return d;}
  React.useEffect(()=>{const scope=++epoch.current;setChat(null);snapshot.current=null;setError('');setBusy(false);setUpdated('');stick.current=true;if(!selected)return;let timer;const controller=new AbortController();const path=endpoint+'/'+selected.member+'/'+selected.session;
   const load=async()=>{try{let d=await get(path+(snapshot.current&&snapshot.current.latestSeq>=0?'?after='+snapshot.current.latestSeq:''),controller.signal);if(epoch.current!==scope)return;
    setChat(previous=>{const rows=previous?[...previous.rows,...d.rows].filter((v,i,all)=>all.findIndex(x=>x.seq===v.seq)===i):d.rows;const next={...d,rows,hasOlder:previous?.hasOlder??d.hasOlder,latestSeq:d.hasNewer?(d.rows.at(-1)?.seq??previous?.latestSeq):d.latestSeq};snapshot.current=next;return next;});setError('');setUpdated(new Date().toLocaleTimeString());
   }catch(e){if(epoch.current===scope&&!controller.signal.aborted)setError(e.message);}finally{if(epoch.current===scope&&!controller.signal.aborted)timer=setTimeout(load,snapshot.current?.hasNewer?50:2500);}};void load();return()=>{epoch.current++;controller.abort();clearTimeout(timer);};},[selected?.member,selected?.session]);
  React.useLayoutEffect(()=>{if(stick.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[chat?.rows.length]);
  async function older(){if(busy||!chat?.hasOlder)return;const scope=epoch.current;setBusy(true);const height=scroll.current?.scrollHeight??0,top=scroll.current?.scrollTop??0;try{const d=await get(endpoint+'/'+selected.member+'/'+selected.session+'?before='+chat.rows[0].seq);if(scope!==epoch.current)return;stick.current=false;setChat(prev=>({...prev,rows:[...d.rows,...prev.rows].filter((v,i,a)=>a.findIndex(x=>x.seq===v.seq)===i),hasOlder:d.hasOlder}));requestAnimationFrame(()=>{if(scroll.current)scroll.current.scrollTop=top+scroll.current.scrollHeight-height;});}catch(e){if(scope===epoch.current)setError(e.message);}finally{if(scope===epoch.current)setBusy(false);}}
  function blockView(block,row,index){const url=endpoint+'/'+selected.member+'/'+selected.session+'/attachments/'+row.seq+'/'+index;
   if(block.type==='text')return h(MarkdownText,{key:index,text:block.text??'',labels:{copy:'复制',copied:'已复制'}});
   if(block.type==='reasoning')return h('details',{key:index,className:'team-chat-process'},h('summary',null,'思考过程'),h(MarkdownText,{text:block.text??'',labels:{copy:'复制',copied:'已复制'}}));
   if(block.type==='image')return h('a',{key:index,href:url,target:'_blank',rel:'noopener noreferrer'},h('img',{src:url,alt:block.attachment?.name??'聊天附件',loading:'lazy',className:'team-chat-image'}));
   if(block.type==='file')return h('div',{key:index,className:'team-chat-attachment'},/\.(png|jpe?g|webp)$/i.test(block.attachment?.name??'')&&h('img',{src:url,alt:block.attachment.name,loading:'lazy',className:'team-chat-image'}),/\.(mp4|mov|m4v)$/i.test(block.attachment?.name??'')&&h('video',{src:url,controls:true,preload:'metadata'}),h('a',{href:url,target:'_blank',rel:'noopener noreferrer'},block.attachment?.name??'下载附件'));
   if(block.type==='tool-call')return h('details',{key:index,className:'team-chat-process'},h('summary',null,'调用工具 · '+block.name),h('pre',null,block.arguments));
   if(block.type==='tool-result')return h('details',{key:index,className:'team-chat-process'},h('summary',null,block.isError?'工具执行错误':'工具执行结果'),h('pre',null,typeof block.content==='string'?block.content:JSON.stringify(block.content??block,null,2)));
   return h('details',{key:index,className:'team-chat-process'},h('summary',null,block.type??'消息内容'),h('pre',null,JSON.stringify(block,null,2)));
  }
  const isMedia=b=>b.type==='image'||b.type==='file'&&/\.(png|jpe?g|webp|gif|avif|mp4|mov|m4v|webm|mkv)$/i.test(b.attachment?.name??'');
  function rowGallery(row){return h(ChatGalleryLink,{title:'查看本次提交',items:(row.content??[]).flatMap((b,index)=>isMedia(b)?[{id:row.seq+':'+index,name:b.attachment?.name??'聊天图片',kind:/\.(mp4|mov|m4v|webm|mkv)$/i.test(b.attachment?.name??'')?'video':'image',src:endpoint+'/'+selected.member+'/'+selected.session+'/attachments/'+row.seq+'/'+index,download:endpoint+'/'+selected.member+'/'+selected.session+'/attachments/'+row.seq+'/'+index+'?download=1'}]:[])});}
  function messageView(row){
   const content=row.content??[],isUser=row.role==='user'&&(!row.sourceKind||row.sourceKind==='user'),isAssistant=row.role==='assistant';
   const Renderer=nativeRenderers[isUser?'user':'assistant-step'];
   if((isUser||isAssistant)&&Renderer){
    const images=()=>null;
    const kind=isUser?'user':'assistant-step';
    const blocks=content.filter(b=>['text','reasoning','image'].includes(b.type)).map(b=>b.type==='image'?{kind:'image',attachment:b.attachment}:{kind:b.type,text:b.text??''});
    const node={key:'member-'+row.seq,target:'chat',kind,anchorSeq:row.seq,visibility:'visible',location:{kind:'session'},data:isUser?{kind:'user',seq:row.seq,time:row.time,content:content.filter(b=>['text','image'].includes(b.type)),source:{kind:'user'}}:{status:'settled',turn:0,step:row.seq,time:row.time,blocks}};
    return h(React.Fragment,null,content.some(isMedia)&&rowGallery(row),h(Renderer,{node,t,renderMessageImages:images,useTurnData:()=>undefined,openFile:()=>{},fileMentions:()=>undefined}),content.map((b,i)=>!isMedia(b)&&!['text','image',...(isAssistant?['reasoning']:[])].includes(b.type)?blockView(b,row,i):null));
   }
   const rows=content.filter(b=>!isMedia(b)).map(b=>blockView(b,row,content.indexOf(b)));const body=h(React.Fragment,null,content.some(isMedia)&&rowGallery(row),rows);return row.role==='user'&&row.sourceKind&&row.sourceKind!=='user'?h('details',{className:'team-chat-process'},h('summary',null,'查看项目上下文'),body):body;
  }
  return h('section',{className:'team-member-chats','aria-label':'成员聊天'},
   h('div',{className:'team-member-transcript'},h('header',null,h('div',null,h('strong',null,selected?selected.name+' · '+(chat?.title??'加载聊天…'):'选择成员的聊天'),h('p',{style:styles.muted,role:'status'},selected?(updated?'更新于 '+updated:'正在加载…'):'在工作区的项目下选择聊天')),h('button',{style:styles.button,onClick:()=>window.dispatchEvent(new CustomEvent('team-return-own-chat'))},'返回我的工作台')),
    selected&&h(ChatGallery,{key:selected.member+':'+selected.session,session:selected.session,owner:selected.member}),
    error&&h('p',{role:'alert',className:'team-chat-read-error'},error+'，将自动重试。'),
    h('div',{ref:scroll,className:'team-member-messages',onScroll:()=>{const e=scroll.current;if(e)stick.current=e.scrollHeight-e.scrollTop-e.clientHeight<80;}},
     chat?.hasOlder&&h('button',{style:styles.button,disabled:busy,onClick:()=>void older()},busy?'正在加载…':'加载更早消息'),
     !selected&&h('div',{className:'team-chat-empty'},'在左侧工作区的项目下选择成员聊天'),chat&&chat.rows.length===0&&h('div',{className:'team-chat-empty'},'这个聊天还没有消息'),
     chat?.rows.map(row=>h('article',{key:row.seq,className:'team-member-message '+(row.role??'event'),'data-message-seq':row.seq},h('div',{className:'team-member-message-label'},({user:row.sourceKind&&row.sourceKind!=='user'?'项目上下文':selected.name,assistant:'智能体',tool:'工具'})[row.role]??({ 'turn/end':'本轮状态','turn/error':'执行错误','compaction/summary':'上下文摘要','command/result':'命令结果'})[row.kind]??'会话记录',h('time',null,new Date(row.time).toLocaleString())),row.content?messageView(row):h('details',null,h('summary',null,row.kind==='turn/end'?({completed:'已完成',stop:'已停止',error:'执行错误'})[row.data?.reason?.kind]??row.data?.reason?.kind??'已结束':'查看记录'),h('pre',null,JSON.stringify(row.data,null,2))))),
     chat?.results?.length>0&&h(ChatGalleryLink,{title:'查看本聊天生成结果',items:chat.results.map(r=>({id:'media:'+r.mediaId,name:(r.name??'生成结果')+(r.round?' · 第 '+r.round+' 轮':''),kind:r.mime?.startsWith('video/')?'video':'image',src:prefix+'/team-settings/api/media/'+r.mediaId,download:prefix+'/team-settings/api/media/'+r.mediaId+'?download=1'}))})
    )
   )
  );
 }

 function WorkspaceFlow({open,onCancel,onError}){
  if(!open)return null;
  if(!team.admin)return h('div',{style:{height:380,minWidth:260,maxWidth:'100%'}},h(SettingsFrame,{section:'workspaces',onProjectCreated:onCancel}));
  return h(SettingsFrame,{section:'workspaces',workspaceAction:true,onFolderResult:result=>{
   if(result.error){onError?.(result.error);onCancel();return;}
   onCancel();
   if(result.unsupported)window.dispatchEvent(new CustomEvent('team-open-settings',{detail:'workspaces'}));
   if(/^(shared|[a-f0-9-]{36})$/.test(result.project??''))window.__TEAM_SEND__?.('team-project-select',{project:result.project});
  }});
 }
 function NativeReferenceEndpoint({referenceSessionId,inputActions,useInput}){
  const input=useInput?.(v=>v),latest=React.useRef(input);latest.current=input;
  React.useEffect(()=>{
   if(!inputActions||!referenceSessionId)return;
   const endpoints=window.__TEAM_REFERENCE_INPUTS__??(window.__TEAM_REFERENCE_INPUTS__=new Map());
   const append=text=>insertNativeReference(inputActions,latest.current,text);
   endpoints.set(referenceSessionId,append);
   return()=>{if(endpoints.get(referenceSessionId)===append)endpoints.delete(referenceSessionId);};
  },[referenceSessionId,inputActions]);
  return null;
 }
 return {inject:['slots','uiWorkspace','layout'],apply(ctx){
  {
   memberWorkspace=createMemberWorkspaceStore({fetchList:signal=>fetchWorkspaceNavigation(prefix+'/team-settings/api/workspace-navigation',signal)});
   ctx.effect(()=>{void memberWorkspace.refresh();return()=>memberWorkspace.dispose();});
   ctx.effect(()=>{
    const wrapper=(Original,props)=>h(MemberWorkspaceBrowser,{...props,Original});
    window.__TEAM_WORKSPACE_BROWSER__=wrapper;
    return()=>{if(window.__TEAM_WORKSPACE_BROWSER__===wrapper)delete window.__TEAM_WORKSPACE_BROWSER__;};
   });
  }
  ctx.effect(()=>{const prompt=(id,text)=>generationChoices.prompt(id,text),syncSkill=async(id,value)=>{if(!value?.id||!/^session-[a-zA-Z0-9-]{1,160}$/.test(String(id??'')))return;const candidates=[String(id),String(id).replace(/^session-team-/,'')].filter((v,i,a)=>v&&a.indexOf(v)===i);for(const sessionId of candidates){try{const response=await fetch(prefix+'/team-settings/api/sessions/'+encodeURIComponent(sessionId),{method:'PATCH',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({skillId:value.id})});if(response.ok)return;}catch{}}},selection={read:id=>generationChoices.read(id),subscribe:fn=>generationChoices.subscribe(fn),set:(id,kind,value)=>{generationChoices.set(id,kind,value);if(kind==='skill')void syncSkill(id,value)}};window.__TEAM_GENERATION_PROMPT__=prompt;window.__TEAM_GENERATION_SELECTION__=selection;return()=>{if(window.__TEAM_GENERATION_PROMPT__===prompt)delete window.__TEAM_GENERATION_PROMPT__;if(window.__TEAM_GENERATION_SELECTION__===selection)delete window.__TEAM_GENERATION_SELECTION__;};});
  ctx.slots.inject('conversation.input.right',()=>ctx.slots.register({name:'conversation.input.right',id:'team-reference-endpoint',order:-10,inject:sessionId=>({referenceSessionId:sessionId})},NativeReferenceEndpoint));
  ctx.slots.inject('conversation.input.right',()=>ctx.slots.register({name:'conversation.input.right',id:'team-generation-models',order:30},()=>{
   const list=ctx.uiWorkspace.sessions.list,state=React.useSyncExternalStore(list.subscribe,list.getSnapshot,list.getSnapshot);
   return h(GenerationModels,{key:currentNativeSession(state),session:currentNativeSession(state)});
  }));
  ctx.slots.inject('conversation.session.header.utilities',()=>ctx.slots.register({name:'conversation.session.header.utilities',id:'team-chat-gallery',order:20},()=>{
   const list=ctx.uiWorkspace.sessions.list,state=React.useSyncExternalStore(list.subscribe,list.getSnapshot,list.getSnapshot);
   return h(ChatGallery,{key:currentNativeSession(state),session:currentNativeSession(state),header:true});
  }));
  ctx.slots.inject('conversation.session.header.utilities',()=>ctx.slots.register({name:'conversation.session.header.utilities',id:'team-model-route',order:25},()=>{
   const list=ctx.uiWorkspace.sessions.list,state=React.useSyncExternalStore(list.subscribe,list.getSnapshot,list.getSnapshot),session=currentNativeSession(state);
   return h(ModelRoute,{key:session,session,running:!!state.byId?.[session]?.running});
  }));
  ctx.effect(()=>{
   if(typeof document==='undefined')return;
   const theme=()=>{const c=getComputedStyle(document.body);window.__TEAM_SEND__?.('team-native-theme',{theme:document.body.hasAttribute('data-ds-dark-theme')?'dark':'light',colors:{ink:c.getPropertyValue('--dsw-alias-label-primary'),muted:c.getPropertyValue('--dsw-alias-label-secondary'),border:c.getPropertyValue('--dsw-alias-border-l2'),surface:c.getPropertyValue('--dsw-alias-bg-base')}});};const themeObserver=new MutationObserver(theme);themeObserver.observe(document.body,{attributes:true,attributeFilter:['data-ds-dark-theme','class','style']});theme();
   const style=document.createElement('style');style.textContent=`
   .team-member-chats{display:flex;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px}.team-member-transcript{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}.team-member-transcript>header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 24px;border-bottom:1px solid var(--dsw-alias-border-l1)}.team-member-transcript header p{margin:4px 0 0}.team-member-messages{flex:1;overflow:auto;overflow-x:hidden;padding:24px max(24px,calc((100% - 780px)/2));overflow-wrap:anywhere}.team-member-message{padding:16px 0}.team-member-message.user .team-member-message-label{justify-content:flex-end}.team-member-message-label{display:flex;gap:12px;color:var(--dsw-alias-label-secondary);font-size:12px;margin-bottom:10px}.team-member-message time{color:var(--dsw-alias-label-caption);font-size:11px}.team-member-chats a{color:var(--dsw-alias-state-business-primary,#4974dc)}.team-chat-process{margin:8px 0;color:var(--dsw-alias-label-secondary)}.team-chat-process summary{cursor:pointer}.team-member-chats pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.team-chat-image{max-width:min(260px,100%);max-height:260px;border-radius:10px;transition:transform .15s}.team-chat-image:hover{transform:scale(1.08)}.team-chat-attachment video,.team-chat-results video,.team-chat-results img{max-width:100%;max-height:420px;border-radius:10px;display:block}.team-chat-empty{padding:80px 20px;text-align:center;color:var(--dsw-alias-label-caption)}.team-chat-read-error{color:var(--dsw-alias-state-error-primary);padding:8px 24px}.team-chat-results{border-top:1px solid var(--dsw-alias-border-l1);margin-top:24px;padding-top:10px}.team-chat-results>div{margin:20px 0}@media(max-width:700px){.team-member-chats{flex-direction:column}.team-member-transcript>header{padding:12px 16px}.team-member-messages{padding:16px}.team-member-message.user .team-member-message-label{justify-content:flex-end}.team-member-message-label{flex-wrap:wrap}}
   .team-project-members{padding-left:12px}.team-member-heading{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;text-align:left;cursor:pointer}.team-member-heading:hover{background:var(--dsw-alias-interactive-bg-hover)}.team-member-heading>span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.team-member-heading small{font-size:11px;color:var(--dsw-alias-label-caption)}.team-member-sessions{padding-left:14px}.team-member-empty{margin:4px 12px 10px;font-size:12px;color:var(--dsw-alias-label-caption)}
   .team-workspace-browser{display:contents}.team-workspace-browser [aria-label^="成员聊天记录："]{display:none}.team-workspace-error{font-size:12px;color:var(--dsw-alias-label-secondary);padding:4px 16px;overflow-wrap:anywhere}.team-workspace-error button{border:0;background:transparent;color:inherit;text-decoration:underline;cursor:pointer}
   .hHd-Xa_root{font-size:13px;padding-top:4px}.hHd-Xa_logoRow{height:50px;margin-bottom:6px}.hHd-Xa_brandName{letter-spacing:0}.hHd-Xa_newSession{box-shadow:none;border-radius:10px;height:36px;font-size:13px}.hHd-Xa_panelRow{font-size:13px;min-height:36px;border-radius:8px}.hHd-Xa_panelActive{color:var(--dsw-alias-state-business-primary,#4974dc)!important;background:var(--dsw-alias-interactive-bg-active)!important}.hHd-Xa_footArea{padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
   [data-slot=main]:has(iframe[data-team-settings]){display:flex;flex:1;min-height:0;width:100%;height:100%}
   [data-slot=main] iframe[data-team-settings]{height:100%}
   [data-slot=tool.call.toolview] img{transition:transform .15s;transform-origin:left center}[data-slot=tool.call.toolview] details img:hover{transform:scale(1.6);position:relative;z-index:3}

   [role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav){width:min(1040px,calc(100vw - 48px));height:min(800px,calc(100dvh - 48px));max-width:calc(100vw - 48px)}
   [role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav)>nav{overflow-y:auto;padding-bottom:16px}
   [role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav) [data-slot="settings.section"]{min-width:0}
   [role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav) div:has(>iframe[data-team-settings]){height:100%;display:flex;flex-direction:column;min-height:0}
   [role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav) div:has(>[data-slot="settings.section"] iframe[data-team-settings]){overflow:hidden;padding:0 24px 24px}
   [role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav) iframe[data-team-settings]{color-scheme:inherit}
   @media(max-width:700px){[role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav){width:calc(100vw - 16px);max-width:calc(100vw - 16px);height:calc(100dvh - 16px);border-radius:20px}[role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav)>nav{width:142px;padding-left:6px;padding-right:6px}[role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav)>nav button{padding-left:9px;padding-right:9px;gap:6px}[role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav) div:has(>[data-slot="settings.section"] iframe[data-team-settings]){padding:0 14px 16px}}
   @media(max-width:560px){
    [role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav){flex-direction:column}
    [role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav)>nav{width:100%;flex:none;padding:12px 14px 8px;overflow:hidden}
    [role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav)>nav>div:first-child{margin:0;padding:0 0 12px}
    [role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav)>nav>div:last-child{display:flex;flex-direction:row;gap:4px;overflow-x:auto}
    [role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav)>nav button{flex:none;white-space:nowrap;font-size:12px;padding:8px}
    [role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav)>nav+div{width:100%;min-height:0;flex:1}
    [role="dialog"][aria-modal="true"]:not(.media-gallery):has(nav)>nav+div>div:first-child{height:36px;min-height:36px;padding:0 14px 8px}
   }

  `+(window.__TEAM_WORKBENCH_CSS__??'');document.head.appendChild(style);theme();
   const panel=e=>{if(e.detail==='tasks'){window.dispatchEvent(new CustomEvent('team-open-settings',{detail:'tasks'}));return;}if(['files','members','images','videos'].includes(e.detail))ctx.layout.selectPanel('team-'+e.detail);};window.addEventListener('team-open-panel',panel);
   const own=()=>{memberWorkspace?.select(null);ctx.layout.selectPanel('conversation');};
   const observe=()=>ctx.layout.selectPanel('team-member-chats');if(team.admin)window.addEventListener('team-member-chat-select',observe);window.addEventListener('team-return-own-chat',own);
   const session=e=>{const sessionId=typeof e.detail==='string'?e.detail:e.detail?.session,memberId=typeof e.detail==='object'?e.detail?.member:undefined,historyOnly=e.detail?.historyOnly===true;if(typeof sessionId!=='string')return;
    if(!historyOnly&&team.admin&&memberId&&memberId!==team.user){window.__TEAM_SEND__?.('team-project-select',{project:team.project,member:memberId,session:sessionId});return;}if(!historyOnly&&(!team.admin||memberId===team.user||!memberId&&ctx.uiWorkspace.sessions.list.getSnapshot().byId[sessionId])){ctx.uiWorkspace.openSession(sessionId);return;}
    void(async()=>{try{const r=await fetch(prefix+'/team-settings/api/admin/native-chats'),data=await r.json();if(!r.ok)throw Error(data.error??'聊天列表读取失败');const member=data.members.find(m=>(!memberId||m.id===memberId)&&m.sessions.some(s=>s.id===sessionId));if(!member)throw Error('当前项目下未找到这个成员聊天');if(member.active!==false){window.__TEAM_SEND__?.('team-project-select',{project:team.project,member:member.id,session:sessionId});return;}memberChatOpenError='';memberChatSelection={project:team.project,member:member.id,name:member.name,session:sessionId};memberWorkspace.select(memberChatSelection);ctx.layout.selectPanel('team-member-chats');window.dispatchEvent(new CustomEvent('team-member-chat-select',{detail:memberChatSelection}));}catch(error){memberChatOpenError=error.message;ctx.layout.selectPanel('team-member-chats');window.dispatchEvent(new CustomEvent('team-member-chat-select',{detail:{error:error.message}}));}})();
   };window.addEventListener('team-open-session',session);
   const fresh=()=>{memberWorkspace?.select(null);ctx.layout.selectPanel('conversation');ctx.uiWorkspace.startSession(ctx.uiWorkspace.workspaces.list.getSnapshot().items.find(w=>w.path==='/workspace')?.workspaceId);};window.addEventListener('team-new-chat',fresh);
   return()=>{if(team.admin)window.removeEventListener('team-member-chat-select',observe);themeObserver.disconnect();style.remove();window.removeEventListener('team-return-own-chat',own);window.removeEventListener('team-open-panel',panel);window.removeEventListener('team-open-session',session);window.removeEventListener('team-new-chat',fresh);};
  });
  if(team.admin)ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'team-member-chats',locale:'chat',inject:()=>({hooks:{nativeChatRenderers:{getSnapshot:()=>ctx.slots.entries('conversation.chat.node'),subscribe:fn=>ctx.slots.subscribe('conversation.chat.node',fn)}}})},MemberChatPanel));
  function ProjectFilesPanel(){
   const delegated=window.__TEAM_WORKBENCH_PANELS__?.includes('files')===true;
   React.useEffect(()=>{if(delegated&&window.__TEAM_OPEN_WORKBENCH_PANEL__?.('files'))ctx.layout.selectPanel('conversation');},[delegated]);
   return delegated?null:h(SettingsFrame,{section:'files',panel:true,onDraft:text=>{ctx.layout.selectPanel('conversation');requestAnimationFrame(()=>{const append=window.__TEAM_REFERENCE_INPUTS__?.get(window.__TEAM_CURRENT_SESSION__);if(!append?.(text))window.__TEAM_SEND__?.('team-native-reference-notice',{error:'原生输入区尚未就绪，请保留引用后重试'});});}});
  }
  for(const [id,label,order,path] of [['files','项目文件',20,'M3 6h7l2 2h9v12H3z'],['images','图片查看',21,'M3 3h18v18H3z M3 16l5-5 4 4 3-3 6 6 M8 7h.01'],['videos','视频查看',22,'M4 4h16v16H4z M10 8l6 4-6 4z'],['tasks',team.admin?'任务中心':'我的统计',30,'M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5']]){
   ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'team-'+id},id==='files'?ProjectFilesPanel:()=>h(SettingsFrame,{section:id,panel:true,onDraft:text=>{ctx.layout.selectPanel('conversation');requestAnimationFrame(()=>{const append=window.__TEAM_REFERENCE_INPUTS__?.get(window.__TEAM_CURRENT_SESSION__);if(!append?.(text))window.__TEAM_SEND__?.('team-native-reference-notice',{error:'原生输入区尚未就绪，请保留引用后重试'});});}})));
   if(id==='files')ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'team-'+id,label:()=>label,order},()=>h('svg',{width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,'aria-hidden':true},h('path',{d:path}))));
  }
  ctx.slots.inject('settings.section',function*(){
   for(const [id,label,order] of [['models','模型',10],['tasks',team.admin?'任务中心':'我的统计',20],['mobile','手机连接',25],['workspaces','工作区',30],...(team.admin?[['members','成员',40],['prompts','提示词',45],['billing','计费核对',50],['operations','运行与审计',60]]:[])])yield ctx.slots.register({name:'settings.section',id,order,label:()=>label},()=>h(SettingsFrame,{section:id,panel:id==='tasks'}));
  });
  ctx.slots.inject('sidebar.brand.name',()=>ctx.slots.register({name:'sidebar.brand.name',priority:-100},()=>h('span',{style:{fontSize:17,fontWeight:650,whiteSpace:'nowrap'}},'team-harness-platform')));
  for(const slot of ['sidebar.workspaces.directoryFlow','conversation.hero.workspace.directoryFlow'])ctx.slots.inject(slot,()=>ctx.slots.register({name:slot,priority:-100},WorkspaceFlow));
  // Harness normally reuses any blank session in the workspace. With several
  // browser tabs that sends all drafts into the same conversation. Reuse only
  // drafts created by this tab; completed conversations remain shared/listed.
  ctx.effect(()=>{
   const ui=ctx.uiWorkspace,original=ui.connectWorkspace,storageKey='team-project-tab-drafts';
   let remembered=[];try{remembered=JSON.parse(sessionStorage.getItem(storageKey)??'[]');}catch{}
   const drafts=new Set(Array.isArray(remembered)?remembered:[]),pending=new Map();
   ui.connectWorkspace=async function(workspaceId){
    const workspace=this.workspaces.list.getSnapshot().items.find(w=>w.workspaceId===workspaceId);
    if(!workspace)throw Error('项目工作区不存在');
    if(pending.has(workspaceId))return pending.get(workspaceId);
    const state=this.sessions.list.getSnapshot(),archived=this.workspaces.list.getSnapshot().archivedSessionIds;
    for(const id of drafts){const s=state.byId[id];if(s?.blank&&s.cwd===workspace.path&&workspace.sessionIds.includes(id)&&!archived.includes(id))return id;}
    const attempt=this.sessions.create({workspaceId}).then(id=>{drafts.add(id);try{sessionStorage.setItem(storageKey,JSON.stringify([...drafts].slice(-100)));}catch{}return id;}).finally(()=>pending.delete(workspaceId));
    pending.set(workspaceId,attempt);return attempt;
   };
   return ()=>{ui.connectWorkspace=original;};
  });
  ctx.effect(()=>{const list=ctx.uiWorkspace?.sessions?.list;if(!list)return;const send=()=>{window.__TEAM_CURRENT_SESSION__=currentNativeSession(list.getSnapshot())??null;window.__TEAM_SYNC__?.select(window.__TEAM_CURRENT_SESSION__);window.__TEAM_SEND__?.('team-incident-session',{session:window.__TEAM_CURRENT_SESSION__});};send();return list.subscribe?.(send);});
  ctx.slots.inject('conversation.chat.turnTail',()=>ctx.slots.register({name:'conversation.chat.turnTail',id:'team-turn-generation-gallery',order:10},TurnGenerationGallery));
  for(const slot of ['conversation.message.images','conversation.trajectory.images','tool.call.images'])ctx.slots.inject(slot,()=>ctx.slots.register({name:slot,priority:-100,locale:'conversation'},NativeMessageGallery));
  for(const key of ['team_video_assemble','team_video_assembly_status','team_video_assembly_resume','team_video_assembly_cancel','team_codex_run','team_codex_status','team_codex_cancel','team_report_issue','team_video_prepare','team_image_prepare','team_video_generate','team_image_generate','team_task_status','team_task_resubmit','team_project_workspace','team_reference_import'])ctx.slots.inject('tool.call.toolview',()=>ctx.slots.register({name:'tool.call.toolview',key},ToolView));
 }};
}});
