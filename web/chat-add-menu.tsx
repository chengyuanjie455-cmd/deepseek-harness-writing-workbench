import React,{useEffect,useId,useRef,useState} from 'react';

export function ChatAddMenu({onUpload,uploadBusy,disabled}:{
  onUpload:()=>void,uploadBusy:boolean,disabled:boolean
}){
  const [open,setOpen]=useState(false);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),first=useRef<HTMLButtonElement>(null);
  const id=useId();
  function close(focus=false){setOpen(false);if(focus)trigger.current?.focus();}
  useEffect(()=>{
    if(!open)return;
    const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))close();};
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  useEffect(()=>{if(disabled)close();},[disabled]);
  useEffect(()=>{if(open&&!uploadBusy)first.current?.focus();},[open,uploadBusy]);
  return <div className="chat-add" ref={root} onBlur={e=>{if(e.relatedTarget&&!e.currentTarget.contains(e.relatedTarget as Node))close();}} onKeyDown={e=>{if(e.key==='Escape'&&open){e.stopPropagation();e.preventDefault();close(true);}}}>
    <button ref={trigger} type="button" className="chat-add-trigger" aria-label="上传附件" title="上传附件" aria-expanded={open} aria-controls={id} disabled={disabled} onClick={()=>open?close():setOpen(true)}>＋</button>
    {open&&<div id={id} className="chat-add-popover" role="region" aria-label="上传附件">
      <button ref={first} type="button" className="chat-add-action" disabled={uploadBusy} onClick={()=>{onUpload();close(true);}}><span aria-hidden="true">↑</span><span><b>{uploadBusy?'附件上传中…':'上传附件'}</b><small>图片、文档及其他文件 · 单个 256 MiB 内</small></span></button>
      <p className="chat-add-note">原件备份到当前项目，智能体可自动查找和调用项目资料。</p>
    </div>}
  </div>;
}
