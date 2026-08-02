import { spawn } from 'node:child_process';

export function waitForChildReadiness(label, child, readinessPromise) {
  if (child.exitCode !== null) {
    return Promise.reject(new Error(`${label} exited before readiness with code ${child.exitCode}`));
  }

  let onError;
  let onExit;
  const childFailure = new Promise((_, reject) => {
    onError = (error) => reject(new Error(`${label} failed to start: ${error.message}`));
    onExit = (code, signal) => reject(new Error(
      `${label} exited before readiness (code ${code ?? 'null'}, signal ${signal ?? 'none'})`,
    ));
    child.once('error', onError);
    child.once('exit', onExit);
  });

  return Promise.race([readinessPromise, childFailure]).finally(() => {
    child.off('error', onError);
    child.off('exit', onExit);
  });
}

export async function runStartupSequence({
  launchEngine,
  waitEngine,
  launchGateway,
  waitGateway,
  launchConsole,
  waitConsole,
  onConsoleLaunched = () => {},
  onReady,
}) {
  const cleanups = [];
  let rejectStartup;
  const startupFailure = new Promise((_, reject) => {
    rejectStartup = reject;
  });

  const monitor = (label, child) => {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited during startup with code ${child.exitCode}`);
    }
    const onError = (error) => rejectStartup(
      new Error(`${label} failed during startup: ${error.message}`),
    );
    const onExit = (code, signal) => rejectStartup(new Error(
      `${label} exited during startup (code ${code ?? 'null'}, signal ${signal ?? 'none'})`,
    ));
    child.once('error', onError);
    child.once('exit', onExit);
    cleanups.push(() => {
      child.off('error', onError);
      child.off('exit', onExit);
    });
    return child;
  };

  const guarded = (operation) => Promise.race([
    Promise.resolve().then(operation),
    startupFailure,
  ]);

  try {
    const engine = monitor('Engine', launchEngine());
    await guarded(waitEngine);

    const gateway = monitor('Gateway', launchGateway());
    await guarded(waitGateway);

    const consoleProcess = monitor('Console', launchConsole());
    await guarded(() => onConsoleLaunched(consoleProcess));
    const health = await guarded(waitConsole);
    await guarded(() => onReady(health));

    return { engine, gateway, consoleProcess, health };
  } finally {
    cleanups.forEach((cleanup) => cleanup());
  }
}

export function browserCommand(platform, url) {
  if (platform === 'win32') {
    return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }
  return { command: platform === 'darwin' ? 'open' : 'xdg-open', args: [url] };
}

export function openExternalUrl(url, {
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  const { command, args } = browserCommand(platform, url);
  return new Promise((resolve, reject) => {
    const opener = spawnImpl(command, args, {
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
      shell: false,
    });
    opener.once('error', reject);
    opener.once('spawn', () => {
      opener.unref();
      resolve();
    });
  });
}
