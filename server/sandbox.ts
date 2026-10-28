import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { id, requireThat } from './store.ts';
const exec = promisify(execFile);
export class TerminationUnconfirmed extends Error { code = 'TERMINATION_UNCONFIRMED'; }
export const IMAGE = 'python@sha256:1a63a53928ce53d2b0baf08092a703f4840ac5dfbd61fd48802dbf48e08c801e';
export async function sandboxAvailable() { try { await exec('docker', ['image', 'inspect', IMAGE], { timeout: 5000, maxBuffer: 1024 * 1024 }); return true; } catch { return false; } }
export async function pythonSandbox(code: string, inputDir: string, signal: AbortSignal, timeoutMs = 15000, executionId: string = id()): Promise<string> {
  requireThat(code.length <= 16000, '脚本长度超过基础版限制'); signal.throwIfAborted();
  const name = `team-harness-${executionId}`;
  const args = ['run', '--name', name, '--rm', '--pull=never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '32', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--user', '65534:65534', '--tmpfs', '/work:rw,noexec,nosuid,size=16m,mode=1777', '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m,mode=1777', '--mount', `type=bind,source=${inputDir},target=/input,readonly`, '--workdir', '/work', '-i', IMAGE, 'python', '-I', '-'];
  // Create before attaching so a cancellation always targets an existing container.
  args[0] = 'create';
  try { await exec('docker', args, { timeout: 15000, maxBuffer: 10000 }); }
  catch { throw new TerminationUnconfirmed('执行器创建结果不明，需要检查该执行编号'); }
  if (signal.aborted) { try { await exec('docker', ['rm', '-f', name], { timeout: 10000 }); } catch { throw new TerminationUnconfirmed('执行器停止未确认'); } signal.throwIfAborted(); }
  return new Promise((resolve, reject) => {
    let output = '', bytes = 0, failure: Error | undefined, removal: Promise<unknown> | undefined;
    const child = spawn('docker', ['start', '-ai', name], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG } });
    const stop = (reason: string) => { failure ??= new Error(reason); removal ??= exec('docker', ['rm', '-f', name], { timeout: 10000, maxBuffer: 10000 }).catch(() => undefined); };
    const abort = () => stop('执行已取消'); const timer = setTimeout(() => stop('脚本执行超时'), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    const collect = (buf: Buffer) => { bytes += buf.length; if (bytes > 65536) stop('脚本输出超过 64 KiB'); else output += buf.toString('utf8'); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); stop('执行器连接失败'); reject(new TerminationUnconfirmed('执行器连接失败，需检查停止状态')); });
    child.on('close', async code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); await removal;
      // A stopped container is the cancellation receipt, not just a killed Docker client.
      try { const r = await exec('docker', ['inspect', '--format', '{{.State.Running}}', name], { timeout: 5000 }); if (r.stdout.trim() === 'true') return reject(new TerminationUnconfirmed('执行器仍在运行，停止未确认')); } catch (e: any) { if (e.killed || !/no such object|no such container/i.test(e.stderr ?? '')) return reject(new TerminationUnconfirmed('无法确认执行器终止')); }
      if (failure) reject(failure); else if (code !== 0) reject(new Error(`脚本失败：${output.slice(0, 1500)}`)); else resolve(output || '脚本执行完成，无标准输出。');
    });
    child.stdin.on('error', () => undefined); child.stdin.end(code);
    if (signal.aborted) abort();
  });
}
export async function stopAndVerify(container: string) {
  requireThat(/^team-harness-[a-f0-9-]+$/.test(container), '无效执行器编号');
  try { await exec('docker', ['rm', '-f', container], { timeout: 10000, maxBuffer: 10000 }); }
  catch (e: any) { if (!/no such object|no such container/i.test(e.stderr ?? '')) throw new TerminationUnconfirmed('停止尚未确认'); }
  try { await exec('docker', ['inspect', container], { timeout: 5000, maxBuffer: 10000 }); throw new TerminationUnconfirmed('执行器仍存在'); }
  catch (e: any) { if (!/no such object|no such container/i.test(e.stderr ?? '')) throw new TerminationUnconfirmed('无法确认执行器已移除'); }
}
