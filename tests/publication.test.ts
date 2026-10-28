import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Platform } from '../server/app.ts';
import { MAX_PROJECT_BYTES } from '../server/project.ts';

const password = 'Publication-regression-only-4835!';
class Client {
  cookie = ''; csrf = '';
  constructor(public base: string) {}
  async call(path: string, method = 'GET', body?: any, expected = 200) {
    const r = await fetch(this.base + '/api' + path, { method, headers: { Origin: this.base, Cookie: this.cookie, 'X-CSRF-Token': this.csrf, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json() as any;
    assert.equal(r.status, expected, `${path}: ${JSON.stringify(j).slice(0, 500)}`);
    const cookie = r.headers.get('set-cookie'); if (cookie) this.cookie = cookie.split(';')[0];
    if (j.csrf) this.csrf = j.csrf;
    return j;
  }
  login(username = 'admin') { return this.call('/login', 'POST', { username, password }); }
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'team-publication-'));
  const app = new Platform({ dataDir: root, mockDelay: 1 });
  const c = new Client(`http://127.0.0.1:${await app.start(0)}`);
  await c.call('/setup', 'POST', { username: 'admin', password }, 201); await c.login();
  return { root, app, c };
}
async function candidate(c: Client, writes: Record<string, string | null>, base?: string) {
  return c.call('/changes', 'POST', { base: base ?? (await c.call('/project')).revision, writes }, 201);
}
async function settle(c: Client, id: string) {
  for (let i = 0; i < 400; i++) { const t = (await c.call('/tasks')).find((t: any) => t.id === id); if (!['queued','running','cancel_requested'].includes(t.state)) return t; await delay(20); }
  throw new Error('task timeout');
}
function consistent(app: Platform) {
  assert.equal(app.projects.git(['rev-parse', 'refs/heads/main']), app.projects.current().revision);
  assert.deepEqual(app.projects.scan(), app.projects.revision().manifest);
  assert.equal(app.projects.pending().length, 0);
}

test('F01: failed publication fences approvals and queued execution; restart recovers only the original intent', async () => {
  const f = await fixture(); let app = f.app, c = f.c;
  try {
    const a = await candidate(c, {'a.md':'original approved bytes'});
    const b = await candidate(c, {'b.md':'independent bytes'}, a.base);
    const s = await c.call('/sessions', 'POST', {title:'queued before failure'}, 201);
    const other = await c.call('/sessions', 'POST', {title:'new request during recovery'}, 201);
    app.options.concurrency = 0;
    const queued = await c.call('/tasks', 'POST', {session:s.id, requestId:'queued-before-fault', workflow:'chat', paths:[], prompt:'synthetic'}, 202);
    app.projects.materialize = () => { throw new Error('injected I/O failure'); };
    await c.call(`/changes/${a.id}/approve`, 'POST', {digest:a.digest}, 500);
    const blocked = await c.call(`/changes/${b.id}/approve`, 'POST', {digest:b.digest}, 503);
    assert.match(blocked.error, /未完成发布/); assert.equal(app.projects.pending().length, 1);
    assert.equal(app.store.get('change', b.id)!.state, 'submitted');
    assert.equal((await c.call('/project')).publication.state, 'recovery_required');
    app.options.concurrency = 1; app.pump(); await delay(30);
    assert.equal(app.store.get('task', queued.id)!.state, 'queued'); assert.equal(app.active.size, 0);
    await c.call('/tasks', 'POST', {session:other.id, requestId:'blocked-new-task', workflow:'chat', paths:[], prompt:'synthetic'}, 503);
    await c.call('/admin/import-diff', 'POST', {}, 503);
    await app.close();
    app = new Platform({dataDir:f.root, mockDelay:1}); c = new Client(`http://127.0.0.1:${await app.start(0)}`); await c.login();
    assert.equal((await settle(c,queued.id)).state,'completed');
    assert.equal(app.store.get('change',a.id)!.state,'committed');
    await c.call(`/changes/${b.id}/approve`, 'POST', {digest:b.digest});
    assert.equal(readFileSync(join(f.root,'project/a.md'),'utf8'),'original approved bytes');
    assert.equal(readFileSync(join(f.root,'project/b.md'),'utf8'),'independent bytes');
    consistent(app);
  } finally { await app.close(); }
});

test('F01: admin recovery is scoped, repeatable and resumes the waiting queue without a restart', async () => {
  const {root,app,c}=await fixture();
  try {
    await c.call('/admin/users','POST',{username:'member',password,role:'member'},201);
    const member=new Client(c.base); await member.login('member');
    const a=await candidate(c,{'recover.md':'one approved result'});
    const session=await c.call('/sessions','POST',{title:'wait for admin recovery'},201);
    app.options.concurrency=0;
    const queued=await c.call('/tasks','POST',{session:session.id,requestId:'queue-admin-recovery',workflow:'chat',paths:[],prompt:'synthetic'},202);
    const original=app.projects.materialize.bind(app.projects);
    app.projects.materialize=()=>{throw new Error('transient disk fault');};
    await c.call(`/changes/${a.id}/approve`,'POST',{digest:a.digest},500);
    await member.call('/admin/project/recover','POST',{},403);
    await c.call('/admin/project/recover','POST',{},500);
    assert.equal(app.projects.pending().length,1);
    app.projects.materialize=original;
    app.options.concurrency=1;
    assert.equal((await c.call('/admin/project/recover','POST',{})).state,'ready');
    assert.equal((await settle(c,queued.id)).state,'completed');
    await c.call('/admin/project/recover','POST',{});
    const count=(app.store.db.prepare("SELECT count(*) n FROM events WHERE type='project.updated'").get() as any).n;
    assert.equal(count,1); consistent(app);
    assert.equal(readFileSync(join(root,'project/recover.md'),'utf8'),'one approved result');
  } finally {await app.close();}
});

test('F01: prepared, directory-swap and database-finalization failures recover consistently', async t => {
  for (const phase of ['prepared','directory_swap','database_finalize']) await t.test(phase,async()=>{
    const f=await fixture(); let app=f.app, c=f.c;
    try {
      const change=await candidate(c,{'phase.md':phase});
      if(phase==='prepared') {
        const git=app.projects.git.bind(app.projects);
        app.projects.git=(args,...rest)=>{if(args[0]==='update-ref') throw new Error('injected reference I/O'); return git(args,...rest);};
      } else if(phase==='directory_swap') {
        app.projects.materialize=()=>{renameSync(app.projects.canonical,join(f.root,'old-directory-preserved')); throw new Error('injected second rename I/O');};
      } else {
        const tx=app.store.tx.bind(app.store);
        app.store.tx=fn=>{if(app.projects.pending()[0]?.phase==='ref_updated') throw new Error('injected final transaction I/O'); return tx(fn);};
      }
      await c.call(`/changes/${change.id}/approve`,'POST',{digest:change.digest},500);
      assert.equal(app.projects.pending().length,1);
      await app.close(); app=new Platform({dataDir:f.root,mockDelay:1});
      c=new Client(`http://127.0.0.1:${await app.start(0)}`); await c.login();
      assert.equal(app.store.get('change',change.id)!.state,'committed'); consistent(app);
      assert.equal(readFileSync(join(f.root,'project/phase.md'),'utf8'),phase);
    } finally {await app.close();}
  });
});

test('F01: recovery preserves unexpected external bytes and failed startup releases its writer lock', async()=>{
  const f=await fixture(); let app=f.app; let closed=false;
  try {
    const change=await candidate(f.c,{'recover.md':'approved'});
    const original=app.projects.materialize.bind(app.projects);
    app.projects.materialize=()=>{throw new Error('injected I/O');};
    await f.c.call(`/changes/${change.id}/approve`,'POST',{digest:change.digest},500);
    app.projects.materialize=original;
    const external=join(f.root,'project/external-new.md'); writeFileSync(external,'unimported bytes must survive');
    await f.c.call('/admin/project/recover','POST',{},409);
    assert.equal(readFileSync(external,'utf8'),'unimported bytes must survive');
    assert.equal(app.store.get('change',change.id)!.state,'approved');
    await app.close(); closed=true;
    assert.throws(()=>new Platform({dataDir:f.root}),/新的外部文件变更/);
    assert.equal(existsSync(join(f.root,'writer.lock')),false);
    assert.equal(readFileSync(external,'utf8'),'unimported bytes must survive');
    // Simulate an operator preserving the new file separately before completing recovery.
    renameSync(external,join(f.root,'preserved-external-new.md'));
    app=new Platform({dataDir:f.root,mockDelay:1}); closed=false; await app.start(0); consistent(app);
    assert.equal(readFileSync(join(f.root,'preserved-external-new.md'),'utf8'),'unimported bytes must survive');
  } finally {if(!closed) await app.close();}
});

test('F02: cumulative HTTP submissions cannot publish past capacity or strand chat and corrective deletion', async()=>{
  const {app,c}=await fixture();
  try {
    for(let i=0;i<8;i++) {
      const change=await candidate(c,{[`large-${i}.txt`]:String.fromCharCode(65+i).repeat(1900*1024)});
      await c.call(`/changes/${change.id}/approve`,'POST',{digest:change.digest});
    }
    const base=app.projects.current().revision;
    const intents=app.store.all('intent').length;
    const change=await candidate(c,{'large-8.txt':'I'.repeat(1900*1024)});
    await c.call(`/changes/${change.id}/approve`,'POST',{digest:change.digest},409);
    assert.equal(app.projects.current().revision,base); assert.equal(app.store.all('intent').length,intents);
    assert.equal(app.store.get('change',change.id)!.state,'submitted'); consistent(app);
    const s=await c.call('/sessions','POST',{title:'chat remains available'},201);
    const task=await c.call('/tasks','POST',{session:s.id,requestId:'chat-after-reject',prompt:'synthetic',workflow:'chat',paths:[]},202);
    assert.equal((await settle(c,task.id)).state,'completed');
    const deletion=await candidate(c,{'large-7.txt':null});
    await c.call(`/changes/${deletion.id}/approve`,'POST',{digest:deletion.digest}); consistent(app);
    assert(app.projects.manifestBytes(app.projects.revision().manifest)<MAX_PROJECT_BYTES);
  } finally {await app.close();}
});

test('F02: exact capacity is allowed, one more byte is rejected before writing any revision', async()=>{
  const {app}=await fixture();
  try {
    const blob=app.projects.blob('X'.repeat(4*1024*1024));
    const manifest={'a.txt':blob,'b.txt':blob,'c.txt':blob,'d.txt':blob};
    const exact=app.projects.makeRevision(manifest,app.projects.current().revision);
    assert.equal(app.projects.manifestBytes(exact.manifest),MAX_PROJECT_BYTES);
    const count=app.store.all('revision').length;
    assert.throws(()=>app.projects.makeRevision({...manifest,'e.txt':app.projects.blob('x')},exact.id),/超过 16 MiB/);
    assert.equal(app.store.all('revision').length,count);
  } finally {await app.close();}
});

test('F02: legacy oversized versions allow strict reduction and external import back within capacity', async()=>{
  const {root,app,c}=await fixture();
  try {
    const blob=app.projects.blob('L'.repeat(3*1024*1024));
    const manifest=Object.fromEntries(Array.from({length:6},(_,i)=>[`legacy-${i}.txt`,blob]));
    // Fixture emulates data already published by 0.5.0; no production validation bypass exists.
    const validate=app.projects.validateCapacity.bind(app.projects); app.projects.validateCapacity=()=>{};
    const legacy=app.projects.makeRevision(manifest,app.projects.current().revision); app.projects.validateCapacity=validate;
    app.projects.git(['update-ref','refs/heads/main',legacy.id]); app.projects.materialize(legacy);
    app.store.put('project',{...app.projects.current(),revision:legacy.id});
    const growth=await candidate(c,{'growth.md':'x'}); await c.call(`/changes/${growth.id}/approve`,'POST',{digest:growth.digest},409);
    const shrink=await candidate(c,{'legacy-0.txt':'L'.repeat(1900*1024)});
    await c.call(`/changes/${shrink.id}/approve`,'POST',{digest:shrink.digest});
    assert(app.projects.manifestBytes(app.projects.revision().manifest)>MAX_PROJECT_BYTES);
    renameSync(join(root,'project/legacy-1.txt'),join(root,'removed-original-preserved.txt'));
    const imported=await c.call('/admin/import-diff','POST',{},201);
    await c.call(`/changes/${imported.id}/approve`,'POST',{digest:imported.digest});
    consistent(app); assert(app.projects.manifestBytes(app.projects.revision().manifest)<MAX_PROJECT_BYTES);
    assert.equal(readFileSync(join(root,'removed-original-preserved.txt')).length,3*1024*1024);
  } finally {await app.close();}
});
