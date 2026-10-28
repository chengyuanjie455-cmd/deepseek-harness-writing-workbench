const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {NativeAccess}=require('../native-access.cjs');
const {isDesktopPage}=require('../host-folder.cjs');
const {isSurfacePage,permittedSender,validProjectRequest,openProject}=require('../project-surface.cjs');
function fixture(){const access=new NativeAccess(),connection={origin:'http://127.0.0.1:4326',epoch:7,call:async()=>({status:200,data:{capabilities:['native-project-surface']}})},url=connection.origin+'/harness/shared/';return {access,connection,url};}
function accepted(url){return new Response('',{status:302,headers:{'Set-Cookie':'team_native_012345=abcdef012345; HttpOnly','Location':new URL(url).pathname}});}

test('direct surface IPC belongs only to the authenticated top-level document and current login',()=>{
 const {access,connection,url}=fixture(),mainFrame={url},webContents={mainFrame},win={webContents},event={sender:webContents,senderFrame:mainFrame};
 access.add(url,'credential',7);assert.equal(isSurfacePage(url,access,connection),false);
 access.add(url,'credential',7,{projectSurface:true});
 for(const suffix of ['', '?newChat=1','?nativeSession=session-123&view=files'])assert.equal(isSurfacePage(url+suffix,access,connection),true);
 for(const suffix of ['api/session/prompt','team-settings/','?ticket=other','?newChat=1&newChat=1','?view=unknown','#other'])assert.equal(isSurfacePage(url+suffix,access,connection),false,suffix);
 for(const channel of ['team:project-request','team:native-open','team:project-home','team:save-media','team:select-host-folder'])assert.equal(permittedSender(event,win,channel,access,connection),true);
 for(const channel of ['team:request','team:host-stop','team:connect','team:account-login'])assert.equal(permittedSender(event,win,channel,access,connection),false);
 assert.equal(permittedSender({...event,senderFrame:{url}},win,'team:save-media',access,connection),false);
 assert.equal(permittedSender({...event,sender:{}},win,'team:save-media',access,connection),false);
 mainFrame.url=connection.origin+'/';assert.equal(permittedSender(event,win,'team:save-media',access,connection),false);
 mainFrame.url=url.replace('4326','4327');assert.equal(permittedSender(event,win,'team:save-media',access,connection),false);
 mainFrame.url=url;connection.epoch++;assert.equal(permittedSender(event,win,'team:save-media',access,connection),false);
 mainFrame.url='team://desktop/index.html';assert.equal(permittedSender(event,win,'team:host-status',access,connection),true);
});

test('surface host requests admit existing project navigation and logout without widening the desktop API',()=>{
 for(const [path,method] of [['/api/projects','GET'],['/api/native/open?project=shared','POST'],['/api/native/open?project=shared&member=11111111-1111-1111-1111-111111111111','POST'],['/api/logout','POST']])assert.equal(validProjectRequest(path,method),true,path);
 for(const [path,method] of [['https://elsewhere.invalid/api/projects','GET'],['//elsewhere.invalid/api/projects','GET'],['/api/login','POST'],['/api/native/open','POST'],['/api/native/open?project=shared&project=shared','POST'],['/api/native/open?project=shared&url=x','POST'],['/api/admin/users','POST'],['/api/logout?next=x','POST'],['/api/projects','POST'],['/api/projects#x','GET']])assert.equal(validProjectRequest(path,method),false,path);
 assert.equal(isDesktopPage('team://desktop/index.html?entry=accounts'),true);
 for(const url of ['team://desktop/index.html?entry=http://elsewhere','team://desktop/index.html?entry=accounts&entry=accounts'])assert.equal(isDesktopPage(url),false);
});

test('native ticket is consumed once without redirects and without exposing its credential to the renderer',async()=>{
 const f=fixture(),ticket=f.url+'?ticket=synthetic',calls=[];
 const value=await openProject({...f,url:ticket,projectSurface:true,fetch:async(url,options)=>{calls.push({url,options});return accepted(url);}});
 assert.deepEqual(value,{url:f.url,projectSurface:true});assert.equal(calls.length,1);assert.equal(calls[0].options.redirect,'manual');assert.equal(f.access.find(f.url,f.connection).cookie,'team_native_012345=abcdef012345');assert.equal(isSurfacePage(f.url,f.access,f.connection),true);
 const legacy=fixture();await openProject({...legacy,url:legacy.url+'?ticket=legacy',fetch:async url=>accepted(url)});assert.equal(isSurfacePage(legacy.url,legacy.access,legacy.connection),false);
});

test('missing capability, foreign ticket, login changes and misleading redirects cannot authorize a surface',async()=>{
 const absent=fixture();absent.connection.call=async()=>({status:200,data:{capabilities:[]}});await assert.rejects(openProject({...absent,url:absent.url+'?ticket=x',projectSurface:true,fetch:async()=>assert.fail('ticket must not be consumed')}),/尚未启用/);
 for(const suffix of ['?ticket=x&ticket=y','?ticket=x&next=remote','#other','?ticket=']){const f=fixture();await assert.rejects(openProject({...f,url:f.url+suffix,fetch:async()=>assert.fail('bad entry must not be fetched')}));}
 const f=fixture();await assert.rejects(openProject({...f,url:'http://elsewhere.invalid/harness/shared/?ticket=x',fetch:async()=>assert.fail('must not fetch foreign origin')}));
 await assert.rejects(openProject({...f,url:f.url+'?ticket=x',projectSurface:true,fetch:async url=>{f.connection.epoch++;return accepted(url);}}),/登录状态/);assert.equal(f.access.entries.size,0);
 const wrong=fixture();await assert.rejects(openProject({...wrong,url:wrong.url+'?ticket=x',projectSurface:true,fetch:async()=>new Response('',{status:302,headers:{'Set-Cookie':'team_native_a=abcdef','Location':'https://elsewhere.invalid/'}})}),/未就绪/);assert.equal(wrong.access.entries.size,0);
});

test('desktop staging includes the direct surface module and retains sandboxed main-frame validation',()=>{
 const main=readFileSync(join(__dirname,'../main.cjs'),'utf8'),pack=readFileSync(join(__dirname,'../package.cjs'),'utf8');
 assert(pack.includes("'project-surface.cjs'"));assert(main.includes('permittedSender(event,win,channel,nativeAccess,connection)'));assert(main.includes('contextIsolation:true,sandbox:true,webSecurity:true'));assert(main.includes("win.webContents.on('will-redirect',navigate)"));
});
