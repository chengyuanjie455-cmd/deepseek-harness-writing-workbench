import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Platform} from '../server/app.ts';import {id} from '../server/store.ts';
import {projectSourceContext,registerProjectSourceContext,teamDefinitions,teamInstructions} from '../native-harness/team-project/index.mjs';

test('native chat independently lists and reads every published project file without manual references and cannot read another project',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'native-project-source-'))),app=new Platform({dataDir:join(root,'data'),nativeOnly:true});
 try{
  const admin=app.newUser({username:'admin',password:'Project-sources-2026!'},'admin'),user=app.newUser({username:'member',password:'Project-sources-2026!'},'member');
  const folder=join(root,'project-a');mkdirSync(folder);for(let n=1;n<=106;n++)writeFileSync(join(folder,`EP001_${String(n).padStart(3,'0')}.md`),'本项目合成正文 '+n);
  const preview=app.projects.previewNew(admin,folder,'剧本核心项目'),project=await app.createProject(admin,{previewId:preview.id,digest:preview.digest});
  const i:any={key:app.native.key(user,project.id),owner:user.id,project:project.id,root:join(root,'native'),work:join(root,'native','workspace'),active:0,closed:false};mkdirSync(i.work,{recursive:true});
  const tool=(operation:string,args:any={})=>app.native.team.tool(i,user,{action:'project_files',sessionId:'session-sources',callId:id(),args:{operation,...args}});
  const first=await tool('list');assert.equal(first.total,106);assert.equal(first.files.length,100);assert.equal(first.nextOffset,100);assert.equal(first.name,'剧本核心项目');
  const last=await tool('list',{offset:first.nextOffset});assert.equal(last.files.length,6);assert.equal(last.nextOffset,null);assert.equal(last.project,project.id);
  const read=await tool('read',{paths:['EP001_106.md']});assert.match(read.content,/本项目合成正文 106/);assert.equal(read.revision,first.revision);
  assert(!first.files.some((f:any)=>f.path==='README.md'));await assert.rejects(tool('attach',{paths:['README.md']}),/当前项目不存在/);for(const path of ['../private.md','/etc/passwd'])await assert.rejects(tool('read',{paths:[path]}));
  const attachment=await tool('attach',{paths:['EP001_106.md']});assert.equal(attachment.files[0].project,project.id);assert.match(attachment.files[0].download,/^\/api\/team\/project-file/);
  app.native.get=async()=>i;const base='http://127.0.0.1:'+await app.start(0),login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({username:'member',password:'Project-sources-2026!'})});const cookie=login.headers.get('set-cookie')!.split(';')[0];await login.text();
  const response=await fetch(base+'/harness/'+project.id+attachment.files[0].download,{headers:{Cookie:cookie}});assert.equal(response.status,200);assert(response.headers.get('content-disposition')!.includes('EP001_106.md'));assert.equal(await response.text(),'本项目合成正文 106');
  const blocked=await fetch(base+'/harness/'+project.id+'/api/team/project-file?path=README.md',{headers:{Cookie:cookie}});assert.equal(blocked.status,404);await blocked.text();assert.equal(app.store.all('model-call').length,0);
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
test('project source context carries identity, revision and pagination without claiming that the whole project was read',()=>{
 const text=projectSourceContext({project:'p-a',name:'项目A',revision:'r1',total:150,files:[{path:'剧本/EP001.md'}],nextOffset:100});assert.match(text,/"project":"p-a"/);assert.match(text,/"revision":"r1"/);assert.match(text,/"nextOffset":100/);assert.match(text,/引用不是权限清单/);
 assert(teamDefinitions.some(([name])=>name==='team_project_files'));assert(!teamInstructions.includes('主机文件访问不再受项目或工作区范围限制'));assert.match(teamInstructions,/全部已发布内容/);
});
test('each native model turn receives fresh current-project source context, and a failed read is explicit',async()=>{
 let handler:any;registerProjectSourceContext({on:(_name:string,h:any)=>{handler=h;}},{baseURL:'http://fixture.invalid'});const previous=globalThis.fetch;const calls:any[]=[];
 try{globalThis.fetch=async(_url,options)=>{calls.push(JSON.parse(String(options?.body)));return new Response(JSON.stringify({project:'project-a',revision:'r2',total:0,files:[],nextOffset:null}));};
 const result=await handler({}, {agent:{session:{id:'session-a'}}},async()=>({contexts:[]}));assert.equal(result.contexts[0].name,'team-project-source');assert.match(result.contexts[0].text,/r2/);assert.deepEqual(calls[0],{action:'project_files',args:{operation:'list'},sessionId:'session-a'});
 globalThis.fetch=async()=>{throw Error('offline');};const failed=await handler({}, {agent:{session:{id:'session-a'}}},async()=>({contexts:[]}));assert.match(failed.contexts[0].text,/不能声称文件为空/);
 }finally{globalThis.fetch=previous;}
});
