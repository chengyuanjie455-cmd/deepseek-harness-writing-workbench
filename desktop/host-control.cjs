const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { normalizeOrigin, probe } = require('./connection.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class HostControl {
  constructor(profile) {
    this.profile = profile; this.busy = false;
    if (profile) {
      if (profile.nativeProjectSurface !== undefined && typeof profile.nativeProjectSurface !== 'boolean') throw new Error('项目侧栏启动配置无效');
      if (profile.mode && !['pickup-uat','pickup-live'].includes(profile.mode)) throw new Error('主机运行模式无效');
      this.root = path.resolve(profile.root); this.data = path.resolve(profile.data);
      if (profile.mode && path.basename(this.data) !== 'data') throw new Error('验收数据目录必须位于独立根目录的 data 下');
      this.entry = path.join(this.root, profile.mode === 'pickup-uat' ? 'scripts/uat-pickups.ts' : profile.mode === 'pickup-live' ? 'scripts/live-single-shot.ts' : 'server/main.ts');
    }
  }
  config() {
    if (!this.profile) throw new Error('此安装包是成员客户端');
    if (this.profile.mode === 'pickup-live') {
      const c = this.profile.live;
      if (!c || !Number.isInteger(c.port) || c.port < 1024 || c.port > 65535 || [4317,4324].includes(c.port) || !path.isAbsolute(c.textConfig || '')) throw new Error('真实验收主机配置不完整或端口不独立');
      if(c.automatic !== undefined && typeof c.automatic !== 'boolean') throw new Error('自动局域网配置无效');
      const url = normalizeOrigin('http://' + (c.automatic ? '127.0.0.1' : c.bind) + ':' + c.port);
      if (c.extraBinds !== undefined && (!Array.isArray(c.extraBinds) || c.extraBinds.some(b => typeof b !== 'string'))) throw new Error('附加局域网地址无效');
      for (const b of c.extraBinds || []) normalizeOrigin('http://' + b + ':' + c.port);
      return { url };
    }
    const filename = path.join(this.data, 'service-config.json');
    const c = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {};
    const url = normalizeOrigin((c.PLATFORM_TLS_CERT ? 'https://' : 'http://') + (c.PLATFORM_BIND || '127.0.0.1') + ':' + (c.PORT || '4317'));
    return { url };
  }
  runtime() {
    try { return JSON.parse(fs.readFileSync(this.profile?.mode === 'pickup-live' ? path.join(path.dirname(this.data), 'runtime.json') : path.join(this.data, 'runtime-state.json'), 'utf8')); } catch { return null; }
  }
  async status() {
    const { url } = this.config(); const state = this.runtime();
    try {
      const s = (await probe(url)).status;
      const managed = !!state && state.entry === this.entry && state.serverId === s.serverId && state.serverInstance === s.serverInstance && Number.isSafeInteger(state.pid) && state.pid > 1 && state.url === url;
      const lanUrls=managed?(state.additionalUrls||[]).filter(u=>{try{return normalizeOrigin(u)===u;}catch{return false;}}):[];
      let memberUrl=null;
      if(managed&&lanUrls.length&&typeof state.lan?.memberUrl==='string') {
        try { const u=new URL(state.lan.memberUrl); if(u.protocol==='http:'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(u.hostname)&&u.port===new URL(url).port&&u.origin===state.lan.memberUrl)memberUrl=u.origin; } catch {}
      }
      return { running: true, managed, url, lanUrls, memberUrl, automaticLan:managed&&state.lan?.automatic===true, version: s.version, serverId: s.serverId, state: managed ? 'running' : 'unmanaged', error: managed ? '' : '地址可达，但不是此控制台核验过的后台进程' };
    } catch (e) { return { running: false, managed: false, url, state: 'stopped_or_unreachable', error: e.message }; }
  }
  async exclusive(fn) {
    if (this.busy) throw new Error('主机操作正在进行');
    this.busy = true; try { return await fn(); } finally { this.busy = false; }
  }
  start() { return this.exclusive(async () => {
    const storage=require('./external-storage.cjs');
    const policyFile=require('./host-profile.cjs').policyFilename(require('./deployment.json'),this.profile?.storagePolicy);
    if(policyFile){
      const policy=storage.loadPolicy(policyFile),state=storage.assertVolume(policy);
      for(const target of [this.root,this.data,this.profile.live?.textConfig].filter(Boolean))storage.assertPath(policy,target,state);
    }
    const before = await this.status(); if (before.running) { if (!before.managed) throw new Error(before.error); return before; }
    const old = this.runtime();
    if (old?.pid) { try { process.kill(old.pid, 0); throw new Error('旧后台进程仍在，请先核对运行状态'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    if (!fs.existsSync(this.entry) || !fs.existsSync(this.profile.node)) throw new Error('主机运行文件未配置完成');
    fs.mkdirSync(this.data, { recursive: true, mode: 0o700 });
    const log = fs.openSync(path.join(this.data, 'service.log'), 'a', 0o600);
    const env = {};
    for (const key of ['HOME','PATH','LANG','TMPDIR','DOCKER_CONFIG','DOCKER_HOST','XDG_CACHE_HOME']) if (process.env[key]) env[key] = process.env[key];
    if(policyFile)env.PLATFORM_STORAGE_POLICY=policyFile;
    env.PLATFORM_DATA = this.data;
    if (this.profile.nativeProjectSurface === true) env.PLATFORM_NATIVE_PROJECT_SURFACE = '1';
    if (this.profile.mode === 'pickup-uat') {
      const u = new URL(before.url); env.PICKUP_UAT_ROOT = path.dirname(this.data);
      env.PICKUP_UAT_BIND = u.hostname; env.PORT = u.port;
    }
    if (this.profile.mode === 'pickup-live') {
      const c = this.profile.live;
      env.PLATFORM_LIVE_ROOT = path.dirname(this.data);
      env.PLATFORM_TEXT_CONFIG = c.textConfig;
      env.PLATFORM_BIND = c.automatic ? '127.0.0.1' : c.bind; env.PORT = String(c.port);
      if(c.automatic)env.PLATFORM_AUTO_LAN='1';
      env.PLATFORM_EXTRA_BINDS = (c.extraBinds || []).join(',');
    }
    let error;
    const child = spawn(this.profile.node, ['--import', path.join(this.root, 'node_modules/tsx/dist/loader.mjs'), this.entry], {
      cwd: this.root, env, detached: true, stdio: ['ignore', log, log]
    });
    fs.closeSync(log); child.on('error', e => { error = e; }); child.unref();
    if (child.pid) fs.writeFileSync(path.join(this.data, 'service.pid'), String(child.pid), { mode: 0o600 });
    for (let i = 0; i < 100; i++) {
      if (error) throw new Error('后台启动失败：' + error.message);
      if (child.exitCode !== null) throw new Error('后台启动失败，请查看主机运行日志');
      const state = this.runtime();
      if (state?.pid === child.pid) { const status = await this.status(); if (status.managed) return status; }
      await sleep(100);
    }
    throw new Error('启动尚未确认，未再次启动；请核对主机日志');
  }); }
  stop() { return this.exclusive(async () => {
    const current = await this.status(); const state = this.runtime();
    if (!current.running || !current.managed || !state) throw new Error('不能安全确认目标后台，未发送停止信号');
    process.kill(state.pid, 'SIGTERM');
    for (let i = 0; i < 150; i++) {
      try { process.kill(state.pid, 0); } catch (e) { if (e.code === 'ESRCH') return { running: false, managed: false, url: current.url, state: 'stopped' }; throw e; }
      await sleep(100);
    }
    throw new Error('后台停止尚未确认，未强制终止；请核对任务及执行器');
  }); }
}
module.exports = { HostControl };
