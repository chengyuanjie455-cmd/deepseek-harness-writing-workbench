import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { Platform } from '../server/app.ts';
import { pythonSandbox, sandboxAvailable, TerminationUnconfirmed } from '../server/sandbox.ts';
const password = 'Synthetic-Test-Password';
class Client {
  cookie = ''; csrf = ''; constructor(public base: string) {}
  async call(path: string, method = 'GET', body?: any, expected = 200) {
    const r = await fetch(this.base + path, { method, headers: { Origin: this.base, 'Content-Type': 'application/json', Cookie: this.cookie, 'X-CSRF-Token': this.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json() as any; assert.equal(r.status, expected, JSON.stringify(j)); const cookie = r.headers.get('set-cookie'); if (cookie) this.cookie = cookie.split(';')[0]; if (j.csrf) this.csrf = j.csrf; return j;
  }
  async login(username: string) { return this.call('/api/login', 'POST', { username, password }); }
}
async function settle(c: Client, taskId: string) { for (let i = 0; i < 600; i++) { const tasks = await c.call('/api/tasks'); const t = tasks.find((t: any) => t.id === taskId); if (!['queued', 'running', 'cancel_requested'].includes(t.state)) return t; await delay(20); } throw new Error('task timeout'); }

test('8 accounts share a real Harness workspace; private chats, review, conflicts, revocation, restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-platform-test-')); let app = new Platform({ dataDir: root, mockDelay: 2 });
  let port = await app.start(0); let base = `http://127.0.0.1:${port}`; let admin = new Client(base);
  try {
    await admin.call('/api/setup', 'POST', { username: 'admin', name: '测试超管', password }, 201); await admin.login('admin');
    const clients: Client[] = []; const users: any[] = []; const sessions: any[] = [];
    for (let i = 0; i < 8; i++) { users.push(await admin.call('/api/admin/users', 'POST', { username: `member${i}`, name: `成员 ${i}`, password, role: 'member' }, 201)); const c = new Client(base); await c.login(`member${i}`); clients.push(c); sessions.push(await c.call('/api/sessions', 'POST', { title: `私聊 ${i}` }, 201)); }
    assert.equal(new Set(sessions.map(s => s.project)).size, 1);
    const submitted = await Promise.all(clients.map((c, i) => c.call('/api/tasks', 'POST', { session: sessions[i].id, requestId: `parallel-${i}`, prompt: `私人标记-${i}`, workflow: 'organize', paths: ['README.md'] }, 202)));
    const finished = await Promise.all(submitted.map((t, i) => settle(clients[i], t.id)));
    assert.deepEqual(finished.map(t => t.state), Array(8).fill('awaiting_review'), JSON.stringify(finished.map(t => ({ state: t.state, error: t.error }))));
    for (let i = 0; i < 8; i++) { const messages = await clients[i].call(`/api/sessions/${sessions[i].id}/messages`); assert(messages.some((m: any) => m.role === 'assistant' && m.text.includes(`私人标记-${i}`))); assert(!messages.some((m: any) => m.text.includes(`私人标记-${(i + 1) % 8}`))); await clients[i].call(`/api/sessions/${sessions[(i + 1) % 8].id}/messages`, 'GET', undefined, 404); }
    const repeated = await clients[0].call('/api/tasks', 'POST', { session: sessions[0].id, requestId: 'parallel-0', prompt: '私人标记-0', workflow: 'organize', paths: ['README.md'] }); assert.equal(repeated.id, submitted[0].id);
    await clients[0].call('/api/tasks', 'POST', { session: sessions[0].id, requestId: 'parallel-0', prompt: '更改内容', workflow: 'organize', paths: ['README.md'] }, 409);
    await clients[0].call('/api/tasks', 'POST', { session: sessions[0].id, requestId: 'model-override', prompt: '测试', workflow: 'chat', paths: [], model: 'other' }, 400);
    await clients[0].call('/api/admin/users', 'GET', undefined, 403);
    for (const t of finished) { const c = await admin.call(`/api/changes/${t.change}`); await admin.call(`/api/changes/${c.id}/approve`, 'POST', { digest: c.digest }); }
    const project = await admin.call('/api/project'); assert.equal(project.files.length, 10);
    const a = await clients[0].call('/api/changes', 'POST', { base: project.revision, writes: { 'README.md': 'first' } }, 201);
    const b = await clients[1].call('/api/changes', 'POST', { base: project.revision, writes: { 'README.md': 'second' } }, 201);
    await admin.call(`/api/changes/${a.id}/approve`, 'POST', { digest: 'wrong' }, 409); await admin.call(`/api/changes/${a.id}/approve`, 'POST', { digest: a.digest }); await admin.call(`/api/changes/${b.id}/approve`, 'POST', { digest: b.digest }, 409);
    await admin.call('/api/changes', 'POST', { base: project.revision, writes: { '../escape': 'x' } }, 400);
    await admin.call(`/api/sessions/${sessions[0].id}/messages`); const audits = await admin.call('/api/admin/audit'); assert(audits.some((a: any) => a.action === 'admin.chat.read'));
    writeFileSync(join(root, 'project', 'external.md'), '外部修改\n'); const external = await admin.call('/api/admin/import-diff', 'POST', {}, 201); assert.equal(external.external, true); await admin.call(`/api/changes/${external.id}/approve`, 'POST', { digest: external.digest }); assert.equal(readFileSync(join(root, 'project', 'external.md'), 'utf8'), '外部修改\n');
    const beforeCancel = await clients[0].call('/api/tasks', 'POST', { session: sessions[0].id, requestId: 'cancel-single', prompt: '取消测试'.repeat(100), workflow: 'chat', paths: [] }, 202);
    const independent = await clients[1].call('/api/tasks', 'POST', { session: sessions[1].id, requestId: 'keep-running', prompt: '另一成员继续', workflow: 'chat', paths: [] }, 202);
    await clients[0].call(`/api/tasks/${beforeCancel.id}/cancel`, 'POST', {}); assert.equal((await settle(clients[0], beforeCancel.id)).state, 'cancelled'); assert.equal((await settle(clients[1], independent.id)).state, 'completed');
    await admin.call(`/api/admin/users/${users[7].id}`, 'PATCH', { active: false }); await clients[7].call('/api/events?after=0', 'GET', undefined, 401);
    assert.throws(() => new Platform({ dataDir: root }), /已有活动写者/);
    await app.close(); app = new Platform({ dataDir: root, mockDelay: 1 }); port = await app.start(0); base = `http://127.0.0.1:${port}`; admin = new Client(base); await admin.login('admin'); const member = new Client(base); await member.login('member1');
    const restored = await member.call(`/api/sessions/${sessions[1].id}/messages`); assert(restored.some((m: any) => m.text.includes('私人标记-1')));
    const resumed = await member.call('/api/tasks', 'POST', { session: sessions[1].id, requestId: 'after-restart', prompt: '重启后继续', workflow: 'chat', paths: [] }, 202); assert.equal((await settle(member, resumed.id)).state, 'completed');
    console.log(JSON.stringify({ evidence: 'foundation_integration', accounts: 8, harness: '0.1.5-rc.2', sharedProject: 'shared', crossOwnerReadsDenied: 8, reviewsPublished: 8, conflictDenied: true, restartPassed: true, mockModelOnly: true }));
  } finally { await app.close(); }
});

