import { requireThat, type Doc } from './store.ts';

const aliases: Record<string, string> = { '分辨率':'resolution', '画幅':'aspect_ratio', '比例':'aspect_ratio', '音频':'audio', '种子':'seed', '尺寸':'size', '时长':'seconds', '秒数':'seconds' };
export function parsePickup(input: string): Doc {
  const labels: Record<string,string> = { '剧本片段':'script', '补抽意见':'notes', '视频模型':'model', '模型参数':'params', '提示词模板':'template', '模板':'template', '镜头':'shot' };
  const out: Doc = {}; let key = '';
  for (const line of input.split('\n')) { const m = /^(剧本片段|补抽意见|视频模型|模型参数|提示词模板|模板|镜头)\s*[:：]\s*(.*)$/.exec(line.trim()); if (m) { key = labels[m[1]]; requireThat(out[key] === undefined, '输入中同一字段出现多次，请明确保留一份'); out[key] = m[2]; } else if (key) out[key] += '\n' + line; else if (line.trim()) out.freeform = (out.freeform ?? '') + line + '\n'; }
  const params: Doc = {};
  if (out.params?.trim()) {
    if (out.params.trim().startsWith('{')) { let obj: Doc; try { obj = JSON.parse(out.params); } catch { throw new Error('模型参数 JSON 无效'); } requireThat(obj && typeof obj === 'object' && !Array.isArray(obj), '模型参数必须是对象'); for (const [k,v] of Object.entries(obj)) params[aliases[k] ?? k] = v; }
    else for (const part of out.params.split(/[,，;；\n]+/).filter((p: string) => p.trim())) { const m = /^\s*([^:：=]+)\s*[:：=]\s*(.+?)\s*$/.exec(part); requireThat(m, `无法识别参数：${part}；请使用“画幅：16:9”等写法`); const k = aliases[m[1].trim()] ?? m[1].trim(); requireThat(params[k] === undefined, '模型参数重复'); const v = m[2]; params[k] = /^(true|开启|开|是)$/i.test(v) ? true : /^(false|关闭|关|否)$/i.test(v) ? false : /^-?\d+(\.\d+)?秒?$/.test(v) ? Number(v.replace('秒','')) : v; }
  }
  return { ...out, params };
}
export const normalized = (s: string) => s.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
export function matchShots(script: string, shots: Doc[], exactIds?: string[]) {
  if (exactIds?.length) { requireThat(exactIds.length <= 8 && new Set(exactIds).size === exactIds.length && exactIds.every(x => shots.some(s => s.id === x)), '所选镜头不在项目索引中'); return shots.filter(s => exactIds.includes(s.id)); }
  const n = normalized(script); requireThat(n.length >= 4, '剧本片段过短，请至少提供一句完整内容');
  return shots.filter(s => { const q = normalized(s.scriptQuote); return q.includes(n) || n.includes(q); });
}
export function modelMatches(name: string, models: Doc[]) { const key = normalized(name); return models.filter(m => [m.name, ...(m.aliases??[])].some((n: string) => normalized(n) === key)); }
export function validParams(model: Doc, values: Doc, duration: number) {
  const forwarded=['resolution','aspect_ratio','size','audio','seed','fps','watermark'];
  requireThat(Object.keys(values).every(k => k === 'seconds' || Object.hasOwn(model.params,k)||model.parameterPolicy==='provider'&&forwarded.includes(k)), '包含此模型不支持的参数');
  const seconds = Math.max(4, duration); requireThat(model.durationPolicy==='provider'||model.durations.includes(seconds), `模型不支持本镜所需 ${seconds} 秒时长`, 422);
  requireThat(values.seconds === undefined || Number(values.seconds) === seconds, `输入时长与镜头要求冲突：本镜需 ${seconds} 秒`, 422);
  const effective = { ...model.defaults, ...values }; delete effective.seconds;
  for (const [k,v] of Object.entries(effective)) {
    if(model.parameterPolicy==='provider'&&!Object.hasOwn(model.params,k))requireThat(['string','number','boolean'].includes(typeof v)&&String(v).length<=100,`${k} 参数类型无效`,422);
    else requireThat(model.params[k]?.includes(v), `${k} 参数不受支持，请按模型允许值填写`, 422);
  }
  return { ...effective, seconds };
}
export function renderTemplate(body: string, values: Record<string,string>) { return body.replace(/\{\{([^{}]+)\}\}/g, (_, k) => { requireThat(Object.hasOwn(values,k), '缺少模板变量'); return values[k]; }); }
