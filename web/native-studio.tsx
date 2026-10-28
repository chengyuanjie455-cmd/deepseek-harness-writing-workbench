import React,{createContext,useCallback,useContext,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ProjectStudio,type StudioReference} from './project-studio';
import {ProjectFiles} from './project-files';
import {ReviewCenter} from './project-hub';
import {WorkspaceHeader} from './workspace-header';
import {referencesForChat,sessionRows,validatedProjectURL} from './native-studio-state';
import {browserDraftStore,retainNativeDraft} from './native-draft-recovery';
import {NativeSidebarLayers} from './native-sidebar';
import './native-studio.css';

type Row=Record<string,any>;
type HostSkill={id:string;name:string;version?:string};
type SkillSelection={id:string;name:string};

/**
 * The team-project plugin normally owns this bridge.  Keep a small local
 * fallback so a reconnecting native plugin cannot leave a visible selector
 * that does nothing.  Only the opaque skill id/name is persisted; the host
 * still owns the skill source and its instructions.
 */
function ensureNativeSelectionBridge(scope:string){
 const current=(window as any).__TEAM_GENERATION_SELECTION__;
 if(current?.read&&current?.set)return current;
 const existing=(window as any).__TEAM_NATIVE_SELECTION_FALLBACK__;
 if(existing)return existing;
 const listeners=new Set<()=>void>(),cache=new Map<string,Record<string,SkillSelection>>(),storage=window.localStorage;
 const key=(session:string)=>`team-generation-models:v2:${scope}:${session}`;
 const read=(session?:string)=>{if(!session)return {};if(!cache.has(session)){let value:Record<string,any>={};try{value=JSON.parse(storage.getItem(key(session))??'{}');}catch{}const skill=value?.skill?.id&&typeof value.skill.name==='string'?{id:value.skill.id,name:value.skill.name}:undefined;cache.set(session,skill?{skill}:{});}return cache.get(session)??{};};
 const set=(session:string,kind:string,value?:HostSkill)=>{if(!session||kind!=='skill')return;const next={...read(session)};if(value?.id&&value.id!=='auto')next.skill={id:value.id,name:value.name};else delete next.skill;cache.set(session,next);try{storage.setItem(key(session),JSON.stringify(next));}catch{}for(const listener of listeners)listener();};
 const bridge={read,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},set,prompt:(session:string,text:string)=>{const skill=read(session).skill;return skill?.id?text+(text?'\n\n':'')+`编剧技能：${skill.id}`:text;}};
 (window as any).__TEAM_NATIVE_SELECTION_FALLBACK__=bridge;
 if(!(window as any).__TEAM_GENERATION_SELECTION__)(window as any).__TEAM_GENERATION_SELECTION__=bridge;
 if(!(window as any).__TEAM_GENERATION_PROMPT__)(window as any).__TEAM_GENERATION_PROMPT__=bridge.prompt;
 return bridge;
}
/** Members receive only the published skill catalog. Skill instructions and
 * source paths stay on the host; the selector persists an opaque id/name
 * through the native generation bridge and never sends the skill body. */
