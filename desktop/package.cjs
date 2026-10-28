const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
(async()=>{
  const role=process.argv[2]||'host',platform=process.argv[3]||process.platform,arch=process.argv[4]||process.arch;
  if(role==='member')throw Error('当前仅分发主机管理桌面端；成员请使用主机控制台显示的网页地址。');
  if(!['host','member'].includes(role)||!['darwin','win32'].includes(platform)||!['arm64','x64'].includes(arch))throw Error('Usage: node package.cjs host darwin|win32 arm64|x64');
  if(role==='host'&&(platform!==process.platform||arch!==process.arch))throw Error('主机控制台只打包当前已核对平台');
  const stage=path.join(__dirname,'package-stage',role+'-'+platform+'-'+arch+'-'+Date.now());
  if(fs.existsSync(stage))throw Error('打包暂存目录已存在，请核对后使用新的输出目录');
  fs.mkdirSync(stage,{recursive:true});
  for(const f of ['main.cjs','account-entry.cjs','presentation.cjs','external-storage.cjs','host-profile.cjs','deployment.json','native-access.cjs','project-surface.cjs','preload.cjs','connection.cjs','reconnect.cjs','remembered-login.cjs','host-folder.cjs','media-receiver.cjs','discovery.cjs','host-control.cjs','package.json','package-lock.json'])fs.copyFileSync(path.join(__dirname,f),path.join(stage,f));
  // Package the current web build, rather than a manually copied desktop/ui
  // snapshot that can silently retain an older model menu or gallery.
  const builtUI=path.join(__dirname,'../dist');
  if(!fs.existsSync(path.join(builtUI,'index.html')))throw Error('请先构建当前工作台界面，再打包桌面应用');
  fs.cpSync(builtUI,path.join(stage,'ui'),{recursive:true});
  fs.copyFileSync(path.join(__dirname,'../web/shared-workbench-ui.js'),path.join(stage,'ui/shared-workbench-ui.js'));
  fs.cpSync(path.join(__dirname,'../licenses'),path.join(stage,'licenses'),{recursive:true});
  const acceptance=process.env.TEAM_PACKAGE_ACCEPTANCE==='1';
  fs.writeFileSync(path.join(stage,'role.json'),JSON.stringify({role,acceptance}));
  const extraResource=[];
  if(role==='host'){
    const root='/path/to/local-user/LocalProjects/本地AI工作流平台_前期整理/platform';
    const profile=process.env.TEAM_PACKAGE_HOST_PROFILE?JSON.parse(fs.readFileSync(process.env.TEAM_PACKAGE_HOST_PROFILE,'utf8')):{root,data:path.join(root,'data'),autoStart:true};
    if(['pickup-uat','pickup-live'].includes(profile.mode)&&!acceptance)throw Error('验收主机必须使用独立验收应用身份');
    fs.writeFileSync(path.join(stage,'host-profile.json'),JSON.stringify(profile));
    const runtime=path.join(__dirname,'runtime');fs.mkdirSync(runtime,{recursive:true});
    fs.copyFileSync(fs.realpathSync(process.execPath),path.join(runtime,'node'));fs.chmodSync(path.join(runtime,'node'),0o755);
    const nodeLicense=path.resolve(fs.realpathSync(process.execPath),'../../LICENSE');
    if(!fs.existsSync(nodeLicense))throw Error('找不到当前 Node 运行时许可证，停止主机打包');
    fs.copyFileSync(nodeLicense,path.join(runtime,'LICENSE-Node.txt'));
    extraResource.push(runtime);
  }
  execFileSync(process.platform==='win32'?'npm.cmd':'npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:stage,stdio:'inherit'});
  // This is a runtime-only staging tree. Packager must not traverse absent build tools.
  const runtimePackage=JSON.parse(fs.readFileSync(path.join(stage,'package.json'),'utf8'));
  delete runtimePackage.devDependencies;delete runtimePackage.scripts;
  fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify(runtimePackage,null,2)+'\n');
  const {packager}=await import('@electron/packager');
  const appName=runtimePackage.productName+' '+runtimePackage.releaseLabel;
  const result=await packager({dir:stage,out:process.argv[5]?path.resolve(process.argv[5]):path.join(__dirname,'out'),name:appName,
    appBundleId:(role==='host'?'local.teamharness.host':'local.teamharness.member')+(acceptance?'.acceptance':''),appVersion:runtimePackage.version,
    ...(platform==='darwin'?{icon:path.join(__dirname,'assets/host.icns')} : {}),
    electronVersion:require('./node_modules/electron/package.json').version,platform,arch,asar:true,prune:true,overwrite:false,
    download:{downloader:require('./download.cjs'),checksums:require('./node_modules/electron/checksums.json'),...(process.env.ELECTRON_CACHE?{cacheRoot:path.resolve(process.env.ELECTRON_CACHE)}:{})},
    extraResource, ...(platform==='win32'?{windowsMetadata:{CompanyName:'Local Team Platform',FileDescription:'team-harness-platform团队协作',ProductName:'team-harness-platform'}}:{})});
  if(platform==='darwin')for(const output of result){
    const bundle=path.join(output,appName+'.app');
    require('./mac-signing.cjs').signMacBundle(bundle);
  }
  console.log(JSON.stringify({role,platform,arch,output:result,localStableSignature:platform==='darwin',signedByDeveloperIdentity:false,notarized:false}));
})().catch(e=>{console.error(e);process.exit(1)});
