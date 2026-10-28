import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addWorkspaceFromNativeFolder} from '../web/native-workspace-folder';
test('native selection creates with the existing preview digest and derives a folder name',async()=>{
 const calls:any[]=[];
 const result=await addWorkspaceFromNativeFolder(async(...args)=>{calls.push(args);return calls.length===1?{id:'preview',digest:'exact-digest'}:{id:'project'};},new AbortController().signal,async()=>({supported:true,path:'/path/to/creator/短剧项目'}));
 assert.deepEqual(calls,[['/admin/projects/preview','POST',{path:'/path/to/creator/短剧项目',name:'短剧项目'}],['/admin/projects','POST',{previewId:'preview',digest:'exact-digest'}]]);
 assert.deepEqual(result,{project:'project'});
});
test('cancel and browser-only selection do not create a project',async()=>{
 let calls=0;const api=async()=>{calls++;};
 assert.deepEqual(await addWorkspaceFromNativeFolder(api,new AbortController().signal,async()=>({supported:true,cancelled:true})),{cancelled:true});
 assert.deepEqual(await addWorkspaceFromNativeFolder(api,new AbortController().signal,async()=>({supported:false})),{unsupported:true});assert.equal(calls,0);
});
test('preview rejection and disposal prevent a create, uncertain creation is never retried',async()=>{
 const choose=async()=>({supported:true as const,path:'/tmp/project'});let calls=0;
 await assert.rejects(addWorkspaceFromNativeFolder(async()=>{calls++;throw Error('目录重叠');},new AbortController().signal,choose),/目录重叠/);assert.equal(calls,1);
 calls=0;const abort=new AbortController();await assert.rejects(addWorkspaceFromNativeFolder(async()=>{calls++;abort.abort();return {id:'p',digest:'d'};},abort.signal,choose));assert.equal(calls,1);
 calls=0;await assert.rejects(addWorkspaceFromNativeFolder(async()=>{if(++calls===1)return {id:'p',digest:'d'};throw Error('暂未收到服务器确认');},new AbortController().signal,choose),/暂未收到服务器确认/);assert.equal(calls,2);
});
