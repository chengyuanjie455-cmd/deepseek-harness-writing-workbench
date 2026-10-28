const { app, BrowserWindow, ipcMain, protocol, session, dialog, safeStorage, webFrameMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { Connection, probe } = require('./connection.cjs');
const { NativeAccess } = require('./native-access.cjs');
const {isSurfacePage,permittedSender,validProjectRequest,openProject}=require('./project-surface.cjs');
const { restoreSaved } = require('./reconnect.cjs');
const { MediaReceiver } = require('./media-receiver.cjs');
const { discover } = require('./discovery.cjs');
const { HostControl } = require('./host-control.cjs');
const { RememberedLogin } = require('./remembered-login.cjs');
const { selectHostFolder, isDesktopPage } = require('./host-folder.cjs');
const release = require('./package.json');

protocol.registerSchemesAsPrivileged([{ scheme: 'team', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const roleFile = path.join(__dirname, 'role.json');
const roleConfig = fs.existsSync(roleFile) ? JSON.parse(fs.readFileSync(roleFile, 'utf8')) : {};
// Current desktop entry is the host console; members use the browser.
const role = roleConfig.role || 'host';
app.setName(role === 'host' ? 'team-harness-host' : 'team-harness-platform');
const portableProfilePath = path.join(__dirname,'host-profile.json');
let portableProfile,stopStorageWatch;
try {
  const deployment=require('./deployment.json');
  require('./host-profile.cjs').policyFilename(deployment,process.env.PLATFORM_STORAGE_POLICY);
  portableProfile=require('./host-profile.cjs').loadHostProfile(portableProfilePath,deployment);
} catch(error) { dialog.showErrorBox('主机配置未就绪',error.message);app.exit(1);throw error; }
const assertSavePath = p => {if(portableProfile?.storagePolicy){const s=require('./external-storage.cjs');s.assertPath(s.loadPolicy(portableProfile.storagePolicy),p);}};
if(portableProfile?.storagePolicy){
  try{
    const storage=require('./external-storage.cjs'),policy=storage.loadPolicy(portableProfile.storagePolicy);
    Object.assign(process.env,storage.environment(policy));
    const state=storage.assertVolume(policy);
    for(const target of ['desktop','desktop/session','tmp','downloads','logs/desktop'])storage.assertPath(policy,path.join(policy.root,target),state);
    app.setPath('userData',path.join(policy.root,'desktop'));
    app.setPath('sessionData',path.join(policy.root,'desktop','session'));
    app.setPath('temp',path.join(policy.root,'tmp'));
    app.setPath('downloads',path.join(policy.root,'downloads'));
    app.setAppLogsPath(path.join(policy.root,'logs','desktop'));
    stopStorageWatch=storage.monitor(policy,error=>{dialog.showErrorBox('外接盘未就绪',error.message);app.exit(1);});
  }catch(error){dialog.showErrorBox('外接盘未就绪',error.message);app.exit(1);throw error;}
}
else {
  const isolated=require('./host-profile.cjs').isolatedDesktopHome({packaged:app.isPackaged,acceptance:roleConfig.acceptance,profile:portableProfile,requested:process.env.TEAM_DESKTOP_TEST_HOME});
  app.setPath('userData',isolated || path.join(app.getPath('appData'), (role === 'host' ? 'DeepSeekTeamHost' : 'DeepSeekTeamMember') + (roleConfig.acceptance ? '-Acceptance' : '')));
}
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  let win;let nativeWindow;const nativeAccess=new NativeAccess(); let quitting = false; let discoveryPromise; let restorePromise; let bindingGeneration=0;
  const connection = new Connection();
  const receiver = new MediaReceiver(connection,app.getPath('downloads'));
  const settingsPath = path.join(app.getPath('userData'), 'connection.json');
  const settings = () => { try { const s = JSON.parse(fs.readFileSync(settingsPath,'utf8')); return { origin: s.origin, serverId: s.serverId }; } catch { return {}; } };
  const save = s => { fs.mkdirSync(path.dirname(settingsPath), {recursive:true,mode:0o700}); fs.writeFileSync(settingsPath+'.tmp', JSON.stringify(s), {mode:0o600}); fs.renameSync(settingsPath+'.tmp',settingsPath); };
  let profile;
  if (role === 'host') {
    const filename = !app.isPackaged && process.env.TEAM_DESKTOP_HOST_PROFILE ? process.env.TEAM_DESKTOP_HOST_PROFILE : path.join(__dirname,'host-profile.json');
    if (fs.existsSync(filename)) {
      profile = portableProfile?.storagePolicy || app.isPackaged ? portableProfile : JSON.parse(fs.readFileSync(filename,'utf8'));
      if (app.isPackaged) profile.node = path.join(process.resourcesPath,'runtime',process.platform==='win32'?'node.exe':'node');
    }
  }
  const host = new HostControl(profile);
  const rememberedLogin = new RememberedLogin({filename:path.join(app.getPath('userData'),'admin-login.enc.json'),storage:safeStorage,connection,target:()=>role==='host'?host.status():Promise.resolve(null)});
  const validate = (event,channel) => {
    if (!permittedSender(event,win,channel,nativeAccess,connection)) throw new Error('无权调用桌面接口');
  };
  const handle = (channel, fn) => ipcMain.handle(channel, async (event,...args) => {
    try { validate(event,channel); return {ok:true,value:await fn(...args)}; }
    catch(e) { return {ok:false,error:e.message || '桌面操作失败'}; }
  });
  handle('team:info', () => ({role, version:release.version, releaseLabel:release.releaseLabel, saved: settings(), loginStart: app.isPackaged && role==='host' ? app.getLoginItemSettings().openAtLogin : false, packaged:app.isPackaged}));
  const connect = async (origin,id) => { bindingGeneration++;const r=await connection.connect(origin,id); save({origin:r.origin,serverId:r.status.serverId}); return r; };
  const accountEntry=new(require('./account-entry.cjs').AccountEntry)({filename:path.join(app.getPath('userData'),'account-entry.enc'),storage:safeStorage,connection,connect,onIdentityChange:()=>{rememberedLogin.pauseAutoLogin();nativeAccess.clear();if(nativeWindow&&!nativeWindow.isDestroyed())nativeWindow.close();}});
  handle('team:account-directory',()=>accountEntry.directory());
  handle('team:account-login',body=>accountEntry.login(body));
  handle('team:account-open',id=>accountEntry.open(id));
  handle('team:account-logout',()=>accountEntry.logout());
  const findServers = () => { if (!discoveryPromise) discoveryPromise=discover().finally(()=>{discoveryPromise=undefined;}); return discoveryPromise; };
  handle('team:connect', connect);
  handle('team:restore', () => {
    if (!restorePromise) {const generation=bindingGeneration;restorePromise=restoreSaved(settings(),{probe,discover:findServers,connect:(origin,id)=>{if(generation!==bindingGeneration)throw new Error('连接选择已变更');return connect(origin,id);}}).finally(()=>{restorePromise=undefined;});}
    return restorePromise;
  });
  handle('team:disconnect', () => { rememberedLogin.pauseAutoLogin(); if(nativeWindow&&!nativeWindow.isDestroyed())nativeWindow.close();bindingGeneration++;nativeAccess.clear();connection.disconnect(); return true; });
  handle('team:remember-status', () => rememberedLogin.status());
  handle('team:remember-restore', () => rememberedLogin.restore());
  handle('team:remember-clear', () => rememberedLogin.clear());
  handle('team:request', async (p,m,b) => {
    if(p==='/api/logout'){nativeAccess.clear();rememberedLogin.pauseAutoLogin();await accountEntry.logout();}
    if(p==='/api/logout'&&nativeWindow&&!nativeWindow.isDestroyed())nativeWindow.close();let r;
    if(p==='/api/login'&&m==='POST'&&(b?.remember!==undefined||b?.useSaved!==undefined))r=b.remember||b.useSaved?await rememberedLogin.login(b):await connection.call(p,m,{username:b.username,password:b.password});
    else r=await connection.call(p,m,b);
    if(m==='GET' && /^\/api\/pickups(?:\?|$)/.test(p) && r.status===200)receiver.observe(r.data);return r;
  });
  handle('team:native-open',(url,options)=>openProject({url,projectSurface:options?.projectSurface===true,connection,access:nativeAccess}));
  handle('team:project-home',(entry='projects')=>{if(!['projects','accounts'].includes(entry))throw Error('项目入口无效');const target=win;setImmediate(()=>{if(target&&!target.isDestroyed())void target.loadURL('team://desktop/index.html'+(entry==='accounts'?'?entry=accounts':'')).catch(()=>console.warn('Project home did not load'));});return true;});
  handle('team:project-request',async(p,m,b)=>{
    if(!validProjectRequest(p,m))throw Error('主机入口不在当前工作台范围');
    if(p==='/api/logout'){rememberedLogin.pauseAutoLogin();await accountEntry.logout();nativeAccess.clear();}
    return connection.call(p,m,b);
  });
  handle('team:received-media', () => receiver.status());
  handle('team:select-host-folder', initialPath => selectHostFolder({role,connection,host,showDialog:options=>dialog.showOpenDialog(win,options)},initialPath));
  handle('team:save-media', async mediaId => {
    if (!/^[a-f0-9-]{36}$/.test(mediaId)) throw new Error('媒体编号无效');
    const meta=await connection.media(mediaId,undefined,'HEAD');const ext=meta.headers['content-type'].split('/')[1]==='jpeg'?'jpg':meta.headers['content-type'].split('/')[1];meta.resume();
    const answer=await dialog.showSaveDialog(win,{defaultPath:'original-'+mediaId+'.'+ext,filters:[{name:'媒体原件',extensions:[ext]}]});
    if(answer.canceled||!answer.filePath)return {cancelled:true};
    assertSavePath(answer.filePath);
    const response=await connection.media(mediaId);
    const temp=answer.filePath+'.partial';
    try {await pipeline(response,fs.createWriteStream(temp,{flags:'wx',mode:0o600}));fs.renameSync(temp,answer.filePath);}
    catch(e){if(fs.existsSync(temp))fs.unlinkSync(temp);throw e;}
    return {saved:true};
  });
  handle('team:save-project-file',async spec=>{
    const meta=await connection.projectFile(spec,'HEAD');meta.resume();const answer=await dialog.showSaveDialog(win,{defaultPath:path.basename(spec.path)});if(answer.canceled||!answer.filePath)return {cancelled:true};assertSavePath(answer.filePath);const response=await connection.projectFile(spec),temp=answer.filePath+'.partial';
    try{await pipeline(response,fs.createWriteStream(temp,{flags:'wx',mode:0o600}));const digest=require('node:crypto').createHash('sha256');for await(const chunk of fs.createReadStream(temp))digest.update(chunk);if(digest.digest('hex')!==meta.headers['x-content-sha256'])throw new Error('附件下载哈希不一致');fs.renameSync(temp,answer.filePath);}catch(e){if(fs.existsSync(temp))fs.unlinkSync(temp);throw e;}return {saved:true};
  });
  handle('team:discover', findServers);
  handle('team:host-status', () => { if (role!=='host') throw new Error('仅主机控制台可用'); return host.status(); });
  handle('team:host-start', () => { if (role!=='host') throw new Error('仅主机控制台可用'); return host.start(); });
  handle('team:host-stop', async () => {
    if (role!=='host') throw new Error('仅主机控制台可用');
    const choice=await dialog.showMessageBox(win,{type:'warning',buttons:['继续运行','停止团队服务'],defaultId:0,cancelId:0,message:'停止后所有成员将暂时断开，在途任务可能中断。',detail:'关闭本窗口不会停止后台。只有选择停止服务才会发送停止请求。'});
    if(choice.response!==1) return {cancelled:true};
    return host.stop();
  });
  handle('team:login-start', enabled => {
    if(role!=='host'||!app.isPackaged||typeof enabled!=='boolean') throw new Error('仅打包后的主机控制台支持登录时启动');
    app.setLoginItemSettings({openAtLogin:enabled,openAsHidden:enabled}); return app.getLoginItemSettings().openAtLogin;
  });
  function createWindow() {
  // Attach project credentials only to this window and an authenticated project
  // prefix, whether the candidate uses a top-level surface or a legacy frame.
  session.defaultSession.webRequest.onBeforeSendHeaders((details,callback)=>{
    const u=new URL(details.url),a=nativeAccess.find(details.url,connection);if(u.protocol==='ws:')u.protocol='http:';if(u.protocol==='wss:')u.protocol='https:';
    if(a&&details.webContentsId===win?.webContents.id&&u.origin===a.origin&&(u.pathname===a.prefix||u.pathname.startsWith(a.prefix+'/'))){
      details.requestHeaders.Cookie=a.cookie;
      if(!['GET','HEAD'].includes(details.method))details.requestHeaders.Origin=a.origin;
      delete details.requestHeaders['Sec-Fetch-Site'];
    }
    callback({requestHeaders:details.requestHeaders});
  });

    win = new BrowserWindow({width:1280,height:850,minWidth:800,minHeight:600,title:release.productName+' '+release.releaseLabel,backgroundColor:'#ffffff',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
    win.on('page-title-updated',event=>event.preventDefault());
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    const navigate=(event,url)=>{if(!isDesktopPage(url)&&!isSurfacePage(url,nativeAccess,connection))event.preventDefault();};
    win.webContents.on('will-navigate',navigate);
    win.webContents.on('will-redirect',navigate);
    win.webContents.on('will-attach-webview', e=>e.preventDefault());
    win.webContents.on('will-prevent-unload', async event => {
      const answer=await dialog.showMessageBox(win,{type:'question',buttons:['继续编辑','放弃草稿并关闭'],defaultId:0,cancelId:0,message:'此窗口有未发送内容。'});
      if(answer.response===1) { event.preventDefault(); win.destroy(); }
    });
    // Legacy frames still receive presentation; direct surfaces compose their
    // own project columns and native conversation without this injection.
    win.webContents.on('did-frame-finish-load', (_event, isMainFrame, processId, routingId) => {
      if (isMainFrame) return;
      const frame = webFrameMain.fromId(processId, routingId);
      const source = fs.readFileSync(path.join(__dirname, 'ui/shared-workbench-ui.js'), 'utf8');
      void require('./presentation.cjs').applyPresentation(frame, nativeAccess, connection, source)
        .catch(() => console.warn('Shared workbench presentation did not attach'));
    });
    win.loadURL('team://desktop/index.html');
    win.on('closed',()=>{win=undefined;});
  }
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}else createWindow();});
  app.on('will-quit',()=>{quitting=true;stopStorageWatch?.();connection.disconnect();receiver.close();});
  app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
  app.on('activate',()=>{if(!win&&!quitting)createWindow();});
  app.whenReady().then(async()=>{
    // Keep bundled UI caches; authenticated HTML and APIs remain no-store.
    const ui=path.resolve(__dirname,'ui');
    protocol.handle('team',async request=>{
      const u=new URL(request.url);
      const pathname=decodeURIComponent(u.pathname);
      if(u.hostname!=='desktop'||!['GET','HEAD'].includes(request.method)||pathname.includes('..')||pathname.includes('\\')) return new Response('',{status:403});
      const media=/^\/media\/([a-f0-9-]{36})$/.exec(pathname);
      if(media) {try {const response=await connection.media(media[1],request.headers.get('range'),request.method);const headers={};for(const k of ['content-type','content-length','content-range','accept-ranges'])if(response.headers[k])headers[k]=response.headers[k];headers['Cache-Control']='no-store';return new Response(request.method==='HEAD'?null:Readable.toWeb(response),{status:response.statusCode,headers});}catch{return new Response('',{status:403});}}
      if(pathname==='/project-file'){try{const spec=Object.fromEntries(u.searchParams);const response=await connection.projectFile(spec,request.method,request.headers.get('range'));const headers={'Content-Type':response.headers['content-type'],'Content-Length':response.headers['content-length'],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"};for(const key of ['accept-ranges','content-range'])if(response.headers[key])headers[key]=response.headers[key];return new Response(request.method==='HEAD'?null:Readable.toWeb(response),{status:response.statusCode,headers});}catch{return new Response('',{status:403});}}
      const p=path.join(ui,pathname);
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
      if(!mime[path.extname(p)]||!fs.existsSync(p)||!fs.statSync(p).isFile())return new Response('',{status:404});
      const headers={'Content-Type':mime[path.extname(p)],'Cache-Control':/^\/assets\/[^/]+-[\w-]{8,}\.(js|css)$/.test(pathname)?'private, max-age=31536000, immutable':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src http: https:; base-uri 'none'; form-action 'none'",'X-Content-Type-Options':'nosniff'};
      return new Response(request.method==='HEAD'?null:fs.readFileSync(p),{headers});
    });
    session.defaultSession.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
    session.defaultSession.setPermissionCheckHandler(()=>false);
    if(role==='host'&&profile?.autoStart) await host.start().catch(()=>{});
    createWindow();
  });
}
