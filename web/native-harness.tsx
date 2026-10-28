import {acceptsProjectFiles} from './native-workbench-bridge';
import {IncidentReport} from './incident-report';
import type {StudioReference} from './project-studio';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {NativeConnection,type NativeApi,type ConnectionView} from './native-connection';
import {createNativeFolderHost} from './host-folder-bridge';
type Item=Record<string,any>;
const labels:Record<string,string>={connecting:'连接项目聊天',environment:'检查运行环境',project:'同步项目资料',runtime:'启动原生工作台',sessions:'恢复历史会话',page:'加载聊天页面',restoring:'恢复聊天界面',reconnecting:'恢复项目连接',blocked:'项目聊天暂未连接',ready:'聊天已就绪'};
const syncLabels:Record<string,string>={waiting:'等待聊天同步状态',loading:'正在读取聊天历史',live:'已接收聊天更新',reconnecting:'聊天重连中 · 保留已有内容',error:'聊天同步中断 · 请重新连接'};
type SyncView={version:number;session:string|null;phase:string;observedAt:number;lastUpdateAt?:number};
export type NativeCommand={id:number;type:'settings'|'session'|'panel'|'new';section?:string;session?:string;member?:string;project?:string;historyOnly?:boolean};
type PaneProps={onFiles?:()=>void;api:NativeApi;project:string;member?:string;visible?:boolean;onReview:(id:string)=>void;command?:NativeCommand;references?:StudioReference[];onReferenceInserted?:(id:string)=>void;onReferenceTarget?:(project:string,member:string|undefined,session:string|undefined)=>void;onProject?:(id:string,panel?:string,session?:string,member?:string,newChat?:boolean,historyOnly?:boolean)=>void};
// Open lazily, retain the actual native editor (including attachments and drafts).
// Switching projects changes visibility, never opens a window or navigates the page.
export function NativeWorkspace(props:PaneProps){
 const key=props.project+':'+(props.member??''),entry={key,project:props.project,member:props.member};
 const [opened,setOpened]=useState([entry]);
 useEffect(()=>{setOpened(items=>items.some(v=>v.key===key)?items:[...items,entry]);},[key]);
 const entries=opened.some(v=>v.key===key)?opened:[...opened,entry];
 return <>{entries.map(item=><NativeHarnessPane {...props} key={item.key} project={item.project} member={item.member} visible={props.visible&&item.key===key} command={item.key===key?props.command:undefined}/>)}</>;

}
export function NativeHarnessPane({api,project,member,visible=true,command,onProject,references=[],onReferenceInserted,onReferenceTarget,onFiles}:PaneProps){
 const scopedApi=useMemo<NativeApi>(()=>(path,method,body)=>api(path+(path.includes('?')?'&':'?')+'project='+encodeURIComponent(project)+(member?'&member='+encodeURIComponent(member):''),method,body),[api,project,member]);
 const visibleRef=useRef(visible);visibleRef.current=visible;
 const frame=useRef<HTMLIFrameElement>(null),controller=useRef<NativeConnection>(null),viewRef=useRef<ConnectionView>(null);
 const [view,setView]=useState<ConnectionView>(),[session,setSession]=useState<string>();
 const [sync,setSync]=useState<SyncView>();
 const insertedReferences=useRef(new Set<string>()),[referenceError,setReferenceError]=useState('');
 const referenceSessions=useRef(new Map<string,string>()),pendingReferences=useRef(references);pendingReferences.current=references;
 const referenceCallbacks=useRef({onReferenceInserted,onReferenceTarget});referenceCallbacks.current={onReferenceInserted,onReferenceTarget};
 useEffect(()=>{if(visible)referenceCallbacks.current.onReferenceTarget?.(project,member,session);},[visible,project,member,session]);
 useEffect(()=>{
  if(!visible||!view?.ready||!view.url||!session||!references.length)return;
  const pending=references.filter(r=>r.project===project&&(r.member??'')===(member??'')&&(!r.session||r.session===session)&&(!referenceSessions.current.has(r.id)||referenceSessions.current.get(r.id)===session)&&!insertedReferences.current.has(r.id));
  if(!pending.length)return;
  const insert=()=>{for(const r of pending){if(insertedReferences.current.has(r.id))continue;referenceSessions.current.set(r.id,session);frame.current?.contentWindow?.postMessage({type:'team-native-reference',protocolVersion:1,version:view.version,scope:view.scope,requestId:r.id,session,project,text:r.text},new URL(view.url!).origin);}};
  insert();const timer=setInterval(insert,1500);return()=>clearInterval(timer);
 },[visible,view?.ready,view?.version,project,member,session,references]);
 const sentCommand=useRef<number|undefined>(undefined);
 const onProjectRef=useRef(onProject);onProjectRef.current=onProject;const onFilesRef=useRef(onFiles);onFilesRef.current=onFiles;
 useEffect(()=>{if(!visible||!view?.ready||!view.url||!command||command.project&&command.project!==project||sentCommand.current===command.id)return;sentCommand.current=command.id;frame.current?.contentWindow?.postMessage({type:'team-native-'+command.type,scope:view.scope,section:command.section,session:command.session,member:command.member,historyOnly:command.historyOnly},new URL(view.url).origin);},[visible,command?.id,view?.ready,view?.version]);
 useEffect(()=>{
  let pendingSnapshot:((hash:string)=>void)|undefined,snapshotId=0,lastHash='',ended=false,timer:ReturnType<typeof setTimeout>;
  const connection=new NativeConnection({api:scopedApi,emit:value=>{viewRef.current=value;setView(value);},
   desktop:window.teamDesktop?async url=>{const result=await window.teamDesktop!.openNativeHarness(url);if(!result.ok)throw Error(result.error);return result.value.url;}:undefined,
   snapshot:()=>new Promise(resolve=>{pendingSnapshot=resolve;frame.current?.contentWindow?.postMessage({type:'team-native-snapshot',scope:viewRef.current?.scope,requestId:++snapshotId},viewRef.current?.url?new URL(viewRef.current.url).origin:'*');setTimeout(()=>{if(pendingSnapshot===resolve){pendingSnapshot=undefined;resolve(lastHash);}},350);})});
  controller.current=connection;
  const folderHost=createNativeFolderHost(()=>{const current=viewRef.current,source=frame.current?.contentWindow;if(!current?.url||!source)return;return {source,origin:new URL(current.url).origin,scope:current.scope,version:current.version};},window.teamDesktop?.selectHostFolder);
  const message=(event:MessageEvent)=>{
   const current=viewRef.current;if(!current?.url||event.source!==frame.current?.contentWindow||event.origin!==new URL(current.url).origin||event.data?.scope!==current.scope)return;
   void folderHost.receive(event);
   if(acceptsProjectFiles(event,{source:frame.current?.contentWindow,url:current.url,scope:current.scope,version:current.version,project,visible:visibleRef.current}))onFilesRef.current?.();
   if(event.data.type==='team-native-reference-receipt'&&event.data.protocolVersion===1&&event.data.version===current.version&&event.data.project===project){
    const r=pendingReferences.current.find(r=>r.id===event.data.requestId&&r.project===project&&(r.member??'')===(member??''));
    if(r&&referenceSessions.current.get(r.id)===event.data.session){if(event.data.state==='inserted'){insertedReferences.current.add(r.id);referenceCallbacks.current.onReferenceInserted?.(r.id);setReferenceError('');}else setReferenceError('引用已保留，等待原生编辑器就绪。');}
   }
   if(event.data.type==='team-incident-session')setSession(/^session-[a-zA-Z0-9-]{1,160}$/.test(event.data.session??'')?event.data.session:undefined);
   if(event.data.type==='team-native-sync'&&event.data.version===current.version&&Object.hasOwn(syncLabels,event.data.phase)&&Number.isFinite(event.data.observedAt))setSync({version:current.version,session:event.data.session,phase:event.data.phase,observedAt:event.data.observedAt,lastUpdateAt:Number.isFinite(event.data.lastUpdateAt)?event.data.lastUpdateAt:undefined});
   const currentReady=event.data.type==='team-native-ready'&&event.data.version===current.version,currentSnapshot=event.data.type==='team-native-snapshot-saved'&&event.data.requestId===snapshotId;
   if((event.data.type==='team-native-location'||currentReady||currentSnapshot)&&typeof event.data.hash==='string'&&(!event.data.hash||event.data.hash.startsWith('#')))lastHash=event.data.hash;
   if(visibleRef.current&&event.data.type==='team-project-select'&&/^(shared|[a-f0-9-]{36})$/.test(event.data.project))onProjectRef.current?.(event.data.project,event.data.panel,event.data.session,event.data.member,event.data.newChat===true,event.data.historyOnly===true);
   if(visibleRef.current&&event.data.type==='team-native-theme'){const root=document.documentElement;root.dataset.nativeTheme=event.data.theme;for(const [key,value] of Object.entries(event.data.colors??{}))if(['ink','muted','border','surface'].includes(key)&&typeof value==='string')root.style.setProperty('--native-'+key,value);}
   if(currentReady){connection.ready(event.data.version);try{sessionStorage.setItem('team-native-last-load:'+current.scope,JSON.stringify({at:new Date().toISOString(),attempt:connection.state.attempt,timings:connection.state.timings}));}catch{}}
   if(currentSnapshot){pendingSnapshot?.(lastHash);pendingSnapshot=undefined;}
  };
  const check=async()=>{await connection.check();if(!ended)timer=setTimeout(check,connection.state.ready&&connection.state.phase==='ready'?10000:1500);};
  const wake=()=>{if(document.visibilityState==='visible')void connection.check();};
  window.addEventListener('message',message);window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);
  void connection.open();timer=setTimeout(check,500);
  return()=>{ended=true;folderHost.dispose();clearTimeout(timer);connection.stop();pendingSnapshot?.(lastHash);window.removeEventListener('message',message);window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake);};
 },[project,member]);
 const loading=!view?.ready||view.phase!=='ready';
 const currentSync=sync?.version===view?.version&&sync?.session===session?sync:undefined;
 return <div className="native-workbench" hidden={!visible}>
  {loading&&<div className={view?.url?'native-loading-bar':'native-empty'} role="status" aria-live="polite">
   <strong>{labels[view?.phase??'connecting']}…</strong><span>{view?.error||'正在准备当前项目和已有会话。'}{view&&view.elapsedMs>0?` · 已用 ${(view.elapsedMs/1000).toFixed(1)} 秒`:''}</span>
   {(view?.error||(view?.elapsedMs??0)>15000)&&<button onClick={()=>controller.current?.retry()}>重新连接</button>}
  </div>}
  {view?.url&&<iframe key={view.version} ref={frame} title="项目聊天 · team-harness-platform" src={view.url} allow="clipboard-read; clipboard-write" onLoad={()=>{controller.current?.loaded(view.version);frame.current?.contentWindow?.postMessage({type:'team-native-probe',scope:view.scope,version:view.version,workbenchPanels:onFiles?['files']:[]},new URL(view.url).origin);}}/>}
  {view?.ready&&view.phase==='ready'&&<details className="native-load-timing"><summary>{session?syncLabels[currentSync?.phase??'waiting']:'界面已加载'} · 界面 {(view.elapsedMs/1000).toFixed(1)} 秒</summary><span>界面加载耗时与聊天同步分别核对。{currentSync?.lastUpdateAt?`最近收到聊天更新：${new Date(currentSync.lastUpdateAt).toLocaleTimeString()}。`:''}任务执行和原件交付以任务卡片状态为准。{view.timings.reused?'复用已有环境':`环境首次准备 ${((view.timings.startupMs??0)/1000).toFixed(1)} 秒`} · 连接入口 {((view.timings.openMs??0)/1000).toFixed(1)} 秒 · 页面恢复 {((view.timings.pageMs??0)/1000).toFixed(1)} 秒</span>{currentSync?.phase==='error'&&<button onClick={()=>controller.current?.retry()}>重新连接</button>}</details>}
  {referenceError&&references.some(r=>r.project===project&&(r.member??'')===(member??''))&&<div className="studio-inline-notice" role="status">{referenceError}<button onClick={async()=>{try{await navigator.clipboard.writeText(references.filter(r=>r.project===project&&(r.member??'')===(member??'')).map(r=>r.text).join('\n\n'));setReferenceError('引用已复制，请粘贴到当前聊天。');}catch{setReferenceError('浏览器未允许复制，请保留引用并在可编辑聊天恢复后重试。');}}}>复制引用</button></div>}
  <IncidentReport visible={visible} api={scopedApi} project={project} member={member} session={session} client={view??{phase:'connecting'}}/>
 </div>;
}
export function NativePolicy({api}:{api:NativeApi}){const [data,setData]=useState<Item>(),[error,setError]=useState('');useEffect(()=>{void api('/native/status').then(setData).catch(e=>setError(e.message));},[]);return <div className="card admin-card"><h3>项目工作台</h3><p>成员可在当前项目中使用完整原生功能，直接提交生成、查看历史上下文和修改文件。项目外操作被隔离；模型范围由管理员统一配置。</p>{data&&<p>运行环境：{data.available?'已确认':'暂未确认，请检查 Docker 状态后重试'} · 当前项目环境：{data.instances?.length??0}</p>}{error&&<p role="alert">{error}</p>}</div>;}
