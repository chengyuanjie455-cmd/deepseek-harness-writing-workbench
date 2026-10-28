import {AccountHostAccess} from './account-host-access';
import {MobileDevices} from './mobile-devices';
import React,{useEffect,useState,useCallback} from 'react';
import {ApiClient} from './api';
import {addWorkspaceFromNativeFolder} from './native-workspace-folder';
import {useNativeSettingsTheme} from './settings-theme';
import {ChatAdmin} from './deferred-panels';
import {MemberModelPolicy} from './deferred-panels';
import {VideoAdmin} from './pickups';
import {BillingAdmin} from './deferred-panels';
import {OperationsAdmin} from './deferred-panels';
import {ProjectCreateAdmin,ProjectCreateMember,ProjectScopeAdmin} from './project-scope';
import {NativePolicy} from './native-harness';
type Item=Record<string,any>;type Api=(path:string,method?:string,body?:any)=>Promise<any>;
export function TeamSettingsContent({section,api,user,project,onProject,autoSelectFolder=false}:{section:string;api:Api;user:Item;project:Item;onProject:(id:string)=>void;autoSelectFolder?:boolean}){
 const [modelTab,setModelTab]=useState('chat');
 if(section==='mobile')return <MobileDevices api={api}/>;
 if(section==='workspaces')return <><h2>工作区</h2>{project.canCreateProjects?<ProjectCreateMember api={api} onCreated={onProject}/>:user.role!=='admin'&&<p className="muted">当前后台尚未启用成员新建项目。</p>}{user.role==='admin'&&<><ProjectCreateAdmin api={api} onCreated={onProject} autoSelectFolder={autoSelectFolder}/><details className="settings-advanced"><summary>当前工作区的文件夹与同步</summary><ProjectScopeAdmin api={api} onBound={async()=>{}}/></details></>}</>;
 if(user.role!=='admin')return section==='models'?<AvailableModels api={api}/>:<p className="muted">团队配置由管理员维护。个人偏好和插件设置可直接使用原生设置。</p>;
 return <>
  {section==='models'&&<><h2>模型</h2><p className="muted">聊天模型向所有成员开放，可直接选择；此处维护 API 连接和生成模型。</p><nav className="admin-subtabs" aria-label="模型分类">{[['chat','聊天模型'],['media','视频与图片'],['access','生成模型范围']].map(([id,name])=><button key={id} aria-pressed={modelTab===id} onClick={()=>setModelTab(id)}>{name}</button>)}</nav>{modelTab==='chat'&&<ChatAdmin api={api} onChanged={async()=>{}}/>}{modelTab==='media'&&<VideoAdmin api={api} revision={project.revision} panels={['channels','video','image','assets']}/>} {modelTab==='access'&&<MemberModelPolicy api={api}/>}</>}
  {section==='members'&&<><Members api={api} me={user}/><AccountHostAccess api={api}/></>}
  {section==='billing'&&<BillingAdmin api={api}/>}
  {section==='operations'&&<OperationsAdmin api={api} visible={true} onBilling={()=>window.parent.postMessage({type:'team-settings-section',section:'billing'},location.origin)}/>}
  {section==='prompts'&&<><h2>提示词</h2><p className="muted">补抽模板只需剧本片段和补抽意见。智能体会结合当前聊天，自动调用对应模型的分镜技能。</p><VideoAdmin api={api} revision={project.revision} panels={['templates']}/></>}
  {section==='scope'&&<NativePolicy api={api}/>}
 </>;
}
function Members({api,me}:{api:Api;me:Item}){
 const [users,setUsers]=useState<Item[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=()=>api('/admin/users').then(setUsers);
 useEffect(()=>{void load().catch(e=>setError(e.message));},[]);
 async function act(fn:()=>Promise<void>){if(busy)return;setBusy(true);setError('');try{await fn();await load();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 return <><h2>成员</h2><p className="muted">账号统一管理，各项目的会话与上下文独立保留。</p><div className="card admin-card">{users.map(u=><div className="user-row" key={u.id}><span className="avatar">{u.name[0]}</span><div><b>{u.name}</b><small>{u.username} · {u.role==='admin'?'管理员':'成员'} · {u.active?'正常':'已停用'}</small></div>{u.id!==me.id&&<button disabled={busy} onClick={()=>void act(async()=>{await api(`/admin/users/${u.id}`,'PATCH',{active:!u.active});})}>{u.active?'停用':'启用'}</button>}</div>)}<details><summary>添加成员</summary><form onSubmit={e=>{e.preventDefault();const form=e.currentTarget,body=Object.fromEntries(new FormData(form));void act(async()=>{await api('/admin/users','POST',body);form.reset();});}}><label>账号<input name="username" required minLength={1} maxLength={40} placeholder="支持中文账号"/></label><label>显示名称<input name="name" required/></label><label>初始密码<input name="password" type="password" required minLength={12} autoComplete="new-password"/></label><label>角色<select name="role"><option value="member">成员</option><option value="admin">超级管理员</option></select></label><button disabled={busy} className="primary">创建账号</button></form></details></div>{error&&<p role="alert">{error}</p>}</>;
}
function AvailableModels({api}:{api:Api}){
 const [data,setData]=useState<Item>(),[error,setError]=useState('');useEffect(()=>{void Promise.all([api('/chat-options'),api('/video-models'),api('/image-models')]).then(([chat,video,image])=>setData({chat:chat.models??[],video,image})).catch(e=>setError(e.message));},[]);
 return <><h2>可用模型</h2><p>在聊天框的模型菜单中切换聊天模型；视频和图片模型可直接在消息里指定。</p>{data&&['chat','video','image'].map(k=><section className="card admin-card" key={k}><h3>{({chat:'聊天',video:'视频',image:'图片'} as Item)[k]}模型</h3>{data[k].map((m:Item)=><p key={m.id}>{m.name??m.id}</p>)}{!data[k].length&&<p className="muted">当前项目暂无开放模型</p>}</section>)}{error&&<p role="alert">{error}</p>}</>;
}
function NativeWorkspaceFolder({api,error,user}:{api:Api;error:string;user?:Item}){
 useEffect(()=>{
  const controller=new AbortController();
  const reply=(result:Record<string,unknown>)=>{if(!controller.signal.aborted)window.parent.postMessage({type:'team-workspace-folder-result',...result},location.origin);};
  const timer=setTimeout(()=>{
   if(error){reply({error});return;}
   if(!user)return;
   if(user.role!=='admin'){reply({error:'请由管理员添加项目文件夹'});return;}
   void addWorkspaceFromNativeFolder(api,controller.signal).then(reply).catch(e=>reply({error:e.message}));
  },0);
  return()=>{clearTimeout(timer);controller.abort();};
 },[api,user,error]);
 return null;
}
export function EmbeddedSettings(){
 useNativeSettingsTheme();
 const [apiClient]=useState(()=>{const a=new ApiClient();a.projectId=location.pathname.split('/')[2]?.split('~')[0];return a;}),[data,setData]=useState<Item>(),[error,setError]=useState('');const api=useCallback((path:string,method?:string,body?:any)=>apiClient.call(path,method,body),[apiClient]),section=new URLSearchParams(location.search).get('panel')??'models';
 useEffect(()=>{let live=true;void Promise.all([api('/me'),api('/project')]).then(([me,project])=>{if(live)setData({user:me.user,project});}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;apiClient.invalidate();};},[]);
 if(new URLSearchParams(location.search).get('action')==='add-workspace')return <NativeWorkspaceFolder api={api} user={data?.user} error={error}/>;
 return <div className="embedded-settings" data-section={section}>{error?<p className="error" role="alert">{error}</p>:data?<TeamSettingsContent section={section} api={api} user={data.user} project={data.project} autoSelectFolder={new URLSearchParams(location.search).get('selectFolder')==='1'} onProject={id=>window.parent.postMessage({type:'team-settings-project',project:id},location.origin)}/>:<p role="status">正在加载设置…</p>}</div>;
}
