import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'yaml';
import { loadModel } from '../server/model.ts';
const root = resolve(process.env.PLATFORM_DATA ?? 'data');
const home = process.env.PLATFORM_HARNESS_HOME ?? join(homedir(), '.dsh');
const file = join(root, 'model-connection.json');
if (!existsSync(file)) {
  const settings = parse(readFileSync(join(home, 'settings.yaml'), 'utf8'));
  const choice = settings['agent-default-model']; const config = settings['llm-deepseek'] ?? {};
  if (choice?.provider !== 'deepseek-official' || choice?.model !== 'deepseek-flash') throw new Error('当前默认路由不是本次核验的 DeepSeek Flash，未导入。');
  const ref = config.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
  const credentials = parse(readFileSync(join(home, '.credentials.yaml'), 'utf8'));
  const key = credentials.refs?.[ref];
  if (typeof key !== 'string' || key.length < 10) throw new Error('指定凭据引用未解析，未导入。');
  const baseURL = config.baseURL ?? 'https://api.deepseek.com';
  if (baseURL !== 'https://api.deepseek.com') throw new Error('端点存在覆盖，请先核验。');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ provider: choice.provider, model: choice.model, reasoningEffort: config.thinking === 'disabled' ? 'off' : (choice.reasoningEffort ?? config.reasoningEffort ?? 'high'), baseURL, apiKey: key, importedAt: new Date().toISOString() }, null, 2), { mode: 0o600, flag: 'wx' });
}
const c = loadModel(root)!;
const receipt: Record<string, unknown> = { provider: c.provider, model: c.model, reasoningEffort: c.reasoningEffort, endpoint: c.baseURL, credential: 'server_file_0600', inferenceSubmitted: false, checkedAt: new Date().toISOString() };
if (process.argv.includes('--probe')) {
  try {
    const r = await fetch(`${c.baseURL}/models`, { headers: { Authorization: `Bearer ${c.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    receipt.httpStatus = r.status;
    if (r.ok) { const j = await r.json() as any; receipt.selectedModelListed = Array.isArray(j.data) && j.data.some((m: any) => m.id === c.model); }
    receipt.connection = r.ok ? 'authenticated_read_only_probe_passed' : 'probe_failed';
  } catch { receipt.connection = 'probe_failed'; }
}
writeFileSync(join(root, 'model-connection-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
console.log(JSON.stringify(receipt));
