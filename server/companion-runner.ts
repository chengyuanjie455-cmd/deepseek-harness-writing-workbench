import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {requireThat} from './store.ts';

const execute = promisify(execFile);
type Runner = {state: 'disabled'|'registered'; namespace?: string; reusedOwner?: boolean};
const helper = fileURLToPath(new URL('../scripts/ensure-companion-runner.py', import.meta.url));
/** Registration is cached, authentication is not. Each HTTP request still checks its device grant. */
export class CompanionRunners {
  private pending = new Map<string, Promise<Runner>>();
  private checked = new Map<string, {at: number; value: Runner}>();
  constructor(private run = async (root: string, accountId: string) => {
    const {stdout} = await execute('/usr/bin/python3', [helper, root, accountId], {timeout: 12000, maxBuffer: 8192});
    return JSON.parse(stdout) as Runner;
  }) {}
  async ensure(root: string, accountId: string): Promise<Runner> {
    requireThat(/^[a-f0-9-]{36}$/i.test(accountId), '执行器账号无效', 400);
    if (!existsSync(join(root, 'companion-runner.json'))) return {state: 'disabled'};
    const key = JSON.stringify([root, accountId]), cached = this.checked.get(key);
    if (cached && Date.now() - cached.at < 30000) return cached.value;
    const pending = this.pending.get(key); if (pending) return pending;
    const task = this.run(root, accountId).then(value => {
      requireThat(value.state === 'registered', '账号执行器尚未就绪，请稍后重连', 503);
      this.checked.set(key, {at: Date.now(), value});
      return value;
    }).catch(() => { throw new Error('账号执行器启动失败，请稍后重连；原聊天保留'); })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task); return task;
  }
}
export const companionRunners = new CompanionRunners();
