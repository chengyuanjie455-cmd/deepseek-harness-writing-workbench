import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const source=readFileSync(new URL('../native-harness/team-project/client.js',import.meta.url),'utf8');
const own={phase:'ready',ids:['session-own'],byId:{'session-own':{id:'session-own',displayTitle:'我的聊天',cwd:'/workspace',blank:false}},current:'session-own'};
const workspace={phase:'ready',items:[{workspaceId:'workspace-main',path:'/workspace',title:'短剧项目',sessionIds:['session-own']},{workspaceId:'workspace-other',path:'/workspace/other',title:'其它目录',sessionIds:[]}],archivedSessionIds:[]};
const members=[{id:'member-a',name:'成员甲',sessions:[{id:'session-same',title:'补抽意见',messageCount:2,updated:30,status:'running'},{id:'session-old',title:'旧聊天',messageCount:1,archived:true,subagent:true}]},{id:'member-b',name:'成员乙',sessions:[{id:'session-same',title:'补抽意见',messageCount:2,updated:40}]}];
function fixture(admin=true,projects?:any[]){
 let plugin:any;const effects:any[]=[],registrations:any[]=[],listeners=new Map<string,Set<any>>();
 const win:any={__TEAM_CONTEXT__:{admin,project:'shared'},__ModuleLoader__:{load:(v:any)=>{plugin=v.factory((name:string)=>name==='react'?React:{});}},addEventListener:(key:string,fn:any)=>{if(!listeners.has(key))listeners.set(key,new Set());listeners.get(key)!.add(fn);},removeEventListener:(key:string,fn:any)=>listeners.get(key)?.delete(fn),dispatchEvent:(e:any)=>{for(const fn of listeners.get(e.type)??[])fn(e);}};
 const globals:any={window:win,location:{pathname:'/harness/shared/'},setTimeout,clearTimeout,AbortController,document:{addEventListener(){},removeEventListener(){}},fetch:async()=>({ok:true,json:async()=>projects?{projects}:{members}}),CustomEvent:class{constructor(public type:string,public options:any){}get detail(){return this.options?.detail;}}};
 // Expose closures only in this VM fixture; shipped code has no testing surface.
 runInNewContext(source.replace(" return {inject:['slots'"," window.testing={store:()=>memberWorkspace,MemberSessionGroups}; return {inject:['slots'"),globals);
 const ctx:any={effect:(fn:any)=>effects.push(fn),slots:{inject:(_name:string,register:()=>any)=>{const result=register();if(result?.[Symbol.iterator])for(const unused of result)void unused;return result;},register:(spec:any,component:any)=>{registrations.push({spec,component});return()=>{};}}};
 plugin.apply(ctx);return {globals,plugin,effects,registrations,ctx,win};
}

test('members merge under the native project without altering either controller; duplicate session ids remain owner-qualified',()=>{
 const f=fixture(),before=JSON.stringify({own,workspace,members});
 const view=f.globals.projectMemberWorkspace(own,workspace,members,{member:'member-b',session:'session-same'});
 assert.equal(view.workspace.items.length,2);assert.equal(view.workspace.items[0].sessionIds.length,4);assert.equal(view.workspace.items[1],workspace.items[1]);
 assert.equal(view.list.ids.length,4);assert.equal(view.list.current,'team-observe:member-b:session-same');assert.equal(view.list.byId['session-own'],own.byId['session-own']);
 assert.equal(view.list.byId['team-observe:member-a:session-same'].running,true);assert.equal(view.list.byId['team-observe:member-b:session-same'].displayTitle,'成员乙 · 补抽意见');assert.match(view.list.byId['team-observe:member-a:session-old'].displayTitle,/已归档.*子会话/);
 assert.equal(JSON.stringify({own,workspace,members}),before);
 const other=f.globals.projectMemberWorkspace(own,{...workspace,items:[workspace.items[1]]},members,null);assert.equal(other.list,own);assert.equal(other.observed.size,0);
 const bad=f.globals.projectMemberWorkspace(own,workspace,[...members,{id:'x',name:'x',sessions:[{id:'../../escape'}]}],null);assert.equal(bad.observed.size,3);assert.equal(bad.list.current,'session-own');
});

