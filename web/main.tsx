import {ProjectFiles} from './project-files';
import {MediaLibrary} from './deferred-panels';
import {WorkbenchRefresh,projectContentChanged} from './workbench-refresh';
import {MediaGallery} from './media-gallery';
import {useNativeSettingsTheme} from './settings-theme';
import {EmbeddedSettings,TeamSettingsContent} from './deferred-panels';
import {ProjectFileTree,MemberTaskCenter,ReviewCenter} from './deferred-panels';
import {OperationsAdmin} from './deferred-panels';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import './settings.css';
import deepseekMark from './deepseek.svg';
import {AttachmentUpload,type AttachmentUploadHandle,FileLink,projectFileURL,displayPath,ChatAttachment} from './attachments';
import {ChatComposer,ChatMarkdown,ChatActivity,CopyButton,Icon,QueueDock,exportChat} from './chat-ui';
import {ChatAdmin} from './deferred-panels';
import {MemberModelPolicy} from './deferred-panels';
import {BillingAdmin} from './deferred-panels';
import {NativeWorkspace,NativePolicy,type NativeCommand} from './native-harness';
import { newRequestId } from './request-id';
import { DesktopRoot } from './desktop';
import { LoginForm } from './login-form';
import { WorkspaceHeader } from './workspace-header';
import { ProjectScopeAdmin,ProjectCreateAdmin,ProjectCreateMember } from './project-scope';
import {ImageCard, MediaModelDirectory, ImageReferences} from './images';
import { PickupCard, VideoAdmin, SharedPickupResult, VideoProgress } from './pickups';
import { pendingKey, readPending, savePending } from './pending';
import './workbench-ui.css';
import './shared-workbench-ui.js';
import {ProjectHome} from './project-home';
import {ProjectStudio,type StudioReference} from './project-studio';
import {initialStudioPage} from '../shared/project-studio';
const Brand = ({hero = false}: {hero?: boolean}) => <div className={hero ? 'brand hero-brand' : 'brand'}><img src={deepseekMark} alt=""/><span>哇唔哇唔<b>智能体</b></span></div>;
type Item = Record<string, any>;
import { ApiClient, StaleResponse } from './api';
const apiClient = new ApiClient();
const api = apiClient.call.bind(apiClient);
const labels: Record<string, string> = { termination_unconfirmed: '停止待核实', awaiting_candidate: '保存候选中', queued: '排队中', running: '执行中', awaiting_review: '待审核', completed: '已完成', submitted: '待审核', committed: '已发布', approved: '已批准', rejected: '已退回', conflict: '有冲突', cancelled: '已取消', cancel_requested: '正在取消', failed: '失败', interrupted: '已中断' };
const Badge = ({ state }: { state: string }) => <span className={`badge ${state}`}>{labels[state] || state}</span>;
const when = (date: string) => new Date(date).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function App({embedded=false}:{embedded?:boolean}) {
  useNativeSettingsTheme(embedded);
  const embeddedPanel=new URLSearchParams(location.search).get('view')??'files';
  const [projectId,setProjectId]=useState(()=>{const id=(embedded?location.pathname.split('/')[2]?.split('~')[0]:new URLSearchParams(location.search).get('project'))??'shared';apiClient.projectId=id;return id;}),[projectList,setProjectList]=useState<Item[]>([]),[projectListReady,setProjectListReady]=useState(false);
  const uploadBusy=useRef(false);
  const attachmentInput=useRef<AttachmentUploadHandle>(null);
  const [attachmentBusy,setAttachmentBusy]=useState(false);
  function updateUploadBusy(value:boolean){uploadBusy.current=value;setAttachmentBusy(value);}
  const drafts=useRef(new Map<string,Item>());
  const scrollport=useRef<HTMLDivElement>(null),stickToBottom=useRef(true);const [showLatest,setShowLatest]=useState(false);
  const draftScope=useRef('');const draftValue=useRef<Item>({prompt:'',workflow:'chat',selected:[]});
  const [sessionTitle,setSessionTitle]=useState('');
  const [status, setStatus] = useState<Item>(); const [user, setUser] = useState<Item>(); const [boot, setBoot] = useState(true); const [error, setError] = useState('');
  const [adminTab,setAdminTab]=useState('workspaces');
  const [nativeMember,setNativeMember]=useState<string>();
  const [nativeCommand,setNativeCommand]=useState<NativeCommand>();
  const openSettings=(section?:string)=>{if(embedded){window.parent.postMessage({type:'team-settings-section',section:section??'models'},location.origin);return;}saveDraft();setWorkspaceOpened(true);setPage('native');setNativeCommand({id:Date.now(),type:'settings',section});};
  const [workspaceOpened,setWorkspaceOpened]=useState(()=>!embedded&&initialStudioPage(location.search)==='native');
  const [references,setReferences]=useState<StudioReference[]>([]);
  const [referenceTarget,setReferenceTarget]=useState<{project:string;member?:string;session?:string}>();
  const [studioUpdate,setStudioUpdate]=useState(0),[projectPanelRequest,setProjectPanelRequest]=useState(0);
  const [page, setPage] = useState(embedded?embeddedPanel:initialStudioPage(location.search)); const [project, setProject] = useState<Item>(); const [sessions, setSessions] = useState<Item[]>([]); const [session, setSession] = useState(''); const [messages, setMessages] = useState<Item[]>([]);
  const [images,setImages]=useState<Item[]>([]);
  const [pickups, setPickups] = useState<Item[]>([]); const [receivedMedia,setReceivedMedia]=useState<Item[]>([]);
  const [tasks, setTasks] = useState<Item[]>([]); const [changes, setChanges] = useState<Item[]>([]); const [selected, setSelected] = useState<string[]>([]); const [prompt, setPrompt] = useState(''); const [workflow, setWorkflow] = useState('chat'); const [busy, setBusy] = useState(false); const [change, setChange] = useState<Item>();
  const [users, setUsers] = useState<Item[]>([]); const [health, setHealth] = useState<Item>(); const [allChats, setAllChats] = useState(false); const [notice, setNotice] = useState(''); const cursor = useRef(0); const authEpoch = useRef(0); const lastMessage = useRef<HTMLDivElement>(null);
  const [connectionError, setConnectionError] = useState(''); const [bootAttempt, setBootAttempt] = useState(0);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [filePath, setFilePath] = useState(''); const [changeId, setChangeId] = useState('');
  const [pending, setPending] = useState<Item>(); const pendingRef = useRef<Item | undefined>(undefined); const sendLock = useRef(false); const draftVersion = useRef(0);
  const pendingStorageKey = user?.id && status?.serverId ? pendingKey(status.serverId,user.id)+(projectId==='shared'?'':'.'+projectId) : '';
  const scopeRef = useRef(''); scopeRef.current = `${user?.id}|${projectId}|${session}|${page}|${allChats}`;
  const [collapsed, setCollapsed] = useState(false); const [filesOpen, setFilesOpen] = useState(false); const [search, setSearch] = useState('');
  const selectedSessionRef = useRef(session); selectedSessionRef.current = session;
  const nativeEnabled = !!status?.capabilities?.includes('native-harness');
  const videoEnabled = status?.capabilities?.includes('video-pickups');
  const nativeStudioPage=!embedded&&nativeEnabled&&workspaceOpened&&['native','files','reviews'].includes(page);
  // The direct conversation surface is opt-in on the local candidate server.
  // Both clients use the same component surface; desktop authenticates its own
  // top-level entry through a narrowly scoped IPC bridge.
  const directNativeSurface=nativeStudioPage&&!!status?.capabilities?.includes('native-project-surface');
  const [directSurfaceAttempt,setDirectSurfaceAttempt]=useState(0),[directSurfaceError,setDirectSurfaceError]=useState('');
  useEffect(()=>{
    if(!directNativeSurface||!user)return;let current=true;setDirectSurfaceError('');
    void(async()=>{
      const value=await api('/native/open?'+new URLSearchParams({project:projectId,...(nativeMember?{member:nativeMember}:{})}),'POST',{});
      if(!current)return;let target:URL;
      if(window.teamDesktop){
        const opened=await window.teamDesktop.openNativeHarness(value.url,{projectSurface:true});if(!opened.ok)throw Error(opened.error||'项目登录入口未确认');
        target=new URL(opened.value.url);const issued=new URL(value.url);if(target.origin!==issued.origin||target.pathname!==issued.pathname||target.search||target.hash)throw Error('项目入口与当前主机不一致');
      }else{
        target=new URL(value.url,location.origin);if(target.origin!==location.origin||!/^\/harness\/(shared|[a-f0-9-]{36})(~[a-f0-9-]{36})?\/$/.test(target.pathname))throw Error('项目入口与当前主机不一致');
        const response=await fetch(target,{credentials:'same-origin'});if(!response.ok)throw Error('项目登录入口未确认');
      }
      if(!current)return;
      target.search='';if(nativeCommand?.session)target.searchParams.set('nativeSession',nativeCommand.session);if(nativeCommand?.type==='new')target.searchParams.set('newChat','1');if(page==='files')target.searchParams.set('view','files');
      location.assign(target.href);
    })().catch(e=>{if(current)setDirectSurfaceError(e.message);});
    return()=>{current=false;};
  },[directNativeSurface,user?.id,projectId,nativeMember,directSurfaceAttempt]);
  const multiChatEnabled=status?.capabilities?.includes('multi-session-chat')&&project?.chat?.multipleSessions!==false;
  const fixedChatEnabled=status?.capabilities?.includes('fixed-project-chat');
  const admin = user?.role === 'admin'; const mySession = sessions.find(s => s.id === session); const activeTask = tasks.find(t => t.session === session && ['running', 'cancel_requested'].includes(t.state));
  const queuedTasks=tasks.filter(t=>t.session===session&&['queued','steering'].includes(t.state));
  const readOnly=Boolean(mySession&&(mySession.owner!==user?.id||mySession.archived));
  const draftKey=user?.id&&status?.serverId&&session?`team.draft.${status.serverId}.${user.id}.${projectId}.${session}`:'';
  draftValue.current={prompt,workflow,selected};
  useEffect(()=>{const save=()=>{if(draftScope.current){try{localStorage.setItem(draftScope.current,JSON.stringify(draftValue.current));}catch{}}};window.addEventListener('beforeunload',save);return()=>window.removeEventListener('beforeunload',save);},[]);
  useEffect(()=>{
    if(draftScope.current===draftKey)return;draftScope.current=draftKey;let d:Item|undefined;try{d=draftKey?JSON.parse(localStorage.getItem(draftKey)||'null'):undefined;}catch{}
    setPrompt(d?.prompt??'');setSelected(d?.selected??[]);setWorkflow(d?.workflow??'chat');stickToBottom.current=true;setShowLatest(false);draftVersion.current++;
  },[draftKey]);
  useEffect(()=>{if(!draftKey||draftScope.current!==draftKey)return;const timer=setTimeout(()=>{try{localStorage.setItem(draftKey,JSON.stringify({prompt,workflow,selected}));}catch{}},180);return()=>clearTimeout(timer);},[draftKey,prompt,workflow,selected]);
  useEffect(()=>{if(session&&mySession?.owner===user?.id){try{localStorage.setItem(`team.session.${status?.serverId}.${user?.id}.${projectId}`,session);}catch{}}},[session,mySession?.owner,user?.id,projectId,status?.serverId]);
  useEffect(()=>{if(status?.capabilities?.includes('native-harness')&&page==='chat')setPage('native');},[page,status]);
  function saveDraft(){if(draftKey){try{localStorage.setItem(draftKey,JSON.stringify({prompt,workflow,selected}));}catch{}}}
  function chooseSession(id:string){if(uploadBusy.current||pendingRef.current){setError('请先完成附件上传或核对提交。');return;}saveDraft();setMessages([]);selectedSessionRef.current=id;setSession(id);setPage('chat');}
  async function sessionSettings(values:Item){await api(`/sessions/${session}`,'PATCH',values);await refresh();}
  function updatePrompt(value:string){draftVersion.current++;setPrompt(value);}
  async function stopChat(){if(activeTask){await api(`/tasks/${activeTask.id}/cancel`,'POST',{});await refresh();}}
  function resetWorkspace(targetPage=embedded?embeddedPanel:'projects') { if(targetPage==='projects'){setWorkspaceOpened(false);setReferences([]);setReferenceTarget(undefined);setProjectList([]);setProjectListReady(false);apiClient.selectProject('shared');setProjectId('shared');const url=new URL(location.href);url.searchParams.delete('project');url.hash='';history.replaceState(null,'',url);} setNativeMember(undefined);setNativeCommand(undefined);authEpoch.current++; apiClient.invalidate(); setSession(''); setSessions([]); setMessages([]); setTasks([]); setPickups([]); setImages([]); setReceivedMedia([]); setChanges([]); setChange(undefined); setChangeId(''); setFilePath(''); setUsers([]); setProject(undefined); setHealth(undefined); setAllChats(false); setSelected([]); setPrompt(''); setNotice(''); setPage(embedded?embeddedPanel:status?.capabilities?.includes('native-harness')?targetPage:'chat'); setAdminTab('projects'); setSearch(''); setFilesOpen(false); setPending(undefined); pendingRef.current = undefined; setBusy(false); sendLock.current = false; setWorkflow('chat'); setConnectionError(''); cursor.current = 0; }
  async function act(fn: () => Promise<void>) { const epoch = authEpoch.current; setError(''); try { await fn(); } catch (e: any) { if (e instanceof StaleResponse || epoch !== authEpoch.current) return; if (e.status === 401) { resetWorkspace(); setUser(undefined); } setError(e.message); } }
  function acceptedSubmission(submission: Item) {
    if (pendingRef.current !== submission) return;
    if (pendingStorageKey) { try { localStorage.removeItem(pendingStorageKey); } catch {} }
    pendingRef.current = undefined; setPending(undefined);
    if (draftVersion.current === submission.draftVersion && selectedSessionRef.current === submission.body.session){setPrompt('');setSelected([]);try{if(draftKey)localStorage.removeItem(draftKey);}catch{}}
    setError('');
  }
  async function refresh(valid: () => boolean = () => true) {
    const epoch = authEpoch.current; const scope = `${user?.id}|${projectId}|${session}|${page}|${allChats}`;
    const current = () => valid() && epoch === authEpoch.current && scope === scopeRef.current;
    if (!current()) throw new StaleResponse();
    const pl=await api('/projects');if(!current())throw new StaleResponse();setProjectList(pl);setProjectListReady(true);if(page==='projects')return;if(!pl.some((p:Item)=>p.id===projectId)){showProjects();throw new StaleResponse();}
    const [p, ss, ts, cs, ps, ips] = await Promise.all([api('/project'+(nativeStudioPage&&status?.capabilities?.includes('project-content-pages')?'?view=studio':'')), api(`/sessions${allChats ? '?all=1' : ''}`), api(`/tasks${admin && (page === 'tasks' || allChats) ? '?all=1' : ''}`), api('/changes'), videoEnabled && !(nativeStudioPage&&status?.capabilities?.includes('project-content-pages')) ? api(`/pickups${admin && (page === 'tasks' || allChats) ? '?all=1' : ''}`) : Promise.resolve([]),status?.capabilities?.includes('image-generation')&&!(nativeStudioPage&&status?.capabilities?.includes('project-content-pages'))?api(`/images${admin&&(page==='tasks'||allChats)?'?all=1':''}`):Promise.resolve([])]);
    const receipt = window.teamDesktop?.receivedMedia ? await window.teamDesktop.receivedMedia() : undefined;
    const management = admin && page === 'admin' ? await Promise.all([api('/admin/users'), status?.capabilities?.includes('native-only-chat')?Promise.resolve(undefined):api('/admin/health')]) : undefined;
    if (!current()) throw new StaleResponse();
    setProjectList(pl);setProject(p); setSessions(ss); setTasks(ts); setChanges(cs); setPickups(ps); setImages(ips); if(!session && fixedChatEnabled){let last='';try{last=localStorage.getItem(`team.session.${status?.serverId}.${user?.id}.${projectId}`)??'';}catch{}const own=ss.find((s:Item)=>s.id===last&&s.owner===user?.id&&!s.archived)??ss.find((s:Item)=>s.owner===user?.id&&!s.archived&&s.fixed)??ss.find((s:Item)=>s.owner===user?.id&&!s.archived);if(own)setSession(own.id);} if(receipt?.ok)setReceivedMedia(receipt.value);
    if (management) { setUsers(management[0]); setHealth(management[1]); }
    const submission = pendingRef.current;
    if (submission && ts.some((t: Item) => t.requestId === submission.body.requestId && t.session === submission.body.session && t.owner === user?.id)) acceptedSubmission(submission);
    if (session) { const ms = await api(`/sessions/${session}/messages`); if (!current()) throw new StaleResponse(); setMessages(ms); }
  }
  useEffect(() => { let stopped = false; void (async () => { try { const server = await api('/status'); let me; try { me = await api('/me'); } catch (e: any) { if (e.status !== 401) throw e; } if (stopped) return; setStatus(server); setUser(me?.user); setConnectionError(''); } catch (e: any) { if (!stopped && !(e instanceof StaleResponse)) setConnectionError(e.message); } finally { if (!stopped) setBoot(false); } })(); return () => { stopped = true; }; }, [bootAttempt]);
  useEffect(() => {
    if (status || !connectionError) return;
    const retry = setTimeout(() => setBootAttempt(n => n + 1), 5000);
    return () => clearTimeout(retry);
  }, [status, connectionError, bootAttempt]);
  useEffect(() => {
    if (!user) return;
    let stopped = false; let working = false; const epoch = authEpoch.current;
    const current = () => !stopped && epoch === authEpoch.current;
    const readViews=new WorkbenchRefresh({readEvents:after=>api(`/events?after=${after}`),refresh:()=>refresh(current),current,cursor:{get:()=>cursor.current,set:value=>{cursor.current=value;}},everyTick:!nativeStudioPage});
    const tick = async () => {
      if (working) return; working = true;
      try {
        const me = await api('/me'); if (!current()) return;
        if (me.user.id !== user.id || me.user.role !== user.role) { resetWorkspace(); setUser(me.user); return; }
        const result=await readViews.poll();if(!current()||!result)return;setConnectionError('');
        if(projectContentChanged(result,projectId))setStudioUpdate(value=>value+1);
        if (result.resetRequired) setNotice('同步记录已更新，已重新读取当前项目和会话。');
        if(result.events.some((e:Item)=>e.type==='project.created'))setNotice('新项目已创建，项目列表已更新。');
        if (result.events.some((e: Item) => e.type === 'project.updated'&&(e.body?.project??'shared')===projectId)) setNotice('共享项目已有更新，后续新任务将读取最新版本。');
      } catch (e: any) { if (current() && !(e instanceof StaleResponse)) { if (e.status === 401) { resetWorkspace(); setUser(undefined); setError(e.message); } else setConnectionError(e.message); } }
      finally { working = false; }
    };
    void tick(); const timer = setInterval(tick, 1500); return () => { stopped = true; clearInterval(timer); };
  }, [user?.id, user?.role, projectId, session, page, allChats]);
  useEffect(() => {
    if (page==='projects' || !pendingStorageKey || pendingRef.current) return;
    const saved = readPending(localStorage,pendingStorageKey);
    if (saved) { const submission={body:{session:saved.session,requestId:saved.requestId},draftVersion:-1}; pendingRef.current=submission;setPending(submission);setSession(saved.session); }
  }, [pendingStorageKey,page]);
  useEffect(() => {
    const warn=(e:BeforeUnloadEvent)=>{if(pendingRef.current||uploadBusy.current){e.preventDefault();e.returnValue='';}};
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
  }, [prompt]);
  useEffect(()=>{if(stickToBottom.current)lastMessage.current?.scrollIntoView({block:'end'});else setShowLatest(true);},[messages.length,activeTask?.partial,activeTask?.reasoning]);
  useEffect(() => { if (!connectionError) setDetailAttempt(n => n + 1); }, [connectionError]);
  const changeVersion = changes.find(c => c.id === changeId)?.state;
  useEffect(() => {
    let stopped = false; setChange(undefined);
    if (changeId) void act(async () => { const result = await api(`/changes/${changeId}`); if (!stopped) setChange(result); });
    return () => { stopped = true; };
  }, [changeId, changeVersion, detailAttempt]);
  function switchProject(next:string){
    if(next===projectId)return;
    if(embedded){window.parent.postMessage({type:'team-settings-project',project:next,panel:embeddedPanel},location.origin);return;}
    if(pendingRef.current||sendLock.current||uploadBusy.current){setError('请先完成附件上传或核对当前提交，再切换项目。');return;}
    saveDraft();drafts.current.set(projectId,{prompt,workflow,selected});const draft=drafts.current.get(next);
    resetWorkspace('native');setWorkspaceOpened(true);apiClient.selectProject(next);setProjectId(next);selectedSessionRef.current='';setError('');
    if(draft){setPrompt(draft.prompt);setWorkflow(draft.workflow);setSelected(draft.selected);}
    const url=new URL(location.href);url.searchParams.set('project',next);history.replaceState(null,'',url);
  }
  function showProjects(){if(pendingRef.current||sendLock.current||uploadBusy.current){setError('请先完成附件上传或核对提交。');return;}saveDraft();setPage('projects');setError('');const url=new URL(location.href);url.searchParams.delete('project');url.hash='';history.replaceState(null,'',url);}
  function openProject(id:string){if(pendingRef.current||sendLock.current||uploadBusy.current){setError('请先完成附件上传或核对提交。');return;}if(id!==projectId)switchProject(id);setWorkspaceOpened(true);setPage('native');const url=new URL(location.href);url.searchParams.set('project',id);history.replaceState(null,'',url);}
  function queueNativeReference(text:string,name:string){setReferences(list=>[...list,{id:newRequestId(),project:projectId,member:nativeMember,session:referenceTarget?.project===projectId&&referenceTarget.member===nativeMember?referenceTarget.session:undefined,text,name}]);}
  async function uploaded(u:Item){setSelected(prev=>prev.includes(u.path)?prev:[...prev.slice(-15),u.path]);draftVersion.current++;if(u.mediaId&&workflow==='image')setPrompt(p=>p+'\n参考图：'+u.mediaId);if(workflow==='pickup')setWorkflow('chat');setNotice('附件原件已备份到当前项目，全部成员可直接调用。');await refresh();}
  async function newChat(){
    if(uploadBusy.current||pendingRef.current||sendLock.current){setError('请先完成附件上传或核对提交。');return;}
    saveDraft();const s=await api('/sessions','POST',multiChatEnabled?{fresh:true}:{});setSessions(prev=>[...prev.filter(v=>v.id!==s.id),s]);selectedSessionRef.current=s.id;setSession(s.id);setMessages([]);setPage('chat');setPrompt('');setSelected([]);setWorkflow('chat');draftVersion.current++;
  }
  function rejectSubmission(submission: Item, e: any) { if (e.status >= 400 && e.status < 500 && pendingRef.current === submission) { if(pendingStorageKey){try{localStorage.removeItem(pendingStorageKey);}catch{}}pendingRef.current = undefined; setPending(undefined); } }
  async function confirmSubmission(submission: Item) {
    try { await api('/tasks', 'POST', submission.body); } catch (e) { if (!(e instanceof StaleResponse) && pendingRef.current !== submission) return; rejectSubmission(submission, e); throw e; }
    acceptedSubmission(submission);
    await refresh();
  }
  async function send(delivery:'queue'|'steer'='queue',again?:Item) {
    if(uploadBusy.current)throw new Error('附件正在上传，请完成后发送。');
    if ((!again&&!prompt.trim()&&!selected.length) || sendLock.current || pendingRef.current || (mySession && (mySession.owner !== user?.id || mySession.archived))) return;
    const epoch = authEpoch.current; let draft = again?.prompt??(prompt.trim()?prompt:'请读取并分析这些附件。'); const version = again?-1:draftVersion.current; const paths = [...(again?.paths??selected)]; let flow = again?.workflow??(workflow === 'pickup' && !videoEnabled ? 'chat' : workflow);
    const slash=draft.match(/^\/(chat|plan|organize|video|image|python)\s+([\s\S]+)$/);if(slash){draft=slash[2];flow=({chat:'chat',plan:'plan',organize:'organize',video:'pickup',image:'image',python:'script'} as Item)[slash[1]];}
    sendLock.current = true; setBusy(true);
    try {
      let sid = session;
      if (!sid) { const s = await api('/sessions', 'POST', { title: draft.slice(0, 28),...(multiChatEnabled?{fresh:true}:{}) }); sid = s.id; if (selectedSessionRef.current === session) { selectedSessionRef.current = sid; setSession(sid); } }
      const submission = { body: { session: sid, prompt: draft, workflow: flow, paths, requestId: newRequestId(),delivery,modelId:mySession?.modelId??project?.chat?.models?.[0]?.id,permission:mySession?.permission??project?.chat?.permissions?.[0],skillId:mySession?.skillId??project?.chat?.defaultSkillId }, draftVersion: version };
      if (!pendingStorageKey) throw new Error('服务器尚未提供稳定身份，请更新后台后再提交');
      try { savePending(localStorage,pendingStorageKey,submission.body); } catch { throw new Error('无法保存提交编号，请启用本地存储后再发送；本次尚未提交'); }
      pendingRef.current = submission; setPending(submission);
      await confirmSubmission(submission);
    } finally { if (epoch === authEpoch.current) { sendLock.current = false; setBusy(false); } }
  }
  async function retrySubmission() {
    const submission = pendingRef.current; if (!submission || sendLock.current) return;
    const epoch = authEpoch.current; sendLock.current = true; setBusy(true);
    try {
      const result=await api('/requests/'+encodeURIComponent(submission.body.requestId)+'?session='+encodeURIComponent(submission.body.session));
      if(result.found){acceptedSubmission(submission);await refresh();}
      else if(result.closed){rejectSubmission(submission,{status:409});setNotice('原提交已结束；你可以编辑内容后重新发送。');}
      else setError('暂未查到原提交，未重新发送。请稍后再次核对，或联系超级管理员检查。');
    } finally { if (epoch === authEpoch.current) { sendLock.current = false; setBusy(false); } }
  }
  async function closeUnacceptedSubmission() {
    const submission=pendingRef.current;if(!submission||sendLock.current)return;
    if(!window.confirm('服务器会先核对原编号：已受理则恢复原任务；未受理则永久封存此编号，阻止迟到请求。此操作不会重新发送内容。'))return;
    const epoch=authEpoch.current;sendLock.current=true;setBusy(true);
    try {
      const result=await api('/requests/'+encodeURIComponent(submission.body.requestId)+'/close','POST',{session:submission.body.session});
      if(result.found){acceptedSubmission(submission);await refresh();}
      else if(result.closed){rejectSubmission(submission,{status:409});setNotice('未受理的提交已结束，可以重新编辑并发送。');setError('');}
    } finally {if(epoch===authEpoch.current){sendLock.current=false;setBusy(false);}}
  }
  if (boot || !status) return <div className="boot"><Brand/><p role="status">{connectionError || '正在连接服务器…'}</p>{connectionError && <button className="secondary" onClick={() => { setBoot(true); setBootAttempt(n => n + 1); }}>重新连接</button>}</div>;
  if (!user) return <div className="login-shell studio-login">
    <div className="login-brand"><Brand/><span className="team-tag">团队协作</span></div>
    <div className="form-card">
      <img className="login-fish" src={deepseekMark} alt="team-harness-platform"/>
      <h1>{status?.needsSetup ? '创建超级管理员' : '登录team-harness-platform'}</h1>
      <p className="muted">{status?.needsSetup ? '初始化团队工作空间，所有成员在同一项目中协作。' : '登录后进入项目，继续上次的创作。'}</p>
      <LoginForm needsSetup={!!status.needsSetup} api={api} onSuccess={async me=>{setError('');resetWorkspace();setUser(me.user);if(me.credentialNotice)setNotice(me.credentialNotice);setStatus(await api('/status'));}}/>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="login-status"><span className="status-dot"/>{status?.modelMode === 'online' ? `${status.onlineModel} · 已连接` : '模拟模型 · 开发验证'}</div>
      <p className="login-hint">会话独立 · 项目共享 · 服务器统一管理</p>
    </div>
    <div className="login-footer">team-harness-platform · 本地团队协作</div>
  </div>;
  return <div className={`app ${embedded?'embedded-tools':''} ${nativeEnabled ? 'native-shell studio-shell' : ''} ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <aside className="sidebar">
      <div className="sidebar-head"><Brand/><button className="icon-button" title={collapsed ? '展开侧栏' : '收起侧栏'} onClick={() => setCollapsed(!collapsed)}>☰</button></div>
      <button className="new-session" title={multiChatEnabled?"新建会话":"我的项目聊天"} onClick={() => {if(status?.capabilities?.includes('native-harness'))setPage('native');else void act(newChat);}}><span>{multiChatEnabled?"＋":"○"}</span><span className="sidebar-label">{multiChatEnabled?"新会话":"我的项目聊天"}</span></button>
      <nav aria-label="工作空间功能">{status?.capabilities?.includes('native-harness')&&<button className="nav" onClick={()=>{saveDraft();setPage('native');}}><span>◈</span><span className="sidebar-label">项目聊天</span></button>}{[['files', '▤', '项目文件'], ['images','▧','图片查看'], ['videos','▷','视频查看'], ['tasks', '▥', admin?'任务中心':'我的统计']].map(([key, icon, title]) => <button key={key} title={title} className={page === key ? 'nav active' : 'nav'} onClick={() => { setPage(key); setError(''); }}><span>{icon}</span><span className="sidebar-label">{title}</span>{key === 'reviews' && changes.filter(c => c.state === 'submitted').length > 0 && <i>{changes.filter(c => c.state === 'submitted').length}</i>}</button>)}</nav>
      <section hidden={!!status?.capabilities?.includes('native-harness')} className="history" aria-label="项目与会话">
        <div className="history-heading"><span>工作空间</span><span title="所有成员共享项目列表">▾</span></div>
        <label className="history-search"><span className="sr-only">搜索会话</span><input placeholder="搜索会话" value={search} onChange={e => setSearch(e.target.value)}/></label>
        <label className="project-switch"><span className="sr-only">切换项目</span><select aria-label="切换项目" value={projectId} onChange={e=>switchProject(e.target.value)}>{projectList.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button className="text-button" onClick={()=>{if(admin){setAdminTab('projects');setPage('admin');}else setPage('project-create');}}>＋ 新建项目</button>
        {admin && <label className="check admin-chat-scope"><input type="checkbox" checked={allChats} onChange={e => { if(uploadBusy.current||pendingRef.current){setError('请先完成附件上传或核对提交。');return;}saveDraft();setAllChats(e.target.checked); setSession(''); setMessages([]); }}/>查看全部成员会话</label>}
        <div className="session-list">{[...sessions].reverse().filter(s=>!s.archived).filter(s => s.title.toLowerCase().includes(search.toLowerCase())).map(s => <button key={s.id} className={`session ${session === s.id && page === 'chat' ? 'selected' : ''}`} onClick={()=>chooseSession(s.id)} title={s.title}><span className="session-dot">○</span><strong>{s.title}</strong><small>{s.owner !== user.id ? '成员' : new Date(s.created).toLocaleDateString('zh-CN', {month:'2-digit', day:'2-digit'})}</small></button>)}{!sessions.length && <div className="history-empty">还没有会话</div>}</div>{sessions.some(s=>s.archived)&&<details className="session-archive"><summary>已归档会话</summary>{sessions.filter(s=>s.archived&&s.title.toLowerCase().includes(search.toLowerCase())).map(s=><button key={s.id} className="session" onClick={()=>chooseSession(s.id)}>{s.title}</button>)}</details>}
      </section>
      <div className="sidebar-bottom">
        {admin && <button className={`nav ${page === 'admin' ? 'active' : ''}`} title="后台管理" onClick={() => setPage('admin')}><span>⚙</span><span className="sidebar-label">后台管理</span></button>}
        <div className="profile"><span className="avatar">{user.name.slice(0,1)}</span><div className="profile-info"><b>{user.name}</b><small>{admin ? '超级管理员' : '团队成员'}</small></div><button className="icon-button logout" title="退出登录" onClick={() => void act(async () => { saveDraft();await api('/logout', 'POST', {});  resetWorkspace(); setUser(undefined); apiClient.csrf = ''; })}>↪</button></div>
      </div>
    </aside>
    <main>
      {!embedded && (nativeEnabled ? <WorkspaceHeader page={nativeStudioPage?'native':page} onPage={next => { if(next==='projects'){showProjects();return;}if(next==='native'){openProject(projectId);return;}if(next==='settings'){openSettings();return;}saveDraft(); setPage(next); setError(''); }} admin={admin} name={user.name} projectId={projectId} projects={projectList as {id:string;name:string}[]} projectName={project?.name} onProject={switchProject} reviews={changes.filter(c => c.state === 'submitted').length} onLogout={() => void act(async () => { saveDraft(); await api('/logout', 'POST', {});  resetWorkspace(); setUser(undefined); apiClient.csrf = ''; })}/> : (
      <header className="workspace-header"><div className="page-title"><button className="icon-button mobile-menu" title="切换侧栏" onClick={() => setCollapsed(!collapsed)}>☰</button><span>{page === 'chat' ? (mySession?.title ?? '新会话') : ({native:'项目聊天',files:'项目文件',tasks:'任务中心',reviews:'成果审核',admin:'后台管理'} as any)[page]}</span><span className="team-tag">团队</span></div><div className="header-right">{page==='native'&&<select aria-label="切换团队项目" value={projectId} onChange={e=>switchProject(e.target.value)}>{projectList.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>}{page==='native'&&<><span className="team-tag">工作区内修改</span>{admin&&<button className="native-team-back" onClick={()=>setPage('admin')}>后台管理</button>}<button className="native-team-back" onClick={()=>void act(async()=>{await api('/logout','POST',{});resetWorkspace();setUser(undefined);apiClient.csrf='';})}>退出登录</button></>}{page==='chat'&&mySession&&<details className="chat-session-actions"><summary aria-label="会话操作">···</summary><div><button onClick={()=>exportChat(mySession.title,messages)}>导出聊天 Markdown</button>{mySession.owner===user.id&&<><input aria-label="会话名称" placeholder={mySession.title} value={sessionTitle} onChange={e=>setSessionTitle(e.target.value)}/><button disabled={!sessionTitle.trim()} onClick={()=>void act(async()=>{await sessionSettings({title:sessionTitle});setSessionTitle('');})}>重命名会话</button><button onClick={()=>void act(()=>sessionSettings({archived:!mySession.archived}))}>{mySession.archived?'恢复会话':'归档会话'}</button></>}</div></details>}<span className="revision" title={project?.revision}>▱ {project?.name}</span>{page!=='native'&&<button className={`icon-button ${filesOpen ? 'selected' : ''}`} title="切换项目资料面板" aria-pressed={filesOpen} onClick={() => { setPage('chat'); setFilesOpen(!filesOpen); }}>▤</button>}</div></header>
      ))}
      {status?.videoMode==='simulated'&&<div className="notice" role="status">隔离验收环境：文字与视频均为模拟，不调用真实生成 API。</div>}
      {connectionError && <div className="notice" role="status">{connectionError}</div>}
      {project?.publication?.state === 'recovery_required' && <div className="notice" role="status">项目有未完成发布，新的审批和任务启动已暂停。{admin ? <button className="text-button" onClick={() => void act(async () => { await api('/admin/project/recover', 'POST', {}); await refresh(); setNotice('原提交已恢复并核对，任务队列继续运行。'); })}>恢复并核对原提交</button> : '请联系超级管理员恢复。'}</div>}
      {error && <div className="error top-alert" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
      {notice && !nativeStudioPage && <div className="notice" onClick={() => setNotice('')}>{notice}　×</div>}
      {!embedded&&page==='projects'&&<ProjectHome projects={projectList} loading={!projectListReady} user={user} api={api} onOpen={openProject} onRefresh={()=>void refresh()}/>}
      {page==='project-create'&&<div className="content"><ProjectCreateMember api={api} onCreated={id=>{switchProject(id);setPage('native');}}/></div>}
      {!embedded&&!nativeStudioPage&&pickups.some(p=>p.owner===user.id&&p.jobs?.length>0)&&<details className="notice video-deliveries"><summary>我的视频进度与接收 · 每 1.5 秒同步</summary><p className="small">主机每 10 秒查询生成状态，下载与检查持续在主机运行。关闭聊天不会中断任务。{window.teamDesktop?.receivedMedia?'桌面端登录在线时，原片自动保存到下载/DeepSeek Team；重新登录会接收离线期间完成的原片。':'原片返回本人聊天，浏览器保存到设备时使用下载按钮。'}</p>{pickups.filter(p=>p.owner===user.id).flatMap(p=>(p.jobs??[]).map((j:Item)=><div className="pickup-job" key={j.id}><b>{j.sourceId} · 第 {j.round} 轮</b><VideoProgress job={j} received={receivedMedia.find(r=>r.mediaId===j.mediaId)}/><button className="text-button" onClick={()=>{setSession(p.session);setPage('chat');}}>打开原片所在聊天</button></div>)).reverse()}</details>}

      {(page==='images'||page==='videos')&&<MediaLibrary key={projectId+page} api={api} kind={page==='images'?'image':'video'} project={projectId} user={user}/>}
      {page === 'chat' && <div className={`chat-layout ${filesOpen ? 'with-files' : ''}`}>
        <section className={`conversation ${!messages.length && !activeTask ? 'is-empty' : ''}`}>
          <div className="messages" ref={scrollport} onScroll={()=>{const el=scrollport.current!;stickToBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<80;setShowLatest(!stickToBottom.current);}}>{!messages.length && !activeTask && <div className="conversation-empty"><img src={deepseekMark} alt="team-harness-platform"/><h1>探索未至之境</h1><span className="preview-label">预览版</span><p>{project?.name}</p></div>}
            {messages.filter(m=>!queuedTasks.some(t=>t.id===m.task)).map(m => <div className={`message ${m.role}`} key={m.id}><span className="message-label">{m.role === 'user' ? (mySession?.owner === user.id ? '你' : '成员') : (m.image?'图片方案':m.pickup?'补抽方案':tasks.find(t=>t.id===m.task)?.release?.model || 'AI')}{m.simulated && ' · 模拟'}</span><ChatActivity task={m.role==='assistant'?tasks.find(t=>t.id===m.task):undefined}/><div className="bubble">{m.role==='assistant'?<ChatMarkdown text={m.text}/>:m.text}</div>{m.attachments?.some((a:Item)=>/\.(png|jpe?g|webp|gif|mp4|mov|m4v|webm)$/i.test(a.name??a.path))&&<MediaGallery compact title="聊天附件" items={m.attachments.filter((a:Item)=>/\.(png|jpe?g|webp|gif|mp4|mov|m4v|webm)$/i.test(a.name??a.path)).map((a:Item)=>({id:a.path,name:a.name??a.path,kind:/\.(mp4|mov|m4v|webm)$/i.test(a.path)?'video':'image',src:projectFileURL(projectId,a.path,a.revision),download:projectFileURL(projectId,a.path,a.revision,true)}))}/>} {m.attachments?.filter((a:Item)=>!/\.(png|jpe?g|webp|gif|mp4|mov|m4v|webm)$/i.test(a.name??a.path)).map((a:Item)=><ChatAttachment key={a.path} project={projectId} attachment={a} onView={()=>{setFilePath(a.path);setPage('files');}}/>)}{m.role === 'user' && (() => { const t = tasks.find(t => t.id === m.task && ['failed','cancelled','interrupted','termination_unconfirmed'].includes(t.state)); return t ? <div className="task-outcome" role="status"><Badge state={t.state}/><p>{t.state === 'cancelled' ? '本次生成已停止。' : (t.error || '本次生成未完成。')}</p>{t.partial && <details><summary>查看未完成的输出</summary><div className="bubble">{t.partial}</div></details>}<button className="text-button" onClick={() => setPage('tasks')}>查看任务记录</button></div> : null; })()}{m.pickup && pickups.find(p=>p.id===m.pickup) && <PickupCard key={m.pickup} plan={pickups.find(p=>p.id===m.pickup)!} received={receivedMedia} user={user} api={api} refresh={refresh} onRevise={s=>{setPrompt(s);setWorkflow('pickup');draftVersion.current++;}}/>}{m.image&&images.find(p=>p.id===m.image)&&<ImageCard plan={images.find(p=>p.id===m.image)!} user={user} api={api} refresh={refresh} onRevise={s=>{setPrompt(s);setWorkflow('image');draftVersion.current++;}}/>}<div className="chat-message-actions"><CopyButton text={m.text} label="复制消息"/>{!readOnly&&<button className="chat-action" title={m.role==='user'?'编辑后重新发送':'重新生成'} aria-label={m.role==='user'?'编辑后重新发送':'重新生成'} onClick={()=>{const task=tasks.find(t=>t.id===m.task);if(m.role==='assistant'){void act(()=>send('queue',task??{prompt:'请重新回答上一条消息。',workflow:'chat',paths:[]}));return;}updatePrompt(m.text);setWorkflow(task?.workflow??'chat');setSelected(task?.paths??[]);document.querySelector<HTMLTextAreaElement>('[aria-label="聊天内容"]')?.focus();}}><Icon name={m.role==='user'?'edit':'retry'}/></button>}</div><small>{when(m.created)}{m.base && ` · 项目 ${m.base.slice(0,8)}`}</small></div>)}
            {activeTask && <div className="message assistant"><span className="message-label">{activeTask.release?.model || 'AI'} · {labels[activeTask.state]}</span><ChatActivity task={activeTask}/><div className="bubble"><ChatMarkdown text={activeTask.partial || '正在处理…'}/></div><button className="text-button" onClick={() => void act(async () => { await api(`/tasks/${activeTask.id}/cancel`, 'POST', {}); await refresh(); })}>停止生成</button></div>}
            <div ref={lastMessage}/>
          </div>
          {showLatest&&<button className="chat-jump-latest" title="回到最新消息" aria-label="回到最新消息" onClick={()=>{stickToBottom.current=true;setShowLatest(false);lastMessage.current?.scrollIntoView({block:'end',behavior:'smooth'});}}><Icon name="down"/></button>}
          <div className="composer-seat">
          <QueueDock tasks={queuedTasks} onEdit={async(id,prompt)=>{await api(`/tasks/${id}`,'PATCH',{prompt});await refresh();}} onCancel={async id=>{await api(`/tasks/${id}/cancel`,'POST',{});await refresh();}}/>
          <ChatComposer prompt={prompt} onPrompt={updatePrompt} workflow={workflow} onWorkflow={setWorkflow} onSend={delivery=>act(()=>send(delivery))} onStop={()=>void act(stopChat)} onNew={()=>void act(newChat)} running={!!activeTask} stopping={activeTask?.state==='cancel_requested'} blocked={busy||!!pending} readOnly={readOnly||!session} uploadBusy={attachmentBusy} onUpload={()=>attachmentInput.current?.chooseFiles()} onFiles={files=>attachmentInput.current?.addFiles(files)} attachments={selected.map(path=>project?.files.find((f:Item)=>f.path===path)??{path})} onRemove={path=>{setSelected(prev=>prev.filter(p=>p!==path));draftVersion.current++;}} project={projectId} options={project?.chat??{}} modelId={mySession?.modelId??project?.chat?.models?.[0]?.id??''} permission={mySession?.permission??project?.chat?.permissions?.[0]??'read-only'} skillId={mySession?.skillId??project?.chat?.defaultSkillId??''} onSettings={v=>void act(()=>sessionSettings(v))} video={!!videoEnabled} image={!!status?.capabilities?.includes('image-generation')} scripts={!!project?.release.allowScripts} draftKey={draftKey}>
            {status?.capabilities?.includes('project-attachments')&&<AttachmentUpload ref={attachmentInput} key={projectId+'-'+session} compact api={api} session={session} disabled={readOnly} onUploaded={uploaded} onBusy={updateUploadBusy}/>}
            {pending&&<div className="submission-status" role="status">{busy?'正在确认提交…':'提交结果待确认。'}{!busy&&<><button className="text-button" onClick={()=>void act(retrySubmission)}>核对提交</button><button className="text-button" onClick={()=>void act(closeUnacceptedSubmission)}>结束未受理提交</button></>}</div>}
          </ChatComposer><div className="composer-hint">{mySession?.archived?'已归档，可在会话菜单中恢复':readOnly?'正在查看成员会话':'Enter 发送 · Shift + Enter 换行'}</div>
          {videoEnabled&&['pickup','image'].includes(workflow)&&<MediaModelDirectory api={api} kind={workflow==='image'?'image':'video'}/>}
          {workflow==='image'&&<ImageReferences key={projectId} api={api} uploadFromComposer={status?.capabilities?.includes('project-attachments')} onReference={id=>{setPrompt(s=>/^参考图\s*[:：]/m.test(s)?s.replace(/^(参考图\s*[:：].*)$/m,'$1，'+id):s+'\n参考图：'+id);draftVersion.current++;}}/>}

          </div>
        </section>
        {filesOpen && <aside className="context-panel"><div className="panel-heading"><h3>项目资料</h3><button className="icon-button" title="关闭资料面板" onClick={() => setFilesOpen(false)}>×</button></div><p className="muted small">项目版本 {project?.revision?.slice(0,8)}</p>{project?.files.map((f: Item) => <button className="project-file-preview" key={f.path} title={f.path} onClick={()=>{setFilePath(f.path);setPage('files');}}>▤ {displayPath(f.path)}</button>)}<p className="context-note">智能体会按任务自动查找和读取本项目资料，无需选择文件。删除和修改原内容须管理员审核。</p></aside>}
      </div>}
  {directNativeSurface&&<div className="native-empty" role="status"><strong>正在打开项目聊天…</strong><span>{directSurfaceError||'保留当前项目、聊天记录与原生会话能力。'}</span>{directSurfaceError&&<button onClick={()=>setDirectSurfaceAttempt(n=>n+1)}>重新连接</button>}</div>}
  {!embedded&&nativeEnabled&&workspaceOpened&&!directNativeSurface&&<ProjectStudio updateVersion={studioUpdate} agentContext={{model:mySession?.modelId,skill:mySession?.skillId,version:project?.revision,scope:'当前项目资料',tools:project?.release?.allowScripts?'脚本与工具按策略开放':'按服务器策略'}} pagedContent={!!status?.capabilities?.includes('project-content-pages')} api={api} projectId={projectId} project={project} plans={pickups} visible={['native','files','reviews'].includes(page)} filesRequest={['files','reviews'].includes(page)?page+':'+filePath+':'+projectPanelRequest:undefined} renderFiles={(visible,focusChat)=>page==='reviews'?<><button className="text-button" onClick={()=>setPage('files')}>← 返回项目文件</button><ReviewCenter changes={changes} change={change} admin={admin} onSelect={id=>{setChangeId(id);setDetailAttempt(n=>n+1);}} onReload={()=>{setDetailAttempt(n=>n+1);void refresh();}} onApprove={async()=>{if(!change)return;await api(`/changes/${change.id}/approve`,'POST',{digest:change.digest});await refresh();setDetailAttempt(n=>n+1);setNotice('成果已发布到项目。');}} onReject={async()=>{if(!change)return;await api(`/changes/${change.id}/reject`,'POST',{digest:change.digest});await refresh();setDetailAttempt(n=>n+1);}}/></>:<ProjectFiles key={user.id+':'+projectId} api={api} projectId={projectId} projects={projectList} revision={project?.revision} visible={visible} updateVersion={studioUpdate} requestedPath={filePath} admin={admin} session={sessions.find(s=>s.owner===user.id&&s.fixed)?.id??''} canUpload={!!status?.capabilities?.includes('project-attachments')} onUploaded={uploaded} onBusy={updateUploadBusy} onProject={id=>{switchProject(id);setPage('files');}} onSettings={()=>openSettings('workspaces')} onChange={id=>{setChangeId(id);setPage('reviews');void refresh();}} onReference={(text,name)=>{queueNativeReference(text,name);focusChat();}}/>} references={references.filter(r=>r.project===projectId&&(r.member??'')===(nativeMember??''))} onReference={(text,name)=>queueNativeReference(text,name)} onRemoveReference={id=>setReferences(list=>list.filter(r=>r.id!==id))} agent={<NativeWorkspace key={user.id+':'+user.role} project={projectId} member={nativeMember} visible={['native','files','reviews'].includes(page)} onFiles={()=>{saveDraft();setProjectPanelRequest(n=>n+1);setPage('files');}} api={api} command={nativeCommand} references={references} onReferenceInserted={id=>setReferences(list=>list.filter(r=>r.id!==id))} onReferenceTarget={(project,member,session)=>setReferenceTarget(old=>old?.project===project&&old.member===member&&old.session===session?old:{project,member,session})} onProject={(id,panel,session,member,newChat,historyOnly)=>{openProject(id);setNativeMember(!historyOnly&&member&&member!==user.id?member:undefined);if(session)setNativeCommand({id:Date.now(),type:'session',session,member,project:id,historyOnly});else if(newChat)setNativeCommand({id:Date.now(),type:'new',project:id});else if(panel)setNativeCommand({id:Date.now(),type:'panel',section:panel,project:id});}} onReview={id=>{setChangeId(id);setPage('reviews');void refresh();}}/>}/>}
  {page === 'files' && (embedded||!nativeEnabled||!workspaceOpened) && <div className="content"><ProjectFiles key={user.id+':'+projectId} api={api} projectId={projectId} projects={projectList} revision={project?.revision} visible updateVersion={studioUpdate} requestedPath={filePath} admin={admin} session={sessions.find(s=>s.owner===user.id&&s.fixed)?.id??''} canUpload={!!status?.capabilities?.includes('project-attachments')} onUploaded={uploaded} onBusy={updateUploadBusy} onProject={id=>{switchProject(id);setPage('files');}} onSettings={()=>openSettings('workspaces')} onChange={id=>{setChangeId(id);setPage('reviews');void refresh();}} onReference={text=>{if(embedded){window.parent.postMessage({type:'team-tools-draft',text},location.origin);return;}setPrompt(p=>p+'\n'+text);setPage('chat');draftVersion.current++;}}/></div>}
  {page === 'tasks' && <MemberTaskCenter api={api} user={user} onOpen={t=>{if(embedded){window.parent.postMessage({type:'team-tools-session',project:t.project,session:t.session,member:t.owner},location.origin);return;}if(t.project!==projectId)switchProject(t.project);setNativeMember(t.owner&&t.owner!==user.id?t.owner:undefined);setPage('native');setNativeCommand({id:Date.now(),type:'session',session:t.session,member:t.owner,project:t.project});}}/>}
  {page === 'reviews' && (embedded||!nativeEnabled||!workspaceOpened) && <><button className="text-button" onClick={()=>setPage('files')}>← 返回项目文件</button><ReviewCenter changes={changes} change={change} admin={admin} onSelect={id=>{setChangeId(id);setDetailAttempt(n=>n+1);}} onReload={()=>{setDetailAttempt(n=>n+1);void refresh();}} onApprove={async()=>{if(!change)return;await api(`/changes/${change.id}/approve`,'POST',{digest:change.digest});await refresh();setDetailAttempt(n=>n+1);setNotice('成果已发布到项目。');}} onReject={async()=>{if(!change)return;await api(`/changes/${change.id}/reject`,'POST',{digest:change.digest});await refresh();setDetailAttempt(n=>n+1);}}/></>}
  {page==='admin'&&admin&&<div className="content"><button className="secondary" onClick={()=>openSettings()}>打开工作台设置</button></div>}
  </main></div>;
}
createRoot(document.getElementById('root')!).render(location.pathname.includes('/team-settings/')?(new URLSearchParams(location.search).has('view')?<App embedded/>:<EmbeddedSettings/>):<DesktopRoot><App/></DesktopRoot>);
