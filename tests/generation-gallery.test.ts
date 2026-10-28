import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {createMediaGallery} from '../native-harness/team-project/media-gallery.mjs';import {adaptNativeClient,scopeNativeAsset} from '../server/native-page.ts';
const client=readFileSync(new URL('../native-harness/team-project/client.js',import.meta.url),'utf8');
function helpers(){const c:any={queueMicrotask,window:{__ModuleLoader__:{load(){}}}};vm.runInNewContext(client,c);return c;}
const row=(n:number,session='session-one')=>({kind:'image',sessionId:session,plan:{id:'p'+n,owner:'member',state:'confirmed',model:{name:'gpt-image-1k-16x9'},jobs:[{id:'j'+n,state:'submitting'}]}});
test('folded native tool data exposes one live assembly card per original job without treating arbitrary file text as a task',()=>{
 const {turnAssemblyJobs}=helpers(),block=(name:string,value:any)=>({call:{name},content:[{type:'text',text:JSON.stringify(value)}]}),first=block('team_video_assemble',{kind:'assembly',job:{id:'a',state:'waiting_sources'}}),latest=block('team_video_assembly_status',{kind:'assemblies',items:[{id:'a',state:'ready',mediaId:'original'},{id:'b',state:'failed'}]}),root:any={subCalls:[first,latest,block('read',{kind:'assembly',job:{id:'not-a-task'}}),{...block('team_video_assemble',{kind:'assembly',job:{id:'error'}}),isError:true}]};root.subCalls.push(root);
 const jobs=turnAssemblyJobs([{root}]);assert.equal(jobs.length,2);assert.equal(jobs[0].id,'a');assert.equal(jobs[0].state,'ready');assert.equal(jobs[0].mediaId,'original');assert.equal(jobs[1].id,'b');
});
test('mixed video references retain video preview and audio playback with original authenticated downloads',()=>{
 let plugin:any;const entries:any[]=[],references:any[]=[];const prefix='/harness/shared~member';
 const runtime={...React,createElement(type:any,props:any,...children:any[]){if(type?.name==='ChatGalleryLink')references.push(...(props.items??[]));return React.createElement(type,props,...children);}};
 const w:any={__TEAM_CONTEXT__:{admin:false,project:'shared',user:'member'},__TEAM_CREATE_GALLERY__:createMediaGallery,__ModuleLoader__:{load(v:any){plugin=v.factory(()=>runtime);}}};
 vm.runInNewContext(scopeNativeAsset(client,prefix),{window:w,location:{pathname:prefix+'/'},setTimeout,clearTimeout,queueMicrotask});
 plugin.apply({effect(){},slots:{inject(_n:string,f:Function){f();},register(o:any,view:any){entries.push({...o,view});}}});
 const View=entries.find(v=>v.key==='team_video_generate').view;
 const value={kind:'video',plan:{id:'mixed',state:'draft',model:{name:'sd2.5'},shots:[{prompt:'画面',assets:[{mediaId:'image',mime:'image/png'},{mediaId:'video',mime:'video/mp4'},{mediaId:'audio',mime:'audio/wav',name:'同期声.wav'}]}],jobs:[]}};
 const html=renderToStaticMarkup(React.createElement(View,{block:{content:[{type:'text',text:JSON.stringify(value)}]}}));
 assert.deepEqual(references.map(v=>v.kind),['image','video']);
 assert(references[1].src===prefix+'/api/team/media/video');
 assert(html.includes('<audio controls="" preload="none" src="'+prefix+'/api/team/media/audio'));
 assert(html.includes(prefix+'/api/team/media/audio?download=1'));
 assert(!references.some(v=>v.id==='media:audio'),'audio never enters image/video previews');
});
test('one turn combines two five-call batches, deduplicates refreshes, hands off the gallery owner and releases state',async()=>{
 const {createImageTurnRegistry,imageTurnKey}=helpers(),r=createImageTurnRegistry(),key=imageTurnKey(row(0),7,'/harness/shared'),off:Function[]=[],tokens=Array.from({length:10},(_,n)=>Symbol(n));
 for(let n=0;n<10;n++)off.push(r.mount(key,tokens[n],row(n),n));assert.equal(r.get(key).rows.length,10);assert.equal(r.get(key).leader,tokens[0]);
 r.update(key,{...row(3),plan:{...row(3).plan,jobs:[{id:'j3',state:'ready',mediaId:'original'}]}});assert.equal(r.get(key).rows.length,10);assert.equal(r.get(key).rows[3].plan.jobs[0].state,'ready');
 off[0]();assert.equal(r.get(key).leader,tokens[1]);assert.equal(r.get(key).rows.length,10,'virtualized first card keeps discovered images');for(const f of off.slice(1))f();await Promise.resolve();assert.equal(r.size(),0);
 assert.notEqual(key,imageTurnKey(row(0),8,'/harness/shared'));assert.notEqual(key,imageTurnKey(row(0,'session-two'),7,'/harness/shared'));assert.notEqual(key,imageTurnKey(row(0),7,'/harness/shared~other'));assert.notEqual(imageTurnKey(row(0),undefined,''),imageTurnKey(row(1),undefined,''),'unknown old metadata never guesses a batch');
});
test('native tool renderer forwards native turn and order without modifying frozen call blocks',()=>{
 const signature='function ToolCallTree({ renderSlot, node, cwd, openFile, inspectCall, loadImage, useHostInfo, t }) {';
 const source=readFileSync(new URL('./fixtures/native-tool-tree-0.1.5.js',import.meta.url),'utf8');assert(source.includes(signature));
 const c:any={node:{location:{kind:'step',turn:{turn:7,status:'closed'},step:{step:2,status:'closed'}},anchorSeq:50,data:{root:Object.freeze({kind:'tool-result',callId:'a'})}}};c.react_jsx_runtime={jsx:(_component:any,props:any)=>props};c.ToolCallBranch=()=>null;vm.runInNewContext(adaptNativeClient(source)+`;branch=ToolCallTree({node,useHostInfo:fn=>fn({home:'/workspace'}),renderSlot:(_slot,owner)=>owner});result=branch.renderSlot('tool.call.toolview',{block:branch.block});`,c);assert.equal(c.result.teamGalleryTurn,7);assert.equal(c.result.teamGalleryOrder,50);assert.equal(c.result.block,c.node.data.root);
});
test('batched image results render one Finder gallery with ten progress thumbnails and keep authenticated media URLs',()=>{
 let plugin:any;const entries:any[]=[];const prefix='/harness/shared~member';const w:any={__TEAM_CONTEXT__:{admin:true,project:'shared',user:'member'},__TEAM_CREATE_GALLERY__:createMediaGallery,__ModuleLoader__:{load(v:any){plugin=v.factory(()=>React);}}};vm.runInNewContext(scopeNativeAsset(client,prefix),{window:w,location:{pathname:prefix+'/'},setTimeout,clearTimeout,queueMicrotask});plugin.apply({effect(){},slots:{inject(_n:string,f:Function){f();},register(o:any,view:any){entries.push({...o,view});}}});const View=entries.find(v=>v.key==='team_task_status').view;const rows=Array.from({length:10},(_,n)=>row(n));rows[0].plan.jobs[0]={id:'j0',state:'ready',mediaId:'original'} as any;const html=renderToStaticMarkup(React.createElement(View,{block:{content:[{type:'text',text:JSON.stringify({kind:'plans',items:rows})}]}}));assert.equal((html.match(/aria-label="本轮图片生成画廊"/g)??[]).length,1);assert.equal((html.match(/class="media-gallery-thumb"/g)??[]).length,10);assert(html.includes('10 张 · 1 张已返回 · 9 张处理中'));assert(html.includes(prefix+'/api/team/media/original?download=1'));assert(!html.includes(prefix+prefix));assert(html.includes('查看单图详情'));assert.equal((html.match(/关闭页面后继续生成/g)??[]).length,1);
});
test('waiting and failed images show actual status instead of an endless media loader; large batches stay bounded',()=>{
 const Gallery=createMediaGallery(React),items=Array.from({length:500},(_,n)=>({id:String(n),name:'图片 '+n,kind:'image' as const,status:n===0?'提交结果待后台核对':'生成中',error:n===0?'等待核对原请求，不会重新生成':undefined}));const html=renderToStaticMarkup(React.createElement(Gallery,{items}));assert(html.includes('提交结果待后台核对'));assert(html.includes('等待核对原请求'));assert(!html.includes('正在加载预览'));assert.equal((html.match(/class="media-gallery-thumb"/g)??[]).length,21);assert(html.includes('1 / 500'));
});

