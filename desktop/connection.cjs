const http = require('node:http');
const https = require('node:https');
const { isIPv4 } = require('node:net');
const PROTOCOL = 1;
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length > 256) throw new Error('服务器地址无效');
  const supplied=value.trim();
  const privateHint=/^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(supplied);
  const u = new URL(supplied.includes('://') ? supplied : (privateHint?'http://':'https://') + supplied);
  if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
  const parts = u.hostname.split('.').map(Number);
  const local = isIPv4(u.hostname) && (u.hostname === '127.0.0.1' || parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
  if (!(u.protocol==='https:' || u.protocol==='http:'&&local) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('请输入 HTTPS 主机地址；本机和局域网 IPv4 也可使用 HTTP 地址及端口');
  return u.origin;
}
function validOperation(path, method) {
  if (typeof path !== 'string' || path.length > 4096 || !path.startsWith('/api/') || !['GET','POST','PATCH'].includes(method)) return false;
  const u = new URL(path, 'http://fixed.local');
  if (u.origin !== 'http://fixed.local' || u.hash) return false;
  const p = u.pathname;
  if(method==='GET'&&['/api/mobile/devices','/api/mobile/bootstrap'].includes(p)||method==='POST'&&['/api/mobile/devices','/api/mobile/devices/revoke'].includes(p))return true;
  if(method==='GET'&&['/api/incidents','/api/admin/incidents'].includes(p)||method==='POST'&&['/api/incidents','/api/incident-attachments','/api/admin/incidents/settings'].includes(p))return true;
  if(method==='GET'&&/^\/api\/incidents\/[a-f0-9-]{36}$/.test(p)||method==='POST'&&/^\/api\/incidents\/[a-f0-9-]{36}\/(supplement|cancel|retry|client-check)$/.test(p))return true;
  if (method === 'GET' && ['/api/member-submissions','/api/admin/billing','/api/admin/member-models','/api/admin/operations','/api/admin/operations/trace','/api/admin/concurrency'].includes(p)) return true;
  if (method === 'POST' && ['/api/admin/billing/prices/verify','/api/admin/billing/reconcile','/api/admin/member-models','/api/admin/operations/recover','/api/admin/operations/catalog','/api/admin/operations/idle','/api/admin/concurrency'].includes(p)) return true;
  if(method==='GET'&&['/api/native/status','/api/native/changes'].includes(p)||method==='POST'&&['/api/native/open','/api/native/stop','/api/native/sync','/api/native/submit','/api/admin/native-policy'].includes(p))return true;
  if(method==='GET'&&['/api/chat-options','/api/admin/chat-models'].includes(p)||method==='POST'&&['/api/admin/chat-models','/api/admin/chat-policy'].includes(p)||method==='PATCH'&&/^\/api\/(sessions|tasks)\/[a-f0-9-]+$/.test(p))return true;
  if((method==='GET'||method==='POST')&&p==='/api/uploads'||method==='POST'&&p==='/api/file-reference'||method==='GET'&&/^\/api\/uploads\/[a-f0-9]{32}$/.test(p)||method==='POST'&&/^\/api\/uploads\/[a-f0-9]{32}\/(chunk|complete|cancel)$/.test(p))return true;
  if(method==='GET'&&p==='/api/projects'||method==='POST'&&['/api/admin/projects','/api/admin/projects/preview'].includes(p))return true;
  if(method==='GET'&&p==='/api/gallery')return true;
  if(method==='GET'&&['/api/project-content','/api/project-content/search','/api/project-content/page'].includes(p))return true;
  if(method==='GET'&&p==='/api/admin/media-models'||method==='POST'&&(p==='/api/admin/image-models'||/^\/api\/admin\/media-models\/(video|image)\/[a-f0-9-]+\/remove$/.test(p)))return true;
  if(method==='GET'&&(/^\/api\/(images|image-models|image-assets|xiaopei-models|admin\/video-quota-requests)$/.test(p)||/^\/api\/images\/[a-f0-9-]+$/.test(p)))return true;
  if(method==='POST'&&(p==='/api/image-assets'||/^\/api\/images\/(?:[a-f0-9-]+\/confirm|jobs\/[a-f0-9-]+\/recover)$/.test(p)||/^\/api\/pickups\/[a-f0-9-]+\/quota-requests$/.test(p)||/^\/api\/admin\/video-quota-requests\/[a-f0-9-]+\/decision$/.test(p)||/^\/api\/admin\/xiaopei-channels\/[a-f0-9-]+\/sync$/.test(p)))return true;
  if(method==='GET' && ['/api/admin/project-directory','/api/admin/host-folders'].includes(p) || method==='POST' && /^\/api\/admin\/project-directory\/(preview|bind)$/.test(p))return true;
  if (method === 'GET' && (/^\/api\/(video-models|pickups|admin\/video-(channels|models|templates|index|assets|storage|jobs))$/.test(p) || /^\/api\/pickups\/[a-f0-9-]+$/.test(p))) return true;
  if (method === 'POST' && (/^\/api\/admin\/video-(channels|models|templates|index|storage|assets\/import)$/.test(p) || /^\/api\/admin\/video-channels\/[a-f0-9-]+\/probe$/.test(p) || /^\/api\/admin\/video-jobs\/[a-f0-9-]+\/recover$/.test(p) || /^\/api\/pickups\/(?:[a-f0-9-]+\/confirm|jobs\/[a-f0-9-]+\/adopt)$/.test(p))) return true;
  if (method === 'GET') return /^\/api\/(status|me|project|file|sessions|tasks|changes|events|admin\/(users|audit|health))$/.test(p)
    || /^\/api\/(sessions\/[a-f0-9-]+\/messages|changes\/[a-f0-9-]+|requests\/[a-zA-Z0-9_-]{8,100})$/.test(p);
  if (method === 'POST') return /^\/api\/(setup|login|logout|sessions|tasks|changes|admin\/(users|releases|import-diff|project\/recover))$/.test(p)
    || /^\/api\/requests\/[a-zA-Z0-9_-]{8,100}\/close$/.test(p)
    || /^\/api\/(tasks\/[a-f0-9-]+\/cancel|changes\/[a-f0-9-]+\/(approve|reject)|admin\/tasks\/[a-f0-9-]+\/confirm-stop)$/.test(p);
  return /^\/api\/admin\/users\/[a-f0-9-]+$/.test(p);
}
function requestJSON(origin, path, method = 'GET', body, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > (path.split('?')[0]==='/api/image-assets'?34:2) * 1024 * 1024) return reject(new Error('请求过大'));
    const u = new URL(path, origin);
    if (u.origin !== origin) return reject(new Error('禁止跨服务器请求'));
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers: {
      ...headers, Origin: origin, 'Content-Type': 'application/json', ...(encoded ? {'Content-Length': Buffer.byteLength(encoded)} : {})
    } }, res => {
      // Never follow redirects with authentication headers.
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return reject(new Error('服务器发生重定向，请重新核对连接地址')); }
      const chunks = []; let size = 0;
      res.on('data', b => { size += b.length; if (size > 24 * 1024 * 1024) { req.destroy(new Error('响应过大')); return; } chunks.push(b); });
      res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')), cookies: res.headers['set-cookie'] ?? [] }); } catch { reject(new Error('服务器没有返回有效的平台响应')); } });
    });
    const timer = setTimeout(() => req.destroy(new Error('连接超时；提交结果需核对')), timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(encoded);
  });
}
async function probe(value) {
  const origin = normalizeOrigin(value);
  const res = await requestJSON(origin, '/api/status', 'GET', undefined, {}, origin.startsWith('https:')?10000:3000);
  const s = res.data;
  if (res.status !== 200 || !uuid.test(s.serverId ?? '') || s.protocol?.min > PROTOCOL || s.protocol?.max < PROTOCOL || !Number.isInteger(s.protocol?.min) || !Number.isInteger(s.protocol?.max))
    throw new Error('服务不可用或协议不兼容，需要 B0.6 或兼容后台');
  return { origin, status: s };
}
class Connection {
  constructor() { this.transfers = new Set(); this.origin = ''; this.serverId = ''; this.cookie = ''; this.csrf = ''; this.userId = ''; this.epoch = 0; this.needsProbe = true; }
  disconnect() { this.stopMedia(); this.epoch++; this.cookie = ''; this.csrf = ''; this.userId = ''; this.origin = ''; this.serverId = ''; this.needsProbe = true; }
  async connect(value, expectedId) {
    this.disconnect(); const epoch = this.epoch;
    const result = await probe(value);
    if (epoch !== this.epoch) throw new Error('连接选择已变更');
    if (expectedId && expectedId !== result.status.serverId) throw new Error('此地址上的服务器身份已变化，请核对后重新选择');
    this.origin = result.origin; this.serverId = result.status.serverId; this.needsProbe = false;
    return result;
  }
  async call(path, method = 'GET', body) {
    if (!this.origin || !validOperation(path, method)) throw new Error('未连接或操作不在桌面接口范围');
    if (path === '/api/logout') return this.logout();
    if (path === '/api/login') { this.stopMedia(); this.epoch++; this.cookie = ''; this.csrf = ''; this.userId = ''; }
    const epoch = this.epoch;
    try {
      if (this.needsProbe || path === '/api/status') {
        const checked = await probe(this.origin);
        if (epoch !== this.epoch) throw new Error('登录状态已变更');
        if (checked.status.serverId !== this.serverId) { this.disconnect(); throw new Error('服务器身份变化，请重新绑定'); }
        this.needsProbe = false;
        if (path === '/api/status') return { status: 200, data: checked.status };
      }
      const res = await requestJSON(this.origin, path, method, body, { Cookie: this.cookie, 'X-CSRF-Token': this.csrf },path.split('?')[0]==='/api/native/open'?120000:15000);
      if (epoch !== this.epoch) throw new Error('登录状态已变更');
      if (path === '/api/login' && res.status === 200) {
        const c = res.cookies.find(x => /^team_session(?:_http)?=/.test(x));
        if (!c || typeof res.data.csrf !== 'string') throw new Error('登录会话响应不完整');
        this.cookie = c.split(';')[0]; this.csrf = res.data.csrf; this.userId = res.data.user?.id || '';
      }
      if (res.status === 401) { this.stopMedia(); this.epoch++; this.cookie = ''; this.csrf = ''; this.userId = ''; }
      return { status: res.status, data: res.data };
    } catch (e) { if (epoch === this.epoch) this.needsProbe = true; throw e; }
  }
  stopMedia() { for (const req of this.transfers) req.destroy(); this.transfers.clear(); }
  async media(mediaId, range, method = 'GET') {
    if (!uuid.test(mediaId) || !this.origin || !this.cookie || !['GET','HEAD'].includes(method) || range && !/^bytes=\d+-\d*$/.test(range)) throw new Error('媒体请求无效或尚未登录');
    const epoch = this.epoch, origin = this.origin;
    const checked = await probe(origin);
    if (epoch !== this.epoch || checked.status.serverId !== this.serverId) throw new Error('服务器或登录身份改变');
    return new Promise((resolve, reject) => {
      const u = new URL('/api/media/' + mediaId, origin);
      const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers: { Cookie:this.cookie, 'X-CSRF-Token':this.csrf, ...(range?{Range:range}:{}) } }, res => {
        if (epoch !== this.epoch || ![200,206].includes(res.statusCode)) { res.resume(); return reject(new Error('媒体不可读或登录已失效')); }
        if (!['video/mp4','image/png','image/jpeg','image/webp'].includes(res.headers['content-type']) || Number(res.headers['content-length']) > 1024*1024*1024) {res.destroy();return reject(new Error('媒体响应无效'));}
        resolve(res);
      });
      this.transfers.add(req); req.on('close',()=>this.transfers.delete(req)); req.on('error',reject); req.setTimeout(60000,()=>req.destroy(new Error('媒体连接超时')));req.end();
    });
  }
  async projectFile(spec,method='GET',range) {
    if(!spec||!['GET','HEAD'].includes(method)||typeof spec.path!=='string'||spec.path.length>240||!(spec.project==='shared'||uuid.test(spec.project))||spec.revision&&!/^[a-f0-9]{40}$/.test(spec.revision)||spec.preview!==undefined&&spec.preview!=='thumb'||!this.origin||!this.cookie)throw new Error('项目附件请求无效');
    if(range!==undefined&&range!==null&&!/^bytes=\d+-\d*$/.test(range))throw new Error('项目附件读取范围无效');
    const epoch=this.epoch,origin=this.origin,checked=await probe(origin);if(epoch!==this.epoch||checked.status.serverId!==this.serverId)throw new Error('服务器或登录身份改变');
    const q=new URLSearchParams({project:spec.project,path:spec.path,...(spec.revision?{revision:spec.revision}:{}),...(spec.preview?{preview:spec.preview}:{})});
    return new Promise((resolve,reject)=>{const req=(origin.startsWith('https:')?https:http).request(new URL('/api/file-content?'+q,origin),{method,headers:{Cookie:this.cookie,'X-CSRF-Token':this.csrf,...(range?{Range:range}:{})}},res=>{if(epoch!==this.epoch||!(res.statusCode===200||range&&res.statusCode===206)){res.resume();return reject(new Error('附件不可读或登录已失效'));}if(!['application/octet-stream','image/png','image/jpeg','image/webp','image/svg+xml','video/mp4','video/quicktime','video/webm'].includes(res.headers['content-type'])||Number(res.headers['content-length'])>256*1024*1024){res.destroy();return reject(new Error('附件响应无效'));}resolve(res);});this.transfers.add(req);req.on('close',()=>this.transfers.delete(req));req.on('error',reject);req.setTimeout(60000,()=>req.destroy(new Error('附件传输超时')));req.end();});
  }
  async logout() {
    this.stopMedia();
    if (!this.origin) return { status: 200, data: { ok: true } };
    const origin = this.origin, cookie = this.cookie, csrf = this.csrf;
    this.epoch++; this.cookie = ''; this.csrf = ''; this.userId = '';
    return requestJSON(origin, '/api/logout', 'POST', {}, { Cookie: cookie, 'X-CSRF-Token': csrf });
  }
}
module.exports = { normalizeOrigin, validOperation, requestJSON, probe, Connection, PROTOCOL };