function NativeSkillPicker({prefix,session,placement='context'}:{prefix:string;session?:string;placement?:'context'|'composer'}){
 const [skills,setSkills]=useState<HostSkill[]>([]),[value,setValue]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 const scope=`${prefix}:${(window as any).__TEAM_CONTEXT__?.user??'current'}`;
 useEffect(()=>{const selection=ensureNativeSelectionBridge(scope),sync=()=>setValue(selection.read?.(session)?.skill?.id??'');sync();const off=selection.subscribe?.(sync);return()=>off?.();},[scope,session]);
 useEffect(()=>{let live=true;const controller=new AbortController();setLoading(true);void fetch(prefix+'/team-settings/api/chat-options',{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])}).then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.error??'技能目录暂不可读');const rows=(Array.isArray(data.skills)?data.skills:[]).filter((skill:Row)=>skill.status==='published'&&skill.memberAccess&&typeof skill.id==='string'&&typeof skill.name==='string').map((skill:Row)=>({id:skill.id,name:skill.name,version:typeof skill.version==='string'?skill.version:undefined}));if(live){setSkills(rows);setError('');}}).catch((cause:any)=>{if(live&&!controller.signal.aborted)setError(cause?.message??'技能目录暂不可读');}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;controller.abort();};},[prefix]);
 const selection=ensureNativeSelectionBridge(scope),chosen=skills.find(skill=>skill.id===value),displayed=chosen??(selection?.read?.(session)?.skill as HostSkill|undefined);if(!session)return null;
 const change=(id:string)=>{const next=skills.find(skill=>skill.id===id);setValue(id);selection?.set?.(session,'skill',next);};
 return <label className="studio-chat-skill-picker" data-skill-host-only="true" data-skill-picker-placement={placement} title="技能正文保留在主机，成员仅选择已发布技能"><span>技能</span><select aria-label="选择技能" value={value} onChange={event=>change(event.target.value)} disabled={loading&&skills.length===0}><option value="">未选择</option>{displayed&&!skills.some(skill=>skill.id===displayed.id)&&<option value={displayed.id}>{displayed.name}{displayed.version?` · ${displayed.version}`:''}</option>}{skills.map(skill=><option key={skill.id} value={skill.id}>{skill.name}{skill.version?` · ${skill.version}`:''}</option>)}</select>{error&&<small role="status">目录暂不可读</small>}</label>;
}
function NativeSkillPickerSlot({session}:{session:string}){
 const prefix=location.pathname.match(/^\/harness\/[^/]+/)?.[0];
 return prefix?<NativeSkillPicker prefix={prefix} session={session} placement="composer"/>:null;
}
function FileChange({api,id,admin,onClose,onUpdated}:{api:(...args:any[])=>Promise<any>;id:string;admin:boolean;onClose:()=>void;onUpdated:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),[change,setChange]=useState<Row>(),[error,setError]=useState(''),[tick,setTick]=useState(0);
 useEffect(()=>{dialog.current?.showModal();},[]);
 useEffect(()=>{let live=true;void api('/changes/'+id).then(v=>{if(live){setChange(v);setError('');}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[api,id,tick]);
 const decide=async(action:string)=>{if(!change)return;await api('/changes/'+change.id+'/'+action,'POST',{digest:change.digest});setTick(n=>n+1);onUpdated();};
 return <dialog ref={dialog} className="studio-native-panel" aria-label="项目文件变更" onCancel={onClose}><button className="studio-native-panel-close" onClick={onClose}>返回项目文件</button><ReviewCenter changes={change?[change]:[]} change={change} admin={admin} onSelect={()=>setTick(n=>n+1)} onReload={()=>setTick(n=>n+1)} onApprove={()=>decide('approve')} onReject={()=>decide('reject')} error={error}/></dialog>;
}
const NativeFrame=createContext<Row|undefined>(undefined);
function StudioFrame({ctx,props}:{ctx:Row;props:Row}){
 const selectedPanel=props.usePanelInfo((v:Row)=>v.activePanelId),panel=selectedPanel==='conversation'?null:selectedPanel,layout=props.useStore((v:Row)=>v.layoutInfo);
 const [historyPanel,setHistoryPanel]=useState<React.ReactNode>();
 const closeDock=()=>{if(ctx.get('sidebarRight')?.isExpanded())ctx.get('sidebarRight').toggleExpanded();};
 return <NativeFrame.Provider value={{...props,activePanel:panel,layoutInfo:layout,closeDock,historyPanel,showHistory:setHistoryPanel}}><div className="app studio-shell team-native-studio-root"><main>{props.renderSlot('main',{}, {entryKey:'conversation'})}</main>{props.renderSlot('shell.overlay',{})}</div></NativeFrame.Provider>;
}
function FloatingNativeMenu({anchor,open,onClose,children}:{anchor:React.RefObject<HTMLElement|null>;open:boolean;onClose:()=>void;children:React.ReactNode}){
 const [style,setStyle]=useState<React.CSSProperties>();
 const update=useCallback(()=>{const el=anchor.current;if(!el)return;const rect=el.getBoundingClientRect(),maxHeight=Math.min(520,Math.max(180,window.innerHeight*.6)),width=Math.min(280,Math.max(180,window.innerWidth-16)),left=Math.max(8,Math.min(rect.right-width,window.innerWidth-width-8)),below=rect.bottom+6+maxHeight<=window.innerHeight-8;setStyle({position:'fixed',left,top:below?rect.bottom+6:Math.max(8,rect.top-6-maxHeight),width,maxHeight,zIndex:1000});},[anchor]);
 useLayoutEffect(()=>{if(!open){setStyle(undefined);return;}update();const onViewport=()=>update(),onPointer=(event:PointerEvent)=>{const target=event.target as Node|null;if(target&&!anchor.current?.contains(target)&&!(event.target as Element|null)?.closest?.('[data-floating-native-menu="true"]'))onClose();},onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose();};window.addEventListener('resize',onViewport);window.addEventListener('scroll',onViewport,true);document.addEventListener('pointerdown',onPointer,true);document.addEventListener('keydown',onKey);return()=>{window.removeEventListener('resize',onViewport);window.removeEventListener('scroll',onViewport,true);document.removeEventListener('pointerdown',onPointer,true);document.removeEventListener('keydown',onKey);};},[open,update,onClose,anchor]);
 if(!open||!style)return null;return createPortal(<div className="studio-native-tools-menu" data-floating="true" data-floating-native-menu="true" style={style} onPointerDown={event=>event.stopPropagation()}>{children}</div>,document.body);
}
// Reuse native settings and registered feature pages without mounting its
// workspace/sidebar shell. The trigger stays in the chat's existing control row.
function NativeTools({props}:{props:Row}){
 const panels=props.usePanels((v:Row)=>v),frame=useContext(NativeFrame),anchor=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false),close=useCallback(()=>setOpen(false),[]);
 return <div className="studio-native-tools"><button type="button" className="studio-sidebar-history-trigger" aria-label="打开聊天历史与项目" title="聊天历史与项目" onClick={()=>frame?.showHistory(props.renderSlot('sidebar.workspaces',{wide:true,expandSidebar:()=>{}}))}>历史</button><button ref={anchor} type="button" className="studio-native-tools-trigger" aria-label="原生工作台功能" aria-expanded={open} title="插件、自动化与工作台功能" onClick={()=>setOpen(value=>!value)}>···</button><FloatingNativeMenu anchor={anchor} open={open} onClose={close}>{panels.map((p:Row)=><button key={p.id} onClick={()=>{close();frame?.showHistory(undefined);if(p.id==='team-files')window.dispatchEvent(new CustomEvent('team-studio-files'));else props.selectPanel(p.id);}}>{p.label}</button>)}{props.renderSlot('sidebar.footer.action',{wide:true})}</FloatingNativeMenu>{props.renderSlot('sidebar.settings',{wide:false})}</div>;
}
function SessionActions({props}:{props:Row}){
 const tabs=props.useConversationViews((v:Row[])=>v),active=props.useStore((v:Row)=>v.view),summary=props.useSessions((v:Row)=>v.byId[props.sessionId]),anchor=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false),close=useCallback(()=>setOpen(false),[]);
 return <div className="studio-native-chat-actions"><button ref={anchor} type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>聊天工具</button><FloatingNativeMenu anchor={anchor} open={open} onClose={close}><label>聊天视图<select aria-label="聊天视图" value={tabs.some((v:Row)=>v.id===active)?active:'chat'} onChange={e=>props.selectView(e.target.value)}>{tabs.map((v:Row)=><option key={v.id} value={v.id}>{v.label}</option>)}</select></label>{props.renderSlot('conversation.session.header.lineage',{lineageSessionId:props.sessionId,displayTitle:summary?.displayTitle??''})}{props.renderSlot('conversation.session.header.actions',{})}{props.renderSlot('conversation.session.header.utilities',{})}{props.renderSlot('conversation.session.header.corner',{})}</FloatingNativeMenu></div>;
}
// Candidate composition only: all conversation input, journals, tool renderers,
// attachments and model selection remain in the native Conversation Factory.
function Studio({ctx,nativeProps,content,controls}:{ctx:Row;nativeProps:Row;content:React.ReactNode;controls:React.ReactNode}){
 const prefix=location.pathname.match(/^\/harness\/[^/]+/)?.[0];
 if(!prefix)throw Error('缺少已认证的项目上下文');
 const team=(window as any).__TEAM_CONTEXT__,projectId=team.project;
 const api=useCallback(async(path:string,method='GET',body?:unknown)=>{
  const url=prefix+'/team-settings/api'+path;
  const response=await fetch(url,{method,cache:'no-store',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const value=await response.json();if(!response.ok)throw Error(value.error??'项目读取未完成');return value;
 },[prefix]);
 const [data,setData]=useState<Row>(),[error,setError]=useState(''),[tick,setTick]=useState(0),[references,setReferences]=useState<StudioReference[]>([]),[referenceError,setReferenceError]=useState(''),[selectionTick,setSelectionTick]=useState(0);
 const frame=useContext(NativeFrame),referenceIds=useRef(new Set<string>()),[filesRequest,setFilesRequest]=useState(()=>new URLSearchParams(location.search).get('view')==='files'?crypto.randomUUID():''),[busy,setBusy]=useState(false),[changeId,setChangeId]=useState<string>();
 const sessions=nativeProps.useSessions((s:Row)=>s),session=nativeProps.sessionId;
 useEffect(()=>{const selection=(window as any).__TEAM_GENERATION_SELECTION__;if(!selection?.subscribe)return;return selection.subscribe(()=>setSelectionTick(value=>value+1));},[session]);
 useEffect(()=>{let disposed=false,flight=false,lastSignature='';const read=async()=>{if(flight||document.visibilityState==='hidden')return;flight=true;try{const [project,legacy,status,me]=await Promise.all([api('/project'),api('/sessions'),api('/status'),api('/me')]);if(disposed)return;const active=(Array.isArray(legacy)?legacy:[]).find((row:Row)=>row.id===session||row.id===session?.replace(/^session-team-/,''));const signature=JSON.stringify({project:[project?.revision,project?.fileCount],active:[active?.id,active?.updated,active?.messageCount,active?.modelId,active?.skillId],status:[status?.serverInstance,status?.onlineModel],me:[me?.user?.id,me?.user?.role]});if(signature===lastSignature)return;lastSignature=signature;setData(old=>({...old,project,legacy,status,me}));setError('');setTick(n=>n+1);}catch(e:any){if(!disposed)setError(e.message);}finally{flight=false;}};const refresh=()=>void read();const visibility=()=>{if(document.visibilityState==='visible')refresh();};void read();window.addEventListener('focus',refresh);window.addEventListener('team-native-refresh',refresh);document.addEventListener('visibilitychange',visibility);return()=>{disposed=true;window.removeEventListener('focus',refresh);window.removeEventListener('team-native-refresh',refresh);document.removeEventListener('visibilitychange',visibility);};},[api,session]);
 useEffect(()=>{let disposed=false,flight=false;const read=async()=>{if(flight)return;flight=true;try{const navigation=await api('/workspace-navigation');if(!disposed)setData(old=>({...old,navigation}));}catch(e:any){if(!disposed)setError(e.message);}finally{flight=false;}};void read();const timer=setInterval(read,10000);return()=>{disposed=true;clearInterval(timer);};},[api]);
 const rows=sessionRows(sessions.byId);
 useEffect(()=>{const files=()=>setFilesRequest(crypto.randomUUID());window.addEventListener('team-studio-files',files);return()=>window.removeEventListener('team-studio-files',files);},[]);
 useEffect(()=>{if(!session||!references.length)return;const insert=()=>{for(const ref of referencesForChat(references,projectId,session)){if(referenceIds.current.has(ref.id))continue;const append=(window as any).__TEAM_REFERENCE_INPUTS__?.get(session);if(append?.(ref.text)){referenceIds.current.add(ref.id);setReferences(old=>old.filter(v=>v.id!==ref.id));setReferenceError('');}else setReferenceError('引用已保留，等待当前聊天输入框就绪。');}};insert();const timer=setInterval(insert,1000);return()=>clearInterval(timer);},[projectId,session,references]);
 const navigateProject=useCallback(async(id:string,options:Row={})=>{if(busy)throw Error('请等待当前文件上传完成');await (window as any).__TEAM_STUDIO_FLUSH_DRAFTS__?.();const hostFetch=(window as any).__TEAM_HOST_FETCH__;if(!hostFetch)throw Error('主机导航接口尚未就绪');const r=await hostFetch('/api/native/open?'+new URLSearchParams({project:id,...(options.member?{member:options.member}:{})}),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),v=await r.json();if(!r.ok)throw Error(v.error??'项目入口未就绪');const target=validatedProjectURL(v.url,location.origin);if(window.teamDesktop){const opened=await window.teamDesktop.openNativeHarness(v.url,{projectSurface:true});if(!opened.ok||opened.value.url!==target.origin+target.pathname)throw Error(opened.error||'项目登录尚未完成');}else{const opened=await fetch(target,{redirect:'follow'});if(!opened.ok)throw Error('项目登录尚未完成');}target.search='';if(options.session)target.searchParams.set('nativeSession',options.session);if(options.newChat)target.searchParams.set('newChat','1');location.assign(target.href);},[busy]);
 useEffect(()=>{const previous=(window as any).__TEAM_SEND__,send=(type:string,options:Row={})=>{if(type==='team-project-select'){if(options.project===projectId&&(!options.member||options.member===team.user)){if(options.session)ctx.uiWorkspace.openSession(options.session);else if(options.newChat)ctx.uiWorkspace.startSession();else if(options.panel==='files')setFilesRequest(crypto.randomUUID());return;}void navigateProject(options.project,options).catch(e=>setError(e.message));return;}previous?.(type,options);};(window as any).__TEAM_SEND__=send;return()=>{if((window as any).__TEAM_SEND__===send)(window as any).__TEAM_SEND__=previous;};},[projectId,team.user,navigateProject]);
 useEffect(()=>{const params=new URLSearchParams(location.search),target=params.get('nativeSession');if(target&&/^session-[a-zA-Z0-9-]{1,160}$/.test(target))ctx.uiWorkspace.openSession(target);else if(params.get('newChat')==='1')ctx.uiWorkspace.startSession();if(target||params.has('newChat')){params.delete('nativeSession');params.delete('newChat');history.replaceState(null,'',location.pathname+(params.size?'?'+params:'')+location.hash);}},[]);
 const home=(entry:'projects'|'accounts'='projects')=>{void (async()=>{await (window as any).__TEAM_STUDIO_FLUSH_DRAFTS__?.();if(window.teamDesktop?.projectHome){const r=await window.teamDesktop.projectHome(entry);if(!r.ok)throw Error(r.error||'项目列表未打开');}else location.assign('/');})().catch(e=>setError(e.message));};
 useEffect(()=>{const account=()=>home('accounts');window.addEventListener('wawu-account-entry',account);return()=>window.removeEventListener('wawu-account-entry',account);},[]);
 const reference=(text:string,name:string)=>setReferences(old=>[...old,{id:crypto.randomUUID(),project:projectId,session,text,name}]);
 const activeChat=rows.find(v=>v.id===session);
 // Some pinned native runtimes expose `agents` through a throwing lazy getter
 // until the agent injection is ready. Treat that as unavailable instead of
 // crashing the entire project surface; a later selection event will re-read it.
 let nativeAgent:Row|undefined;try{nativeAgent=ctx.agents?.get?.(session);}catch{nativeAgent=undefined;}
 const nativeHeader=nativeAgent?.session?.requestHeader?.(),nativeProjection=activeChat?.projections?.values?.modelSelection?.next??activeChat?.projections?.values?.modelSelection?.current,nativeChoice=(window as any).__TEAM_GENERATION_SELECTION__?.read?.(session),nativeModel=nativeHeader?.config?.model??nativeProjection?.model??nativeProjection?.modelId??activeChat?.modelId,nativeSkill=nativeChoice?.skill?.name??nativeChoice?.skill?.id??nativeHeader?.config?.skill??nativeProjection?.skill??nativeProjection?.skillId??activeChat?.skillId;void selectionTick;
 useEffect(()=>{frame?.showHistory(undefined);},[session]);
 const heading=<div className="native-sidebar-heading"><div className="native-sidebar-session-name"><strong title={activeChat?.displayTitle??'项目智能体'}>{activeChat?.displayTitle||'项目智能体'}</strong><span title={team.ownerName}>{team.ownerName??data?.me?.user?.name??'当前成员'} · {data?.project?.name??'当前项目'}</span></div><button type="button" className="studio-sidebar-new" aria-label="新建聊天" title="新建聊天" onClick={()=>ctx.uiWorkspace.startSession(ctx.uiWorkspace.workspaces.list.getSnapshot().items.find((v:Row)=>v.path==='/workspace')?.workspaceId)}>＋</button>{frame?.renderSlot('sidebar',{collapsed:true,width:0})}</div>;
 const dock=frame?.layoutInfo?.rightbarShown;
 const panel=dock?frame?.renderSlot('rightbar',{width:420,viewportWidth:innerWidth,canShow:true}):frame?.historyPanel??(frame?.activePanel?frame.renderSlot('main',{}, {entryKey:frame.activePanel}):undefined);
 const chatContext=<div className="studio-chat-context studio-chat-context-inline" data-chat-context="true" aria-label={`当前聊天配置：技能 ${nativeSkill??'未确认'}，模型 ${nativeModel??'未确认'}`}><span className="studio-chat-context-title">当前聊天</span><NativeSkillPicker prefix={prefix} session={session}/><span className="studio-chat-context-chip" title={`当前技能：${nativeSkill??'未确认'}`}><b>已用技能</b><strong>{nativeSkill??'未确认'}</strong></span><span className="studio-chat-context-chip" title={`当前模型：${nativeModel??'未确认'}`}><b>模型</b><strong>{nativeModel??'未确认'}</strong></span></div>;
 const topbar=<div className="studio-agent-topline"><div className="studio-agent-topline-heading">{heading}</div>{chatContext}<div className="studio-agent-topline-controls">{controls}</div></div>;
 const chat=<div className="native-chat-surface" data-native-chat-surface="conversation.content"><NativeSidebarLayers chat={<>{referenceError&&<p role="status">{referenceError}</p>}<div className="native-chat-content">{content}</div></>} panel={panel} title={dock?'会话文件与终端':frame?.historyPanel?'聊天历史与项目':'工作台功能'} onBack={()=>{if(dock)frame?.closeDock();else if(frame?.historyPanel)frame.showHistory(undefined);else ctx.layout.selectPanel(null);}}/></div>;

 const navigationHeader=<WorkspaceHeader placement="sidebar" page="native" onPage={page=>{if(page==='projects')home();else if(page==='files')setFilesRequest(crypto.randomUUID());else window.dispatchEvent(new CustomEvent('team-open-settings',{detail:page}));}} admin={team.admin} name={data?.me?.user?.name??team.ownerName??'团队成员'} projectId={projectId} projects={data?.navigation?.projects??[]} projectName={data?.project?.name} onProject={id=>{void navigateProject(id).catch(e=>setError(e.message));}} reviews={0} onLogout={()=>{void Promise.resolve((window as any).__TEAM_STUDIO_FLUSH_DRAFTS__?.()).then(()=>(window as any).__TEAM_HOST_FETCH__('/api/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).then((r:Response)=>{if(!r.ok)throw Error('退出登录未确认');home();}).catch((e:Error)=>setError(e.message));}}/>;
 return <>{error&&<p role="status" className="studio-inline-notice">{error}，已读资料保留。</p>}<ProjectStudio navigationHeader={navigationHeader} agentHeading={topbar} agentContext={{model:nativeModel,skill:nativeSkill,version:data?.project?.revision,scope:'当前项目资料',tools:data?.project?.release?.allowScripts?'脚本与工具按策略开放':'按服务器策略'}} dockedAgent api={api} projectId={projectId} project={data?.project} plans={[]} visible agent={chat} onReference={reference} references={referencesForChat(references,projectId,session)} onRemoveReference={id=>setReferences(old=>old.filter(v=>v.id!==id))} filesRequest={filesRequest} pagedContent={!!data?.status?.capabilities?.includes('project-content-pages')} updateVersion={tick} renderFiles={(visible,focusChat)=><ProjectFiles api={api} projectId={projectId} projects={data?.navigation?.projects??(data?.project?[data.project]:[])} revision={data?.project?.revision} visible={visible} updateVersion={tick} admin={team.admin} session={data?.legacy?.find((v:Row)=>v.fixed&&v.owner===team.user)?.id??''} canUpload={!!data?.status?.capabilities?.includes('project-attachments')} onUploaded={async()=>{setTick(n=>{return n+1;});}} onBusy={setBusy} onProject={id=>{void navigateProject(id).catch(e=>setError(e.message));}} onSettings={()=>window.dispatchEvent(new CustomEvent('team-open-settings',{detail:'workspaces'}))} onChange={setChangeId} onReference={(text,name)=>{reference(text,name);focusChat();}}/>}/>{changeId&&<FileChange api={api} id={changeId} admin={team.admin} onClose={()=>setChangeId(undefined)} onUpdated={()=>setTick(n=>n+1)}/>}</>;
}

export function installStudio(ctx:Row){
 const checkpoints=new Map<string,{retainer:ReturnType<typeof retainNativeDraft>;active:boolean;listeners:Set<(text:string)=>void>;notice:string}>(),store=browserDraftStore(indexedDB);
 function NativeDraftCheckpoint({session}:{session:string}){
  const [message,setMessage]=useState('');
  useEffect(()=>{
   let live=true,attached:ReturnType<typeof checkpoints.get>;
   // Let the native Conversation store seed its own draft during this commit
   // before taking the recovery revision. Do not race that seed with an empty
   // input snapshot from a sibling composer's effect.
   void Promise.resolve().then(()=>{
   if(!live)return;
   let checkpoint=checkpoints.get(session);
   if(!checkpoint?.active){
    const conversation=ctx.get('conversation'),shell=conversation?.input.shell(session);
    if(!conversation||!shell){setMessage('聊天附件恢复接口尚未就绪');return;}
    const listeners=new Set<(text:string)=>void>();
    // Native session navigation can release and recreate the input shell. Finish
    // the former shell's checkpoint before reading it into the new native shell.
    const previous=checkpoint?.retainer;
    const value={active:true,listeners,notice:'',retainer:undefined as unknown as ReturnType<typeof retainNativeDraft>};
    value.retainer=retainNativeDraft({scope:(window as any).__TEAM_STUDIO_SCOPE__,session,shell,conversation,store:{...store,read:async key=>{await previous?.flush();return store.read(key);}},notice:text=>{value.notice=text;for(const listener of listeners)listener(text);}});
    checkpoints.set(session,value);checkpoint=value;
   }
   attached=checkpoint;
   checkpoint.listeners.add(setMessage);setMessage(checkpoint.notice);
   }).catch(error=>{if(live)setMessage('聊天附件恢复未完成：'+(error instanceof Error?error.message:String(error)));});
   return()=>{live=false;if(attached){attached.listeners.delete(setMessage);attached.active=false;attached.retainer.dispose();}};
  },[session]);
  return message?<span role="status" className="studio-inline-notice">{message}</span>:null;
 }
 ctx.slots.inject('conversation.input.right',()=>ctx.slots.register({name:'conversation.input.right',id:'team-native-draft-checkpoint',order:-20,inject:(session:string)=>({session})},NativeDraftCheckpoint));
 ctx.slots.inject('conversation.input.right',()=>ctx.slots.register({name:'conversation.input.right',id:'team-native-skill-picker',order:25,inject:(session:string)=>({session})},NativeSkillPickerSlot));
 const flush=async()=>{await Promise.all([...checkpoints.values()].map(v=>v.retainer.flush()));};
 (window as any).__TEAM_STUDIO_FLUSH_DRAFTS__=flush;
 ctx.effect(()=>()=>{for(const value of checkpoints.values())value.retainer.dispose();if((window as any).__TEAM_STUDIO_FLUSH_DRAFTS__===flush)delete (window as any).__TEAM_STUDIO_FLUSH_DRAFTS__;});
 const view=(nativeProps:Row,content:React.ReactNode,controls:React.ReactNode)=>React.createElement(Studio,{ctx,nativeProps,content,controls});
 const root=(props:Row)=>React.createElement(StudioFrame,{ctx,props}),tools=(props:Row)=>React.createElement(NativeTools,{props});
 (window as any).__TEAM_STUDIO_VIEW__=view;
 (window as any).__TEAM_STUDIO_ROOT__=root;(window as any).__TEAM_STUDIO_TOOLS__=tools;
 const actions=(props:Row)=>React.createElement(SessionActions,{props});(window as any).__TEAM_STUDIO_ACTIONS__=actions;
 ctx.effect(()=>()=>{for(const [key,value] of Object.entries({__TEAM_STUDIO_VIEW__:view,__TEAM_STUDIO_ROOT__:root,__TEAM_STUDIO_TOOLS__:tools,__TEAM_STUDIO_ACTIONS__:actions}))if((window as any)[key]===value)delete (window as any)[key];});
}
