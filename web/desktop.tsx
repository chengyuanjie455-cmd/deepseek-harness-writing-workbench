import React, { useEffect, useState } from 'react';
import {AccountEntry} from './account-entry';
type Envelope = { ok: boolean; value?: any; error?: string };
export type DesktopBridge = {
  accountDirectory?():Promise<Envelope>; accountLogin?(body:{username:string;password:string}):Promise<Envelope>; accountOpen?(id:string):Promise<Envelope>; accountLogout?():Promise<Envelope>;
  openNativeHarness(url:string,options?:{projectSurface:boolean}):Promise<Envelope>;
  projectHome?(entry?:'projects'|'accounts'):Promise<Envelope>; projectRequest?(path:string,method:string,body?:unknown):Promise<Envelope>;
  selectHostFolder?(initialPath?:string): Promise<Envelope>;
  rememberStatus?(): Promise<Envelope>; restoreLogin?(): Promise<Envelope>; forgetLogin?(): Promise<Envelope>;
  saveProjectFile(spec:{project:string,path:string,revision?:string}): Promise<Envelope>;
  receivedMedia?(): Promise<Envelope>; saveMedia(id: string): Promise<Envelope>; info(): Promise<Envelope>; connect(origin: string, serverId?: string): Promise<Envelope>; disconnect(): Promise<Envelope>;
  restore(): Promise<Envelope>; discover(): Promise<Envelope>; request(path: string, method: string, body?: unknown): Promise<Envelope>;
  hostStatus(): Promise<Envelope>; hostStart(): Promise<Envelope>; hostStop(): Promise<Envelope>; loginStart(enabled: boolean): Promise<Envelope>;
};
declare global { interface Window { teamDesktop?: DesktopBridge } }
async function value(p: Promise<Envelope>) { const r = await p; if (!r.ok) throw new Error(r.error || '操作失败'); return r.value; }
export function DesktopRoot({ children }: { children: React.ReactNode }) {
  const bridge = window.teamDesktop;
  const [info, setInfo] = useState<any>(); const [connected, setConnected] = useState<any>(); const [address, setAddress] = useState('http://127.0.0.1:4317');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [servers, setServers] = useState<any[]>([]); const [host, setHost] = useState<any>();
  const [accountOpen,setAccountOpen]=useState(()=>new URLSearchParams(location.search).get('entry')==='accounts');
  useEffect(()=>{const open=()=>setAccountOpen(true);window.addEventListener('wawu-account-entry',open);return()=>window.removeEventListener('wawu-account-entry',open);},[]);
  const [autoRetry, setAutoRetry] = useState(true);
  const [initialized, setInitialized] = useState(false); const [relocated, setRelocated] = useState<any>();
  async function run(fn: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }
  function connectedTo(c:any) { setAddress(c.origin); setConnected(c);setRelocated(undefined);setInfo((i:any)=>({...i,saved:{origin:c.origin,serverId:c.status.serverId}})); }
  async function connect(origin: string, expected?: string) { connectedTo(await value(bridge!.connect(origin, expected))); }
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const i = await value(bridge.info()); if (cancelled) return; setInfo(i);
        const directory=bridge.accountDirectory?await value(bridge.accountDirectory()):null;
        if(directory?.defaultHost&&bridge.accountOpen){connectedTo(await value(bridge.accountOpen(directory.defaultHost)));return;}
        if (i.role === 'host') { const h = await value(bridge.hostStatus()); if (!cancelled) { setHost(h); if(h.managed) { if(i.saved?.origin&&i.saved.origin!==h.url) {setAddress(i.saved.origin);await connect(i.saved.origin,i.saved.serverId);} else {if(i.saved?.serverId && i.saved.serverId !== h.serverId) throw new Error('本地主机身份与已保存身份不同，请重新核对'); setInfo({...i,saved:{origin:h.url,serverId:h.serverId}});setAddress(h.url);await connect(h.url,h.serverId);} } else if(i.saved?.origin) {setAddress(i.saved.origin);await connect(i.saved.origin,i.saved.serverId);} } }
        else if (i.saved?.origin) { setAddress(i.saved.origin); const c=await value(bridge.restore());if(!cancelled)connectedTo(c); }
        else { const found=await value(bridge.discover()); if(!cancelled)setServers(found); }
      } catch (e: any) { if (!cancelled) { setError(e.message); void value(bridge.discover()).then(found=>{if(!cancelled)setServers(found);}).catch(()=>{}); } }
      finally { if(!cancelled){setBusy(false);setInitialized(true);} }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!bridge || connected || !autoRetry || !initialized || busy || !info?.saved?.origin) return;
    let ended=false, working=false;
    const timer=setInterval(async()=>{
      if(working)return;working=true;
      try {
        const c=await value(bridge.restore());
        if(!ended){connectedTo(c);setError('');}
      } catch(e:any) {if(!ended){setError(e.message);if(/身份|不兼容/.test(e.message))setAutoRetry(false);}}
      finally{working=false;}
    },5000);
    return()=>{ended=true;clearInterval(timer);};
  }, [connected, autoRetry, initialized, busy, info?.saved?.origin]);
  useEffect(()=>{
    if(!bridge || !connected || info?.role!=='member')return;
    let ended=false,working=false;
    const timer=setInterval(async()=>{
      if(working)return;working=true;
      try { await value(bridge.request('/api/status','GET'));if(!ended)setRelocated(undefined); }
      catch {try {const found=await value(bridge.discover());const candidate=found.find((s:any)=>s.serverId===connected.status.serverId&&s.origin!==connected.origin);if(!ended)setRelocated(candidate);}catch{} }
      finally{working=false;}
    },5000);
    return()=>{ended=true;clearInterval(timer);};
  },[connected,info?.role]);
  useEffect(() => {
    if (!bridge || info?.role !== 'host') return;
    let ended=false,working=false;
    const tick=async()=>{if(working)return;working=true;try{const h=await value(bridge.hostStatus());if(!ended)setHost(h);}catch{}finally{working=false;}};
    void tick(); const t=setInterval(tick,5000);return()=>{ended=true;clearInterval(t);};
  }, [info?.role]);
  if (!bridge) return <>{children}</>;
  const localSelected=!connected||(connected.origin===host?.url&&connected.status.serverId===host?.serverId);
  const controls=info?.role==='host'&&localSelected && <><span className="desktop-state">{host?.managed?'后台运行中':host?.running?'后台需核对':'后台未连接'}</span>
    {host?.managed&&host?.automaticLan&&<details><summary>成员统一网页地址</summary>{host.memberUrl?<><div>{host.memberUrl}</div><small>Wi-Fi 与有线共用；复制此地址给成员。</small></>:<div>统一名称暂不可用，请查看备用地址。</div>}<details><summary>备用 IP（排查连接时使用）</summary>{host.lanUrls?.length?host.lanUrls.map((u:string)=><div key={u}>{u}</div>):<div>尚未连接可用局域网</div>}</details></details>}
    <button disabled={busy||host?.running} onClick={()=>void run(async()=>{const h=await value(bridge.hostStart());setHost(h);await connect(h.url,h.serverId);})}>启动后台</button>
    <button disabled={busy||!host?.managed} onClick={()=>void run(async()=>{const h=await value(bridge.hostStop());if(!h.cancelled){setHost(h);await value(bridge.disconnect());setConnected(undefined);}})}>停止后台</button>
    {info.packaged&&<label><input type="checkbox" checked={!!info.loginStart} onChange={e=>{const enabled=e.target.checked;void run(async()=>{const on=await value(bridge.loginStart(enabled));setInfo({...info,loginStart:on});});}}/>登录电脑时启动</label>}
  </>;
  if(accountOpen||(!connected&&initialized))return <div className="desktop-connect"><div className="desktop-card"><div className="desktop-wordmark">哇唔哇唔<b>智能体</b></div><AccountEntry onConnected={c=>{connectedTo(c);setAccountOpen(false);setAutoRetry(false);}} onClose={connected?()=>setAccountOpen(false):undefined}/>{controls&&<details><summary>本机服务管理</summary>{controls}</details>}{host?.managed&&!connected&&<button className="text-button" onClick={()=>void run(()=>connect(host.url,host.serverId))}>使用已保存的本机登录</button>}</div></div>;
  if (connected) return <div className="desktop-shell"><div className="desktop-toolbar"><b>{info?.role==='host'?(localSelected?'主机控制台':'远程工作台'):'成员客户端'}</b>{info?.releaseLabel&&<small>{info.releaseLabel}</small>}<span>{connected.origin}</span>{controls}<button disabled={busy} onClick={()=>void run(async()=>{setAccountOpen(true);})}>可访问的主机</button></div>{relocated&&<div className="desktop-toolbar"><span>已找到原主机的新地址：{relocated.origin}</span><button disabled={busy} onClick={()=>void run(async()=>{if(!window.confirm('重新连接需要再次登录。请先复制未发送的草稿；已提交任务不会重发。'))return;await connect(relocated.origin,relocated.serverId);})}>重新连接主机</button></div>}{error&&<div className="error" role="alert">{error}</div>}<div className="desktop-workspace" key={connected.origin}>{children}</div></div>;
  return <div className="desktop-connect"><div className="desktop-card">
    <div className="desktop-wordmark">哇唔哇唔<b>智能体</b></div><p className="muted">{info?.role==='host'?'主机管理桌面端':'团队成员桌面端'} · 项目和任务统一在服务器保存</p>
    {controls&&<div className="desktop-host-controls">{controls}</div>}
    <h1>连接团队服务器</h1><p>首次确认主机地址后，使用你自己的账号密码登录。之后会记住地址。</p>
    <form onSubmit={e=>{e.preventDefault();void run(()=>connect(address,info?.saved?.origin===address?info.saved.serverId:undefined));}}>
      <label>服务器地址<input aria-label="服务器地址" value={address} onChange={e=>{setAutoRetry(false);setAddress(e.target.value);}} placeholder="https://work.cyj123.top"/></label>
      <div className="actions"><button className="primary" disabled={busy}>{busy?'正在处理…':'连接服务器'}</button><button type="button" className="secondary" disabled={busy} onClick={()=>void run(async()=>setServers(await value(bridge.discover())))}>查找局域网主机</button></div>
    </form>
    <div className="desktop-known-hosts"><h2>我的两台主机</h2><p className="small muted">进入同一台主机，各设备共享该主机的聊天、任务和媒体。</p>{[
      {name:'MacBook',origin:'https://work.cyj123.top',serverId:'52527694-2e4c-4758-b39f-fdb4095f7100'},
      {name:'M4 Mac mini',origin:'https://154.64.253.71',serverId:'c42c60b1-0ef0-457d-ad57-a37ed88a63d6'}
    ].map(s=><button disabled={busy} className="desktop-server" key={s.serverId} onClick={()=>void run(()=>connect(s.origin,s.serverId))}><b>{s.name}</b><span>{s.origin}</span></button>)}{host?.managed&&<button disabled={busy} className="desktop-server" onClick={()=>void run(()=>connect(host.url,host.serverId))}>本机直接连接 · {host.url}</button>}</div>
    {servers.map(s=><button className="desktop-server" key={s.serverId+s.origin} onClick={()=>void run(()=>connect(s.origin,s.serverId))}><b>{s.name}</b><span>{s.origin} · {s.serverId.slice(0,8)}</span><small>选择并确认此主机</small></button>)}
    {error&&<div className="error" role="alert">{error}</div>}
    {autoRetry&&info?.saved?.origin&&<p className="small muted">正在等待已确认的主机，每 5 秒重新探测一次；不会自动重发任务。</p>}
    <p className="small muted">公网使用 HTTPS 地址；局域网可查找原主机。切换主机后使用该主机的账号登录，聊天和文件保留在各自主机。</p>
    {info?.role==='host'&&<p className="small muted">关闭控制台不会停止后台。仅点击“停止后台”才会停止团队服务。</p>}
  </div></div>;
}
