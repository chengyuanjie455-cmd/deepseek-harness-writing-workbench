const {isDesktopPage}=require('./host-folder.cjs');

const project=/^(shared|[a-f0-9-]{36})$/;
function isSurfacePage(value,access,connection){
  try{
    const u=new URL(value),entry=access.find(value,connection);
    if(!entry?.projectSurface||u.pathname!==entry.prefix+'/'||u.hash||u.username||u.password)return false;
    for(const [key,v] of u.searchParams){
      if(u.searchParams.getAll(key).length!==1)return false;
      if(key==='nativeSession'&&/^session-[a-zA-Z0-9-]{1,160}$/.test(v))continue;
      if(key==='newChat'&&v==='1'||key==='view'&&v==='files')continue;
      return false;
    }
    return true;
  }catch{return false;}
}
const surfaceChannels=new Set(['team:info','team:native-open','team:project-home','team:project-request','team:received-media','team:save-media','team:save-project-file','team:select-host-folder']);
function permittedSender(event,win,channel,access,connection){
  if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)return false;
  return isDesktopPage(event.senderFrame.url)||(surfaceChannels.has(channel)&&isSurfacePage(event.senderFrame.url,access,connection));
}
function validProjectRequest(path,method){
  if(typeof path!=='string'||path.length>1024)return false;
  const u=new URL(path,'http://fixed.local');
  if(u.origin!=='http://fixed.local'||u.hash||!path.startsWith('/api/'))return false;
  if(u.pathname==='/api/projects'&&method==='GET'||u.pathname==='/api/logout'&&method==='POST')return !u.search;
  if(u.pathname!=='/api/native/open'||method!=='POST')return false;
  for(const [key,v] of u.searchParams){
    if(u.searchParams.getAll(key).length!==1)return false;
    if(key==='project'&&project.test(v)||key==='member'&&/^[a-f0-9-]{36}$/.test(v))continue;
    return false;
  }
  return u.searchParams.has('project');
}
async function openProject({url,projectSurface=false,connection,access,fetch:request=fetch}){
  const u=new URL(url),epoch=connection.epoch;
  if(u.origin!==connection.origin||u.username||u.password||u.hash||!/^\/harness\/(shared|[a-f0-9-]{36})(?:~[a-f0-9-]{36})?\/$/.test(u.pathname)||u.searchParams.size!==1||!u.searchParams.get('ticket'))throw Error('原生入口不属于当前服务器');
  const unchanged=()=>epoch===connection.epoch&&u.origin===connection.origin;
  if(projectSurface){
    const status=await connection.call('/api/status','GET');
    if(!unchanged())throw Error('登录状态已变更');
    if(status.status!==200||!status.data?.capabilities?.includes('native-project-surface'))throw Error('当前主机尚未启用三栏聊天组件');
  }
  const response=await request(url,{redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(!unchanged())throw Error('登录状态已变更');
  const cookie=response.headers.get('set-cookie')?.split(';')[0];
  if(response.status!==302||!/^team_native(?:_[a-f0-9]+)?=[a-f0-9]+$/.test(cookie??'')||response.headers.get('location')!==u.pathname)throw Error('项目聊天认证未就绪');
  access.add(url,cookie,epoch,{projectSurface});
  return {url:u.origin+u.pathname,projectSurface};
}
module.exports={isSurfacePage,permittedSender,validProjectRequest,openProject};