test('completed native turn renders generated media without mounting any folded tool card',()=>{
 let plugin:any;const entries:any[]=[];const prefix='/harness/shared~member';const w:any={__TEAM_CONTEXT__:{admin:false,project:'shared',user:'member'},__TEAM_CREATE_GALLERY__:createMediaGallery,__ModuleLoader__:{load(v:any){plugin=v.factory(()=>React);}}};
 const context:any={window:w,location:{pathname:prefix+'/'},setTimeout,clearTimeout,queueMicrotask};vm.runInNewContext(scopeNativeAsset(client,prefix),context);
 plugin.apply({effect(){},slots:{inject(_n:string,f:Function){f();},register(o:any,view:any){entries.push({...o,view});}}});
 const rows=Array.from({length:10},(_,n)=>row(n));rows[0].plan.jobs[0]={id:'j0',state:'ready',mediaId:'original'} as any;
 const call=(value:any)=>({kind:'tool-result',call:{name:'team_image_generate'},content:[{type:'text',text:JSON.stringify(value)}],subCalls:[]});
 const nested={root:{call:{name:'code'},subCalls:rows.map(call)}};
 const status={root:{call:{name:'team_task_status'},content:[{type:'text',text:JSON.stringify({kind:'plans',items:[row(99)]})}]}};
 const data=[nested,{root:call(rows[0])},status];const snapshot={nodes:{turnDataSource(turn:number,kind:string){assert.equal(turn,7);assert.equal(kind,'tool-call');return {subscribe:()=>()=>{},getSnapshot:()=>data};}}};
 const View=entries.find(v=>v.name==='conversation.chat.turnTail'&&v.id==='team-turn-generation-gallery').view;
 const html=renderToStaticMarkup(React.createElement(View,{turn:{turn:7,status:'closed'},sessionId:'session-one',useChat:(fn:Function)=>fn(snapshot)}));
 assert.equal((html.match(/aria-label="本轮图片生成画廊"/g)??[]).length,1);assert.equal((html.match(/class="media-gallery-thumb"/g)??[]).length,10);
 assert(html.includes('data-team-turn-gallery="7"'));assert(html.includes('10 张 · 1 张已返回 · 9 张处理中'));assert(html.includes(prefix+'/api/team/media/original?download=1'));
 assert.equal(context.turnGenerationPlans([status]).length,0,'a status lookup must not attach earlier turns to this submission');
 const ClosedTool=entries.find(v=>v.key==='team_image_generate').view;const closed=renderToStaticMarkup(React.createElement(ClosedTool,{block:call(rows[0]),teamGallerySettled:true}));assert(!closed.includes('media-gallery-thumb'),'expanding process must not duplicate the inline gallery');
 const video={kind:'video',plan:{id:'video',jobs:[{id:'vjob',state:'ready',mediaId:'video-original'}]}};
 const extracted=context.turnGenerationPlans([{root:{call:{name:'team_video_generate'},content:[{type:'text',text:JSON.stringify(video)}]}}]);assert.equal(extracted[0].kind,'video');
});
