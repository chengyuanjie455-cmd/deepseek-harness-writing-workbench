import React,{useMemo,useState} from 'react';
import {ProjectCreateAdmin,ProjectCreateMember} from './project-scope';
import {StudioIcon} from './project-studio';
type Row=Record<string,any>;type Api=(path:string,method?:string,body?:any)=>Promise<any>;
export function ProjectHome({projects,loading,user,api,onOpen,onRefresh}:{projects:Row[];loading:boolean;user:Row;api:Api;onOpen:(id:string)=>void;onRefresh:()=>void}){
 const [q,setQ]=useState(''),[create,setCreate]=useState<'empty'|'import'>(),[created,setCreated]=useState(false),[sort,setSort]=useState<'recent'|'name'>('recent');
 const shown=useMemo(()=>projects.filter(p=>String(p.name).toLocaleLowerCase().includes(q.trim().toLocaleLowerCase())).sort((a,b)=>sort==='name'?String(a.name).localeCompare(String(b.name),'zh-CN'):(Number(b.updatedAt??b.updated??b.created??0)-Number(a.updatedAt??a.updated??a.created??0))),[projects,q,sort]);
 const done=(id:string)=>{setCreate(undefined);setCreated(true);onRefresh();onOpen(id);};
 return <div className="studio-home">
  <nav className="studio-rail" aria-label="项目空间导航"><span className="studio-monogram" aria-label="哇唔哇唔">W</span><button className="studio-rail-new" aria-label="新建项目" onClick={()=>setCreate('empty')}><StudioIcon name="plus"/></button><button className="active" aria-label="全部项目" onClick={()=>{setQ('');setCreate(undefined);}}><StudioIcon name="folder"/></button><span className="studio-rail-line"/><span className="studio-rail-caption">工作空间</span></nav>
  <section className="studio-home-content">
   <header className="studio-home-heading"><div><p className="studio-eyebrow">WORKSPACE</p><h1>你的项目</h1><p>从剧本开始，让每一集的创作井然有序。</p></div><button className="studio-primary" onClick={()=>setCreate('empty')}><StudioIcon name="plus"/>新建项目</button></header>
   <div className="studio-home-toolbar"><span>全部项目 <b>{projects.length}</b></span><label className="studio-search"><StudioIcon name="search"/><input aria-label="搜索项目" placeholder="搜索项目…" value={q} onChange={e=>setQ(e.target.value)}/></label><label className="studio-home-sort">排序<select aria-label="项目排序" value={sort} onChange={e=>setSort(e.target.value as 'recent'|'name')}><option value="recent">最近更新</option><option value="name">项目名称</option></select></label>{user.role==='admin'&&<button className="studio-quiet" onClick={()=>setCreate('import')}><StudioIcon name="folder"/>导入主机文件夹</button>}</div>
   {created&&<p className="studio-feedback" role="status">项目已创建，团队成员可在项目列表中访问。</p>}
   <div className="studio-project-grid" aria-label="项目文件夹">
    {shown.map((p,i)=>{const files=Array.isArray(p.files)?p.files.length:undefined;const health=String(p.status??p.health??'').toLowerCase();const healthLabel=health.includes('error')||health.includes('fail')?'需检查':health.includes('pending')||health.includes('review')?'待审核':'可用';return <button key={p.id} className="studio-project-card" onClick={()=>onOpen(p.id)} aria-label={'打开项目：'+p.name}><div className={'studio-folder-cover tone-'+(i%4)}><StudioIcon name="folder"/><span>PROJECT</span><i aria-hidden="true">↗</i></div><div className="studio-project-copy"><strong>{p.name}</strong><span>剧本 · 分镜 · 资产 · 视频 · 剪辑</span><div className="studio-project-meta"><span className={'studio-health-dot '+(healthLabel==='可用'?'ready':healthLabel==='待审核'?'pending':'attention')} aria-label={'项目状态：'+healthLabel}/><small>{healthLabel}</small>{files!==undefined&&<small>{files} 个文件</small>}{p.revision&&<small title={String(p.revision)}>版本 {String(p.revision).slice(0,8)}</small>}</div></div></button>})}
    {!q&&<button className="studio-create-card" onClick={()=>setCreate('empty')}><StudioIcon name="plus"/><strong>创建一个新项目</strong><span>建立独立的项目文件夹</span></button>}
   </div>
   {loading&&<p role="status" className="studio-empty">正在读取项目文件夹…</p>}{!loading&&!shown.length&&<p className="studio-empty">{q?'没有找到这个项目。':'还没有项目，先创建一个项目文件夹。'}</p>}
   <p className="studio-home-footnote">项目资料由团队共享 · 每位成员的智能体聊天独立留存</p>
  </section>
  <div className="studio-dialog-backdrop" hidden={!create}>
   <section className="studio-create-dialog" role="dialog" aria-modal="true" aria-label="创建或导入项目"><header><span>{create==='import'?'导入项目':'新建项目'}</span><button className="studio-icon-button" aria-label="收起项目创建" onClick={()=>setCreate(undefined)}><StudioIcon name="close"/></button></header>
    <div hidden={create!=='empty'}><ProjectCreateMember api={api} onCreated={done}/></div>{user.role==='admin'&&<div hidden={create!=='import'}><ProjectCreateAdmin api={api} onCreated={done}/></div>}
   </section>
  </div>
 </div>;
}
