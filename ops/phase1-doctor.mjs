import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-08-25 incident: the primary provider in the default/coding chains
// (kimi via local CLIProxyAPI) was dead for days while this doctor stayed
// GREEN, because the checks below only ever confirmed env-var NAME presence
// and chain-document shape -- they never dialed a provider. Every FRONTIER
// turn burned a median 91.3s on the dead primary (engine-internal retry
// budget) before cascading to the fallback. The provider-dial section further
// down closes that gap with a real HTTP probe.
const PROVIDER_DIAL_TIMEOUT_MS = 3000;

async function dialProvider(provider, env, fetchImpl) {
  const baseUrl = env[provider.baseUrlEnvName];
  const apiKey = env[provider.apiKeyEnvName];
  let host = '(unresolved)';
  try { host = new URL(baseUrl).host; } catch { /* left as (unresolved) below */ }
  if (!baseUrl) return { status: 'fail', detail: `${provider.baseUrlEnvName} is not configured`, host };
  let url;
  // Append "/models" relative to the FULL base path (which may already carry
  // a version segment like /v1) -- new URL('/models', base) would instead
  // root-relatively discard that segment.
  try { url = new URL(`${baseUrl.replace(/\/$/, '')}/models`); } catch { return { status: 'fail', detail: `${provider.baseUrlEnvName} is not a valid URL`, host }; }
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(PROVIDER_DIAL_TIMEOUT_MS) });
    if (response.status === 401 || response.status === 403) {
      return apiKey
        ? { status: 'fail', detail: 'auth rejected', host }
        : { status: 'warn', detail: 'unauthorized; no API key configured', host };
    }
    if (response.status === 404) return { status: 'warn', detail: 'HTTP 404 on /models (endpoint shape differs)', host };
    if (response.ok) {
      const body = await response.json().catch(() => ({}));
      const count = Array.isArray(body?.data) ? body.data.length : Array.isArray(body?.models) ? body.models.length : null;
      return { status: 'pass', detail: count === null ? 'reachable' : `reachable, ${count} models`, host };
    }
    return { status: 'fail', detail: `HTTP ${response.status}`, host };
  } catch (error) {
    // undici wraps the real cause (e.g. ECONNREFUSED) inside error.cause on a
    // generic TypeError('fetch failed'); surface the cause code when present
    // so the operator sees the actionable reason, not just "fetch failed".
    // D-1 (2026-08-25, independent verification): the message fallback below
    // can otherwise echo a full credentialed URL (scheme://user:pass@host/...)
    // when baseUrl carries userinfo and undici throws a TypeError with no
    // .code -- strip any such credential substring before it is ever recorded.
    const stripCredentials = (value) => typeof value === 'string' ? value.replace(/\/\/[^/@\s]+@/g, '//') : value;
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? `timed out after ${PROVIDER_DIAL_TIMEOUT_MS}ms`
      : error?.cause?.code || error?.code || stripCredentials(error?.cause?.message) || stripCredentials(error?.message) || 'unreachable';
    return { status: 'fail', detail: reason, host };
  }
}

