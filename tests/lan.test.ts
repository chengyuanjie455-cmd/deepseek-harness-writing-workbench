import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request, type RequestOptions } from 'node:https';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Platform, privateIPv4 } from '../server/app.ts';
import { newRequestId } from '../web/request-id.ts';

test('password-only LAN mode requires explicit private bind and retains auth plus HTTP-safe request IDs', async () => {
  for (const address of ['192.168.200.10', '10.0.0.1', '172.16.0.1', '172.31.255.254']) assert(privateIPv4(address));
  for (const address of ['0.0.0.0', '8.8.8.8', '::', 'localhost', '192.168.1.999', '172.32.0.1']) assert(!privateIPv4(address));
  const root = mkdtempSync(join(tmpdir(), 'team-password-only-'));
  let app = new Platform({ dataDir: root, allowLanHttp: true });
  await assert.rejects(app.start(0, '192.168.200.10'), /超级管理员/); await app.close();
  app = new Platform({ dataDir: root });
  const password = 'Synthetic-HTTP-only-9384!'; app.newUser({ username: 'http_admin', password }, 'admin');
  await assert.rejects(app.start(0, '192.168.200.10'), /明确开启/); await app.close();
  app = new Platform({ dataDir: root, allowLanHttp: true });
  for (const bind of ['0.0.0.0', '8.8.8.8', '::']) await assert.rejects(app.start(0, bind), /具体私网/);
  const port = await app.start(0); const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(base + '/api/project')).status, 401);
    const failed = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: base }, body: JSON.stringify({ username: 'http_admin', password: 'Wrong-password-9384' }) }); assert.equal(failed.status, 401);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: base }, body: JSON.stringify({ username: 'http_admin', password }) });
    assert.equal(login.status, 200); const identity = await login.json() as any;
    const cookie = login.headers.get('set-cookie')!; assert.match(cookie, /^team_session_http=/); assert.match(cookie, /HttpOnly; SameSite=Strict/); assert(!cookie.includes('; Secure')); assert.equal(login.headers.get('strict-transport-security'), null);
    const headers = { Cookie: cookie.split(';')[0], Origin: base, 'X-CSRF-Token': identity.csrf };
    assert.equal((await fetch(base + '/api/me', { headers })).status, 200);
    assert.equal((await fetch(base + '/api/me', { headers: { Cookie: headers.Cookie.replace('team_session_http=', 'team_session=') } })).status, 401);
    assert.equal((await fetch(base + '/api/sessions', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'wrong' }, body: '{}' })).status, 403);
    const source = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) }; // Deliberately no randomUUID.
    const requestId = newRequestId(source); assert.match(requestId, /^[0-9a-f]{32}$/);
    assert.notEqual(newRequestId(source), requestId);
    const session = await fetch(base + '/api/sessions', { method: 'POST', headers, body: JSON.stringify({ title: 'HTTP request id check' }) }); assert.equal(session.status, 201);
    const s = await session.json() as any;
    const task = await fetch(base + '/api/tasks', { method: 'POST', headers, body: JSON.stringify({ session: s.id, requestId, prompt: 'Synthetic HTTP check', workflow: 'chat', paths: [] }) }); assert.equal(task.status, 202);
    assert.equal((await fetch(base + '/api/logout', { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal((await fetch(base + '/api/me', { headers })).status, 401);
  } finally { await app.close(); }
});

test('HTTPS verifies CA and host; 8 private clients, secure cookies, CSRF and slow-stop remain isolated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-lan-tls-'));
  execFileSync('python3', ['scripts/configure-lan.py', '--address', '127.0.0.1', '--data', root]);
  const config = JSON.parse(readFileSync(join(root, 'service-config.json'), 'utf8'));
  const ca = readFileSync(config.PLATFORM_TLS_CA);
  const app = new Platform({ dataDir: root, tls: { cert: config.PLATFORM_TLS_CERT, key: config.PLATFORM_TLS_KEY } });
  const port = await app.start(0); const base = `https://127.0.0.1:${port}`;
  const password = 'Synthetic-TLS-only-9384!';
  const call = (path: string, method = 'GET', body?: any, headers: Record<string, string> = {}, extra: RequestOptions = {}) => new Promise<{ status: number; headers: any; body: any }>((resolve, reject) => {
    const req = request(base + path, { ca, agent: false, method, headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, ...extra }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(data) }); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  let closed = false;
  try {
    assert.equal((await call('/api/status')).status, 200);
    await assert.rejects(call('/api/status', 'GET', undefined, {}, { ca: undefined }));
    await assert.rejects(call('/api/status', 'GET', undefined, {}, { servername: 'wrong.example' }));
    assert.equal((await call('/api/status', 'GET', undefined, { Host: 'attacker.example' }, { servername: 'localhost' })).status, 403);
    assert.equal((await call('/api/setup', 'POST', { username: 'tls_admin', password })).status, 201);
    const admin = await call('/api/login', 'POST', { username: 'tls_admin', password });
    const cookie = admin.headers['set-cookie'][0];
    assert.match(cookie, /; Secure/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    assert.equal(admin.headers['strict-transport-security'], 'max-age=86400');
    const adminHeaders = { Cookie: cookie.split(';')[0], 'X-CSRF-Token': admin.body.csrf };
    assert.equal((await call('/api/sessions', 'POST', { title: 'forbidden origin' }, { ...adminHeaders, Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await call('/api/sessions', 'POST', { title: 'forbidden csrf' }, { ...adminHeaders, 'X-CSRF-Token': 'invalid' })).status, 403);
    for (let i = 0; i < 8; i++) assert.equal((await call('/api/admin/users', 'POST', { username: `tls_member${i}`, password, role: 'member' }, adminHeaders)).status, 201);
    const clients = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
      const login = await call('/api/login', 'POST', { username: `tls_member${i}`, password }); assert.equal(login.status, 200);
      const headers = { Cookie: login.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': login.body.csrf };
      const session = await call('/api/sessions', 'POST', { title: `TLS private ${i}` }, headers); assert.equal(session.status, 201);
      const project = await call('/api/project', 'GET', undefined, headers);
      assert.equal(project.status, 200); assert.equal(project.body.id, 'shared'); assert.equal(session.body.project, 'shared');
      return { headers, session: session.body, project: project.body.id };
    }));
    assert.equal(new Set(clients.map(c => c.project)).size, 1);
    await Promise.all(clients.map(async (c, i) => {
      assert.equal((await call(`/api/sessions/${clients[(i + 1) % 8].session.id}/messages`, 'GET', undefined, c.headers)).status, 404);
      assert.equal((await call('/api/admin/users', 'GET', undefined, c.headers)).status, 403);
    }));
    assert.equal((await call('/api/logout', 'POST', {}, clients[0].headers)).status, 200);
    assert.equal((await call('/api/me', 'GET', undefined, clients[0].headers)).status, 401);
    assert.equal((await call('/api/login', 'POST', { username: 'tls_member0', password })).status, 200);
    const before = app.store.all('session').length;
    const slow = request(base + '/api/sessions', { ca, agent: false, method: 'POST', headers: { ...adminHeaders, Origin: base, 'Content-Type': 'application/json', 'Content-Length': '10000' } });
    slow.on('error', () => {}); slow.write('{"title":"must not commit');
    await delay(100); const started = Date.now(); await app.close(); closed = true;
    assert(Date.now() - started < 5000, 'slow peer must not hold shutdown indefinitely');
    slow.destroy();
    const restarted = new Platform({ dataDir: root, tls: { cert: config.PLATFORM_TLS_CERT, key: config.PLATFORM_TLS_KEY } });
    await restarted.start(0); assert.equal(restarted.store.all('session').length, before); await restarted.close();
  } finally { if (!closed) await app.close(); }
});

