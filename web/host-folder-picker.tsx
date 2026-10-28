import React,{useEffect,useRef,useState,useId} from 'react';
import {chooseNativeHostFolder} from './host-folder-bridge';
type Api=(path:string,method?:string,body?:unknown)=>Promise<any>;
type Folder={name:string,path:string};
type Listing={path:string,name:string,parent:string|null,folders:Folder[],shortcuts:Folder[],selectable:boolean,reason:string,truncated:boolean};

export function HostFolderPicker({api,value,onChange,mode,disabled=false,autoSelect=false}:{api:Api,value:string,onChange:(path:string)=>void,mode:'create'|'bind',disabled?:boolean,autoSelect?:boolean}) {
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const alive=useRef(true),generation=useRef(0),pending=useRef<AbortController|null>(null);const label=useId();
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;pending.current?.abort();};},[]);
  async function choose(){
    setError('');
    if(pending.current)return;setBusy(true);const attempt=++generation.current,controller=new AbortController();pending.current=controller;
    try{const result=await chooseNativeHostFolder(value,controller.signal);if(!alive.current||attempt!==generation.current)return;if(!result.supported){setOpen(true);return;}if(result.path)onChange(result.path);}
    catch(e:any){if(alive.current)setError(e.message);}
    finally{if(pending.current===controller)pending.current=null;if(alive.current)setBusy(false);}
  }
  useEffect(()=>{if(!autoSelect)return;const timer=setTimeout(()=>void choose(),0);return()=>clearTimeout(timer);},[autoSelect]);
  return <div className="host-folder-field"><span id={label} className="field-label">项目主机文件夹</span>
    <div className={`selected-folder ${value?'has-folder':''}`} aria-labelledby={label}><span className="folder-symbol" aria-hidden="true">▱</span><div><strong>{value?value.split('/').filter(Boolean).at(-1):'还未选择文件夹'}</strong><small>{value||'选择服务器上已有的项目文件夹'}</small></div></div>
    <div className="actions"><button type="button" className="secondary" disabled={disabled||busy} onClick={()=>void choose()}>{busy?'等待选择…':value?'更换主机文件夹':'选择主机文件夹'}</button></div>
    {error&&<p className="error" role="alert">{error}</p>}
    {open&&<FolderBrowser api={api} initialPath={value} mode={mode} onClose={()=>setOpen(false)} onSelect={path=>{onChange(path);setOpen(false);}}/>}
  </div>;
}

function FolderBrowser({api,initialPath,mode,onSelect,onClose}:{api:Api,initialPath:string,mode:string,onSelect:(path:string)=>void,onClose:()=>void}){
  const sequence=useRef(0);const heading=useId();
  const [listing,setListing]=useState<Listing>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState('');
  async function load(path='',q=''){
    const seq=++sequence.current;setBusy(true);setError('');
    try{const p=new URLSearchParams({mode});if(path)p.set('path',path);if(q)p.set('q',q);const next=await api('/admin/host-folders?'+p);if(seq===sequence.current)setListing(next);}
    catch(e:any){if(seq===sequence.current)setError(e.message);}
    finally{if(seq===sequence.current)setBusy(false);}
  }
  function navigate(path:string){setQuery('');void load(path);}
  useEffect(()=>{void load(initialPath);return()=>{sequence.current++;};},[]);
  return <section className="folder-dialog folder-browser-inline" role="region" aria-labelledby={heading}>
    <header className="folder-dialog-header"><div><span className="section-label">服务器上的文件夹</span><h2 id={heading}>选择项目文件夹</h2><p className="small muted">这里只选择目录，确认预览后才会导入项目资料。</p></div><button type="button" className="icon-button" aria-label="收起主机目录" onClick={onClose}>×</button></header>
    <div className="folder-browser"><nav aria-label="主机常用目录">{listing?.shortcuts.map(s=><button type="button" key={s.path} className={s.path===listing.path?'selected':''} disabled={busy} onClick={()=>navigate(s.path)}>{s.name}</button>)}{!listing&&<button type="button" disabled={busy} onClick={()=>navigate('')}>主机个人文件夹</button>}</nav>
      <div className="folder-browser-main"><div className="folder-location"><button type="button" className="secondary" disabled={busy||!listing?.parent} onClick={()=>navigate(listing!.parent!)}>↑ 上一级</button><span title={listing?.path}>{listing?.path??'正在读取主机目录…'}</span></div>
        <div className="folder-search"><input aria-label="查找文件夹" placeholder="按文件夹名称查找" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();void load(listing?.path,query);}}}/><button type="button" className="secondary" disabled={busy||!listing} onClick={()=>void load(listing?.path,query)}>查找</button></div>
        {error&&<p className="error" role="alert">{error}</p>}
        <div className="folder-list" aria-label="文件夹列表" aria-busy={busy}>{busy?<p className="muted" role="status">正在读取文件夹…</p>:listing?.folders.map(f=><button type="button" key={f.path} onClick={()=>navigate(f.path)} aria-label={'打开文件夹 '+f.name}><span aria-hidden="true">▱</span><strong>{f.name}</strong><span aria-hidden="true">›</span></button>)}{!busy&&listing&&!listing.folders.length&&!error&&<p className="empty">{query?'没有匹配的文件夹':'此处没有可浏览的子文件夹。可选择当前目录。'}</p>}</div>
        {listing?.truncated&&<p className="small muted">目录较多，仅展示前 500 个匹配项；请用名称查找，或使用主机系统选择窗口。</p>}
      </div>
    </div>
    <footer className="folder-dialog-footer"><div><b>{listing?.name??'尚未选择'}</b><p className="small muted">{listing?.reason||'选择后将返回项目表单，继续预览文件。'}</p></div><div className="actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button type="button" className="primary" disabled={busy||!!error||!listing?.selectable} onClick={()=>onSelect(listing!.path)}>选择此文件夹</button></div></footer>
  </section>;
}
