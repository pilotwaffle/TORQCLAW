import { parseHttpUrl, parsePositiveInteger } from './readiness.mjs';

const PORT_OPTIONS = { max: 65535 };
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const effectivePort = (url) => Number(url.port || (url.protocol === 'https:' ? 443 : 80));

function requireLocalEndpoint(value, label, expectedPort) {
  const parsed = new URL(parseHttpUrl(value, label));
  if (parsed.protocol !== 'http:') {
    throw new Error(`${label} must use HTTP for the local development stack`);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`${label} must target the local machine`);
  }
  if (effectivePort(parsed) !== expectedPort) {
    throw new Error(`${label} must use configured port ${expectedPort}`);
  }
  return parsed;
}

export function buildLauncherConfig(env = process.env) {
  const consolePort = parsePositiveInteger(
    env.TORQCLAW_CONSOLE_PORT, 3000, 'TORQCLAW_CONSOLE_PORT', PORT_OPTIONS,
  );
  const enginePort = parsePositiveInteger(
    env.HERMES_PORT, 8000, 'HERMES_PORT', PORT_OPTIONS,
  );
  const gatewayPort = parsePositiveInteger(
    env.TORQCLAW_PORT, 18790, 'TORQCLAW_PORT', PORT_OPTIONS,
  );

  const consoleUrl = requireLocalEndpoint(
    env.TORQCLAW_CONSOLE_URL ?? `http://localhost:${consolePort}`,
    'TORQCLAW_CONSOLE_URL',
    consolePort,
  );
  if (consoleUrl.pathname !== '/' || consoleUrl.search || consoleUrl.hash) {
    throw new Error('TORQCLAW_CONSOLE_URL must identify the console root path (/)');
  }
  const consoleHealthUrl = requireLocalEndpoint(
    env.TORQCLAW_CONSOLE_HEALTH_URL ?? new URL('/api/health', consoleUrl).href,
    'TORQCLAW_CONSOLE_HEALTH_URL',
    consolePort,
  );
  if (consoleHealthUrl.origin !== consoleUrl.origin) {
    throw new Error('TORQCLAW_CONSOLE_HEALTH_URL must share TORQCLAW_CONSOLE_URL origin');
  }

  const engineUrl = requireLocalEndpoint(
    env.HERMES_ENGINE_URL ?? `http://127.0.0.1:${enginePort}/mcp`,
    'HERMES_ENGINE_URL',
    enginePort,
  );
  if (engineUrl.pathname !== '/mcp' || engineUrl.search || engineUrl.hash) {
    throw new Error('HERMES_ENGINE_URL must identify the local /mcp endpoint');
  }

  return {
    consolePort,
    enginePort,
    gatewayPort,
    consoleUrl: consoleUrl.href,
    consoleHealthUrl: consoleHealthUrl.href,
    engineUrl: engineUrl.href,
    gatewayHealthUrl: `http://127.0.0.1:${gatewayPort}/health`,
    engineReadyTimeoutMs: parsePositiveInteger(
      env.TORQCLAW_ENGINE_READY_TIMEOUT_MS,
      60000,
      'TORQCLAW_ENGINE_READY_TIMEOUT_MS',
    ),
    gatewayReadyTimeoutMs: parsePositiveInteger(
      env.TORQCLAW_GATEWAY_READY_TIMEOUT_MS,
      60000,
      'TORQCLAW_GATEWAY_READY_TIMEOUT_MS',
    ),
    consoleReadyTimeoutMs: parsePositiveInteger(
      env.TORQCLAW_CONSOLE_READY_TIMEOUT_MS,
      60000,
      'TORQCLAW_CONSOLE_READY_TIMEOUT_MS',
    ),
  };
}
