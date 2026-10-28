import React,{useEffect,useState} from 'react';
type Host={id:string;name:string};
type Entry={account:{id:string;username:string;name:string;role:string};hosts:Host[];defaultHost:string|null;pending:string[]};
type Api=(path:string,method?:string,body?:unknown)=>Promise<any>;
export function AccountHostAccess({api}:{api:Api}){
 const [data,setData]=useState<{hosts:Host[];accounts:Entry[]}>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=async()=>{setData(await api('/admin/account-host-access'));};
 useEffect(()=>{void load().catch(e=>setError(e.message));},[]);
 async function refresh(){if(busy)return;setBusy(true);setError('');try{await api('/admin/account-host-access/refresh','POST',{});await load();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 return <section className="card admin-card" aria-labelledby="account-host-title"><div className="ops-heading"><h3 id="account-host-title">账号可访问的主机</h3><button disabled={busy} onClick={()=>void refresh()}>同步已有账号</button></div><p className="muted">成员登录后自动连接默认或上次使用的获授权主机。管理员可访问全部主机，各主机数据独立保存。</p>{data?.accounts.map(entry=><AccountHostRow key={entry.account.id+':'+entry.hosts.map(h=>h.id).join(',')+':'+entry.defaultHost} entry={entry} hosts={data.hosts} api={api} changed={load}/>)}{error&&<p role="alert">{error}</p>}</section>;
}
function AccountHostRow({entry,hosts,api,changed}:{entry:Entry;hosts:Host[];api:Api;changed:()=>Promise<void>}){
 const admin=entry.account.role==='admin';
 const [selected,setSelected]=useState(entry.hosts.map(h=>h.id)),[preferred,setPreferred]=useState(entry.defaultHost??''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 function toggle(id:string){const next=selected.includes(id)?selected.filter(h=>h!==id):[...selected,id];setSelected(next);if(!next.includes(preferred))setPreferred(next[0]??'');}
 async function save(){if(busy)return;setBusy(true);setError('');try{await api('/admin/account-host-access','POST',{accountId:entry.account.id,hosts:selected,defaultHost:preferred||null});await changed();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 return <details className="settings-advanced"><summary>{entry.account.name} · {entry.account.username} <span className="muted">{admin?'全部主机':entry.hosts.map(h=>h.name).join('、')||'暂无主机权限'}</span></summary><fieldset disabled={busy||admin} style={{border:0,padding:'12px 0',display:'flex',gap:16,flexWrap:'wrap'}}><legend>允许访问</legend>{hosts.map(host=><label key={host.id} style={{display:'flex',alignItems:'center',gap:6}}><input type="checkbox" checked={selected.includes(host.id)} onChange={()=>toggle(host.id)} style={{width:'auto'}}/>{host.name}</label>)}</fieldset><label>默认连接<select value={preferred} onChange={e=>setPreferred(e.target.value)} disabled={busy||!selected.length}>{!selected.length&&<option value="">暂无可访问主机</option>}{hosts.filter(h=>selected.includes(h.id)).map(h=><option key={h.id} value={h.id}>{h.name}</option>)}</select></label>{entry.pending.length>0&&<p role="status">权限已保存，等待以下主机应用：{hosts.filter(h=>entry.pending.includes(h.id)).map(h=>h.name).join('、')}。后台会继续同步。</p>}<button className="primary" disabled={busy} onClick={()=>void save()}>{busy?'保存中…':'保存主机权限'}</button>{error&&<p role="alert">{error}</p>}</details>;
}
