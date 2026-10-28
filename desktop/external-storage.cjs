const fs = require('node:fs');
const path = require('node:path');
const {homedir} = require('node:os');
const {execFileSync} = require('node:child_process');

function loadPolicy(filename) {
  const p = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (p.version !== 1 || !path.isAbsolute(p.root || '') || !p.root.startsWith('/Volumes/') || !/^[A-F0-9-]{36}$/i.test(p.volumeUUID || '') || p.allowInternalFallback !== false) throw Error('外接盘存储配置无效');
  return p;
}
function inspectDisk(target) {
  const mount = '/Volumes/' + target.split('/')[2];
  const xml = execFileSync('/usr/sbin/diskutil', ['info', '-plist', mount], {timeout:5000});
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert','json','-o','-','-'], {input:xml,timeout:5000,encoding:'utf8'}));
}
function assertVolume(p, inspect = inspectDisk) {
  if (!fs.existsSync(p.root) || fs.realpathSync(p.root) !== p.root) throw Error('指定外接盘未挂载或路径改变，主机暂停；不会改写内置盘');
  const info = inspect(p.root);
  if (info.Internal !== false || info.VolumeUUID !== p.volumeUUID || info.FilesystemType !== 'apfs' || info.Writable !== true) throw Error('外接盘身份或可写状态不符，主机暂停');
  const state={root:p.root, mount:info.MountPoint, device:fs.statSync(p.root).dev};
  checkAvailable(p,state);
  return state;
}
function assertPath(p, target, state = assertVolume(p)) {
  const resolved = path.resolve(target);
  if (resolved !== state.mount && !resolved.startsWith(state.mount + '/')) throw Error('按外接盘存储规则，请选择指定外接盘中的文件夹');
  let cursor = state.mount;
  // lstat sees dangling links, unlike existsSync. Check every existing component.
  for (const part of ['',...path.relative(state.mount,resolved).split(path.sep).filter(Boolean)]) {
    if(part)cursor=path.join(cursor,part);
    let st;
    try {st=fs.lstatSync(cursor);} catch(error){if(error.code==='ENOENT')break;throw error;}
    if(st.isSymbolicLink() || st.dev!==state.device)throw Error('存储路径经过链接或已离开指定外接盘');
    if(cursor!==resolved&&!st.isDirectory())throw Error('存储路径包含非目录节点');
  }
  return resolved;
}
function environment(p) {
  const state = assertVolume(p);
  const values = {TMPDIR:path.join(p.root,'tmp'),XDG_CACHE_HOME:path.join(p.root,'cache'),DOCKER_CONFIG:path.join(p.root,'docker','cli'),DOCKER_HOST:'unix://'+path.join(homedir(),'.docker','run','docker.sock')};
  for (const [key,value] of Object.entries(values)) if (key !== 'DOCKER_HOST') { assertPath(p,value,state); fs.mkdirSync(value,{recursive:true,mode:0o700}); }
  values.PATH = [path.join(p.root,'tools','bin'),path.join(p.root,'tools','Docker.app','Contents','Resources','bin'),process.env.PATH || '/usr/bin:/bin'].join(':');
  return values;
}
function checkAvailable(p,state,io=fs) {
  if(io.realpathSync(p.root)!==p.root || io.statSync(p.root).dev!==state.device)throw Error('外接盘已断开或被替换');
  io.accessSync(p.root,fs.constants.W_OK);
  const space=io.statfsSync(p.root);
  if(space.bavail*space.bsize<(p.minimumFreeBytes??64*1024*1024))throw Error('外接盘可用空间不足，主机暂停');
}
function monitor(p, onUnavailable, options={}) {
  const state = assertVolume(p,options.inspect); let failed = false;
  checkAvailable(p,state,options.io);
  const timer = setInterval(() => {
    if (failed) return;
    try { checkAvailable(p,state,options.io); }
    catch (e) { failed = true; clearInterval(timer); onUnavailable(e); }
  },options.intervalMs??1000);
  timer.unref(); return () => clearInterval(timer);
}
module.exports = {loadPolicy,assertVolume,assertPath,environment,monitor,checkAvailable};