test('refreshes coalesce, retain the last list on failure and discard responses after project disposal',async()=>{
 const f=fixture();let finish:any,signal:any,calls=0;const timers:any[]=[];
 const store=f.globals.createMemberWorkspaceStore({fetchList:(s:any)=>{signal=s;calls++;return new Promise(r=>finish=r);},setTimer:(fn:any)=>{timers.push(fn);return fn;},clearTimer:()=>{}});
 const a=store.refresh(),b=store.refresh();assert.equal(calls,1);finish({members});await Promise.all([a,b]);assert.equal(store.getSnapshot().members,members);
 store.select({member:'member-a',session:'session-same'});assert.equal(store.getSnapshot().selected.member,'member-a');
 const next=store.refresh();assert.equal(calls,2);store.dispose();assert(signal.aborted);finish({members:[]});await next;assert.equal(store.getSnapshot().members,members);
 let fails=false;const retry=f.globals.createMemberWorkspaceStore({fetchList:async()=>{if(fails)throw Error('暂时离线');return {members};},setTimer:()=>0,clearTimer:()=>{}});await retry.refresh();fails=true;await retry.refresh();assert.equal(retry.getSnapshot().members,members);assert.equal(retry.getSnapshot().error,'暂时离线');retry.dispose();
});

test('admin duplicate navigation is removed while settings, tools and add-workspace entries remain',()=>{
 const admin=fixture(),member=fixture(false);
 assert(!admin.registrations.some(r=>r.spec.name==='sidebar.panellist'&&r.spec.id==='team-member-chats'));
 assert(admin.registrations.some(r=>r.spec.name==='main'&&r.spec.key==='team-member-chats'));
 assert(!member.registrations.some(r=>r.spec.key==='team-member-chats'));
 for(const section of ['models','tasks','workspaces','members','prompts','billing','operations'])assert(admin.registrations.some(r=>r.spec.name==='settings.section'&&r.spec.id===section));
 for(const [f,label] of [[admin,'任务中心'],[member,'我的统计']] as const){
  const sidebar=f.registrations.filter(r=>r.spec.name==='sidebar.panellist');assert.deepEqual(sidebar.map(r=>r.spec.id),['team-files']);
  const tasks=f.registrations.find(r=>r.spec.name==='settings.section'&&r.spec.id==='tasks')!;assert.equal(tasks.spec.label(),label);
  const html=renderToStaticMarkup(React.createElement(tasks.component));assert(html.includes('/team-settings/?view=tasks'));assert(html.includes('title="'+label+'"'),'settings reuses the existing task page');
 }
 for(const slot of ['sidebar.workspaces.directoryFlow','conversation.hero.workspace.directoryFlow'])assert(admin.registrations.some(r=>r.spec.name===slot));
});

test('wrapper reuses native browser and folder flow; member selection and own actions target their original identities',async()=>{
 const f=fixture();let nativeProps:any,registered:any;const original={component:(props:any)=>{nativeProps=props;return React.createElement('div',null,props.useSessions((s:any)=>s.ids.map((id:string)=>s.byId[id].displayTitle).join('|')));},options:{},children:{'sidebar.workspaces.directoryFlow':{kind:'single',scope:'root'}},store:{identity:'native'},inject:()=>({native:true}),locale:'workspace'};
 f.ctx.slots={...f.ctx.slots,entries:()=>[original],subscribe:()=>()=>{},register:(spec:any,component:any)=>{registered={spec,component};return()=>{};}};
 const cleanup=f.effects[1]();assert.equal(registered,undefined,'decorate the native entry without registering duplicate child slots');assert.equal(typeof f.win.__TEAM_WORKSPACE_BROWSER__,'function');
 const store=f.win.testing.store();await store.refresh();let originalOpened='',started=false;
 const props={wide:true,useSessions:(s:any)=>s(own),useWorkspaces:(s:any)=>s(workspace),usePanelInfo:(s:any)=>s({activePanelId:null}),open:(id:string)=>originalOpened=id,startSession:()=>started=true,renameSession:async()=>{},forkSession:()=>{},archiveSession:async()=>{},insertSessionBefore:async()=>{},renderSlot:(name:string)=>name,t:(key:string,v:any)=>v?.name??key};
 const html=renderToStaticMarkup(f.win.__TEAM_WORKSPACE_BROWSER__(original.component,props));assert(html.includes('我的聊天'));assert(html.includes('成员乙 · 补抽意见'));
 const opened:any[]=[];f.win.__TEAM_SEND__=(type:any,value:any)=>opened.push({type,...value});nativeProps.open('team-observe:member-b:session-same');assert.deepEqual(opened,[{type:'team-project-select',project:'shared',member:'member-b',session:'session-same'}]);assert.equal(store.getSnapshot().selected,null);assert.equal(originalOpened,'');
 await assert.rejects(nativeProps.renameSession('team-observe:member-b:session-same'),/成员聊天/);
 nativeProps.open('session-own');assert.equal(originalOpened,'session-own');assert.equal(store.getSnapshot().selected,null);
 nativeProps.startSession();assert(started);assert.equal(nativeProps.renderSlot('sidebar.workspaces.directoryFlow',{}),'sidebar.workspaces.directoryFlow');cleanup();store.dispose();
});

