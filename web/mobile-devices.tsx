import React,{useEffect,useState} from 'react';
type Api=(path:string,method?:string,body?:any)=>Promise<any>;
export function MobileDevices({api}:{api:Api}) {
 const [items,setItems]=useState<any[]>([]),[name,setName]=useState('我的手机'),[code,setCode]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function load(){setItems((await api('/mobile/devices')).items);}
 useEffect(()=>{void load().catch(e=>setError(e.message));return()=>setCode('');},[]);
 async function action(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();await load();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 return <><h2>手机连接</h2><p className="muted">使用当前工作台账号配对 HAPI。配对仅代表登录，不会新建聊天或提交任务。C 版直接使用工作台登录。</p>
 <form onSubmit={e=>{e.preventDefault();void action(async()=>{const v=await api('/mobile/devices','POST',{label:name});setCode(v.token);});}}><label>设备名称<input value={name} maxLength={80} required onChange={e=>setName(e.target.value)}/></label><button className="primary" disabled={busy}>生成我的配对码</button></form>
 {code&&<div className="card"><p>将配对码填入 H 版的访问令牌框；该码仅在此显示一次。</p><input aria-label="手机配对码" type="password" readOnly value={code}/><button onClick={()=>void navigator.clipboard.writeText(code).catch(()=>setError('请选中配对码后复制'))}>复制配对码</button><button onClick={()=>setCode('')}>收起</button></div>}
 {items.map(i=><div className="user-row" key={i.id}><div><b>{i.label}</b><small>{i.revoked?'已解除配对':'有效期至 '+new Date(i.expires).toLocaleString()}</small></div>{!i.revoked&&<button disabled={busy} onClick={()=>void action(async()=>{await api('/mobile/devices/revoke','POST',{id:i.id});setCode('');})}>解除配对</button>}</div>)}
 {error&&<p role="alert">{error}</p>}</>;
}
