import React,{useEffect,useState} from 'react';
import {AttachmentUpload,FileLink,projectFileURL,displayPath} from './attachments';
import {ProjectFileTree} from './deferred-panels';
import {SharedPickupResult} from './pickups';
import {useProjectRead} from './use-project-read';
type Item=Record<string,any>;type Api=(path:string,method?:string,body?:any)=>Promise<any>;

// The standalone compatibility route and the project/chat pane share this view
// and the existing upload, preview, publication and download services.
export function ProjectFiles({api,projectId,projects,revision,visible,updateVersion=0,requestedPath='',admin,session,canUpload,onUploaded,onBusy,onProject,onSettings,onChange,onReference}:{api:Api;projectId:string;projects:Item[];revision?:string;visible:boolean;updateVersion?:number;requestedPath?:string;admin:boolean;session:string;canUpload:boolean;onUploaded:(item:Item)=>Promise<void>;onBusy:(busy:boolean)=>void;onProject:(id:string)=>void;onSettings:()=>void;onChange:(id:string)=>void;onReference:(text:string,name:string)=>void}){
 const [project,setProject]=useState<Item>(),[path,setPath]=useState(requestedPath),[file,setFile]=useState<Item>(),[error,setError]=useState(''),[readError,setReadError]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0),[loading,setLoading]=useState(false);
 useEffect(()=>{if(requestedPath)setPath(requestedPath);},[requestedPath]);
 const scoped=(endpoint:string)=>endpoint+(endpoint.includes('?')?'&':'?')+'project='+encodeURIComponent(projectId);
 useProjectRead<Item>({identity:api,scope:visible?projectId:undefined,refresh:JSON.stringify([revision,updateVersion,reload]),read:()=>api(scoped('/project')),commit:value=>{setProject(value);setError('');},fail:e=>setError(e.message),busy:setLoading});
 const selected=path,version=project?.revision;
 useProjectRead<Item>({identity:api,scope:visible&&selected&&version?JSON.stringify([projectId,selected,version]):undefined,refresh:String(reload),
  read:()=>api(scoped('/file?'+new URLSearchParams({path:selected,revision:version}))),commit:value=>{setFile(value);setReadError('');},fail:e=>setReadError(e.message)});
 async function act(fn:()=>Promise<void>){if(busy)return;setBusy(true);setError('');try{await fn();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 const current=file?.path===selected&&file.revision===version?file:undefined;
 return <section className="project-files" aria-label="项目文件管理">
  <div className="section-heading"><div><h3>项目文件</h3><p className="muted">{project?.name??projects.find(p=>p.id===projectId)?.name} · 原件、资料与当前聊天在同一项目中。</p></div><div className="project-files-actions"><button className="secondary" disabled={loading} onClick={()=>setReload(n=>n+1)}>刷新文件</button>{admin&&<><button className="secondary" onClick={onSettings}>选择本地项目文件夹</button><button className="secondary" disabled={busy} onClick={()=>void act(async()=>{const c=await api(scoped('/admin/import-diff'),'POST',{});onChange(c.id);})}>检测外部变更</button></>}</div></div>
  {error&&<p className="error" role="alert">{error}。已有文件和聊天保留，可刷新重试。</p>}
  {canUpload&&<details className="file-upload-panel"><summary>上传项目文件</summary><AttachmentUpload api={api} session={session} onUploaded={async item=>{await onUploaded(item);setReload(n=>n+1);}} onBusy={onBusy}/></details>}
  <div className="split project-files-layout"><ProjectFileTree projects={projects} current={projectId} loading={!project&&loading} files={project?.files??[]} selected={selected} onProject={onProject} previewURL={p=>projectFileURL(projectId,p,version)} onFile={p=>{setPath(p);setReadError('');}}/>
   <div className="card preview">{readError&&<p className="error" role="alert">读取文件未完成：{readError}<button className="text-button" onClick={()=>setReload(n=>n+1)}>重新加载</button></p>}{current?<>
    <h3 title={current.path}>{displayPath(current.path)}</h3><p className="small muted">预览版本 {current.revision.slice(0,8)}</p><FileLink project={projectId} path={current.path} revision={current.revision}/>
    <button className="text-button" onClick={()=>onReference(['【当前项目文件】','项目：'+projectId,'项目文件：'+current.path,'文件版本：'+current.revision].join('\n'),displayPath(current.path))}>引用到当前聊天</button>
    <button className="text-button" disabled={busy} onClick={()=>void act(async()=>{const c=await api(scoped('/changes'),'POST',{base:current.revision,writes:{[current.path]:null}});onChange(c.id);})}>申请管理员删除</button>
    {current.mime?.startsWith('image/')&&<><img className="project-image" src={projectFileURL(projectId,current.path,current.revision)} alt={current.path}/><button className="text-button" disabled={busy} onClick={()=>void act(async()=>{const m=await api(scoped('/file-reference'),'POST',{path:current.path});onReference(['【当前项目图片参考】','项目：'+projectId,'项目文件：'+current.path,'文件版本：'+current.revision,'参考图：'+m.id].join('\n'),displayPath(current.path));})}>用作图片参考</button></>}
    <p className="small muted">{current.note}</p>{current.mime?.startsWith('video/')&&<video className="project-video" controls preload="metadata" src={projectFileURL(projectId,current.path,current.revision)}/>}<SharedPickupResult file={current}/><pre>{current.content}</pre>
    {current.nextOffset!=null&&<button disabled={busy} onClick={()=>void act(async()=>{const next=await api(scoped('/file?'+new URLSearchParams({path:current.path,revision:current.revision,offset:String(current.nextOffset)})));setFile(old=>old&&old.path===next.path&&old.revision===next.revision?{...next,content:old.content+next.content}:old);})}>继续读取正文</button>}
   </>:<div className="empty">{selected?(loading?'正在读取项目文件…':project?.files?.some((f:Item)=>f.path===selected)?'正在加载当前版本…':'此文件不在当前发布版本中。'):'选择左侧文件查看内容'}</div>}</div>
  </div>
 </section>;
}
