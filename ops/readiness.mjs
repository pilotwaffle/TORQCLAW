import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 1000;
const DEFAULT_TIMEOUT_MS = 60000;

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
