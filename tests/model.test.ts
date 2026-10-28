import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PRICING, ZEN_PRICING, loadModel } from '../server/model.ts';
import { Platform } from '../server/app.ts';

for (const provider of ['deepseek-official', 'opencode-zen'] as const) test(provider + ': server-only key, fixed model/effort, workflow, tool roundtrip, usage, no retry and unlimited cost policy', async () => {
  const zen = provider === 'opencode-zen'; const pricing = zen ? ZEN_PRICING : PRICING; const modelId = zen ? 'glm-5.3-flash' : 'deepseek-flash'; const effort = zen ? 'max' : 'high';
  const bodies: any[] = []; let providerFailure = false; let loop = false; let parsing=false; const originalExpiry = pricing.expires; pricing.expires = '2000-01-01';
  const fixture = createServer(async (req, res) => {
    assert.equal(req.url, '/chat/completions'); assert.equal(req.headers.authorization, 'Bearer fixture-not-a-real-key');
    let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw); bodies.push(body);
    if (providerFailure) { res.writeHead(503); res.end('{"error":{"message":"synthetic failure"}}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (j: any) => res.write(`data: ${JSON.stringify(j)}\n\n`);
    if(parsing){send({id:'parse',choices:[{index:0,delta:{role:'assistant',content:'{"script":"共享测试项目","notes":"保持杯子","model":"","template":"","params":{},"shotIds":["S1"],"needsClarification":""}'},finish_reason:null}]});send({id:'parse',choices:[{index:0,delta:{},finish_reason:'stop'}]});send({id:'parse',choices:[],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}});res.end('data: [DONE]\n\n');return;}
    const done = !loop && body.messages.some((m: any) => m.role === 'tool');
    if (bodies.length === 1) { const t = app.store.all('task').find(t => t.state === 'running')!; app.store.put('model-call', { id: 'expensive-history', owner: t.owner, task: t.id, day: new Date().toISOString().slice(0,10), state: 'usage_recorded', estimatedUsd: 10000, syntheticHistory: true }); }
    send({ id: 'fixture-response', choices: [{ index: 0, delta: done ? { role: 'assistant', content: '受控适配器已读取测试资料。' } : { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'project_read', arguments: '{"paths":["README.md"]}' } }] }, finish_reason: null }] });
    send({ id: 'fixture-response', choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }] });
    send({ id: 'fixture-response', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 90 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
  const app = new Platform({ dataDir: mkdtempSync(join(tmpdir(), 'team-model-test-')), model: { provider, model: modelId, reasoningEffort: effort, baseURL: `http://127.0.0.1:${(fixture.address() as any).port}`, apiKey: 'fixture-not-a-real-key', configId: 'fixture-config', fixture: true } });
  const port = await app.start(0); const base = `http://127.0.0.1:${port}`; let cookie = '', csrf = '';
  async function call(path: string, body?: any, expected = 200) { const r = await fetch(base + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const j = await r.json() as any; assert.equal(r.status, expected, JSON.stringify(j)); if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0]; if (j.csrf) csrf = j.csrf; assert(!JSON.stringify(j).includes('fixture-not-a-real-key')); return j; }
  async function settle(task: any) { for (let i = 0; i < 300; i++) { const t = (await call('/tasks')).find((t: any) => t.id === task.id); if (!['running', 'queued'].includes(t.state)) return t; await delay(20); } throw new Error('timeout'); }
  try {
    const password = 'Test-only-model-password'; await call('/setup', { username: 'admin', password }, 201); await call('/login', { username: 'admin', password });
    const session = await call('/sessions', { title: '模型接入测试' }, 201);
    const task = { session: session.id, requestId: 'model-adapter-test', prompt: '整理测试资料', workflow: 'organize', paths: ['README.md'] };
    const initialUsage = await call('/admin/model-usage'); assert.equal(initialUsage.budget.mode, 'unlimited'); assert.equal(initialUsage.budget.dailyUsd, null); assert.equal(initialUsage.budget.enabled, true);
    await call('/admin/model-budget', { dailyUsd: 0 }, 410);
    await call('/admin/releases', { title: '专用模板', instruction: '独特的管理员流程要求', allowScripts: false }, 201);
    const t = await settle(await call('/tasks', task, 202)); assert.equal(t.state, 'awaiting_review', JSON.stringify(t));
    assert.equal(bodies.length, 2); assert(bodies.every(b => b.model === modelId && b.reasoning_effort === effort && b.max_tokens === (zen ? 32768 : 4096) && (zen ? b.thinking === undefined : b.thinking.type === 'enabled')));
    assert(bodies[0].messages.some((m: any) => m.role === 'system' && m.content.includes('独特的管理员流程要求')));
    assert(bodies[1].messages.some((m: any) => m.role === 'tool' && m.content.includes('共享')));
    const usage = await call('/admin/model-usage'); assert.equal(usage.calls.filter((c: any) => !c.syntheticHistory).length, 2); assert(usage.calls.filter((c: any) => !c.syntheticHistory).every((c: any) => c.state === 'usage_recorded' && c.usage.inputTokens === 90 && c.usage.cacheReadTokens === 10 && c.estimatedUsd > 0 && c.pricingStale)); assert(usage.budget.usedEstimateUsd > 10000);
    assert.equal(usage.calls.find((c:any)=>!c.syntheticHistory).estimatedUsd, (90*pricing.inputPerMillion + 10*pricing.cacheReadPerMillion + 20*pricing.outputPerMillion)/1e6);
    const messages = await call(`/sessions/${session.id}/messages`); assert.equal(messages.at(-1).simulated, false);
    providerFailure = true; const failure = await settle(await call('/tasks', { ...task, requestId: 'no-auto-retry' }, 202)); assert.equal(failure.state, 'failed'); assert.equal(bodies.length, 3);
    const unknown = await call('/admin/model-usage'); assert.equal(unknown.calls.filter((c: any) => c.state === 'unconfirmed').length, 1);
    providerFailure = false; app.store.put('budget', { id: 'active', dailyUsd: 0 });
    const afterLegacyZero = await settle(await call('/tasks', { ...task, requestId: 'old-zero-budget-ignored' }, 202)); assert.equal(afterLegacyZero.state, 'awaiting_review'); assert.equal(bodies.length, 4);
    loop = true; const loopingSession = await call('/sessions', { title: 'bounded tool loop' }, 201); const bounded = await settle(await call('/tasks', { ...task, session: loopingSession.id, requestId: 'tool-loop-stops' }, 202)); assert.equal(bounded.state, 'failed'); assert.equal(bodies.length, 8, 'fifth model request must not be sent');
    parsing=true;const admin=app.store.all('user')[0];app.pickups.publishIndex(admin,{base:app.projects.current().revision,shots:[{id:'S1',episode:'synthetic',scriptPath:'README.md',scriptQuote:'共享测试项目',storyboardPath:'README.md',storyboardQuote:'共享测试项目',duration:4,dayPeriod:'day',kind:'establishing',framing:'wide',visualDescription:'白天桌上的杯子',characters:[],assets:[],dialogue:[]}]});
    const extraction=await settle(await call('/tasks',{...task,requestId:'structured-extraction',workflow:'pickup',prompt:'剧本片段：共享测试项目\n补抽意见：保持杯子'},202));
    assert.notEqual(extraction.state,'failed');assert.equal(bodies.length,9);assert.equal(bodies.at(-1).thinking?.type,zen?undefined:'disabled');assert(!bodies.at(-1).tools?.length);assert.equal(app.store.all('model-call').at(-1)!.reasoningEffort,zen?'max':'off');assert.equal(app.store.all('model-call').at(-1)!.wireReasoningEffort,zen?'max':'off');
    console.log(JSON.stringify({ evidence: 'official_adapter_fixture', transport: 'loopback_only', onlineInference: false, toolRoundtrip: true, usageRecorded: true, secretNotInAPI: true, noRetry: true, unlimitedCostPolicy: true, oldZeroBudgetIgnored: true, expiredPricingDoesNotBlock: true, toolLoopBound: 4 }));
  } finally { pricing.expires = originalExpiry; await app.close(); await new Promise<void>(r => fixture.close(() => r())); }
});


