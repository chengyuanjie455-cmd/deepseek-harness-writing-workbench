import type {DesktopBridge} from './desktop';

const requestType='team-native-folder-picker',replyType='team-native-folder-picked';
type Reply=Awaited<ReturnType<NonNullable<DesktopBridge['selectHostFolder']>>>;
type Selection={supported:false}|{supported:true;path?:string;cancelled?:boolean};
type Target={source:Window;origin:string;scope:string;version:number};
declare global {interface Window {__TEAM_SEND__?:(type:string,extra:Record<string,unknown>)=>void}}

function selection(reply:Reply):Selection {
 if(!reply.ok)throw Error(reply.error||'文件夹选择失败');
 return {supported:true,...reply.value?.path?{path:reply.value.path}:{cancelled:true}};
}

// Embedded settings share an origin with the native workbench, but not with
// Electron's outer document. Reuse its scoped message bridge and existing IPC.
export async function chooseNativeHostFolder(initialPath:string,signal:AbortSignal,win:Window=window,timeoutMs=5000):Promise<Selection>{
 signal.throwIfAborted();
 if(win.teamDesktop?.selectHostFolder){const reply=await win.teamDesktop.selectHostFolder(initialPath);signal.throwIfAborted();return selection(reply);}
 let parent:Window,parentOrigin:string,send:NonNullable<Window['__TEAM_SEND__']>;
 try{
  const project=win.location.pathname.match(/^\/harness\/((?:shared|[a-f0-9-]{36})(?:~[a-f0-9-]{36})?)\/team-settings\//)?.[1];
  parent=win.parent;
  if(!project||parent===win||parent.location.origin!==win.location.origin||parent.location.pathname!==`/harness/${project}/`||!parent.__TEAM_SEND__)return {supported:false};
  parentOrigin=parent.document.referrer?new URL(parent.document.referrer).origin:'null';
  send=parent.__TEAM_SEND__;
 }catch{return {supported:false};}
 return new Promise((resolve,reject)=>{
  const requestId=win.crypto.randomUUID();let timer:ReturnType<typeof setTimeout>;
  const cleanup=()=>{clearTimeout(timer);parent.removeEventListener('message',message);signal.removeEventListener('abort',abort);};
  const abort=()=>{cleanup();reject(signal.reason??Error('文件夹选择已取消'));};
  const message=(event:MessageEvent)=>{
   const data=event.data;
   const trustedOrigin=event.origin===parentOrigin||parentOrigin==='null'&&[win.location.origin,'team://desktop','team://app'].includes(event.origin);
   if(event.source!==parent.parent||!trustedOrigin||data?.type!==replyType||data.requestId!==requestId)return;
   if(data.phase==='opening'){clearTimeout(timer);return;}
   cleanup();
   try{resolve(data.supported===false?{supported:false}:selection(data.result));}catch(error){reject(error);}
  };
  parent.addEventListener('message',message);signal.addEventListener('abort',abort,{once:true});
  // Only the bridge handshake expires; a user may leave the system dialog open.
  timer=setTimeout(()=>{cleanup();reject(Error('桌面文件夹选择暂未响应，请重新打开设置后重试。'));},timeoutMs);
  try{send(requestType,{requestId,initialPath});}catch(error){cleanup();reject(error);}
 });
}

export function createNativeFolderHost(target:()=>Target|undefined,select:((path:string)=>Promise<Reply>)|undefined){
 let disposed=false,busy=false;const seen=new Set<string>();
 const same=(a:Target,b:Target|undefined)=>!!b&&a.source===b.source&&a.origin===b.origin&&a.scope===b.scope&&a.version===b.version;
 return {
  async receive(event:MessageEvent){
   const current=target(),data=event.data;
   if(disposed||!current||event.source!==current.source||event.origin!==current.origin||data?.scope!==current.scope||data.type!==requestType||typeof data.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(data.requestId)||typeof data.initialPath!=='string'||data.initialPath.length>1000||seen.has(data.requestId))return;
   seen.add(data.requestId);if(seen.size>64)seen.delete(seen.values().next().value!);
   const reply=(extra:Record<string,unknown>)=>{if(!disposed&&same(current,target()))current.source.postMessage({type:replyType,scope:current.scope,requestId:data.requestId,...extra},current.origin);};
   if(!select){reply({supported:false});return;}
   if(busy){reply({supported:true,result:{ok:false,error:'已有文件夹选择窗口，请先完成或取消。'}});return;}
   busy=true;reply({supported:true,phase:'opening'});
   try{reply({supported:true,result:await select(data.initialPath)});}
   catch(error){reply({supported:true,result:{ok:false,error:error instanceof Error?error.message:'文件夹选择失败'}});}
   finally{busy=false;}
  },
  dispose(){disposed=true;seen.clear();},
 };
}
