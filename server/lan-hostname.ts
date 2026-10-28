import { execFileSync } from 'node:child_process';

export function localHostname(label: string): string | null {
  const name = label.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? name + '.local' : null;
}

// Use macOS's own per-interface mDNS records without changing system settings.
export function nativeLocalHostname(): string | null {
  if (process.platform !== 'darwin') return null;
  try { return localHostname(execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 })); }
  catch { return null; }
}
