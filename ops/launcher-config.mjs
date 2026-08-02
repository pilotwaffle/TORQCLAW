import { parseHttpUrl, parsePositiveInteger } from './readiness.mjs';

const PORT_OPTIONS = { max: 65535 };
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const PLACEHOLDER_TOKENS = new Set([
  'change-me', 'changeme', 'replace-me', 'replace_me', 'your-token',
  'your_token', 'token', 'secret', 'example', 'dev', 'test', 'unset',
]);

const effectivePort = (url) => Number(url.port || (url.protocol === 'https:' ? 443 : 80));

function requireLocalEndpoint(value, label, expectedPort) {
  const parsed = new URL(parseHttpUrl(value, label));
  if (parsed.protocol !== 'http:') {
    throw new Error(`${label} must use HTTP for the local development stack`);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`${label} must target the local machine`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  if (effectivePort(parsed) !== expectedPort) {
    throw new Error(`${label} must use configured port ${expectedPort}`);
  }
  return parsed;
}

function requireLoopbackHost(value, label, fallback) {
  const host = String(value ?? fallback).trim();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`${label} must be a loopback host`);
  }
  return host;
}

function requireProductionTokens(env) {
  const server = String(env.TORQCLAW_GATEWAY_TOKEN ?? '').trim();
  const browser = String(env.NEXT_PUBLIC_GATEWAY_TOKEN ?? '').trim();
  const valid = (token) => token && !PLACEHOLDER_TOKENS.has(token.toLowerCase());
  if (!valid(server) || !valid(browser)) {
    throw new Error('production gateway tokens must be nonempty and non-placeholder');
  }
  if (server !== browser) {
    throw new Error('production gateway tokens must match');
  }
}

export function buildLauncherConfig(env = process.env, { production = false } = {}) {
  const engineHost = requireLoopbackHost(env.HERMES_BIND_HOST, 'HERMES_BIND_HOST', '127.0.0.1');
  const gatewayHost = requireLoopbackHost(env.TORQCLAW_HOST, 'TORQCLAW_HOST', '127.0.0.1');
  const consolePort = parsePositiveInteger(
    env.TORQCLAW_CONSOLE_PORT, 3000, 'TORQCLAW_CONSOLE_PORT', PORT_OPTIONS,
  );
  const enginePort = parsePositiveInteger(
    env.HERMES_PORT, 8000, 'HERMES_PORT', PORT_OPTIONS,
  );
  const gatewayPort = parsePositiveInteger(
    env.TORQCLAW_PORT, 18790, 'TORQCLAW_PORT', PORT_OPTIONS,
  );
  if (new Set([consolePort, enginePort, gatewayPort]).size !== 3) {
    throw new Error('TORQCLAW, HERMES, and console ports must be pairwise distinct');
  }
  const defaultConsoleHost = production ? '127.0.0.1' : 'localhost';

  const consoleUrl = requireLocalEndpoint(
    env.TORQCLAW_CONSOLE_URL ?? `http://${defaultConsoleHost}:${consolePort}`,
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
    env.HERMES_ENGINE_URL ?? `http://${engineHost}:${enginePort}/mcp`,
    'HERMES_ENGINE_URL',
    enginePort,
  );
  if (engineUrl.pathname !== '/mcp' || engineUrl.search || engineUrl.hash) {
    throw new Error('HERMES_ENGINE_URL must identify the local /mcp endpoint');
  }

  const config = {
    consolePort,
    enginePort,
    gatewayPort,
    consoleUrl: consoleUrl.href,
    consoleHealthUrl: consoleHealthUrl.href,
    engineUrl: engineUrl.href,
    engineHealthUrl: `http://${engineHost}:${enginePort}/health`,
    gatewayHealthUrl: `http://${gatewayHost}:${gatewayPort}/health`,
    gatewayUrl: `ws://${gatewayHost}:${gatewayPort}/ws`,
    gatewayHost,
    engineHost,
    consoleUrlOrigin: consoleUrl.origin,
    nextPublicGatewayUrl: (() => {
      const browserGatewayHost = production ? '127.0.0.1' : 'localhost';
      const raw = env.NEXT_PUBLIC_GATEWAY_URL ?? `ws://${browserGatewayHost}:${gatewayPort}/ws`;
      let parsed;
      try {
        parsed = new URL(raw);
      } catch {
        throw new Error('NEXT_PUBLIC_GATEWAY_URL must be a valid WebSocket URL');
      }
      if (parsed.protocol !== 'ws:' || !LOOPBACK_HOSTS.has(parsed.hostname) || parsed.username || parsed.password ||
          parsed.pathname !== '/ws' || parsed.search || parsed.hash || effectivePort(parsed) !== gatewayPort) {
        throw new Error('NEXT_PUBLIC_GATEWAY_URL must exactly target the configured loopback gateway /ws');
      }
      return parsed.href;
    })(),
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

  if (production) requireProductionTokens(env);

  return config;
}
