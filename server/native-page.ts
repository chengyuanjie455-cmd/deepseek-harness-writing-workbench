import {readFileSync} from 'node:fs';
import {galleryCSS} from '../native-harness/team-project/media-gallery.mjs';
const workbenchCSS=readFileSync(new URL('../native-harness/team-project/workbench.css',import.meta.url),'utf8');
const syncFactory=readFileSync(new URL('../native-harness/team-project/native-sync.mjs',import.meta.url),'utf8').replace('export function','function');
const referenceFactory=readFileSync(new URL('../native-harness/team-project/reference-bridge.mjs',import.meta.url),'utf8').replace('export function','function');
// Read the source factory so runtime transpiler helpers cannot leak into browser code.
const galleryFactorySource=readFileSync(new URL('../native-harness/team-project/media-gallery.mjs',import.meta.url),'utf8').split('export const galleryCSS')[0].replace('export function','function').trim();
// This bridge is served only inside authenticated HTML, never a cached asset.
export function nativePageBridge(scope:string,context:{project:string;admin:boolean;user?:string;viewer?:string;ownerName?:string}={project:'shared',admin:false},directSurface=false){return `;(()=>{
 if(typeof document==='undefined')return;
 window.__TEAM_WORKBENCH_CSS__=${JSON.stringify(workbenchCSS)};
 window.__TEAM_CREATE_GALLERY__=(${galleryFactorySource});window.__TEAM_GALLERY_CSS__=${JSON.stringify(galleryCSS)};
 ${directSurface?'':'if(window.parent===window)return;'}
 window.__TEAM_CONTEXT__=${JSON.stringify(context).replace(/</g,'\\u003c')};
 const scope=${JSON.stringify(scope)},parentOrigin=document.referrer?new URL(document.referrer).origin:'null';
 ${directSurface?'window.__TEAM_STUDIO_SCOPE__=scope;':''}
 const send=(type,extra={})=>window.parent.postMessage({type,scope,...extra},parentOrigin==='null'?'*':parentOrigin);
 const key='team-native-reconnect-draft:'+scope;
 const composer=()=>document.querySelector('[data-composer-input="true"][contenteditable="true"]');
 let ready=false,viewVersion;
 window.__TEAM_SYNC__=(${syncFactory})({emit:value=>send('team-native-sync',{...value,version:viewVersion})});
 const references=(${referenceFactory})({scope,project:window.__TEAM_CONTEXT__.project,storage:sessionStorage,currentSession:()=>window.__TEAM_CURRENT_SESSION__,insert:(session,text)=>window.__TEAM_REFERENCE_INPUTS__?.get(session)?.(text)===true});
 // The native store owns text. The direct surface checkpoints native files and
 // reference occurrences separately; never overwrite either with a DOM draft.
 const snapshot=()=>{try{sessionStorage.setItem(key,JSON.stringify({hash:location.hash,time:Date.now()}));}catch{}};
 const probe=()=>{const el=composer(),panel=document.querySelector('iframe[data-team-settings]')||document.querySelector('.team-member-chats');if(!(el&&document.querySelector('button[aria-label^="选择模型"]'))&&!panel)return;
  if(!ready){ready=true;send('team-native-ready',{hash:location.hash,version:viewVersion});}
 };
 window.__TEAM_SEND__=(type,extra={})=>send(type,extra);
 // A containing workbench can own project views without replacing the native
 // conversation. Older or standalone shells keep the full native file panel.
 window.__TEAM_WORKBENCH_PANELS__=[];
 window.__TEAM_OPEN_WORKBENCH_PANEL__=section=>{
  if(section!=='files'||!window.__TEAM_WORKBENCH_PANELS__.includes(section)||!viewVersion)return false;
  send('team-workbench-panel',{protocolVersion:1,version:viewVersion,project:window.__TEAM_CONTEXT__.project,section});return true;
 };
 window.addEventListener('message',event=>{if(event.source!==window.parent||!(event.origin===parentOrigin||parentOrigin==='null'&&[location.origin,'team://desktop','team://app'].includes(event.origin))||event.data?.scope!==scope)return;
  if(event.data.type==='team-native-probe'&&Number.isSafeInteger(event.data.version)&&event.data.version>0){viewVersion=event.data.version;window.__TEAM_WORKBENCH_PANELS__=event.data.workbenchPanels?.includes?.('files')?['files']:[];ready=false;probe();window.__TEAM_SYNC__.snapshot();}
  if(event.data.type==='team-native-reference'&&event.data.version===viewVersion)void references.receive(event.data).then(reply=>send(reply.type,reply));
  if(event.data.type==='team-native-snapshot'){snapshot();send('team-native-snapshot-saved',{hash:location.hash,requestId:event.data.requestId});}
  if(event.data.type==='team-native-panel'&&['files','tasks','members','images','videos'].includes(event.data.section))window.dispatchEvent(new CustomEvent('team-open-panel',{detail:event.data.section}));
  if(event.data.type==='team-native-new')window.dispatchEvent(new CustomEvent('team-new-chat'));
  if(event.data.type==='team-native-settings')window.dispatchEvent(new CustomEvent('team-open-settings',{detail:event.data.section}));
  if(event.data.type==='team-native-session'&&/^session-[a-zA-Z0-9-]+$/.test(event.data.session))window.dispatchEvent(new CustomEvent('team-open-session',{detail:event.data.member?{session:event.data.session,member:event.data.member,historyOnly:event.data.historyOnly===true}:event.data.session}));
 });
 window.addEventListener('hashchange',()=>send('team-native-location',{hash:location.hash}));
 const start=()=>{send('team-native-loaded');const observer=new MutationObserver(probe);observer.observe(document.body,{childList:true,subtree:true});probe();setTimeout(()=>observer.disconnect(),120000);};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();`;}