test('additional explicit LAN listener shares identity and auth while retaining origin gates and closing both sockets',async()=>{
 const root=mkdtempSync(join(tmpdir(),'team-extra-listener-'));const app=new Platform({dataDir:root,allowLanHttp:true,mockDelay:1});
 const password='Extra-listener-fixture-9384!';app.newUser({username:'admin',password},'admin');
 let closed=false;
 try{
  const first=`http://127.0.0.1:${await app.start(0)}`;
  for(const bind of ['0.0.0.0','8.8.8.8','::'])await assert.rejects(app.addLanListener(bind,0),/具体私网/);
  const second=`http://127.0.0.1:${await app.addLanListener('127.0.0.1',0)}`;
  const ids=await Promise.all([first,second].map(async u=>(await(await fetch(u+'/api/status')).json() as any).serverId));assert.equal(ids[0],ids[1]);
  assert.equal((await fetch(second+'/api/project')).status,401);
  const login=await fetch(second+'/api/login',{method:'POST',headers:{Origin:second},body:JSON.stringify({username:'admin',password})});assert.equal(login.status,200);const me=await login.json() as any;
  const headers={Cookie:login.headers.get('set-cookie')!.split(';')[0],Origin:second,'X-CSRF-Token':me.csrf};
  const session=await fetch(second+'/api/sessions',{method:'POST',headers,body:'{}'});assert.equal(session.status,201);
  const sessions=await(await fetch(first+'/api/sessions',{headers:{Cookie:headers.Cookie}})).json() as any[];assert.equal(sessions.length,1);
  assert.equal((await fetch(second+'/api/sessions',{method:'POST',headers:{...headers,Origin:first},body:'{}'})).status,403);
  const badHost=await new Promise<number>((resolve,reject)=>{const req=httpRequest(second+'/api/status',{headers:{Host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.end();});assert.equal(badHost,403);
  const instance=(await(await fetch(first+'/api/status')).json() as any).serverInstance;
  await app.removeLanListener('127.0.0.1',Number(new URL(second).port));
  await assert.rejects(fetch(second+'/api/status'));
  assert.equal((await(await fetch(first+'/api/status')).json() as any).serverInstance,instance);
  assert.equal((await fetch(first+'/api/me',{headers:{Cookie:headers.Cookie}})).status,200);
  const third=`http://127.0.0.1:${await app.addLanListener('127.0.0.1',0)}`;
  assert.equal((await(await fetch(third+'/api/status')).json() as any).serverId,ids[0]);
  await app.close();closed=true;
  for(const u of [first,second,third])await assert.rejects(fetch(u+'/api/status'));
 }finally{if(!closed)await app.close();}
});
