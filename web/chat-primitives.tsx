import React,{useState,type ReactNode} from 'react';
export function Icon({name}:{name:string}){
  const paths:Record<string,ReactNode>={
    plus:<path d="M12 5v14M5 12h14"/>,send:<path d="M12 19V5m-6 6 6-6 6 6"/>,stop:<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>,
    clip:<path d="m8 12 5-5a3 3 0 0 1 4 4l-7 7a5 5 0 0 1-7-7l8-8a6 6 0 0 1 9 9l-7 7"/>,chevron:<path d="m7 10 5 5 5-5"/>,
    copy:<><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></>,edit:<><path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14z"/></>,
    retry:<><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/></>,close:<path d="m6 6 12 12M6 18 18 6"/>,down:<path d="M12 5v14m-6-6 6 6 6-6"/>,
    shield:<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>,folder:<path d="M3 7V5h7l2 3h9v12H3z"/>,
    settings:<><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="12" r="2" fill="currentColor"/><circle cx="8" cy="18" r="2" fill="currentColor"/></>,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.plus}</svg>;
}
export async function copyText(text:string){
  if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(text);return;}catch{}}
  const active=document.activeElement as HTMLElement|null,el=document.createElement('textarea');el.value=text;el.style.cssText='position:fixed;left:-9999px;top:0';document.body.appendChild(el);el.select();const copied=document.execCommand('copy');el.remove();active?.focus();if(!copied)throw Error('复制失败，请选择文字后复制');
}
export function CopyButton({text,label='复制'}:{text:string,label?:string}){const [state,setState]=useState('');return <button className="chat-action" title={state||label} aria-label={state||label} onClick={()=>void copyText(text).then(()=>{setState('已复制');setTimeout(()=>setState(''),1800);}).catch(()=>setState('复制失败'))}><Icon name="copy"/>{state&&<span role="status">{state}</span>}</button>;}