test('restart migrates active cost policy without rewriting past releases or bills', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'team-policy-upgrade-'));
  const model = { provider: 'deepseek-official' as const, model: 'deepseek-flash', reasoningEffort: 'high' as const, baseURL: 'http://127.0.0.1:1', apiKey: 'fixture-key-never-used', configId: 'same-model-config', fixture: true };
  let app = new Platform({ dataDir, model }); await app.start(0);
  const old: any = { ...app.release(), limits: { ...app.release().limits, taskUsd: .25 } }; app.store.put('release', old); app.store.put('budget', { id: 'active', dailyUsd: 0 });
  app.store.put('model-call', { id: 'historical-bill', state: 'unconfirmed', reservedUsd: 42, day: '2026-09-20' });
  await app.close(); app = new Platform({ dataDir, model }); await app.start(0);
  try { assert.notEqual(app.release().id, old.id); assert.equal(app.release().limits.taskUsd, undefined); assert.equal(app.store.get('release', old.id)!.limits.taskUsd, .25); assert.equal(app.store.get('model-call', 'historical-bill')!.reservedUsd, 42); } finally { await app.close(); }
});

test('configuration pins Zen endpoint, model and declared effort; public policy excludes secrets', () => {
  const root=mkdtempSync(join(tmpdir(),'team-zen-config-'));const file=join(root,'model-connection.json');
  const c={provider:'opencode-zen',model:'glm-5.3-flash',reasoningEffort:'max',baseURL:'https://opencode.ai/zen/v1',apiKey:'fixture-not-a-real-secret'};
  const save=(v:any)=>{writeFileSync(file,JSON.stringify(v));chmodSync(file,0o600);};save(c);assert.equal(loadModel(root)!.reasoningEffort,'max');
  for(const bad of [{baseURL:'http://opencode.ai/zen/v1'},{baseURL:'https://example.test/v1'},{model:'unknown'},{reasoningEffort:'off'}]){save({...c,...bad});assert.throws(()=>loadModel(root));}
});