export function adaptNativeClient(source:string){
 // Observe the pinned native journal's actual recovery callbacks. This adapter
 // neither sends prompts nor owns event ordering, cursors or retry decisions.
 if(source.includes('var SessionEventStream = class extends')&&!source.includes('teamSyncToken')){
  const anchor='constructor(remote, address, options) {';
  if(source.split(anchor).length!==2)throw Error('原生会话同步观察接口变化，请核对版本');
  source=source.replace(anchor,anchor+`
   const sync = window.__TEAM_SYNC__;
   const teamSyncToken = sync?.begin(address.sessionId ?? address.childSessionId);
   const originalOptions = options;
   options = {...options,
    publish: change => { originalOptions.publish(change); if(change.type==='replace'||change.type==='append')sync?.update(teamSyncToken,'live'); },
    carrierFailed: error => { originalOptions.carrierFailed?.(error); sync?.update(teamSyncToken,'reconnecting'); },
    failed: error => { originalOptions.failed(error); sync?.update(teamSyncToken,'error'); }
   };`);
  const close='this.address = address;';
  const start=source.indexOf(anchor),end=source.indexOf(close,start);
  if(end<0)throw Error('原生会话同步清理接口变化，请核对版本');
  source=source.slice(0,end)+source.slice(end).replace(close,close+`
   const nativeDispose=this.dispose.bind(this);
   this.dispose=()=>{sync?.end(teamSyncToken);return nativeDispose();};
   const nativeOpen=this.open.bind(this);
   this.open=async(...args)=>{try{return await nativeOpen(...args);}catch(error){sync?.update(teamSyncToken,'error');throw error;}};`);
 }
 // New native clients resolve routes relative to document.baseURI. Keep
 // API path constants absolute before applying the authenticated team prefix.
 const paths=[...source.matchAll(/const (\w+) = (["'])(\/(?:api|plugins|assets)\/[^"']+)\2/g)].map(m=>m[1]);
 for(const name of paths)source=source.replaceAll(name+'.slice(1)',name);
 source=source.replace(/(["'])(\/(?:api|plugins|assets)\/[^"']+)\1\.slice\(1\)/g,'$1$2$1');

 // Use the native admission boundary so queue, steer, attachments and draft recovery stay native.
 const sendSession='async sendSession(session, text, attachmentIds, mode, signal) {';
 if(source.includes(sendSession)&&!source.includes('text = window.__TEAM_GENERATION_PROMPT__'))source=source.replace(sendSession,sendSession+`
 text = window.__TEAM_GENERATION_PROMPT__?.(session.sessionId, text) ?? text;`);
 // Pass the native turn identity through the existing Tool slot. This is display
 // metadata only: durable events, tool calls and submission order stay native.
 const toolTree=source.match(/function ToolCallTree\(\{ renderSlot, node, cwd, openFile, inspectCall, loadImage, (?:useDisclosure, )?useHostInfo, t \}\) \{/)?.[0]??'';
 if(toolTree)source=source.replace(toolTree,toolTree+`
  const originalRenderSlot=renderSlot;
  renderSlot=(name,owner,options)=>originalRenderSlot(name,{...owner,teamGalleryTurn:node.location?.turn?.turn??node.location?.turn,teamGalleryOrder:node.anchorSeq,teamGallerySettled:node.location?.turn?.status==='closed'},options);`);

 if(source.includes('function PresentedFileCard(')){
  const download=`(0, react_jsx_runtime.jsx)("a", {
   className: Deliverables_module_css_default.open,
   href: window.__TEAM_WORKSPACE_DOWNLOAD_URL__(resolveWorkspacePath(cwd, file.path)),
   download: name, "aria-label": "下载 " + name,
   style: {textDecoration:"none"},
   onClick: event => event.stopPropagation(), children: "下载"
  })`;
  if(source.includes('function PresentedFileCard({ file, cwd, phase, host, onPreview, actions, t })')){
   const action=/(className: Deliverables_module_css_default\.actions,\s*children: )actions/;
   if(!action.test(source))throw Error('原生文件下载适配点不匹配');
   source=source.replace(action,`$1[${download}, actions]`);
  }else if(source.includes('function PresentedFileCard({ file, cwd, phase, host, onPreview, onAction, t })')){
   const action=/(className: Deliverables_module_css_default\.split,\s*children: \[)/;
   if(!action.test(source))throw Error('原生文件下载适配点不匹配');
   source=source.replace(action,`$1${download}, `);
  }else throw Error('原生文件卡片接口变化，请核对版本');
 }

 source=source.replace('const productTitle = "DeepSeek Harness"','const productTitle = "team-harness-platform"');
 if(source.includes('function SettingsRoot(props)')){
  const anchor='const { close, openSection } = actions;';
  if(!source.includes(anchor))throw Error('原生设置导航接口变化，请核对版本');
  source=source.replace(anchor,anchor+`
 (0, react.useEffect)(()=>{const open=e=>actions.openSection(e.detail||undefined),close=()=>actions.close();window.addEventListener('team-open-settings',open);window.addEventListener('team-close-settings',close);return()=>{window.removeEventListener('team-open-settings',open);window.removeEventListener('team-close-settings',close);};},[actions]);`);
 }
 // Retain the older shell contract for preserved 0.1 history/rollback fixtures.
 if(!source.includes('function SettingsRoot(props)')){
  const anchor='const [activeId, setActiveId] = (0, react.useState)(void 0);';
  if(source.includes(anchor))source=source.replace(anchor,anchor+`
 (0, react.useEffect)(()=>{const open=e=>{setActiveId(e.detail||undefined);setOpen(true);},close=()=>setOpen(false);window.addEventListener('team-open-settings',open);window.addEventListener('team-close-settings',close);return()=>{window.removeEventListener('team-open-settings',open);window.removeEventListener('team-close-settings',close);};},[]);`);
 }
 // Group the pinned native message attachment presentation without changing uploads or messages.
 if(source.includes('function UserStyleBubble({')){
  const marker='const compactImages = attachments.length > 1;';
  const map='attachments.map((attachment, index) => attachment.type === "image" ?';
  if(!source.includes(marker)||!source.includes(map))throw Error('原生聊天附件画廊适配点不匹配');
  source=source.replace(marker,marker+'\n const isGalleryMedia = a => a.type === "image" || /\\.(mp4|mov|m4v|webm|mkv|png|jpe?g|webp|gif|avif)$/i.test(a.file?.name ?? "");')
   .replace(map,'attachments.filter((a,i) => !isGalleryMedia(a) || i === attachments.findIndex(isGalleryMedia)).map((attachment, index) => isGalleryMedia(attachment) ?')
   .replace('images: [attachment.image],','images: attachments.filter(isGalleryMedia).map(a => a.type === "image" ? a.image : {file:a.file}),');
 }
 // Extend the pinned native tree at its row-render boundary. Project controls,
 // session rows, search and controllers stay owned by Harness.
 if(source.includes('function WorkspaceBrowser({ wide,')){
  const current=source.includes('function SessionTree({ list,');
  const signature=current?'function SessionTree({ list,':'function SessionTree({ useSessions,';
  const rows=current?'sessions.map((node) => {':'(sessionsExpanded ? group.sessions : collapsed.rows).map((node) => {';
  const registration='}, WorkspaceBrowser));';
  if(!source.includes(signature)||!source.includes(rows)||!source.includes(registration))throw Error('原生工作区分组适配点不匹配');
  source=source.replace('function WorkspaceBrowser({ wide,','function WorkspaceBrowser({ renderMemberGroups, wide,')
   .replace(signature,current?'function SessionTree({ renderMemberGroups, list,':'function SessionTree({ renderMemberGroups, useSessions,')
   .replace('(SessionTree, {','(SessionTree, { renderMemberGroups,')
   .replace(rows,'((renderRow) => renderMemberGroups ? renderMemberGroups(group, renderRow) : '+(current?'sessions':'(sessionsExpanded ? group.sessions : collapsed.rows)')+'.map(renderRow))((node) => {')
   .replace('actions: group.workspaceId === void 0 ? void 0 : {','actions: group.workspaceId === void 0 || group.workspaceId.startsWith("team-project:") ? void 0 : {')
   .replace('drag: workspaceDragProps,','drag: group.workspaceId?.startsWith("team-project:") ? undefined : workspaceDragProps,')
   .replace('collapsed.hiddenCount > 0 &&','!renderMemberGroups && collapsed.hiddenCount > 0 &&')
   // Decorate the original registered entry, retaining its complete child-slot
   // authorization, stores, menus and extension points without duplicate slots.
   .replace(registration,'}, (props) => window.__TEAM_WORKSPACE_BROWSER__ ? window.__TEAM_WORKSPACE_BROWSER__(WorkspaceBrowser, props) : (0, react_jsx_runtime.jsx)(WorkspaceBrowser, props)));');
 }

 return source;
}

/** Apply the same root-asset scope to every served native client. */
export function scopeNativeAsset(source:string,prefix:string){return adaptNativeClient(source).replace(/(["'`])\/(plugins|assets|api)\//g,`$1${prefix}/$2/`).replace('<base href="/">',`<base href="${prefix}/">`);}

/** Keep authentication on the already-private manifest route, including same-origin fetches. */
export function credentialedManifestLinks(source:string,prefix:string){
 return source.replace(/<link\b[^>]*>/gi,tag=>{
  const rel=tag.match(/\brel\s*=\s*(["'])(.*?)\1/i)?.[2],href=tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
  if(!rel?.split(/\s+/).some(v=>v.toLowerCase()==='manifest')||!href||/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href.trim()))return tag;
  if(href.startsWith('/')&&!href.startsWith(prefix+'/'))tag=tag.replace(/(\bhref\s*=\s*["'])[^"']+(["'])/i,(_,a,b)=>a+prefix+href+b);
  if(/\bcrossorigin\b/i.test(tag))return tag.replace(/\bcrossorigin(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i,'crossorigin="use-credentials"');
  return tag.replace(/\s*\/?>$/,ending=>' crossorigin="use-credentials"'+ending);
 });
}