export async function runPhase1Doctor(argv = process.argv.slice(2), env = process.env, { fetch: fetchImpl = fetch } = {}) {
  const jsonOutput = argv.includes('--json');
  const pathArg = argv.indexOf('--chains');
  const configuredPath = pathArg >= 0 ? argv[pathArg + 1] : env.TORQCLAW_PROVIDER_CHAINS_PATH;
  const chainPath = configuredPath ? resolve(configuredPath) : null;
  const checks = [];
  const record = (name, status, detail, extra = {}) => checks.push({ name, status, detail, ...extra });
  const safeSelector = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
  const finiteCeiling = (value) => Number.isSafeInteger(value) && value >= 0;
  let parsedChainDocument;

  if (!chainPath) {
    record('chains-path', 'fail', 'TORQCLAW_PROVIDER_CHAINS_PATH is not configured');
  } else if (!existsSync(chainPath)) {
    record('chains-path', 'fail', 'configured provider-chain document is not readable');
  } else {
    let document;
    try { document = JSON.parse(readFileSync(chainPath, 'utf8')); } catch { record('chains-parse', 'fail', 'provider-chain document is not valid JSON'); }
    if (document !== undefined) {
      const validShape = document && typeof document === 'object' && !Array.isArray(document) &&
        typeof document.revision === 'string' && document.revision.length > 0 &&
        document.chains && typeof document.chains === 'object' && !Array.isArray(document.chains);
      if (!validShape) {
        record('chains-schema', 'fail', 'revision and chains are required');
      } else {
        record('chains-parse', 'pass', 'provider-chain JSON is parseable');
        record('revision', 'pass', 'chain revision is present');
        let valid = true;
        let privacyEligible = true;
        let selectorsAccepted = true;
        let envNamesPresent = true;
        for (const chain of Object.values(document.chains)) {
          if (!chain || typeof chain !== 'object' || chain.id === undefined ||
              !Array.isArray(chain.providers) || chain.providers.length !== 2 ||
              chain.providers.some((provider) => !provider || typeof provider !== 'object')) {
            valid = false;
            continue;
          }
          const ids = chain.providers.map((provider) => provider.id);
          if (new Set(ids).size !== ids.length || ids.some((id) => !safeSelector(id))) selectorsAccepted = false;
          for (const provider of chain.providers) {
            if (!finiteCeiling(provider.ceilingMicroUsd)) valid = false;
            if (!Array.isArray(provider.privacyClasses) ||
                !provider.privacyClasses.includes('standard') || !provider.privacyClasses.includes('sensitive')) privacyEligible = false;
            for (const envName of [provider.apiKeyEnvName, provider.baseUrlEnvName]) {
              if (typeof envName !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(envName) ||
                  env[envName] === undefined || env[envName] === '') envNamesPresent = false;
            }
          }
        }
        record('ordered-distinct-ids', valid && selectorsAccepted ? 'pass' : 'fail', valid && selectorsAccepted
          ? 'chains contain two ordered accepted Hermes selectors' : 'chain IDs or provider selectors are invalid');
        record('finite-ceilings', valid ? 'pass' : 'fail', valid
          ? 'all provider ceilings are finite non-negative integers' : 'a provider ceiling is invalid');
        record('privacy-eligibility', privacyEligible ? 'pass' : 'fail', privacyEligible
          ? 'each chain has two providers eligible for standard and sensitive work' : 'privacy eligibility is incomplete');
        record('referenced-env-presence', envNamesPresent ? 'pass' : 'fail', envNamesPresent
          ? 'all referenced environment variables are present' : 'a referenced environment variable is absent');
        if (valid && selectorsAccepted) parsedChainDocument = document;
      }
    }
  }

  // Live provider-reachability dial (2026-08-25 incident, see comment above).
  // Only runs once the chain document has already passed structural
  // validation above -- a malformed document has nothing safe to dial.
  if (env.TORQCLAW_DOCTOR_SKIP_PROVIDER_DIAL === '1') {
    record('provider-dial', 'skip', 'skipped by TORQCLAW_DOCTOR_SKIP_PROVIDER_DIAL=1 (offline/CI context)');
  } else if (parsedChainDocument) {
    let anyPrimaryDown = false;
    for (const chain of Object.values(parsedChainDocument.chains)) {
      const results = await Promise.all(chain.providers.map((provider) => dialProvider(provider, env, fetchImpl)));
      results.forEach((result, index) => {
        const provider = chain.providers[index];
        const isPrimary = index === 0;
        const name = `provider-dial:${chain.id}:${provider.id}`;
        if (result.status === 'fail') {
          if (isPrimary) {
            anyPrimaryDown = true;
            record(name, 'fail',
              `PRIMARY UNREACHABLE -- ${provider.id} (${result.host}): ${result.detail}. ` +
              'Every FRONTIER turn on this chain will burn the engine retry budget ' +
              '(~90s) cascading past this provider before it can fail over.');
          } else {
            record(name, 'warn', `fallback unreachable -- ${provider.id} (${result.host}): ${result.detail}`);
          }
        } else {
          record(name, result.status, `${provider.id} (${result.host}): ${result.detail}`);
        }
      });
    }
    record('provider-dial', anyPrimaryDown ? 'fail' : 'pass', anyPrimaryDown
      ? 'at least one chain primary is unreachable' : 'all chain primaries are reachable');
  } else {
    record('provider-dial', 'skip', 'no valid provider-chain document to dial');
  }

  const diagnosticsArg = argv.indexOf('--maintenance-diagnostics');
  const configuredDiagnosticsPath = diagnosticsArg >= 0 ? argv[diagnosticsArg + 1] : env.TORQCLAW_MAINTENANCE_DIAGNOSTICS_PATH;
  const diagnosticsPath = configuredDiagnosticsPath
    ? resolve(configuredDiagnosticsPath)
    : join(env.TORQCLAW_DATA_DIR || join(homedir(), '.torqclaw'), 'resilience-maintenance.json');
  if (!existsSync(diagnosticsPath)) {
    record('maintenance', 'warn', 'no shutdown maintenance snapshot is available; no checkpoint was triggered', {
      maintenanceNeeded: null, lastPassiveOutcome: null, walMaintenanceDeferred: null,
    });
  } else {
    try {
      const diagnostics = JSON.parse(readFileSync(diagnosticsPath, 'utf8'));
      const valid = diagnostics && typeof diagnostics === 'object' && diagnostics.schemaVersion === 1 &&
        typeof diagnostics.maintenanceNeeded === 'boolean' && diagnostics.lastPassiveOutcome &&
        typeof diagnostics.lastPassiveOutcome === 'object' && typeof diagnostics.walMaintenanceDeferred === 'boolean';
      record('maintenance', valid ? 'pass' : 'fail', valid
        ? 'read-only shutdown maintenance diagnostics loaded; no checkpoint triggered'
        : 'maintenance snapshot is malformed', {
        maintenanceNeeded: valid ? diagnostics.maintenanceNeeded : null,
        lastPassiveOutcome: valid ? diagnostics.lastPassiveOutcome : null,
        walMaintenanceDeferred: valid ? diagnostics.walMaintenanceDeferred : null,
      });
    } catch {
      record('maintenance', 'fail', 'maintenance snapshot is not valid JSON', {
        maintenanceNeeded: null, lastPassiveOutcome: null, walMaintenanceDeferred: null,
      });
    }
  }

  // Mode reflects whether this run actually dialed a provider over the
  // network (using the referenced apiKeyEnvName as a bearer credential) or
  // stayed fully offline/secret-free (skipped section, or no valid chain
  // document to dial). Never claim offline-secret-free once a dial ran.
  const dialedLive = checks.some((check) => check.name.startsWith('provider-dial:'));
  const mode = dialedLive ? 'live-provider-dial' : 'offline-secret-free';
  const result = { ok: !checks.some((check) => check.status === 'fail'), mode, checks };
  if (jsonOutput) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`TORQCLAW Phase-1 doctor (${dialedLive ? 'live provider dial' : 'offline, secret-free'})`);
    for (const check of checks) console.log(`${check.status.toUpperCase()}  ${check.name}: ${check.detail}`);
    console.log(result.ok ? 'Result: READY' : 'Result: NOT READY');
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPhase1Doctor();
}
