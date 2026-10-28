import React,{useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {displayPath,projectFileURL} from './attachments';
import './chat.css';
type Item=Record<string,any>;
export {Icon,CopyButton,copyText} from './chat-primitives';
import {Icon,CopyButton} from './chat-primitives';
import {DeferredMarkdown} from './deferred-markdown';
export function ChatMarkdown({text}:{text:string}){return <DeferredMarkdown text={text}/>;}

export function ChatActivity({task}:{task?:Item}){if(!task)return null;return <>{task.reasoning&&<details className="chat-reasoning"><summary>{task.state==='running'?'正在思考':'思考过程'}</summary><ChatMarkdown text={task.reasoning}/></details>}{task.tools?.length>0&&<details className="chat-tool-trace"><summary>已调用 {task.tools.length} 次工具</summary>{task.tools.map((t:Item,i:number)=><div key={i}><code>{t.name}</code><small>{new Date(t.time).toLocaleTimeString('zh-CN',{hour12:false})}</small></div>)}</details>}</>;}

export function ChatSelect({label,value,options,disabled,onChange,icon}:{label:string,value:string,options:{value:string,label:string,detail?:string}[],disabled?:boolean,onChange:(v:string)=>void,icon?:string}){
  const [open,setOpen]=useState(false);const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(!open)return;const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};document.addEventListener('pointerdown',close);root.current?.querySelector<HTMLButtonElement>('[role=option][aria-selected=true]')?.focus();return()=>document.removeEventListener('pointerdown',close);},[open]);
  return <div className="chat-select" ref={root} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();setOpen(false);trigger.current?.focus();}if(['ArrowDown','ArrowUp'].includes(e.key)&&open){e.preventDefault();const buttons=Array.from(root.current!.querySelectorAll<HTMLButtonElement>('[role=option]'));const i=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(i+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}}}>
    <button ref={trigger} className="chat-select-trigger" type="button" aria-label={label} title={options.find(o=>o.value===value)?.label??label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={()=>setOpen(!open)}>{icon&&<Icon name={icon}/>}<span>{options.find(o=>o.value===value)?.label??label}</span><Icon name="chevron"/></button>
    {open&&!disabled&&<div className="chat-popover" role="listbox" aria-label={label}>{options.map(o=><button key={o.value} type="button" role="option" aria-selected={o.value===value} onClick={()=>{onChange(o.value);setOpen(false);trigger.current?.focus();}}><span>{o.label}</span>{o.value===value&&<b>✓</b>}{o.detail&&<small>{o.detail}</small>}</button>)}</div>}
  </div>;
}

export function QueueDock({tasks,onEdit,onCancel}:{tasks:Item[],onEdit:(id:string,prompt:string)=>Promise<void>,onCancel:(id:string)=>Promise<void>}){
  const [editing,setEditing]=useState(''),[draft,setDraft]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  if(!tasks.length)return null;
  async function action(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();setEditing('');}catch(e:any){setError(e.message);}finally{setBusy(false);}}
  return <div className="chat-queue"><details open><summary>待处理消息 <span>{tasks.length}</span></summary>{tasks.map(t=><div key={t.id} className="chat-queue-row">{editing===t.id?<><textarea aria-label="编辑排队消息" value={draft} onChange={e=>setDraft(e.target.value)}/><div><button disabled={busy||!draft.trim()} onClick={()=>void action(()=>onEdit(t.id,draft))}>保存</button><button disabled={busy} onClick={()=>setEditing('')}>取消编辑</button></div></>:<><span>{t.prompt}</span><small>{t.state==='steering'?'已插话，等待处理':'排队中'}</small>{t.state==='queued'&&<><button title="编辑排队消息" aria-label="编辑排队消息" onClick={()=>{setEditing(t.id);setDraft(t.prompt);}}><Icon name="edit"/></button><button title="移除排队消息" aria-label="移除排队消息" disabled={busy} onClick={()=>void action(()=>onCancel(t.id))}><Icon name="close"/></button></>}</>}</div>)}</details>{error&&<p role="alert">{error}</p>}</div>;
}

