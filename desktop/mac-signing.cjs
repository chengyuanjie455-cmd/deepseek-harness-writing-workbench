const {execFileSync,spawnSync}=require('node:child_process');
const {validateMacBundle}=require('./mac-bundle.cjs');
const policy=require('./signing-identity.json');

function signMacBundle(bundle) {
  // Do not fall back to ad-hoc signatures: their cdhash changes on every build
  // and breaks the application's previously granted Keychain access.
  if(!/^[A-Fa-f0-9]{40}$/.test(policy.identity))throw Error('缺少固定的本机签名身份，停止打包');
  const info=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',require('node:path').join(bundle,'Contents/Info.plist')],{encoding:'utf8'}));
  if(info.CFBundleIdentifier!==policy.bundleIdentifier)throw Error('应用标识与钥匙串固定身份不匹配，停止打包');
  validateMacBundle(bundle);
  execFileSync('/usr/bin/codesign',['--force','--deep','--timestamp=none','--sign',policy.identity,bundle],{stdio:'inherit'});
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{stdio:'inherit'});
  const inspected=spawnSync('/usr/bin/codesign',['-d','-r-',bundle],{encoding:'utf8'});
  if(inspected.status!==0)throw Error('读取应用签名身份失败');
  const requirement=inspected.stdout+inspected.stderr;
  if(!requirement.includes('designated =>')||requirement.includes('designated => cdhash'))throw Error('签名身份不稳定，停止发布');
  return {identity:policy.identity,name:policy.name,requirement:requirement.trim()};
}
module.exports={signMacBundle};
