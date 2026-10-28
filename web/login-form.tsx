import React, {useEffect,useState} from 'react';

export function LoginForm({needsSetup,api,onSuccess}:{needsSetup:boolean;api:(p:string,m?:string,b?:unknown)=>Promise<any>;onSuccess:(me:any)=>Promise<void>}) {
  const bridge=window.teamDesktop;
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[remember,setRemember]=useState(false);
  const [saved,setSaved]=useState<any>(),[host,setHost]=useState(false),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const useSaved=!!saved?.saved&&saved.username===username&&!password;
  async function savedState() {
    if(!bridge?.rememberStatus)return;
    const result=await bridge.rememberStatus();if(!result.ok)throw Error(result.error);
    return result.value;
  }
  useEffect(()=>{
    let stopped=false;
    void (async()=>{
      try {
        if(needsSetup||!bridge?.rememberStatus)return;
        const info=await bridge.info();if(!info.ok||info.value?.role!=='host')return;
        if(!stopped)setHost(true);
        const result=await savedState();
        if(!stopped){setSaved(result);setUsername(result.username);setRemember(result.supported);if(result.error)setError(result.error);}
        if(!stopped&&result.saved&&bridge.restoreLogin){
          setBusy(true);
          const restored=await bridge.restoreLogin();
          if(stopped)return;
          if(!restored.ok)throw Error(restored.error);
          if(restored.value.status===200){await onSuccess(restored.value.data);return;}
          if(restored.value.status!==204){
            const fresh=await savedState();
            if(!stopped){setSaved(fresh);setError(restored.value.data?.error||'自动登录暂未成功，请点击登录重试。');}
          }
        }
      }catch(e:any){if(!stopped)setError(e.message);}
      finally{if(!stopped){setReady(true);setBusy(false);}}
    })();return()=>{stopped=true;};
  },[]);
  async function forget(clearUsername:boolean) {
    setBusy(true);setError('');
    try {const result=await bridge!.forgetLogin!();if(!result.ok)throw Error(result.error);setSaved({...saved,saved:false,canClear:false,username:''});setRemember(false);setPassword('');if(clearUsername)setUsername('');}
    catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  return <form onSubmit={e=>{
    e.preventDefault();if(busy||!ready)return;const form=e.currentTarget;
    setBusy(true);setError('');
    void (async()=>{
      try {
        const data={username,password,...(needsSetup?{name:new FormData(form).get('name')}:{})};
        if(needsSetup)await api('/setup','POST',data);
        const me=await api('/login','POST',{...data,...(host?{remember,useSaved}:{})});
        setPassword('');await onSuccess(me);
      }catch(e:any){
        setError(e.message);
        if(e.status===401&&host){setPassword('');const result=await savedState().catch(()=>undefined);if(result){setSaved(result);setRemember(result.saved);}}
      }finally{setBusy(false);}
    })();
  }}>
    {bridge?.accountLogin&&<button type="button" className="secondary full" onClick={()=>window.dispatchEvent(new Event('wawu-account-entry'))}>使用账号自动连接主机</button>}
    <label>账号<input name="username" autoComplete="username" placeholder="账号" minLength={1} maxLength={40} required value={username} disabled={busy||!ready} onChange={e=>setUsername(e.target.value)}/></label>
    {needsSetup&&<label>显示名称<input name="name" placeholder="你的名字" required disabled={busy}/></label>}
    <label>密码<input name="password" type="password" autoComplete={needsSetup?'new-password':'current-password'} minLength={12} required={!useSaved} placeholder={useSaved?'已记住密码，点击登录即可':'至少 12 个字符'} value={password} disabled={busy||!ready} onChange={e=>setPassword(e.target.value)}/></label>
    {host&&<><label className="check remember-login"><input type="checkbox" checked={remember} disabled={busy||!ready||!saved?.supported} onChange={e=>{if(!e.target.checked&&saved?.canClear)void forget(false);else setRemember(e.target.checked);}}/>记住账号密码并自动登录</label><p className="small muted">仅此主机的超管账号；由 macOS 钥匙串加密保护，下次打开自动登录，主动退出后可切换账号。</p>{saved?.canClear&&<button type="button" className="text-button" disabled={busy} onClick={()=>void forget(true)}>清除已记住的账号密码</button>}</>}
    <button className="primary full" disabled={busy||!ready}>{busy?'正在登录…':needsSetup?'创建并进入':'登录'}</button>
    {error&&<div className="error" role="alert">{error}</div>}
  </form>;
}