test('Docker Python has readonly inputs, no host mount, bounded scratch and isolated cancellation', async t => {
  if (!await sandboxAvailable()) { t.skip('Pinned Docker image/engine unavailable'); return; }
  const root = mkdtempSync(join(tmpdir(), 'team-sandbox-test-')); chmodSync(root, 0o755); writeFileSync(join(root, 'sample.txt'), 'test input');
  const output = await pythonSandbox(`import os, socket\nassert open('/input/sample.txt').read() == 'test input'\ntry:\n open('/input/sample.txt','w').write('overwrite')\n raise RuntimeError('input writable')\nexcept OSError: pass\nassert not os.path.exists('/path/to/local-user/.dsh')\nassert os.getuid() == 65534\nprint('isolation-probe-pass')\n`, root, new AbortController().signal);
  assert.match(output, /isolation-probe-pass/); assert.equal(readFileSync(join(root, 'sample.txt'), 'utf8'), 'test input');
  const control = new AbortController(); const cancelled = pythonSandbox('import time\ntime.sleep(60)\n', root, control.signal); setTimeout(() => control.abort(), 1000); await assert.rejects(cancelled, (e:Error)=>e.name==='AbortError'||/取消/.test(e.message));
  const good = await pythonSandbox("print('another execution works')", root, new AbortController().signal); assert.match(good, /another execution works/);
});

