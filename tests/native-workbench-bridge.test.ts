import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {acceptsProjectFiles} from '../web/native-workbench-bridge';
import {nativePageBridge} from '../server/native-page';

test('project file navigation accepts only the visible owning frame and current authenticated generation',()=>{
 const source={},view={source,url:'https://host.example/harness/shared/',scope:'member:shared',version:7,project:'shared',visible:true};
 const data={type:'team-workbench-panel',protocolVersion:1,scope:view.scope,version:7,project:'shared',section:'files'},event={source,origin:'https://host.example',data};
 assert.equal(acceptsProjectFiles(event,view),true);
 for(const patch of [{source:{}},{origin:'https://foreign.example'},{data:{...data,scope:'other:shared'}},{data:{...data,version:6}},{data:{...data,project:'other'}},{data:{...data,section:'models'}},{data:{...data,protocolVersion:2}}])assert.equal(acceptsProjectFiles({...event,...patch},view),false);
 assert.equal(acceptsProjectFiles(event,{...view,visible:false}),false);assert.equal(acceptsProjectFiles(event,{...view,source:undefined}),false);
});

test('native project view delegation is explicitly negotiated; old and standalone parents retain their file view',()=>{
 const sent:any[]=[],listeners=new Map<string,Function>(),parent={postMessage:(v:any)=>sent.push(v)};
 const win:any={parent,addEventListener:(k:string,f:Function)=>listeners.set(k,f)};
 vm.runInNewContext(nativePageBridge('member:shared',{project:'shared',admin:false}),{window:win,document:{referrer:'https://host.example/',readyState:'loading',addEventListener(){},querySelector:()=>null},location:{origin:'https://host.example',hash:''},sessionStorage:{getItem:()=>null,setItem(){}},URL,Date,Map,Promise,setTimeout(){}});
 const probe=(data:any,origin='https://host.example',source=parent)=>listeners.get('message')!({source,origin,data:{type:'team-native-probe',scope:'member:shared',version:7,...data}});
 assert.equal(win.__TEAM_OPEN_WORKBENCH_PANEL__('files'),false);
 probe({workbenchPanels:['files']},'https://foreign.example');probe({workbenchPanels:['files']},undefined,{} as any);assert.equal(win.__TEAM_OPEN_WORKBENCH_PANEL__('files'),false);
 probe({workbenchPanels:['files']});assert.equal(win.__TEAM_OPEN_WORKBENCH_PANEL__('files'),true);assert.equal(sent.at(-1).section,'files');assert.equal(sent.at(-1).version,7);assert.equal(sent.at(-1).project,'shared');assert.equal(win.__TEAM_OPEN_WORKBENCH_PANEL__('models'),false);
 probe({});assert.equal(win.__TEAM_OPEN_WORKBENCH_PANEL__('files'),false);
});

test('native file slot reuses the current conversation in a workbench and retains complete standalone tools',()=>{
 const source=readFileSync(new URL('../native-harness/team-project/client.js',import.meta.url),'utf8');let plugin:any;
 const registered=new Map<string,any>(),selected:string[]=[],requests:string[]=[],effects:Function[]=[];
 const win:any={__TEAM_CONTEXT__:{project:'shared',admin:false},__TEAM_WORKBENCH_PANELS__:['files'],__TEAM_OPEN_WORKBENCH_PANEL__:(section:string)=>{requests.push(section);return true;},__ModuleLoader__:{load:(value:any)=>{plugin=value.factory(()=>({createElement:(type:any,props:any)=>({type,props}),useEffect:(f:Function)=>effects.push(f)}));}}};
 vm.runInNewContext(source,{window:win,setTimeout,clearTimeout,location:{pathname:'/harness/shared/'}});
 plugin.apply({effect(){},layout:{selectPanel:(key:string)=>selected.push(key)},slots:{inject:(name:string,f:Function)=>{if(name==='main')f();},register:(options:any,render:any)=>{registered.set(options.key,render);}}});
 const render=registered.get('team-files');assert.equal(typeof render,'function');assert.equal(render(),null);effects.shift()!();assert.deepEqual(requests,['files']);assert.deepEqual(selected,['conversation']);
 win.__TEAM_WORKBENCH_PANELS__=[];const fallback=render();assert.equal(fallback.props.section,'files');assert.equal(fallback.props.panel,true);assert.equal(typeof fallback.props.onDraft,'function');effects.shift()!();assert.equal(requests.length,1);
});
