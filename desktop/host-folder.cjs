const {isAbsolute}=require('node:path');
const {lstatSync,realpathSync}=require('node:fs');

function isDesktopPage(value){
  try{const u=new URL(value);return u.protocol==='team:'&&u.hostname==='desktop'&&!u.port&&!u.username&&!u.password&&u.pathname==='/index.html'&&!u.hash&&[...u.searchParams].every(([k,v])=>k==='project'&&(v==='shared'||/^[a-f0-9-]{36}$/.test(v))||k==='entry'&&v==='accounts')&&u.searchParams.getAll('project').length<=1&&u.searchParams.getAll('entry').length<=1;}catch{return false;}
}

// The native dialog belongs to this computer, never to a remote connected server.
async function selectHostFolder({role,connection,host,showDialog},initialPath) {
  const scope={origin:connection.origin,serverId:connection.serverId,epoch:connection.epoch};
  const unchanged=()=>connection.origin===scope.origin&&connection.serverId===scope.serverId&&connection.epoch===scope.epoch;
  async function authorize() {
    if(role!=='host'||!unchanged())throw Error('主机或登录身份已变更，请重新选择');
    const target=await host.status();
    if(!target.managed||target.url!==scope.origin||target.serverId!==scope.serverId||!/^http:\/\/127\.0\.0\.1:\d+$/.test(scope.origin))throw Error('当前连接不是本机受管服务器，请使用浏览主机目录');
    const me=await connection.call('/api/me','GET');
    if(!unchanged()||me.status!==200||me.data?.user?.role!=='admin')throw Error('仅已登录的超级管理员可以选择主机文件夹');
    return me.data.user.id;
  }
  const user=await authorize();let defaultPath;
  if(typeof initialPath==='string'&&initialPath.length<=1000&&isAbsolute(initialPath)) {
    try{if(lstatSync(initialPath).isDirectory()&&realpathSync(initialPath)===initialPath)defaultPath=initialPath;}catch{}
  }
  const answer=await showDialog({title:'选择项目所在的主机文件夹',buttonLabel:'选择文件夹',properties:['openDirectory'],...(defaultPath?{defaultPath}:{})});
  if(await authorize()!==user)throw Error('登录身份已变更，目录选择未应用');
  if(answer.canceled||!answer.filePaths?.length)return {cancelled:true};
  const path=answer.filePaths[0];
  if(!isAbsolute(path)||path.length>1000||!lstatSync(path).isDirectory()||realpathSync(path)!==path)throw Error('请选择真实文件夹，不能经过符号链接');
  return {path};
}
module.exports={selectHostFolder,isDesktopPage};
