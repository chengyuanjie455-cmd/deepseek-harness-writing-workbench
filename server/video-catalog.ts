import {providerFailure} from './provider-failure.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIPv4 } from 'node:net';
import {memberModelAllowed} from './member-models.ts';
import {storyboardEnabled,videoFamily} from './video-storyboard.ts';
import { Store, requireThat, id, now, hash, Problem, type Doc } from './store.ts';

/** Only use for errors proven to occur before the provider request is sent. */
export class VideoNotSubmitted extends Problem {constructor(message:string,public retryable=false){super(409,message);}}

export function fields(b: Doc, names: string[]) { requireThat(b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).every(k => names.includes(k)), '包含不允许的字段'); }
export function text(v: unknown, label: string, max = 1000): string { requireThat(typeof v === 'string' && v.trim().length > 0 && v.length <= max, `${label}无效`); return v.trim(); }
export function httpsURL(v: unknown) { const u = new URL(text(v, 'HTTPS 地址', 4096)); requireThat(u.protocol === 'https:' && !u.username && !u.password && !u.hash, '仅接受不含账户信息的 HTTPS 地址'); return u; }
export function apiOrigin(v:unknown,allowLocalHTTP=false,allowRuiyunPrefix=false) { const u=new URL(text(v,'API 地址',4096)); const n=u.hostname.split('.').map(Number);const local=u.hostname==='localhost'||u.hostname==='[::1]'||isIPv4(u.hostname)&&(n[0]===127||n[0]===10||n[0]===192&&n[1]===168||n[0]===172&&n[1]>=16&&n[1]<=31);requireThat(!u.username&&!u.password&&!u.hash&&!u.search&&(u.pathname==='/'||allowRuiyunPrefix&&u.pathname==='/ruiyun') && (u.protocol==='https:' || allowLocalHTTP && u.protocol==='http:' && local),'使用 HTTPS 根地址，或明确启用本机/局域网 HTTP；不接受公网 HTTP');return u; }
export const templateVariables = ['script', 'storyboard', 'notes', 'assets', 'dayPeriod', 'duration', 'dialogue', 'wardrobe', 'visualDescription'];
const nameKey = (v:string) => v.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();
export type VideoAdapter = {
  create(channel: Doc, key: string, payload: Doc, signal: AbortSignal): Promise<Doc>;
  query(channel: Doc, key: string, taskId: string, signal: AbortSignal): Promise<Doc>;
  content(channel: Doc, key: string, taskId: string, signal: AbortSignal): Promise<Response>;
  upload?(channel: Doc, key: string, bytes: Buffer, name:string, mime:string, signal:AbortSignal): Promise<string>;
};
/** Freeze the exact provider body before authorization is consumed. */
export function videoPayload(channel: Doc, payload: Doc): Doc {
  requireThat(['xiaopei','ruiyun'].includes(channel.adapter), '该 API 适配器尚未实现');
  fields(payload, ['model','prompt','seconds','size','resolution','aspect_ratio','audio','seed','fps','watermark','images','videos','audios','referenceMode']);
  const extra: Doc = {};
  for (const k of ['resolution','aspect_ratio','seed','fps','watermark']) if (payload[k] !== undefined) extra[k] = payload[k];
  if (payload.audio !== undefined) extra.generate_audio = payload.audio;
  if (payload.images?.length && payload.referenceMode!=='first_frame') extra.reference_images = payload.images.map((item:string|Doc,index:number) => typeof item==='string'?{url:item,role:payload.referenceMode==='first_last'?(index===0?'first_frame':'last_frame'):'reference_image'}:item);
  for(const [key,items] of [['reference_videos',payload.videos],['reference_audios',payload.audios]] as const)if(items?.length)extra[key]=items.map((url:string)=>({url}));
  return {model:payload.model,prompt:payload.prompt,seconds:channel.adapter==='ruiyun'?String(payload.seconds):payload.seconds,...(payload.images?.length&&payload.referenceMode==='first_frame'?{input_reference:{url:typeof payload.images[0]==='string'?payload.images[0]:payload.images[0].url}}:{}),...(payload.size ? {size:payload.size} : {}),extra};
}
/** Resolve every frozen media reference into the same wire fields at planning and submission. */
export function videoShotPayload(channel:Doc,model:Doc,shot:Doc,assets:Doc[]=shot.assets){
  const urls=(kind:string)=>assets.filter(a=>(a.mediaKind??'image')===kind).map(a=>a.url||`asset:${a.mediaId}`);
  return videoPayload(channel,{model:model.remoteModel,prompt:shot.prompt,...shot.params,referenceMode:shot.referenceMode??model.referenceMode,
    ...(model.watermark!==undefined?{watermark:model.watermark}:{}),images:urls('image'),videos:urls('video'),audios:urls('audio')});
}
export class VideoHTTPFailure extends Problem {constructor(public httpStatus:number,public receipt:Doc){super(502,`API 返回 HTTP ${httpStatus}；${providerFailure(receipt).error}`);}}
export async function boundedJSON(response: Response) {
  requireThat(response.body, 'API 返回空响应', 502); const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body as any) { size += chunk.length; requireThat(size <= 2 * 1024 * 1024, 'API 响应超过限制', 502); chunks.push(chunk); }
  if(!response.ok){let receipt:Doc={};try{receipt=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}throw new VideoHTTPFailure(response.status,receipt);}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Doc; } catch { throw new Error('API 响应不是 JSON'); }
}
export function apiEndpoint(origin:string,path:string){
  requireThat(/^\/(?:v1\/|api\/)/.test(path)&&!path.includes('..'),'API 路径无效');
  const base=new URL(origin.replace(/\/$/,'')+'/'),url=new URL(path.slice(1),base);
  requireThat(url.origin===base.origin&&url.pathname.startsWith(base.pathname),'API 地址越界');return url;
}
export class RuiyunAdapter implements VideoAdapter {
  async request(c: Doc, key: string, path: string, signal: AbortSignal, payload?: Doc) {
    const url = apiEndpoint(c.origin,path);
    return fetch(url, { method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), headers: { Authorization: `Bearer ${key}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  }
  create(c: Doc, key: string, payload: Doc, signal: AbortSignal) { return this.request(c, key, '/v1/videos', signal, payload).then(boundedJSON); }
  query(c: Doc, key: string, taskId: string, signal: AbortSignal) { return this.request(c, key, `/v1/videos/${encodeURIComponent(taskId)}`, signal).then(boundedJSON); }
  content(c: Doc, key: string, taskId: string, signal: AbortSignal) { return this.request(c, key, `/v1/videos/${encodeURIComponent(taskId)}/content`, signal); }
}

/** Xiaopei Video API v1. Creation is a single fetch; neither redirects nor retries are allowed. */
export class XiaopeiAdapter extends RuiyunAdapter {
  async upload(c:Doc,key:string,bytes:Buffer,name:string,mime:string,signal:AbortSignal) {
    requireThat(c.origin==='https://api.aicopy.top','素材上传渠道无效');
    const form=new FormData();form.append('image',new Blob([new Uint8Array(bytes)],{type:mime}),name);
    // The official workbench hosts uploads separately from the paid video API.
    const response=await fetch('https://api.aione.help/v1/uploads',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`},body:form,signal:AbortSignal.any([signal,AbortSignal.timeout(120000)])});
    const raw=await boundedJSON(response);const d=raw.data??{};
    const url=raw.url??raw.file_url??raw.image_url??raw.urls?.[0]??d.url??d.file_url??d.image_url??d.urls?.[0];
    return httpsURL(url).toString();
  }
  override async query(c:Doc,key:string,taskId:string,signal:AbortSignal) {
    const result=await super.query(c,key,taskId,signal);
    // Observed provider receipt: status=unknown with the explicit queue message.
    // Other unknown states remain unknown; retain the raw status for auditing.
    return result.status==='unknown'&&result.status_message==='排队中'
      ? {...result,status:'queued',providerStatus:result.status,statusNormalizedFrom:'status_message'} : result;
  }
  override async request(c:Doc,key:string,path:string,signal:AbortSignal,payload?:Doc) {
    requireThat(c.origin === 'https://api.aicopy.top', '小裴适配器仅连接已核验的 HTTPS API 地址');
    return fetch(new URL(path,c.origin), {method:payload?'POST':'GET',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(payload?900000:60000)]),headers:{Authorization:`Bearer ${key}`,Accept:'application/json',...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{})});
  }
}
export class ConfiguredVideoAdapter implements VideoAdapter {
  upload(c:Doc,k:string,b:Buffer,n:string,m:string,s:AbortSignal){requireThat(c.adapter==='xiaopei','此渠道需配置素材托管');return new XiaopeiAdapter().upload(c,k,b,n,m,s);}
  select(c:Doc) { requireThat(['ruiyun','xiaopei'].includes(c.adapter),'该 API 适配器尚未实现');return c.adapter==='xiaopei'?new XiaopeiAdapter():new RuiyunAdapter(); }
  create(c:Doc,k:string,p:Doc,s:AbortSignal){return this.select(c).create(c,k,p,s);}
  query(c:Doc,k:string,t:string,s:AbortSignal){return this.select(c).query(c,k,t,s);}
  content(c:Doc,k:string,t:string,s:AbortSignal){return this.select(c).content(c,k,t,s);}
}

