import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import {chooseNativeHostFolder,createNativeFolderHost} from '../web/host-folder-bridge.ts';
import {nativePageBridge} from '../server/native-page.ts';
const {selectHostFolder}=createRequire(import.meta.url)('../desktop/host-folder.cjs');
const origin='http://127.0.0.1:4325',scope='admin:shared',root=realpathSync(tmpdir());
const flush=()=>new Promise<void>(r=>setImmediate(r));

function fixture(select?: (path:string)=>Promise<any>,outerOrigin='team://desktop'){
 const listeners=new Set<(event:any)=>void>(),replies:any[]=[],requests:any[]=[];let version=1;
 const native:any={location:{origin,pathname:'/harness/shared/'},document:{referrer:''},addEventListener:(name:string,fn:any)=>{if(name==='message')listeners.add(fn);},removeEventListener:(name:string,fn:any)=>listeners.delete(fn)};
 const outer:any={postMessage(data:any){requests.push(data);void host.receive({data,origin,source:native} as MessageEvent);}};
 native.parent=outer;native.postMessage=(data:any,target:string)=>{assert.equal(target,origin);replies.push(data);queueMicrotask(()=>{for(const fn of listeners)fn({data,source:outer,origin:outerOrigin});});};
 const host=createNativeFolderHost(()=>({source:native,origin,scope,version}),select);
 runInNewContext(nativePageBridge(scope),{window:native,document:{referrer:'',readyState:'loading',addEventListener(){}},location:{origin,hash:''},sessionStorage:{getItem:()=>null},URL});
 const child:any={parent:native,location:{origin,pathname:'/harness/shared/team-settings/'},crypto:{randomUUID}};
 return {host,native,child,outer,replies,requests,listeners,reload:()=>version++};
}

test('nested workspaces and directory settings reach the existing OS dialog through the real native page bridge',async()=>{
 let dialogs=0;const connection={origin,serverId:'test',epoch:1,call:async()=>({status:200,data:{user:{id:'admin',role:'admin'}}})};
 const f=fixture(async path=>({ok:true,value:await selectHostFolder({role:'host',connection,host:{status:async()=>({managed:true,url:origin,serverId:'test'})},showDialog:async(options:any)=>{dialogs++;assert.deepEqual(options.properties,['openDirectory']);assert.equal(options.defaultPath,path||undefined);return {filePaths:[root]};}},path)}));
 for(const initial of ['',root])assert.deepEqual(await chooseNativeHostFolder(initial,new AbortController().signal,f.child),{supported:true,path:root});
 assert.equal(dialogs,2);assert.equal(f.requests.filter(r=>r.type==='team-native-folder-picker').length,2);assert.equal(f.listeners.size,1);f.host.dispose();
});

test('cancel stays a native cancellation and failures remain visible rather than opening a web directory dialog',async()=>{
 const f=fixture(async()=>({ok:true,value:{cancelled:true}}));
 assert.deepEqual(await chooseNativeHostFolder('',new AbortController().signal,f.child),{supported:true,cancelled:true});
 const failed=fixture(async()=>({ok:false,error:'本机连接已变更'}));
 await assert.rejects(chooseNativeHostFolder('',new AbortController().signal,failed.child),/本机连接已变更/);
 const thrown=fixture(async()=>{throw Error('系统窗口打开失败');});
 await assert.rejects(chooseNativeHostFolder('',new AbortController().signal,thrown.child),/系统窗口打开失败/);
 for(const x of [f,failed,thrown]){assert.equal(x.listeners.size,1);x.host.dispose();}
});

test('browser settings use server directory browsing even with no referrer; direct desktop reuses IPC',async()=>{
 const browser=fixture(undefined,origin);
 assert.deepEqual(await chooseNativeHostFolder('',new AbortController().signal,browser.child),{supported:false});
 let calls=0;const direct:any={teamDesktop:{selectHostFolder:async(p:string)=>{calls++;assert.equal(p,root);return {ok:true,value:{path:root}};}}};
 assert.deepEqual(await chooseNativeHostFolder(root,new AbortController().signal,direct),{supported:true,path:root});assert.equal(calls,1);
 browser.host.dispose();
});

