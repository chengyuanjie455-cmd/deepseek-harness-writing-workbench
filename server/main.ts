import {watchExternalStorage} from './external-storage.ts';
import { resolve, join } from 'node:path';
import { loadModel } from './model.ts';
import { Platform } from './app.ts';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { advertise } from './discovery.ts';
import { loadIncidentConfig } from './incident-config.ts';
const dataDir = resolve(process.env.PLATFORM_DATA ?? 'data');
const savedConfig = join(dataDir, 'service-config.json');
if (existsSync(savedConfig)) {
  const config = JSON.parse(readFileSync(savedConfig, 'utf8'));
  const allowed = new Set(['PORT', 'PLATFORM_BIND', 'PLATFORM_ALLOWED_HOSTS', 'PLATFORM_TLS_CERT', 'PLATFORM_TLS_KEY', 'PLATFORM_TLS_CA', 'PLATFORM_LOCAL_REDIRECT', 'PLATFORM_KEEP_AWAKE', 'PLATFORM_ALLOW_LAN_HTTP', 'PLATFORM_DISCOVERY']);
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Object.entries(config).every(([k, v]) => allowed.has(k) && typeof v === 'string')) throw new Error('服务配置字段无效');
  for (const [key, value] of Object.entries(config)) process.env[key] ??= value as string;
}
if (!!process.env.PLATFORM_TLS_CERT !== !!process.env.PLATFORM_TLS_KEY) throw new Error('HTTPS 证书和私钥必须同时配置');
const requestedPort = Number(process.env.PORT ?? 4317);
const bind = process.env.PLATFORM_BIND ?? '127.0.0.1';
const redirectTarget = process.env.PLATFORM_LOCAL_REDIRECT;
const protocol = process.env.PLATFORM_TLS_CERT ? 'https' : 'http';
if (redirectTarget && (redirectTarget !== `${protocol}://${bind}:${requestedPort}/` || bind === '127.0.0.1' || requestedPort === 0)) throw new Error('本机跳转配置无效');
const incidentConfig=loadIncidentConfig(dataDir);
const app = new Platform({ nativeProjectSurface:process.env.PLATFORM_NATIVE_PROJECT_SURFACE==='1', mediaWorker:process.env.PLATFORM_MEDIA_WORKER!=='0', incidents:incidentConfig, nativeOnly:true, dataDir, model: loadModel(dataDir), allowLanHttp: process.env.PLATFORM_ALLOW_LAN_HTTP === '1', staticDir: resolve('dist'), tls: process.env.PLATFORM_TLS_CERT && process.env.PLATFORM_TLS_KEY ? { cert: process.env.PLATFORM_TLS_CERT, key: process.env.PLATFORM_TLS_KEY } : undefined });
// The old local bookmark only redirects. No credentials or API bodies are proxied over HTTP.
const redirect = redirectTarget ? createServer((req, res) => {
  const permittedHost = new Set([`127.0.0.1:${requestedPort}`, `localhost:${requestedPort}`]);
  if (!permittedHost.has(req.headers.host ?? '') || !['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(403); res.end(); return; }
  res.writeHead(302, { Location: redirectTarget, 'Cache-Control': 'no-store' }); res.end();
}) : undefined;
if (redirect) {
  redirect.headersTimeout = 10000; redirect.requestTimeout = 30000;
  // Bind redirect first: failure must not start HTTPS or resume queued model tasks.
  try { await new Promise<void>((resolve, reject) => { redirect.once('error', reject); redirect.listen(requestedPort, '127.0.0.1', resolve); }); }
  catch (error) { await app.close(); throw error; }
}
let port: number;
try { port = await app.start(requestedPort, bind); }
catch (error) { redirect?.close(); redirect?.closeAllConnections(); await app.close(); throw error; }
console.log(JSON.stringify({ state: 'listening', port, bind, model: app.release().model, pilot: false }));
const runtimePath = join(dataDir, 'runtime-state.json');
const runtime = { pid: process.pid, serverId: app.serverId, serverInstance: app.instanceId, entry: resolve(process.argv[1]), url: protocol + '://' + bind + ':' + port, version: '0.7.2' };
writeFileSync(runtimePath + '.tmp', JSON.stringify(runtime), { mode: 0o600 });
renameSync(runtimePath + '.tmp', runtimePath);
let stopDiscovery: (() => void) | undefined;
if (process.env.PLATFORM_DISCOVERY === '1' && bind !== '127.0.0.1') {
  try { stopDiscovery = advertise(app.serverId, port, bind, !!app.options.tls); }
  catch { console.error('discovery_unavailable'); }
}
// Keep this Mac awake only while the server runs; do not change global energy settings.
const awake = process.platform === 'darwin' && process.env.PLATFORM_KEEP_AWAKE === '1' ? spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }) : undefined;
awake?.on('error', () => console.error('keep_awake_unavailable'));
watchExternalStorage();
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => {
  if (stopping) return; stopping = true; stopDiscovery?.(); redirect?.close(); redirect?.closeAllConnections();
  await app.close(); awake?.kill();
  if (existsSync(runtimePath) && JSON.parse(readFileSync(runtimePath, 'utf8')).serverInstance === app.instanceId) unlinkSync(runtimePath);
  process.exit(0);
});
