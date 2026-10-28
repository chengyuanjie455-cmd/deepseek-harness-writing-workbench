const fs = require('node:fs');
const path = require('node:path');

// This manifest is mandatory. Deployment replaces the development declaration
// with an external-host binding; an absent environment variable cannot unbind it.
function policyFilename(deployment, supplied) {
  if (deployment?.version !== 1 || !['development','external-host'].includes(deployment.kind)) throw Error('主机部署配置缺失或无效');
  if (deployment.kind === 'external-host') {
    if (!path.isAbsolute(deployment.storagePolicy || '') || !path.isAbsolute(deployment.activeProfile || '')) throw Error('外盘主机部署配置不完整');
    if (supplied && supplied !== deployment.storagePolicy) throw Error('存储配置与部署绑定不一致');
    return deployment.storagePolicy;
  }
  return supplied;
}
function loadHostProfile(filename, deployment) {
  const required = policyFilename(deployment);
  if (!fs.existsSync(filename)) {
    if (required) throw Error('主机入口配置缺失，已停止启动');
    return null;
  }
  const bundled = JSON.parse(fs.readFileSync(filename,'utf8'));
  if (required && bundled.externalProfile !== deployment.activeProfile) throw Error('活动配置与部署绑定不一致');
  // A pointer is never a runnable fallback, including on a development build.
  let profile = bundled;
  if (bundled.externalProfile !== undefined) {
    if (!path.isAbsolute(bundled.externalProfile || '') || !fs.existsSync(bundled.externalProfile)) throw Error('指定的活动配置缺失，已停止启动；不会使用测试数据');
    profile = JSON.parse(fs.readFileSync(bundled.externalProfile,'utf8'));
    if (profile.externalProfile) throw Error('活动配置不能再次转发');
  }
  if (required && profile.storagePolicy !== required) throw Error('活动配置缺少已绑定的外盘存储规则');
  if (required && (profile.purpose !== 'production' || profile.data !== deployment.productionData)) throw Error('活动配置不是已绑定的正式数据配置');
  return profile;
}
// A signed acceptance build needs its own Electron state as well as its own
// server data. Production profiles keep their existing login/keychain paths.
function isolatedDesktopHome({packaged,acceptance,profile,requested}) {
  if (profile?.storagePolicy) return;
  if (!packaged) return requested ? path.resolve(requested) : undefined;
  if (!acceptance || profile?.purpose !== 'acceptance') return;
  if (!path.isAbsolute(profile.data || '')) throw Error('验收数据目录必须为绝对路径');
  return path.join(profile.data,'desktop-state');
}
module.exports = {policyFilename,loadHostProfile,isolatedDesktopHome};
