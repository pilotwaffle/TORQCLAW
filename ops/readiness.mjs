import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 1000;
const DEFAULT_TIMEOUT_MS = 60000;

export function parsePositiveInteger(value, fallback, label, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}; received ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function parseHttpUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  return parsed.href;
}

export async function waitForHttpReady(url, {
  expectedService,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
  sleepImpl = sleep,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'no response';

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`;
      } else {
        const payload = await response.json();
        if (expectedService && payload?.service !== expectedService) {
          lastFailure = `unexpected service ${JSON.stringify(payload?.service ?? null)}`;
        } else if (payload?.status !== 'ready') {
          lastFailure = `status ${JSON.stringify(payload?.status ?? null)}`;
        } else {
          return payload;
        }
      }
    } catch (error) {
      lastFailure = error?.name === 'AbortError' ? 'request timeout' : error.message;
    } finally {
      clearTimeout(timer);
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) await sleepImpl(Math.min(intervalMs, remaining));
  }

  throw new Error(`Timed out waiting for ${url} after ${timeoutMs}ms; last failure: ${lastFailure}`);
}

export async function waitForHttpReachable(url, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
  sleepImpl = sleep,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'no response';

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      await fetchImpl(url, { signal: controller.signal });
      return;
    } catch (error) {
      lastFailure = error?.name === 'AbortError' ? 'request timeout' : error.message;
    } finally {
      clearTimeout(timer);
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) await sleepImpl(Math.min(intervalMs, remaining));
  }

  throw new Error(`Timed out waiting for ${url} after ${timeoutMs}ms; last failure: ${lastFailure}`);
}

export async function waitForHttpOk(url, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
  sleepImpl = sleep,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'no response';

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (response.ok) return response;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error?.name === 'AbortError' ? 'request timeout' : error.message;
    } finally {
      clearTimeout(timer);
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) await sleepImpl(Math.min(intervalMs, remaining));
  }

  throw new Error(`Timed out waiting for ${url} after ${timeoutMs}ms; last failure: ${lastFailure}`);
}