test('slow HTTP mutations recheck account and candidate; uncertain stop never becomes cancelled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-platform-race-')); const app = new Platform({ dataDir: root, mockDelay: 1 }); const port = await app.start(0); const base = `http://127.0.0.1:${port}`; const admin = new Client(base);
  function slow(c: Client, path: string, body: any) {
    const encoded = JSON.stringify(body); let send!: () => void;
    const done = new Promise<number>((resolve, reject) => { const r = httpRequest(base + path, { method: 'POST', headers: { Origin: base, Cookie: c.cookie, 'X-CSRF-Token': c.csrf, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }); r.on('error', reject); r.write(encoded.slice(0, 1)); send = () => r.end(encoded.slice(1)); }); return { done, send };
  }
  try {
    await admin.call('/api/setup', 'POST', { username: 'admin', password }, 201); await admin.login('admin');
    const secondary = await admin.call('/api/admin/users', 'POST', { username: 'secondadmin', password, role: 'admin' }, 201); const other = new Client(base); await other.login('secondadmin');
    const project = await admin.call('/api/project'); const c = await admin.call('/api/changes', 'POST', { base: project.revision, writes: { 'race.md': 'only approved bytes' } }, 201);
    const pending = slow(other, `/api/changes/${c.id}/approve`, { digest: c.digest }); await delay(30); await admin.call(`/api/admin/users/${secondary.id}`, 'PATCH', { active: false }); pending.send(); assert.equal(await pending.done, 401);
    const stale = slow(admin, `/api/changes/${c.id}/reject`, { digest: c.digest }); await delay(30); await admin.call(`/api/changes/${c.id}/approve`, 'POST', { digest: c.digest }); stale.send(); assert.equal(await stale.done, 409); assert.equal((await admin.call(`/api/changes/${c.id}`)).state, 'committed');
    const noCsrf = await fetch(base + '/api/sessions', { method: 'POST', headers: { Origin: base, Cookie: admin.cookie, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(noCsrf.status, 403);
    const forbiddenHost = await new Promise<number>((resolve, reject) => { const r = httpRequest(base + '/api/status', { headers: { Host: 'attacker.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }); r.on('error', reject); r.end(); }); assert.equal(forbiddenHost, 403);
    const session = await admin.call('/api/sessions', 'POST', { title: 'uncertain stop fixture' }, 201);
    app.host.run = async () => { await delay(80); throw new TerminationUnconfirmed('injected missing stop receipt'); };
    const task = await admin.call('/api/tasks', 'POST', { session: session.id, requestId: 'uncertain-stop', prompt: 'test', workflow: 'chat', paths: [] }, 202); await admin.call(`/api/tasks/${task.id}/cancel`, 'POST', {}); assert.equal((await settle(admin, task.id)).state, 'termination_unconfirmed');
  } finally { await app.close(); }
});

test('prepared Git publication recovers after materialization failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-platform-recover-')); let app = new Platform({ dataDir: root, mockDelay: 1 }); let port = await app.start(0); let admin = new Client(`http://127.0.0.1:${port}`);
  try {
    await admin.call('/api/setup', 'POST', { username: 'admin', password }, 201); await admin.login('admin'); const project = await admin.call('/api/project'); const c = await admin.call('/api/changes', 'POST', { base: project.revision, writes: { 'recover.md': 'committed content' } }, 201);
    app.projects.materialize = () => { throw new Error('injected I/O failure'); }; await admin.call(`/api/changes/${c.id}/approve`, 'POST', { digest: c.digest }, 500); await app.close();
    app = new Platform({ dataDir: root, mockDelay: 1 }); port = await app.start(0); admin = new Client(`http://127.0.0.1:${port}`); await admin.login('admin'); assert.equal((await admin.call(`/api/changes/${c.id}`)).state, 'committed'); assert.equal(readFileSync(join(root, 'project', 'recover.md'), 'utf8'), 'committed content');
  } finally { await app.close(); }
});

test('published script policy drives real scoped Harness tool and pinned Docker worker', async t => {
  if (!await sandboxAvailable()) { t.skip('Docker unavailable'); return; }
  const root = mkdtempSync(join(tmpdir(), 'team-platform-tool-')); const app = new Platform({ dataDir: root, mockDelay: 1 }); const port = await app.start(0); const admin = new Client(`http://127.0.0.1:${port}`);
  try {
    await admin.call('/api/setup', 'POST', { username: 'admin', password }, 201); await admin.login('admin'); const s = await admin.call('/api/sessions', 'POST', { title: '脚本链路' }, 201);
    const body = { session: s.id, requestId: 'script-policy', prompt: "print('real-container-tool-output')", workflow: 'script', paths: [] };
    await admin.call('/api/tasks', 'POST', body, 409);
    const policy = await admin.call('/api/admin/releases', 'POST', { title: '允许隔离脚本', instruction: '脚本输出仅留存为当前任务结果', allowScripts: true }, 201);
    const task = await admin.call('/api/tasks', 'POST', body, 202); assert.equal(task.release.id, policy.id); const result = await settle(admin, task.id); assert.equal(result.state, 'completed', result.error);
    assert(result.container.startsWith('team-harness-')); const messages = await admin.call(`/api/sessions/${s.id}/messages`); assert(messages.some((m: any) => m.role === 'assistant' && m.text.includes('real-container-tool-output')));
    const events = app.store.get('harness', s.id)!.events; assert(events.some((e: any) => e.type === 'tool/call' && e.data.name === 'sandbox_python'));
    const headers = events.filter((e: any) => e.type === 'request/header'); assert(headers.every((e: any) => e.data.header.config.provider === 'platform-mock'));
  } finally { await app.close(); }
});
