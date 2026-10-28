import {accountingUsage} from './model-usage.ts';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { LlmAdapter, type GenerateOptions, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm';
import { type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import { Store, requireThat, hash, id, now, type Doc } from './store.ts';

import {chatProvider,type ChatProvider} from '../shared/chat-providers.ts';
import {ProtocolAdapter} from './protocol-adapter.ts';
import {modelProtocol} from './model-directory.ts';
import type {DirectoryModel,ModelProtocol} from './model-directory.ts';
import {adaptChatRequest,estimateUsd} from './chat-wire.ts';

export type ModelConnection = { provider: ChatProvider; model: string; protocol?:ModelProtocol; metadata?:DirectoryModel; reasoningEffort: 'off' | 'low' | 'high' | 'max'; baseURL: string; apiKey: string; configId: string; fixture?: boolean; verificationNoTools?: boolean; limits?: Partial<typeof LIMITS> };
export const LIMITS = { maxRequests: 4, maxTokens: 4096, maxRequestBytes: 128000 };
// Peak, cache-miss prices verified against the official page on 2026-09-21.
// These are conservative estimates, never a claim about the supplier's final bill.
export const PRICING = { currency: 'USD', inputPerMillion: 0.3, cacheReadPerMillion: 0.006, outputPerMillion: 1.2, verified: '2026-09-21', expires: '2026-10-21', source: 'https://api-docs.deepseek.com/quick_start/pricing' };
export const ZEN_PRICING = { currency: 'USD', inputPerMillion: 0.15, cacheReadPerMillion: 0.03, outputPerMillion: 0.5, verified: '2026-09-24', expires: '2026-10-24', source: 'https://opencode.ai/docs/zen/' };
export function modelPricing(c: ModelConnection) {
  if(c.provider==='ruiyun')return {currency:'CNY',inputPerMillion:null,cacheReadPerMillion:null,outputPerMillion:null,billingMode:'unpriced',verified:'',expires:'',source:chatProvider(c.provider)!.docs};
  if(c.provider==='zhipu-coding')return {currency:'CNY',inputPerMillion:null,cacheReadPerMillion:null,outputPerMillion:null,billingMode:'subscription',verified:'2026-09-25',expires:'2026-10-25',source:'https://docs.bigmodel.cn/cn/coding-plan/overview'};
  if(c.provider==='opencode-zen'&&!['glm-5.3','glm-5.3-flash'].includes(c.model)||c.provider==='deepseek-official'&&c.model!=='deepseek-flash')return {currency:'USD',inputPerMillion:null,cacheReadPerMillion:null,outputPerMillion:null,billingMode:'unpriced',verified:'',expires:'',source:chatProvider(c.provider)!.docs};
  if(c.provider==='opencode-zen')return c.model==='glm-5.3'?{...ZEN_PRICING,inputPerMillion:1.4,cacheReadPerMillion:0.26,outputPerMillion:4.4,verified:'2026-09-25'}:ZEN_PRICING;
  return PRICING;
}
function reasoning(c: ModelConnection, workflow: string) { return c.provider === 'deepseek-official' && workflow === 'pickup' ? 'off' : c.reasoningEffort; }
export function loadModel(root: string): ModelConnection | undefined {
  const path = join(root, 'model-connection.json'); if (!existsSync(path)) return;
  requireThat((statSync(path).mode & 0o077) === 0, '模型凭据文件权限必须为 600');
  const c = JSON.parse(readFileSync(path, 'utf8'));
  const preset=chatProvider(c.provider);
  requireThat(preset&&preset.baseURL===c.baseURL&&(preset.models as readonly string[]).includes(c.model),'模型与端点不在当前适配范围');
  requireThat((preset.efforts as readonly string[]).includes(c.reasoningEffort),'此模型不支持该推理档位');
  requireThat(c.provider!=='zhipu-coding','Coding Plan 请在后台添加并绑定席位成员，不能作为团队共享默认密钥');
  requireThat(['off', 'low', 'high', 'max'].includes(c.reasoningEffort) && typeof c.apiKey === 'string' && c.apiKey.length > 10, '模型配置不完整');
  return { provider: c.provider, model: c.model, reasoningEffort: c.reasoningEffort, baseURL: c.baseURL, apiKey: c.apiKey, ...(c.metadata?{metadata:c.metadata}:{}), configId: hash(JSON.stringify({ provider: c.provider, model: c.model, reasoningEffort: c.reasoningEffort, baseURL: c.baseURL })) };
}
export function effectiveLimits(c: ModelConnection) {
  const ceiling = c.provider !== 'deepseek-official' ? { ...LIMITS, maxTokens: 32768 } : LIMITS;
  const limits = { ...ceiling, ...c.limits };
  for (const [key, value] of Object.entries(limits)) requireThat(Number.isFinite(value) && value > 0 && value <= ceiling[key as keyof typeof LIMITS], '模型调用限额无效');
  return limits;
}
export function modelPolicy(c?: ModelConnection) {
  return c ? { provider: c.provider, model: c.model, reasoningEffort: c.reasoningEffort, configId: c.configId, limits: effectiveLimits(c), pricing: modelPricing(c) } : { provider: 'platform-mock', model: 'foundation-v1' };
}
export function budgetStatus(store: Store) {
  const day = new Date().toISOString().slice(0, 10);
  const calls = store.all('model-call');
  const used = calls.filter(c => c.day === day || ['reserved', 'pending', 'unconfirmed'].includes(c.state)).reduce((sum, c) => sum + (c.estimatedUsd ?? c.reservedUsd ?? 0), 0);
  const release = store.get('release', store.get('config', 'active')?.release ?? '');
  const pricing = release?.pricing ?? PRICING;
  return { mode: 'unlimited', dailyUsd: null, taskUsd: null, usedEstimateUsd: used, day, dayTimezone: 'UTC', enabled: true, pricing, pricingStale: day > pricing.expires, limits: release?.limits ?? LIMITS, unconfirmedCalls: calls.filter(c => ['reserved', 'pending', 'unconfirmed'].includes(c.state)).length };
}
type Active = { task: Doc; signal: AbortSignal; onText: (s: string) => void; onReasoning?: (s:string)=>void; calls: number; modelCallId?: string };

// Harness can retain multiple policy messages on a resumed request surface. A
// compatible provider may privilege the first one; send only today's assembled
// policy first, while preserving the complete durable conversation on the host.
export function currentModelContext(messages: GenerateOptions['messages']) {
  const latestSystem = messages.filter(m => m.role === 'system').at(-1);
  const lastUser = messages.findLastIndex(m => m.role === 'user' && !m.content.some(b => (b as any).type === 'tool-result'));
  const history = messages.filter(m => m.role !== 'system').map(m => {
    const index = messages.indexOf(m);
    return m.role === 'assistant' && index < lastUser ? { ...m, content: m.content.filter(b => b.type !== 'reasoning') } : m;
  });
  return latestSystem ? [latestSystem, ...history] : history;
}

/** Compatible chat-completions transport, with provider-specific identity and accounting.
 * Only explicit provider routes are exposed; no generic custom endpoints. */
export class ControlledChat extends LlmAdapter {
  private inner: DeepSeekAdapter;
  private limits: typeof LIMITS;
  constructor(private store: Store, private connection: ModelConnection, private active: (session: string) => Active | undefined) {
    super(); this.limits = effectiveLimits(connection);
    const limits = this.limits; const pricing = modelPricing(connection);
    let identity = store.get('runtime', 'identity'); if (!identity) { identity = { id: 'identity', anonymousId: id() }; store.put('runtime', identity); }
    const anonymousId = identity.anonymousId;
    const c = resolveAdapterOptions({ baseURL: connection.baseURL, reasoningEffort: connection.reasoningEffort, maxTokens: limits.maxTokens, streamIdleTimeoutMs: 60000, models: [{ id: connection.model, inputModalities: ['text'], maxTokens: limits.maxTokens }], retryPolicy: { mode: 'normal', maxRetries: 0 } });
    const adapterConfig = { options: () => c, resolveAuth: async () => ({headers:{Authorization:'Bearer '+connection.apiKey}}), resolveUserId: () => anonymousId as AnonymousUserId,
      prepareExtensions: async (request:any) => {
        request.signal.throwIfAborted();
        const e = this.execution(String(request.sessionId));
        adaptChatRequest(connection,request.body);
        const contextAudit = { policy: 'current_system_v1', systemMessageCount: (Array.isArray(request.body.messages)?request.body.messages:[]).filter((m:any) => m?.role === 'system').length, toolNames: (Array.isArray(request.body.tools)?request.body.tools:[]).map((t:any) => t?.function?.name).filter(Boolean) };
        const bytes = Buffer.byteLength(JSON.stringify(request.body)); requireThat(bytes <= limits.maxRequestBytes, '会话上下文超过当前调用限额，请新建聊天或减少引用资料', 422);
        // UTF-8 bytes plus protocol margin deliberately overestimates text tokens.
        const reservedUsd = estimateUsd(pricing,bytes+8192,0,limits.maxTokens*2);
        const budget = budgetStatus(store);
        const call = { id: id(), owner: e.task.owner, task: e.task.id, day: budget.day, provider: connection.provider, model: connection.model, configId: connection.configId, reasoningEffort: reasoning(connection, e.task.workflow), wireReasoningEffort: request.body.reasoning_effort ?? 'off', maxTokens: request.body.max_tokens, requestSha256: hash(JSON.stringify(request.body)), endpoint: connection.baseURL + '/chat/completions', pricing: { ...pricing }, workflow: e.task.workflow, state: 'pending', reservedUsd, budgetMode: 'unlimited', pricingStale: budget.day > pricing.expires, requestBytes: bytes, created: now(), fixture: !!connection.fixture };
        store.put('model-call', { ...call, contextAudit }); e.modelCallId = call.id;
        store.audit(e.task.owner, 'model.request.recorded', e.task.id, { call: call.id, model: connection.model, reservedUsd });
        return { fields: {}, accept: async () => { store.put('model-call', { ...store.get('model-call', call.id)!, accepted: true }); } };
      }
    };
    // All configured protocols pass through the existing host transport bridge.
    // Upstream's DeepSeek adapter now speaks Messages only.
    this.inner=new ProtocolAdapter(connection,store,adapterConfig);
  }
  private execution(session: string) {
    const e = this.active(session); requireThat(e && !e.signal.aborted && this.store.get('user', e.task.owner)?.active, '模型执行授权失效', 403);
    requireThat(e.task.release.configId === this.connection.configId, '后台模型配置已改变，请重新提交任务', 409); return e;
  }
  override providerRetryPolicy(provider: string) { return this.inner.providerRetryPolicy(provider); }
  override resolveModel(provider: string, model: string) { return this.inner.resolveModel(provider, model); }
  override listModels(provider: string) { return this.inner.listModels(provider); }
  override async *stream(o: GenerateOptions): AsyncIterable<StreamChunk> {
    const e = this.execution(String(o.sessionId));
    requireThat(o.provider === this.connection.provider && o.model === this.connection.model, '后台模型政策不匹配', 403);
    requireThat(++e.calls <= this.limits.maxRequests, '任务已达到模型调用步数上限', 422);
    e.modelCallId = undefined; let usage: TokenUsage | undefined; let completed = false;
    try {
      // Preserve the selected Zen effort; only DeepSeek extraction uses its separate policy.
      const reasoningEffort = reasoning(this.connection, e.task.workflow);
      for await (const chunk of this.inner.stream({ ...o, messages: currentModelContext(o.messages), ...(this.connection.verificationNoTools || e.task.workflow === 'pickup' ? { tools: [] } : {}), maxTokens: this.limits.maxTokens, reasoningEffort: reasoningEffort as any, signal: AbortSignal.any([e.signal, ...(o.signal ? [o.signal] : []), AbortSignal.timeout(180000)]) })) {
        if (this.connection.verificationNoTools && (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call'))) throw new Error('验收请求禁止工具调用');
        if (chunk.type === 'text-delta') e.onText(chunk.text);
        if (chunk.type === 'reasoning-delta') e.onReasoning?.(chunk.text);
        if (chunk.type === 'usage') usage = chunk.usage;
        if (chunk.type === 'finish') completed = ['stop', 'tool-calls'].includes(chunk.reason.kind);
        yield chunk;
      }
    } catch { throw new Error('线上模型请求未完成；请管理员查看调用记录。平台未自动重发。'); }
    finally {
      if (e.modelCallId) {
        const call = this.store.get('model-call', e.modelCallId)!;
        const pricing = call.pricing;
        const recordedUsage = accountingUsage(usage), valid = !!recordedUsage;
        const estimatedUsd = valid ? estimateUsd(pricing,recordedUsage!.inputTokens+(recordedUsage!.cacheWriteTokens??0),recordedUsage!.cacheReadTokens??0,recordedUsage!.outputTokens) : undefined;
        this.store.put('model-call', { ...call, state: valid ? 'usage_recorded' : 'unconfirmed', finished: now(), completed, ...(valid ? { usage: recordedUsage, estimatedUsd, billing: pricing.billingMode==='subscription'?'subscription_usage_pending_reconciliation':'peak_rate_estimate_not_final_bill' } : { billing: 'usage_unknown_pending_reconciliation' }) });
      }
    }
  }
}