type ComposerProps={
  prompt:string;onPrompt:(s:string)=>void;workflow:string;onWorkflow:(s:string)=>void;onSend:(delivery:'queue'|'steer')=>Promise<void>;onStop:()=>void;onNew:()=>void;
  running:boolean;stopping:boolean;blocked:boolean;readOnly:boolean;uploadBusy:boolean;onUpload:()=>void;onFiles:(files:File[])=>void;attachments:Item[];onRemove:(path:string)=>void;
  project:string;options:Item;modelId:string;permission:string;skillId?:string;onSettings:(p:Item)=>void;video:boolean;image:boolean;scripts:boolean;draftKey:string;children?:ReactNode;
};
export function ChatComposer(p:ComposerProps){
  const input=useRef<HTMLTextAreaElement>(null),root=useRef<HTMLDivElement>(null),dragDepth=useRef(0),composing=useRef(false);
  const [commands,setCommands]=useState(false),[drag,setDrag]=useState(false),[busyMode,setBusyMode]=useState<'queue'|'steer'>(()=>{try{return localStorage.getItem('team.chat.busyEnter')==='steer'?'steer':'queue';}catch{return 'queue';}}),[error,setError]=useState('');
  useLayoutEffect(()=>{if(!input.current)return;input.current.style.height='0px';input.current.style.height=Math.min(216,Math.max(36,input.current.scrollHeight))+'px';},[p.prompt]);
  useEffect(()=>{setError('');setCommands(false);dragDepth.current=0;setDrag(false);if(!p.readOnly)input.current?.focus({preventScroll:true});},[p.draftKey]);
  useEffect(()=>{if(!commands)return;if(document.activeElement!==input.current)root.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setCommands(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[commands]);
  const modes=[{value:'chat',label:'标准模式'},{value:'plan',label:'计划模式'},{value:'organize',label:'整理 → 审核'},...(p.video?[{value:'pickup',label:'视频补抽'}]:[]),...(p.image?[{value:'image',label:'图片生成'}]:[]),...(p.scripts?[{value:'script',label:'Python 脚本'}]:[])];
  const commandList=[{id:'new',title:'新建会话',description:'在当前项目中开始独立聊天',run:p.onNew},...modes.map(m=>({id:({chat:'chat',plan:'plan',organize:'organize',pickup:'video',image:'image',script:'python'} as Item)[m.value],title:m.label,description:m.value==='plan'?'先讨论方案与实施步骤':m.value==='organize'?'整理结果经管理员审核发布':'切换聊天模式',run:()=>p.onWorkflow(m.value)})),{id:'stop',title:'停止生成',description:'停止当前回复',run:p.onStop}];
  const token=p.prompt.match(/^\/([a-z]*)$/)?.[1],filtered=commandList.filter(c=>token===undefined||c.id.startsWith(token));
  function choose(c:typeof commandList[number]){if(p.prompt.startsWith('/'))p.onPrompt('');c.run();setCommands(false);input.current?.focus();}
  async function submit(delivery=busyMode){
    if(p.blocked||p.readOnly||p.uploadBusy||!p.prompt.trim()&&!p.attachments.length)return;
    const cmd=p.prompt.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
    if(cmd){const item=commandList.find(c=>c.id===cmd[1]);if(item&&!cmd[2]){choose(item);return;}}
    setCommands(false);setError('');try{await p.onSend(p.running?delivery:'queue');input.current?.focus();}catch(e:any){setError(e.message);}
  }
  const hasInput=!!p.prompt.trim()||p.attachments.length>0,canStop=p.running&&!hasInput;
  return <div className="harness-composer" ref={root} onKeyDown={e=>{if(!commands)return;if(e.key==='Escape'){e.preventDefault();setCommands(false);input.current?.focus();}if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const buttons=Array.from(root.current!.querySelectorAll<HTMLButtonElement>('[role=menuitem]'));const i=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(i+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}}} onDragEnter={e=>{if(!e.dataTransfer.types.includes('Files')||p.readOnly||p.uploadBusy)return;e.preventDefault();dragDepth.current++;setDrag(true);}} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect=p.readOnly?'none':'copy';}}} onDragLeave={e=>{e.preventDefault();if(--dragDepth.current<=0)setDrag(false);}} onDrop={e=>{e.preventDefault();dragDepth.current=0;setDrag(false);if(!p.readOnly&&!p.uploadBusy)p.onFiles(Array.from(e.dataTransfer.files));}}>
    {drag&&<div className="chat-drop-overlay">松开以上传附件</div>}
    {p.attachments.length>0&&<div className="chat-draft-attachments">{p.attachments.map(a=><div key={a.path} className="chat-draft-file">{a.mime?.startsWith('image/')?<img src={projectFileURL(p.project,a.path)} alt={displayPath(a.path)}/>:<Icon name="folder"/>}<div><span>{displayPath(a.path)}</span><small>{a.bytes?`${Math.ceil(a.bytes/1024)} KB`:'项目附件'}</small></div><button title="移除本次附件引用" aria-label={`移除附件 ${displayPath(a.path)}`} disabled={p.blocked} onClick={()=>p.onRemove(a.path)}><Icon name="close"/></button></div>)}</div>}
    <div className="harness-editor"><textarea ref={input} aria-label="聊天内容" rows={1} maxLength={16000} placeholder={p.readOnly?'此会话只读':p.workflow==='plan'?'描述目标，一起制定计划…':p.workflow==='pickup'?'输入剧本片段和补抽意见…':p.workflow==='image'?'描述要生成的图片…':'发消息，或输入 / 查看指令'} value={p.prompt} disabled={p.readOnly} onChange={e=>{p.onPrompt(e.target.value);setCommands(/^\/[a-z]*$/.test(e.target.value));}} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{setTimeout(()=>{composing.current=false;},0);}} onPaste={e=>{const files=Array.from(e.clipboardData.files);if(files.length&&!p.readOnly&&!p.uploadBusy){e.preventDefault();p.onFiles(files);}}} onKeyDown={e=>{if(composing.current||e.nativeEvent.isComposing||e.keyCode===229)return;if(e.key==='Escape'){setCommands(false);return;}if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(commands&&filtered.length===1&&!e.metaKey&&!e.ctrlKey)choose(filtered[0]);else void submit(e.metaKey||e.ctrlKey?(busyMode==='queue'?'steer':'queue'):busyMode);}}}/></div>
    <div className="harness-composer-row"><div className="harness-composer-tools">
      <button className="harness-circle" aria-label="指令" title="指令" aria-expanded={commands} disabled={p.readOnly} onClick={()=>setCommands(!commands)}><Icon name="plus"/></button>
      <button className="harness-circle" aria-label="添加附件" title="添加附件（支持粘贴和拖放）" disabled={p.readOnly||p.uploadBusy||p.blocked} onClick={p.onUpload}><Icon name="clip"/></button>
      <ChatSelect label="选择模型" value={p.modelId} disabled={p.readOnly||p.running||p.blocked} options={(p.options.models??[]).map((m:Item)=>({value:m.id,label:m.name,detail:`${m.model} · ${m.reasoningEffort==='off'?'不思考':m.reasoningEffort+' 推理'}`}))} onChange={modelId=>p.onSettings({modelId})}/>
      <ChatSelect label="选择技能" value={p.skillId??p.options.defaultSkillId??''} disabled={p.readOnly||p.running||p.blocked} options={(p.options.skills??[]).map((s:Item)=>({value:s.id,label:s.name,detail:`v${s.version}`}))} onChange={skillId=>p.onSettings({skillId})}/>
      <ChatSelect label="权限模式" icon="shield" value={p.permission} disabled={p.readOnly||p.running||p.blocked} options={(p.options.permissions??[]).map((v:string)=>({value:v,label:v==='read-only'?'只读':'工作区写入',detail:v==='read-only'?'读取项目资料与回答问题':'修改形成候选，经管理员审核后发布'}))} onChange={permission=>p.onSettings({permission})}/>
    </div><div className="harness-composer-trailing">
      <ChatSelect label="工作流" value={p.workflow} options={modes} disabled={p.readOnly||p.blocked} onChange={p.onWorkflow}/>
      <button className="harness-primary" title={canStop?'停止生成':p.running?(busyMode==='queue'?'排队发送':'插话发送'):'发送消息'} aria-label={canStop?'停止生成':p.running?(busyMode==='queue'?'排队发送':'插话发送'):'发送消息'} disabled={p.readOnly||p.stopping||(canStop?false:p.blocked||p.uploadBusy||!hasInput)} onClick={()=>canStop?p.onStop():void submit()}><Icon name={canStop?'stop':'send'}/></button>
    </div></div>
    {commands&&!p.readOnly&&<div className="chat-command-menu" style={{maxHeight:Math.max(120,Math.min(330,(root.current?.getBoundingClientRect().top??450)-(root.current?.closest('.conversation')?.getBoundingClientRect().top??90)-12))}} role="menu" aria-label="聊天指令">{filtered.map(c=><button key={c.id} role="menuitem" onClick={()=>choose(c)}><span>/{c.id}</span><div><b>{c.title}</b><small>{c.description}</small></div></button>)}{!filtered.length&&<p>没有匹配的指令</p>}</div>}
    {p.children}{error&&<p className="chat-composer-error" role="alert">{error}</p>}
    <div className="chat-keyboard-settings"><details><summary><Icon name="settings"/>发送设置</summary><label>运行时 Enter<select aria-label="运行时 Enter" value={busyMode} onChange={e=>{const v=e.target.value as 'queue'|'steer';setBusyMode(v);try{localStorage.setItem('team.chat.busyEnter',v);}catch{}}}><option value="queue">排队发送</option><option value="steer">插话发送</option></select></label><p>Shift + Enter 换行 · Ctrl/⌘ + Enter 使用另一种发送方式</p></details></div>
  </div>;
}

export function exportChat(title:string,messages:Item[]){const text=`# ${title}\n\n`+messages.map(m=>`## ${m.role==='user'?'用户':'助手'}\n\n${m.text}\n`).join('\n');const blob=new Blob([text],{type:'text/markdown;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=title.replace(/[\\/:*?"<>|]/g,'_')+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
