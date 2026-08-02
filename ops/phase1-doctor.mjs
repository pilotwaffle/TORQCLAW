import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function runPhase1Doctor(argv = process.argv.slice(2), env = process.env) {
  const jsonOutput = argv.includes('--json');
  const pathArg = argv.indexOf('--chains');
  const configuredPath = pathArg >= 0 ? argv[pathArg + 1] : env.TORQCLAW_PROVIDER_CHAINS_PATH;
  const chainPath = configuredPath ? resolve(configuredPath) : null;
  const checks = [];
  const record = (name, status, detail, extra = {}) => checks.push({ name, status, detail, ...extra });
  const safeSelector = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
  const finiteCeiling = (value) => Number.isSafeInteger(value) && value >= 0;

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
      }
    }
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

  const result = { ok: !checks.some((check) => check.status === 'fail'), mode: 'offline-secret-free', checks };
  if (jsonOutput) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('TORQCLAW Phase-1 doctor (offline, secret-free)');
    for (const check of checks) console.log(`${check.status.toUpperCase()}  ${check.name}: ${check.detail}`);
    console.log(result.ok ? 'Result: READY' : 'Result: NOT READY');
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runPhase1Doctor();
}
