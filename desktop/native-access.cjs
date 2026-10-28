// Retain opened project frames within one window, scoped to the login lifetime.
class NativeAccess {
  constructor() { this.entries = new Map(); }
  clear() { this.entries.clear(); }
  add(url, cookie, epoch, {projectSurface=false}={}) {
    const u = new URL(url);
    if (!/^\/harness\/(shared|[a-f0-9-]{36})(?:~[a-f0-9-]{36})?\/$/.test(u.pathname)) throw Error('项目入口无效');
    this.entries.set(u.origin + u.pathname, {origin:u.origin, prefix:u.pathname.slice(0,-1), cookie, epoch, projectSurface});
  }
  find(url, connection) {
    const u = new URL(url);
    if (u.protocol === 'ws:') u.protocol = 'http:';
    if (u.protocol === 'wss:') u.protocol = 'https:';
    const prefix = u.pathname.match(/^\/harness\/(?:shared|[a-f0-9-]{36})(?:~[a-f0-9-]{36})?(?=\/|$)/)?.[0];
    const entry = prefix && this.entries.get(u.origin + prefix + '/');
    return entry && entry.epoch === connection.epoch && entry.origin === connection.origin ? entry : undefined;
  }
}
module.exports = {NativeAccess};