test('all project roots coexist; project-qualified rows preserve collisions across owners and projects',()=>{
 const f=fixture(),projects=[{id:'shared',name:'甲项目',members:[{id:'admin',self:true,sessions:[{id:'session-own',messageCount:1}]},...members]},{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',name:'乙项目',members:[{id:'admin',self:true,name:'管理员',sessions:[{id:'session-own',title:'乙的自己的聊天',messageCount:1}]},...members]}];
 const before=JSON.stringify({own,workspace,projects}),view=f.globals.allProjectWorkspace(own,workspace,projects,'shared',{project:'shared',member:'member-a',session:'session-same'});
 assert.deepEqual(Array.from(view.workspace.items,(w:any)=>w.title),['甲项目','乙项目','其它目录']);assert.equal(view.list.current,'team-observe:shared:member-a:session-same');assert.equal(view.observed.size,7);
 const foreign=view.observed.get('team-observe:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb:member-a:session-same');assert.equal(foreign.project,projects[1].id);assert.equal(foreign.member,'member-a');assert.equal(foreign.session,'session-same');
 assert.equal(view.foreign.get('team-project:'+projects[1].id),projects[1].id);assert.equal(view.list.byId['session-own'],own.byId['session-own']);assert.equal(JSON.stringify({own,workspace,projects}),before);
});

test('foreign project selection stays in the host page and carries exact project and owner; creating a chat never touches the current controller',async()=>{
 const project='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',f=fixture(true,[{id:'shared',name:'甲',members},{id:project,name:'乙',members}]);let nativeProps:any,entry:any;const sent:any[]=[];f.win.__TEAM_SEND__=(type:any,payload:any)=>sent.push({type,...payload});
 const original={component:(p:any)=>{nativeProps=p;return null;},options:{},children:{'sidebar.workspaces.directoryFlow':{}},store:{},inject:()=>({})};f.ctx.slots={...f.ctx.slots,entries:()=>[original],subscribe:()=>()=>{},register:(spec:any,component:any)=>{entry={spec,component};return()=>{};}};
 const cleanup=f.effects[1](),store=f.win.testing.store();await store.refresh();let ownOp=0;
 renderToStaticMarkup(f.win.__TEAM_WORKSPACE_BROWSER__(original.component,{wide:true,useSessions:(s:any)=>s(own),useWorkspaces:(s:any)=>s(workspace),usePanelInfo:(s:any)=>s({activePanelId:null}),open:()=>ownOp++,startSession:()=>ownOp++,renameSession:()=>ownOp++,forkSession:()=>ownOp++,archiveSession:()=>ownOp++,insertSessionBefore:()=>ownOp++,insertWorkspaceBefore:()=>ownOp++,renderSlot:()=>null,t:(k:string)=>k}));
 nativeProps.open('team-observe:'+project+':member-b:session-same');nativeProps.startSession('team-project:'+project);
 assert.deepEqual(sent,[{type:'team-project-select',project,session:'session-same',member:'member-b'},{type:'team-project-select',project,newChat:true}]);assert.equal(ownOp,0);assert.equal(store.getSnapshot().selected,null);
 nativeProps.open('session-own');assert.equal(ownOp,1);cleanup();store.dispose();
});

test('workspace renders only active members with history and hides an empty own group without deleting its native draft',()=>{
 const f=fixture(),hidden=[{id:'disabled',name:'停用成员',active:false,sessions:[{id:'session-disabled',messageCount:3}]},{id:'empty',name:'空白成员',active:true,sessions:[{id:'session-empty',messageCount:0}]}];
 const draft={...own,byId:{'session-own':{...own.byId['session-own'],blank:true}}};
 const rows=[...members,...hidden],before=JSON.stringify({draft,workspace,rows});
 const view=f.globals.projectMemberWorkspace(draft,workspace,rows,null);
 assert.equal(view.observed.size,3);assert(!view.list.ids.some((id:string)=>id.includes('disabled')||id.includes('empty')));
 assert.equal(view.list.byId['session-own'],draft.byId['session-own'],'the original draft remains available to the native composer');
 const render=(byId:any)=>renderToStaticMarkup(React.createElement(f.win.testing.MemberSessionGroups,{group:{expanded:true,sessions:view.list.ids.map((id:string)=>({id}))},renderRow:(node:any)=>React.createElement('span',{key:node.id},node.id),members:rows,observed:view.observed,current:'session-own',t:(key:string)=>key,sessionById:byId}));
 const html=render(draft.byId);assert(html.includes('成员甲'));assert(html.includes('成员乙'));assert(!html.includes('停用成员'));assert(!html.includes('空白成员'));assert(!html.includes('data-member-id="self"'));
 assert(render(own.byId).includes('data-member-id="self"'),'sending the first message makes the native member group visible');
 assert.equal(JSON.stringify({draft,workspace,rows}),before);
});
