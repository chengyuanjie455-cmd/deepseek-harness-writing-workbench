import React,{useState,useEffect,useRef} from 'react';
import {HostFolderPicker} from './host-folder-picker';
import {newRequestId} from './request-id';
type Item=Record<string,any>;type Api=(path:string,method?:string,body?:unknown)=>Promise<any>;
export function ProjectCreateMember({api,onCreated}:{api:Api,onCreated:(id:string)=>void}) {
 const [name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState<{name:string;requestId:string}>(),locked=useRef(false);
 async function create(){
  if(locked.current)return;locked.current=true;setBusy(true);setError('');
  const request=pending??{name:name.trim(),requestId:newRequestId()};setPending(request);
  try{const project=await api('/projects','POST',request);setPending(undefined);setName('');onCreated(project.id);}
  catch(e:any){if(!e.uncertain&&(!e.status||e.status<500))setPending(undefined);setError(e.uncertain||e.status>=500?'创建结果尚未确认，点击“核对创建结果”恢复同一个项目。':e.message);}
  finally{locked.current=false;setBusy(false);}
 }
 return <section className="card admin-card" aria-label="新建项目"><h3>新建项目</h3><p className="small muted">主机自动建立独立文件夹。项目供团队使用，每个人的聊天独立保存。</p><form onSubmit={e=>{e.preventDefault();void create();}}><label>项目名称<input required maxLength={80} value={name} disabled={busy||!!pending} onChange={e=>setName(e.target.value)}/></label><button className="primary" disabled={busy||!name.trim()}>{busy?'正在创建…':pending?'核对创建结果':'创建项目'}</button></form>{error&&<p className="error" role="alert">{error}</p>}</section>;
}
export function ProjectScopeAdmin({api,onBound}:{api:Api,onBound:()=>Promise<void>}) {
 const [active,setActive]=useState<Item>(),[path,setPath]=useState(''),[name,setName]=useState(''),[preview,setPreview]=useState<Item>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 async function load(){const c=await api('/admin/project-directory');setActive(c);setPath(c.path);setName(c.name);}
 useEffect(()=>{void load().catch(e=>setError(e.message));},[]);
 async function act(fn:()=>Promise<void>){if(busy)return;setBusy(true);setError('');setNotice('');try{await fn();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 return <section className="card admin-card"><span className="section-label">当前项目</span><h3>目录与资料同步</h3><p className="small muted">管理「{active?.name??'当前项目'}」的名称和来源目录。更换目录前，请核对预览中的新增、修改和移除项。</p>
 <form onSubmit={e=>{e.preventDefault();void act(async()=>setPreview(await api('/admin/project-directory/preview','POST',{path,name})));}}>
 <label>项目名称<input value={name} required maxLength={80} onChange={e=>{setName(e.target.value);setPreview(undefined);}}/></label>
 <HostFolderPicker api={api} value={path} mode="bind" disabled={busy} onChange={p=>{setPath(p);setPreview(undefined);}}/><p className="small muted">选择主机文件夹后先预览差异。已批准的成果会同步到该目录，外部修改仍需检测后导入。</p><button disabled={busy||!path||!name.trim()} className="secondary">预览目录与差异</button></form>
 {preview&&<div className="directory-preview"><p><b>待绑定：{preview.name}</b></p><p className="small">{preview.path} · {preview.files} 个文件 · {(preview.bytes/1024).toFixed(1)} KiB</p><ul>{preview.diff.map((d:Item)=><li key={d.path}>{({added:'新增',modified:'修改',removed:'从当前发布版本移除'} as Item)[d.action]}：{d.path}</li>)}</ul>{!preview.diff.length&&<p>与当前发布内容一致。</p>}<button className="primary" disabled={busy} onClick={()=>void act(async()=>{await api('/admin/project-directory/bind','POST',{previewId:preview.id,digest:preview.digest});setPreview(undefined);await load();await onBound();setNotice('项目目录已绑定，成员继续在各自固定聊天中协作。');})}>确认目录及以上差异，绑定项目</button></div>}
 {notice&&<p role="status">{notice}</p>}{error&&<p className="error" role="alert">{error}</p>}
 </section>;
}

export function ProjectCreateAdmin({api,onCreated,autoSelectFolder=false}:{api:Api,onCreated:(id:string)=>void,autoSelectFolder?:boolean}){
 const [name,setName]=useState(''),[path,setPath]=useState(''),[preview,setPreview]=useState<Item>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function act(fn:()=>Promise<void>){if(busy)return;setBusy(true);setError('');try{await fn();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 return <section className="card admin-card" aria-label="添加工作区"><span className="section-label">本地工作区</span><h3>添加本地项目文件夹</h3><p className="small muted">选择主机文件夹，预览资料，确认后自动同步全部成员。每位成员拥有独立聊天。</p>
 <form onSubmit={e=>{e.preventDefault();void act(async()=>setPreview(await api('/admin/projects/preview','POST',{name,path})));}}>
 <label>工作区名称<input required maxLength={80} value={name} onChange={e=>{setName(e.target.value);setPreview(undefined);}}/></label><HostFolderPicker api={api} value={path} mode="create" disabled={busy} autoSelect={autoSelectFolder} onChange={p=>{setPath(p);if(!name.trim())setName(p.split('/').filter(Boolean).at(-1)??'');setPreview(undefined);}}/>
 <details className="import-limits"><summary>导入范围与容量</summary><p className="small muted">目录不能与其他项目重叠。支持任意类型原件，单文件 256 MiB、总量 8 GiB 内；可编辑文本合计 16 MiB。成员访问服务器上的已发布资料，不会自动复制整个文件夹到成员电脑。</p></details><button className="primary" disabled={busy||!path||!name.trim()}>预览文件夹</button></form>
 {preview&&<div className="directory-preview"><b>{preview.name}</b><p>{preview.files} 个文件 · {(preview.bytes/1024).toFixed(1)} KiB · 全部成员可见</p><ul style={{maxHeight:220,overflowY:'auto'}}>{Object.keys(preview.manifest).map(p=><li key={p}>{p}</li>)}</ul><button className="primary" disabled={busy} onClick={()=>void act(async()=>{const p=await api('/admin/projects','POST',{previewId:preview.id,digest:preview.digest});onCreated(p.id);})}>添加工作区并同步成员</button></div>}{error&&<p role="alert" className="error">{error}</p>}</section>;
}
