import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export async function stopProcessTree(pid, {
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  killImpl = process.kill,
  isAlive = () => false,
  sleepImpl = sleep,
  timeoutMs = 5000,
} = {}) {
  if (!pid) return true;
  if (platform === 'win32') {
    try {
      spawnSyncImpl('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // The bounded liveness wait below remains the source of truth.
    }
  } else {
    try {
      killImpl(-pid, 'SIGTERM');
    } catch {
      try { killImpl(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleepImpl(Math.min(50, deadline - Date.now()));
  }
  return !isAlive(pid);
}