test('wrong frame, origin, project scope and malformed requests cannot open a system dialog',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return {ok:true,value:{cancelled:true}};});
 const valid={type:'team-native-folder-picker',scope,requestId:randomUUID(),initialPath:''};
 for(const event of [
  {data:valid,source:{},origin}, {data:valid,source:f.native,origin:'https://outside.invalid'},
  {data:{...valid,scope:'another:project'},source:f.native,origin},
  {data:{...valid,initialPath:{}},source:f.native,origin},
  {data:{...valid,requestId:'bad'},source:f.native,origin},
 ])await f.host.receive(event as MessageEvent);
 assert.equal(calls,0);assert.equal(f.replies.length,0);f.host.dispose();
});

test('repeated clicks share no additional dialog; a replacement page never receives the selected path',async()=>{
 let finish!:(r:any)=>void,calls=0;const f=fixture(()=>{calls++;return new Promise(r=>finish=r);});
 const abort=new AbortController(),first=chooseNativeHostFolder('',abort.signal,f.child);const cancelled=assert.rejects(first);
 await flush();const request=f.requests.at(-1);
 await f.host.receive({data:request,source:f.native,origin} as MessageEvent);
 await assert.rejects(chooseNativeHostFolder('',new AbortController().signal,f.child),/已有文件夹/);
 assert.equal(calls,1);f.reload();finish({ok:true,value:{path:'/private/project'}});await flush();
 assert(!JSON.stringify(f.replies).includes('/private/project'));abort.abort();await cancelled;assert.equal(f.listeners.size,1);f.host.dispose();
});

test('unmount releases listeners; forged replies are ignored; handshake timeout does not silently change pickers',async()=>{
 const f=fixture(()=>new Promise(()=>{}));const controller=new AbortController();
 const pending=chooseNativeHostFolder('',controller.signal,f.child);const rejected=assert.rejects(pending);await flush();
 const id=f.requests.at(-1).requestId;
 for(const fn of f.listeners)fn({source:{},origin:'https://outside.invalid',data:{type:'team-native-folder-picked',requestId:id,supported:true,result:{ok:true,value:{path:'/fake'}}}});
 assert.equal(f.listeners.size,2);controller.abort();await rejected;assert.equal(f.listeners.size,1);f.host.dispose();
 const dead=fixture();dead.native.__TEAM_SEND__=()=>{};
 await assert.rejects(chooseNativeHostFolder('',new AbortController().signal,dead.child,5),/暂未响应/);assert.equal(dead.listeners.size,1);dead.host.dispose();
});

test('add-workspace entrances contain only the hidden native picker bridge, without a custom modal',async()=>{
 const {readFileSync}=await import('node:fs');let plugin:any;const slots:any[]=[],events:any[]=[];
 const React={createElement:(type:any,props:any,...children:any[])=>({type,props,children}),useRef:()=>({current:null}),useEffect:()=>{}};
 const win:any={addEventListener(){},removeEventListener(){},__TEAM_CONTEXT__:{admin:true,project:'shared'},__TEAM_SEND__:(type:string,data:any)=>events.push({type,...data}),__ModuleLoader__:{load:(v:any)=>{plugin=v.factory(()=>React);}}};
 runInNewContext(readFileSync(new URL('../native-harness/team-project/client.js',import.meta.url),'utf8'),{window:win,location:{pathname:'/harness/shared/'},setTimeout,clearTimeout,document:{addEventListener(){},removeEventListener(){}}});
 plugin.apply({effect(){},slots:{inject:(_name:string,register:()=>any)=>register(),register:(spec:any,component:any)=>{slots.push({spec,component});return spec;}}});
 const entrances=slots.filter(s=>['sidebar.workspaces.directoryFlow','conversation.hero.workspace.directoryFlow'].includes(s.spec.name));assert.equal(entrances.length,2);
 for(const {component} of entrances){let cancelled=0;const tree=component({open:true,onCancel(){cancelled++;}});assert.equal(tree.props.workspaceAction,true);const frame=tree.type(tree.props);assert(frame.props.src.endsWith('action=add-workspace'));assert.equal(frame.props.hidden,true);assert.equal(frame.props.style.display,'none');tree.props.onFolderResult({cancelled:true});assert.equal(cancelled,1);assert.equal(events.length,0);}
});

test('administrator in a member workbench retains the native OS folder picker',async()=>{
 const f=fixture(async()=>({ok:true,value:{path:root}})),segment='shared~11111111-1111-1111-1111-111111111111';f.native.location.pathname='/harness/'+segment+'/';f.child.location.pathname='/harness/'+segment+'/team-settings/';
 assert.deepEqual(await chooseNativeHostFolder('',new AbortController().signal,f.child),{supported:true,path:root});f.host.dispose();
});
