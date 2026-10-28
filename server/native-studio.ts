import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {requireThat} from './store.ts';

/** Pinned presentation seams only: no conversation controller, RPC, tool or
 * prompt changes. A changed native composition fails explicitly. */
export function adaptStudioSource(source:string){
 let code=source;
 // Native browser preferences are origin-wide by default. These three stores
 // contain project/session selection or draft content, so give the original
 // stores their authenticated viewer/owner/project namespace. No global
 // localStorage proxy and no migration from an ambiguous previous account.
 const scoped=(key:string)=>`(window.__TEAM_STUDIO_MODE__?${JSON.stringify(key+':team:')}+encodeURIComponent(window.__TEAM_STUDIO_SCOPE__):${JSON.stringify(key)})`;
 if(code.includes('function createWorkspaceViewStore()')){
  for(const key of ['dsh.workspace.view.v5','dsh.sessions.current']){
   const literal=JSON.stringify(key);requireThat(code.split(literal).length===2,'原生项目选择存储接口变化',503);
   code=code.replace(literal,()=>scoped(key));
  }
 }
 if(code.includes('function AppFrame({ useStore, useSessions, usePanelInfo, actions, renderSlot, t })')){
  const anchor='}, AppFrame);';requireThat(code.split(anchor).length===2,'原生布局注册接口变化',503);
  code=code.replace(anchor,()=>`}, function TeamProjectSurfaceRoot(props){
   if(!window.__TEAM_STUDIO_MODE__)return react.createElement(AppFrame,props);
   if(!window.__TEAM_STUDIO_ROOT__)throw Error('项目聊天布局尚未注册');
   return react.createElement(react.Fragment,null,react.createElement(DocumentTitle,{useSessions:props.useSessions,usePanelInfo:props.usePanelInfo,productTitle:'team-harness-platform'}),window.__TEAM_STUDIO_ROOT__(props));
  });`);
 }
 if(code.includes('function SidebarRoot({ collapsed, width, startSession, toggleSidebar, selectPanel, usePanels, useShortcuts, usePanelInfo, t, renderSlot })')){
  const anchor='function SidebarRoot({ collapsed, width, startSession, toggleSidebar, selectPanel, usePanels, useShortcuts, usePanelInfo, t, renderSlot }) {';
  requireThat(code.split(anchor).length===2,'原生功能菜单接口变化',503);
  code=code.replace(anchor,()=>anchor+`
   if(window.__TEAM_STUDIO_MODE__){
    if(!window.__TEAM_STUDIO_TOOLS__)throw Error('项目聊天功能菜单尚未注册');
    return window.__TEAM_STUDIO_TOOLS__({selectPanel,usePanels,renderSlot});
   }
  `);
 }
 if(code.includes('function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose })')){
  const anchor='}), document.body);';
  requireThat(code.split(anchor).length===2,'原生设置面板挂载接口变化',503);
  // Keep the original settings sections, native modal layer, shortcuts and
  // mutations. Only dock the existing portal inside the workbench sidebar.
  code=code.replace(anchor,()=>"}), window.__TEAM_STUDIO_MODE__?(document.querySelector('[data-studio-settings-host]')??document.body):document.body);");
 }
 if(code.includes('function ConversationMainPanel(props)')){
  for(const seam of ['createDrafts(sessionId, files) {','resolveDraftAttachments(ids) {','restoreDraft(draft, occurrences) {','shell(id) {'])requireThat(code.includes(seam),'原生附件恢复接口变化',503);
  const key='const CONVERSATION_STORE_KEY = "dsh.conversation";';
  requireThat(code.split(key).length===2,'原生聊天草稿存储接口变化',503);
  code=code.replace(key,()=>`const CONVERSATION_STORE_KEY = ${scoped('dsh.conversation')};`);
  const anchor='return (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\tclassName: ConversationRoot_module_css_default.root,';
  requireThat(code.split(anchor).length===2,'原生聊天内容接口变化',503);
  code=code.replace(anchor,()=>`if(window.__TEAM_STUDIO_MODE__){
   if(!window.__TEAM_STUDIO_VIEW__)throw Error('项目聊天组件尚未注册');
   return window.__TEAM_STUDIO_VIEW__(props,renderFactorySlot('conversation.content',{variant:'embedded',phase,hero}),renderSlot('conversation.header',{}));
  }
  `+anchor);
 }
 if(code.includes('function ConversationHeader({ sessionId, useSession, useConversation, renderSlot })')){
  const anchor='const blank = session === void 0 || conversation === void 0 || session.blank && conversationPhase(session, conversation) === "blank";';
  requireThat(code.split(anchor).length===2,'原生聊天操作栏接口变化',503);
  code=code.replace(anchor,()=>anchor+`
   if(window.__TEAM_STUDIO_MODE__)return sessionId===void 0?null:renderSlot('conversation.session.header',{hideChrome:blank});
  `);
  const signature='function ConversationSessionHeader({ sessionId, hideChrome, useSessions, useConversationViews, useStore, renderSlot, open, selectView, t }) {';
  requireThat(code.split(signature).length===2,'原生会话功能接口变化',503);
  code=code.replace(signature,()=>`function ConversationSessionHeader(props) {
   const { sessionId, hideChrome, useSessions, useConversationViews, useStore, renderSlot, open, selectView, t }=props;
   if(window.__TEAM_STUDIO_MODE__){
    if(!window.__TEAM_STUDIO_ACTIONS__)throw Error('会话操作组件尚未注册');
    return window.__TEAM_STUDIO_ACTIONS__(props);
   }
  `);
 }
 return code;
}

export function prepareStudioPlugin(codeRoot:string,control:string){
 const base=join(codeRoot,'native-harness/team-project'),bundle=join(base,'studio.cjs');
 requireThat(existsSync(bundle)&&existsSync(join(base,'studio.css')),'项目聊天组件尚未构建，请运行 npm run native:surface',503);
 const target=join(control,'team-project/client.js'),original=readFileSync(target,'utf8'),anchor='factory:require=>{',apply="return {inject:['slots','uiWorkspace','layout'],apply(ctx){";
 requireThat(original.split(anchor).length===2&&original.split(apply).length===2,'团队聊天组件注册接口变化',503);
 // Preserve compiled project code byte-for-byte. The legacy native asset
 // scoper rewrites literal /api paths; applying it inside this independent
 // project component would corrupt its validated project URLs and file links.
 const encoded=readFileSync(bundle).toString('base64');
 const code=original.replace(anchor,()=>anchor+`\nconst studioSurface=(()=>{const module={exports:{}},exports=module.exports;const source=new TextDecoder().decode(Uint8Array.from(atob('${encoded}'),c=>c.charCodeAt(0)));new Function('require','module','exports',source)(require,module,exports);return module.exports;})();\n`).replace(apply,()=>apply+'if(window.__TEAM_STUDIO_MODE__)studioSurface.installStudio(ctx);');
 writeFileSync(target,code);
 const metadata=join(control,'team-project/package.json'),pkg=JSON.parse(readFileSync(metadata,'utf8'));pkg.dsh.client.external=[...new Set([...(pkg.dsh.client.external??[]),'react','react/jsx-runtime'])];writeFileSync(metadata,JSON.stringify(pkg));
}

export function studioStyle(codeRoot:string){return readFileSync(join(codeRoot,'native-harness/team-project/studio.css'),'utf8');}