export function capabilityIdentity(m:Doc,c:Doc) {
  return hash(JSON.stringify([c.origin,c.adapter,c.secretRef,c.allowLocalHTTP===true,m.remoteModel,m.params,m.defaults,m.secondsType,m.durations,m.referenceField,m.maxReferences,m.referenceMode,m.minReferences,...(m.unifiedMedia?[m.modes,m.maxVideoReferences,m.maxAudioReferences,m.durationPolicy,m.parameterPolicy]:[])]));
}

export class VideoCatalog {
  constructor(public store: Store, public maxConcurrency = 2) { mkdirSync(join(store.root, 'video-secrets'), { recursive: true, mode: 0o700 }); }
  legacyTemplates(projectId:string){return this.store.all('video-template').filter(t=>!t.nativeEnabled&&(!t.projectId||t.projectId===projectId));}
  admin(user: Doc) { const u = this.store.get('user', user.id); requireThat(u?.active && u.role === 'admin', '仅超级管理员可配置视频服务', 403); }
  secret(c: Doc) { requireThat(/^[a-f0-9-]{36}$/.test(c.secretRef), '渠道密钥未配置', 409); return readFileSync(join(this.store.root, 'video-secrets', c.secretRef), 'utf8'); }
  publicChannel(c: Doc): Doc { const { secretRef, ...safe } = c; return { ...safe, credentialConfigured: !!secretRef }; }
  channels() { return this.store.all('video-channel').map(c => this.publicChannel(c)); }
  saveChannel(user: Doc, b: Doc) {
    this.admin(user); fields(b, ['id', 'name', 'origin', 'adapter', 'apiKey', 'enabled', 'concurrency', 'noRetryEvidence', 'allowLocalHTTP']);
    const old = b.id ? this.store.get('video-channel', b.id) : undefined; requireThat(!b.id || old, '渠道不存在', 404);
    requireThat(b.allowLocalHTTP===undefined||typeof b.allowLocalHTTP==='boolean','本地 HTTP 开关无效'); const u = apiOrigin(b.origin,b.allowLocalHTTP===true,b.adapter==='ruiyun'); requireThat(['ruiyun','xiaopei'].includes(b.adapter), '该 API 适配器尚未实现');
    requireThat(b.adapter!=='xiaopei'||u.origin==='https://api.aicopy.top','小裴适配器仅连接已核验的 HTTPS API 地址');
    requireThat(typeof b.enabled === 'boolean' && Number.isInteger(b.concurrency) && b.concurrency >= 1 && b.concurrency <= this.maxConcurrency, `渠道并发须为1至${this.maxConcurrency}`);
    let secretRef = old?.secretRef;
    if (b.apiKey) { const key = text(b.apiKey, 'API 密钥', 4096); requireThat(!/[\r\n]/.test(key), '密钥格式错误'); secretRef = id(); writeFileSync(join(this.store.root, 'video-secrets', secretRef), key, { flag: 'wx', mode: 0o600 }); }
    requireThat(secretRef, '请配置 API 密钥');
    const evidence = typeof b.noRetryEvidence === 'string' ? b.noRetryEvidence.trim().slice(0, 8000) : '';
    // Capacity is scheduling policy, not a new provider contract. Preserve model
    // verification and already-authorized plans when only this setting changes.
    if(old&&!b.apiKey&&old.name===b.name.trim()&&old.origin===u.origin&&old.adapter===b.adapter&&old.enabled===b.enabled&&!!old.allowLocalHTTP===(b.allowLocalHTTP===true)&&old.noRetryEvidence===evidence){
      const next:Doc={...old,concurrency:b.concurrency,updated:now()};this.store.tx(()=>{this.store.put('video-channel',next);this.store.audit(user.id,'video.channel.capacity',next.id,{before:old.concurrency,after:next.concurrency});});return this.publicChannel(next);
    }
    const c = { id: old?.id ?? id(), revision: id(), name: text(b.name, '渠道名称', 100), origin: u.href.replace(/\/$/,''), allowLocalHTTP:b.allowLocalHTTP===true, adapter: b.adapter, secretRef, enabled: b.enabled, concurrency: b.concurrency, noRetryEvidence: evidence, evidenceStatus: evidence ? 'admin_attested' : 'missing', verified: false, created: now(), author: user.id };
    this.store.tx(() => { this.store.put('video-channel', c); this.store.put('video-channel-version', { ...c, id: c.revision, channelId: c.id }); this.store.audit(user.id, 'video.channel.save', c.id, { revision: c.revision, evidenceStatus: c.evidenceStatus }); }); return this.publicChannel(c);
  }
  async probe(user: Doc, channelId: string) {
    this.admin(user); const c = this.store.get('video-channel', channelId); requireThat(c, '渠道不存在', 404);
    const result = await boundedJSON(await new RuiyunAdapter().request(c, this.secret(c), '/v1/models', new AbortController().signal));
    this.admin(user); requireThat(this.store.get('video-channel', c.id)?.revision === c.revision, '检测期间渠道已修改', 409);
    requireThat(Array.isArray(result.data), '模型列表响应不符合协议', 422);
    const models = result.data.map((m: Doc) => String(m.id)).filter((v: string) => v.length <= 240).slice(0, 2000);
    const next = { ...c, verified: true, reachableModels: models, checkedAt: now() }; this.store.put('video-channel', next); this.store.put('video-channel-version', { ...next, id: c.revision, channelId: c.id }); this.store.audit(user.id, 'video.channel.probe', c.id, { count: models.length }); return this.publicChannel(next);
  }
  saveModel(user: Doc, b: Doc) {
    this.admin(user); fields(b, ['id', 'name', 'aliases', 'channelId', 'remoteModel', 'status', 'default', 'params', 'defaults', 'secondsType', 'durations', 'referenceField', 'maxReferences', 'capabilityEvidence', 'pricePerSecond', 'currency', 'memberAccess']);
    const old = b.id ? this.store.get('video-model', b.id) : undefined; requireThat(!b.id || old, '模型不存在', 404);
    const name=text(b.name,'模型名称',100);requireThat(!this.store.all('video-model').some(m=>m.id!==b.id&&nameKey(m.name)===nameKey(name)),'展示名称已存在，请在名称中加入渠道以区分',409);
    const c = this.store.get('video-channel', b.channelId); requireThat(c, '请先配置 API 渠道');
    requireThat(['draft', 'testing', 'published', 'disabled'].includes(b.status), '发布状态无效');
    requireThat(Array.isArray(b.aliases) && b.aliases.length <= 20 && b.aliases.every((a: any) => typeof a === 'string' && a.trim() && a.length <= 100), '模型别名无效');
    requireThat(Array.isArray(b.durations) && b.durations.length > 0 && b.durations.length <= 120 && b.durations.every((n: any) => Number.isFinite(n) && n >= 4 && n <= 120), '请按已核验能力填写允许时长');
    requireThat(['string', 'number'].includes(b.secondsType), 'seconds 类型未配置');
    const allowed = ['resolution', 'aspect_ratio', 'audio', 'seed', 'size','fps','watermark']; fields(b.params, allowed); fields(b.defaults, Object.keys(b.params));
    for (const [k, values] of Object.entries(b.params)) requireThat(Array.isArray(values) && values.length > 0 && values.length <= 100 && values.every(v => ['string', 'number', 'boolean'].includes(typeof v)) && (b.defaults[k] === undefined || values.includes(b.defaults[k])), `${k} 参数选项或默认值无效`);
    requireThat(['none', 'images'].includes(b.referenceField) && Number.isInteger(b.maxReferences) && b.maxReferences >= 0 && b.maxReferences <= 30, '参考图片能力无效');
    requireThat(b.referenceField !== 'none' || b.maxReferences === 0, '无参考模型的引用上限应为零');
    requireThat(b.pricePerSecond === null || typeof b.pricePerSecond === 'number' && Number.isFinite(b.pricePerSecond) && b.pricePerSecond >= 0, '单价无效；未知请填 null');
    requireThat(['CNY', 'USD'].includes(b.currency), '币种无效');
    requireThat(b.memberAccess===undefined||typeof b.memberAccess==='boolean','成员使用权限无效');
    const m = { ...(old?Object.fromEntries(['unifiedMedia','modes','maxVideoReferences','maxAudioReferences','minVideoReferences','requiresReference','durationPolicy','parameterPolicy','contractConfidence','watermark'].map(k=>[k,old[k]])):{}),managedBy:'admin',referenceMode:old?.referenceMode,minReferences:old?.minReferences,memberAccess:b.memberAccess===true, id: old?.id ?? id(), revision: id(), name: text(b.name, '模型名称', 100), aliases: b.aliases.map((a: string) => a.trim()), channelId: c.id, channelRevision: c.revision, remoteModel: text(b.remoteModel, '真实模型 ID', 240), status: b.status, default: !!b.default, params: b.params, defaults: b.defaults, secondsType: b.secondsType, durations: b.durations, referenceField: b.referenceField, maxReferences: b.maxReferences, capabilityEvidence: String(b.capabilityEvidence ?? '').slice(0, 8000), pricePerSecond: b.pricePerSecond, currency: b.currency, created: now(), author: user.id };
    const capabilityHash = hash(JSON.stringify([m.channelRevision, m.remoteModel, m.params, m.defaults, m.secondsType, m.durations, m.referenceField, m.maxReferences, m.capabilityEvidence]));
    if (['testing', 'published'].includes(m.status)) { requireThat(c.enabled && c.verified && c.reachableModels?.includes(m.remoteModel), '渠道未验证或当前账号不可用此模型', 409); requireThat(c.noRetryEvidence && m.capabilityEvidence, '需登记当前服务端单次创建证据及模型协议证据', 409); }
    if (m.status === 'published') requireThat(this.store.all('video-job').some(j => {
      if (!['ready','adopted'].includes(j.state) || j.simulated || !j.technicalQA?.passed) return false;
      if (j.modelCapabilityHash === capabilityHash) return true;
      // Capacity/name-only channel changes do not invalidate a verified wire contract.
      // Reuse requires the immutable original plan, original channel and same credential.
      const p=this.store.get('pickup',j.planId), previous=this.store.get('video-channel-version',j.channelRevision);
      const originalContractHash=hash(JSON.stringify([j.channelRevision,m.remoteModel,m.params,m.defaults,m.secondsType,m.durations,m.referenceField,m.maxReferences,m.capabilityEvidence]));
      return p && p.model?.capabilityHash===j.modelCapabilityHash && originalContractHash===j.modelCapabilityHash && previous &&
        capabilityIdentity(p.model,previous)===capabilityIdentity(m,c);
    }), '先在测试状态完成真实原片回收和技术检查，再开放模型', 409);
    this.store.tx(() => { if (m.default && ['published','testing'].includes(m.status)) for (const other of this.store.all('video-model')) if (other.default && other.id !== m.id) this.store.put('video-model', { ...other, default: false }); this.store.put('video-model', { ...m, capabilityHash });this.store.db.prepare('DELETE FROM docs WHERE kind=? AND id=?').run('media-model-exclusion',hash(JSON.stringify([c.id,m.remoteModel,'video']))); this.store.audit(user.id, 'video.model.save', m.id, { revision: m.revision, status: m.status }); }); return this.store.get('video-model', m.id)!;
  }
  models(user: Doc): Doc[] { return this.store.all('video-model').filter(m=>!storyboardEnabled(this.store)||!!videoFamily(m)||m.unifiedMedia===true).filter(m => memberModelAllowed(this.store,user,'video',m.id)).filter(m => user.role === 'admin' || (m.status === 'published'||m.status==='testing'&&m.memberAccess===true) && this.store.get('video-channel', m.channelId)?.enabled && this.store.get('video-channel',m.channelId)?.reachableModels?.includes(m.remoteModel)).map(m => { const { capabilityEvidence, ...safe } = m; return { ...(user.role === 'admin' ? m : safe),channelName:this.store.get('video-channel',m.channelId)?.name }; }); }
  saveTemplate(user: Doc, b: Doc, projectId?:string) {
    this.admin(user); fields(b, ['id', 'name', 'body', 'status', 'modelIds', 'default', 'nativeEnabled']);
    const old = b.id ? this.store.get('video-template', b.id) : undefined; requireThat(!b.id || old, '模板不存在', 404);
    text(b.body, '模板正文', 16000); const body: string = b.body; const vars = [...body.matchAll(/\{\{([^{}]+)\}\}/g)].map(m => m[1]); requireThat(vars.every(v => templateVariables.includes(v)), '模板包含未知变量');
    requireThat(['draft', 'published', 'disabled'].includes(b.status) && Array.isArray(b.modelIds) && b.modelIds.every((m: string) => this.store.get('video-model', m)), '模板状态或适用模型无效');
    const simple = ['script', 'notes'].every(v => vars.includes(v));
    const legacy = ['notes', 'storyboard', 'assets', 'dayPeriod', 'duration'].every(v => vars.includes(v));
    requireThat(b.status !== 'published' || simple || legacy, '补抽模板请保留剧本片段 {{script}} 和补抽意见 {{notes}}');
    requireThat(b.nativeEnabled===undefined||typeof b.nativeEnabled==='boolean','项目模板开关无效');const nativeEnabled=b.nativeEnabled??old?.nativeEnabled??false;requireThat(!nativeEnabled||projectId,'原生模板需要当前项目');requireThat(!old?.projectId||old.projectId===projectId,'模板属于其他项目',403);
    const t = { nativeEnabled,projectId:nativeEnabled?projectId:old?.projectId,version:(old?.version??(old?1:0))+1,id: old?.id ?? id(), revision: id(), name: text(b.name, '模板名称', 100), body, status: b.status, modelIds: b.modelIds, default: !!b.default, author: user.id, created: now() };
    this.store.tx(() => { if (t.default && t.status === 'published') for (const other of this.store.all('video-template')) if (other.default && other.id !== t.id && !!other.nativeEnabled===t.nativeEnabled && (other.projectId??null)===(t.projectId??null)) this.store.put('video-template', { ...other, default: false }); this.store.put('video-template', t); this.store.put('video-template-version', { ...t, id: t.revision, templateId: t.id }); this.store.audit(user.id, 'video.template.save', t.id, { revision: t.revision }); }); return t;
  }
}
