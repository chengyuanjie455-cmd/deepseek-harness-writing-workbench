import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient, StaleResponse } from '../web/api.ts';
import { Platform } from '../server/app.ts';

test('late responses cannot overwrite a new identity or CSRF token', async () => {
  for (const status of [200, 401]) {
    let resolve!: (r: Response) => void;
    const client = new ApiClient(() => new Promise(r => { resolve = r; }));
    const old = client.call('/changes/private');
    client.invalidate(); client.csrf = 'new-account';
    resolve(new Response(JSON.stringify({ csrf: 'old-account', error: 'old failure', diff: ['private'] }), { status }));
    await assert.rejects(old, StaleResponse);
    assert.equal(client.csrf, 'new-account');
  }
});

test('HTTP timeout is bounded and reports an uncertain submission without retry', async () => {
  let attempts = 0;
  const client = new ApiClient((_url, init) => new Promise((_resolve, reject) => {
    attempts++; init!.signal!.addEventListener('abort', () => reject(new Error('timeout')));
  }), 15);
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(client.call('/tasks', 'POST', {}), (e: any) => e.uncertain === true); assert.equal(attempts, 1); }
  finally { clearTimeout(keepAlive); }
});

test('lost task receipt reconciles by original ID and cannot execute twice; stale tab reads are rejected', async () => {
  const app = new Platform({ dataDir: mkdtempSync(join(tmpdir(), 'team-lost-receipt-')), mockDelay: 1 });
  const base = `http://127.0.0.1:${await app.start(0)}`;
  let cookie = ''; let drop = true;
  const client = new ApiClient(async (path, options) => {
    const response = await fetch(base + path, { ...options, headers: { ...options?.headers, Origin: base, Cookie: cookie } });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    if (path === '/api/tasks' && options?.method === 'POST' && drop) { drop = false; await response.json(); throw new TypeError('response lost after accepted'); }
    return response;
  });
  try {
    const credentials = { username: 'admin', password: 'synthetic-test-only-4422' };
    await client.call('/setup', 'POST', credentials); await client.call('/login', 'POST', credentials);
    const session = await client.call('/sessions', 'POST', { title: 'lost receipt' });
    const body = { session: session.id, prompt: 'once only', paths: [], workflow: 'chat', requestId: 'same-request-on-recovery' };
    await assert.rejects(client.call('/tasks', 'POST', body), (e: any) => e.uncertain);
    const found = (await client.call('/tasks')).find((t: any) => t.requestId === body.requestId);
    assert(found);
    const confirmed = await client.call('/tasks', 'POST', body);
    assert.equal(confirmed.id, found.id);
    assert.equal((await client.call('/tasks')).length, 1);
    assert.equal((await client.call(`/sessions/${session.id}/messages`)).filter((m: any) => m.role === 'user').length, 1);
    const oldCsrf = client.csrf; await client.call('/login', 'POST', credentials);
    const stale = await fetch(base + '/api/project', { headers: { Cookie: cookie, 'X-CSRF-Token': oldCsrf } });
    assert.equal(stale.status, 401);
    assert((await client.call('/project')).revision);
  } finally { await app.close(); }
});


test('an unconfigured optional service returns JSON null without a false network error',async()=>{
 const client=new ApiClient(async()=>new Response('null',{headers:{'Content-Type':'application/json'}}));
 assert.equal(await client.call('/admin/video-storage'),null);
});

test('changing project invalidates late responses and binds subsequent requests to the selected project',async()=>{
 let finish!:(r:Response)=>void;const paths:string[]=[];let pending=true;
 const client=new ApiClient((url)=>{paths.push(String(url));return pending?new Promise(r=>{finish=r;}):Promise.resolve(new Response('{}'));});
 const old=client.call('/tasks');client.selectProject('12345678-1234-1234-1234-123456789012');finish(new Response(JSON.stringify({csrf:'stale'})));await assert.rejects(old,StaleResponse);assert.equal(client.csrf,'');pending=false;
 await client.call('/file?path=script.md');assert.equal(paths[1],'/api/file?path=script.md&project=12345678-1234-1234-1234-123456789012');client.selectProject('shared');await client.call('/tasks');assert.equal(paths[2],'/api/tasks');
});
