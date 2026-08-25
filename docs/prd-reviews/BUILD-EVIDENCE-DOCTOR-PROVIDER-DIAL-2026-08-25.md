# BUILD EVIDENCE — Doctor Live Provider Reachability Dial (2026-08-25)

## Objective

Add a live HTTP reachability probe to `ops/phase1-doctor.mjs` so a dead FRONTIER provider chain fails doctor loudly instead of staying GREEN on env-var-presence checks alone.

## Scope

Touched exactly one file: `ops/phase1-doctor.mjs`. No other file was modified. CI (`.github/workflows/ci.yml`) does not invoke `pnpm doctor` or `ops/doctor.mjs`/`ops/phase1-doctor.mjs` anywhere (verified by grep — zero matches), so per task instruction 4 CI was left untouched.

## Controlling invariant

Doctor's overall pass/fail must reflect real provider reachability for the path a live FRONTIER turn will actually take: a dead **chain primary** (index 0) must fail doctor; a dead **fallback** (index 1) must only warn, because the chain still functions via failover. Secrets must never appear in doctor output — only host, status, and model count are logged.

> **CORRECTION (2026-08-25, post independent verification, D-1):** the original wording of this invariant and of the "never logs" claim below scoped "secrets" implicitly to the API key alone. Independent verification found a second credential path this scoping missed and this doc did not disclose: if an operator's `baseUrlEnvName` value carries HTTP userinfo (`scheme://user:pass@host/...`), a `TypeError` thrown by Node's fetch guard ("Request cannot be constructed from a URL that includes credentials") embeds the full credentialed URL — including the password — directly in `error.message`, with no `.code` and no `.cause` to prefer instead. The pre-fix message fallback (`error?.cause?.message || error?.message`) would have echoed that verbatim into a FAIL line. Not exploitable against this deployment's actual configuration (neither live `baseUrlEnvName` value carries userinfo), but the code did not enforce that, and the claim below was wrong as stated. Fixed same-day; see the addendum at the bottom of this file for the fix and its before/after proof.

## What changed

In `ops/phase1-doctor.mjs`:

1. **`dialProvider(provider, env, fetchImpl)`** (new helper) — resolves `baseUrl` from `env[provider.baseUrlEnvName]`, builds `{baseUrl}/models` (string-concatenated against the full base path, not `new URL('/models', base)`, which would root-relatively discard an existing path segment like `/v1` — this was caught and fixed during verification, see Deviations), sends `GET` with `Authorization: Bearer {apiKey}` when an API key is configured, and a 3000 ms timeout via `AbortSignal.timeout`. Grades the response:
   - 2xx → `pass`, `"reachable, N models"` (count from `body.data` or `body.models`, whichever is an array)
   - 401/403 with a key configured → `fail`, `"auth rejected"`
   - 401/403 with no key configured → `warn`
   - 404 → `warn` (endpoint shape differs, not necessarily down)
   - timeout / abort → `fail`, `"timed out after 3000ms"`
   - network error (ECONNREFUSED, etc.) → `fail`, the underlying `error.cause.code` (undici wraps the real cause under `TypeError: fetch failed`; the cause code is surfaced instead of the generic wrapper message)
   - other non-2xx → `fail`, `"HTTP {status}"`
   - Never logs the API key — only `new URL(baseUrl).host` is used for identification. **CORRECTION (2026-08-25, D-1):** this line originally also claimed the credentialed URL itself could never leak. That was wrong for the case where `baseUrl` carries HTTP userinfo — see the invariant-section correction above and the fix addendum at the end of this document.

2. **Dial loop in `runPhase1Doctor`** — runs only after the existing chain-document structural validation (`valid && selectorsAccepted`) passes; a malformed document has nothing safe to dial (`provider-dial: skip, "no valid provider-chain document to dial"`). For each chain, dials both providers in parallel (`Promise.all`) and records one check per provider (`provider-dial:{chainId}:{providerId}`) plus a roll-up check (`provider-dial`). Index 0 (primary) failing produces the loud line:
   `PRIMARY UNREACHABLE -- {providerId} ({host}): {reason}. Every FRONTIER turn on this chain will burn the engine retry budget (~90s) cascading past this provider before it can fail over.`
   Index 1 (fallback) failing produces a plain `warn`, not `fail`. The roll-up check (`provider-dial`) is `fail` if any chain's primary is down, `pass` otherwise — this is what participates in doctor's overall exit code via the pre-existing `checks.some(c => c.status === 'fail')` logic (unchanged).

3. **`TORQCLAW_DOCTOR_SKIP_PROVIDER_DIAL=1`** opt-out — when set, the entire provider-dial section is skipped and recorded as `provider-dial: skip, "skipped by TORQCLAW_DOCTOR_SKIP_PROVIDER_DIAL=1 (offline/CI context)"`. No network call is attempted.

4. **Mode/header honesty** — `result.mode` and the printed header now say `live-provider-dial` / `"(live provider dial)"` when a dial actually ran (`provider-dial:*` checks present), and fall back to the original `offline-secret-free` / `"(offline, secret-free)"` when the dial was skipped or never attempted. The prior unconditional `"offline, secret-free"` claim would have been false once this section makes network calls carrying a bearer credential.

5. **Signature change**: `runPhase1Doctor` is now `async` (the dial requires `await`), and accepts an optional third parameter `{ fetch: fetchImpl }` (test-injection seam, defaulting to the global `fetch`). The self-invocation at the bottom of the file now does `process.exitCode = await runPhase1Doctor();` (top-level await, valid in this ESM `.mjs` file). Checked both call sites: `ops/doctor.mjs`'s `main()` (`async function main() { ... if (options.phase1) return runPhase1Doctor(argv); ... }`) is itself `async` and is `await`ed by its own IIFE, so returning a Promise from `runPhase1Doctor` there is already correctly awaited — no change needed in `ops/doctor.mjs`. Grepped the whole repo for other callers of `runPhase1Doctor`: none exist outside these two files, so no other caller needed updating.

## Files changed

- `E:\TorqClaw\ops\phase1-doctor.mjs` (92 insertions, 4 deletions — `git diff --stat` confirmed)
- `E:\TorqClaw\docs\prd-reviews\BUILD-EVIDENCE-DOCTOR-PROVIDER-DIAL-2026-08-25.md` (this file)

No CI workflow file was touched (confirmed no `doctor` reference exists in `.github/workflows/ci.yml`).

## Tests added/changed

None (vitest). This is an ops script; per task instruction 5, verified by direct execution against the live box, not unit tests. Confirmed no existing vitest file references `phase1-doctor.mjs` or `runPhase1Doctor` (`grep -rl "phase1-doctor\|phase1Doctor" tests/` → no matches), so there is no pre-existing coverage this change could regress.

## Commands run + actual results

All three runs used the operator's real, already-configured `.env` and the real `~/.torqclaw/provider-chains.json` (2 chains: `default`, `coding`, each with `kimi-sub-primary` at index 0 and `glm-fallback` at index 1). `.env` and the running proxy were never modified; the RED-proof run overrode `HERMES_KIMISUB_BASE_URL` only in the spawned child process's env, not in the file.

### (a) As-is, proxy up — `node --env-file=.env ops/phase1-doctor.mjs`

```
TORQCLAW Phase-1 doctor (live provider dial)
PASS  chains-parse: provider-chain JSON is parseable
PASS  revision: chain revision is present
PASS  ordered-distinct-ids: chains contain two ordered accepted Hermes selectors
PASS  finite-ceilings: all provider ceilings are finite non-negative integers
FAIL  privacy-eligibility: privacy eligibility is incomplete
PASS  referenced-env-presence: all referenced environment variables are present
PASS  provider-dial:default:kimi-sub-primary: kimi-sub-primary (127.0.0.1:8317): reachable, 23 models
PASS  provider-dial:default:glm-fallback: glm-fallback (api.z.ai): reachable, 9 models
PASS  provider-dial:coding:kimi-sub-primary: kimi-sub-primary (127.0.0.1:8317): reachable, 23 models
PASS  provider-dial:coding:glm-fallback: glm-fallback (api.z.ai): reachable, 9 models
PASS  provider-dial: all chain primaries are reachable
WARN  maintenance: no shutdown maintenance snapshot is available; no checkpoint was triggered
Result: NOT READY
```
Exit code: 1

The new provider-dial section is all PASS with real model counts and host-only identifiers (no keys, no full credentialed URLs). The overall `NOT READY` / exit 1 is caused entirely by the pre-existing `privacy-eligibility: FAIL` check (the live `provider-chains.json` only lists `"privacyClasses": ["standard"]`, missing `"sensitive"`), which is unrelated to this change — **confirmed identical on the unmodified `HEAD` version of the file** (see Known limitations).

### (b) Skip flag — `TORQCLAW_DOCTOR_SKIP_PROVIDER_DIAL=1 node --env-file=.env ops/phase1-doctor.mjs`

```
TORQCLAW Phase-1 doctor (offline, secret-free)
PASS  chains-parse: provider-chain JSON is parseable
PASS  revision: chain revision is present
PASS  ordered-distinct-ids: chains contain two ordered accepted Hermes selectors
PASS  finite-ceilings: all provider ceilings are finite non-negative integers
FAIL  privacy-eligibility: privacy eligibility is incomplete
PASS  referenced-env-presence: all referenced environment variables are present
SKIP  provider-dial: skipped by TORQCLAW_DOCTOR_SKIP_PROVIDER_DIAL=1 (offline/CI context)
WARN  maintenance: no shutdown maintenance snapshot is available; no checkpoint was triggered
Result: NOT READY
```
Exit code: 1

Zero network calls attempted; section correctly downgrades to SKIPPED with the reason printed; header correctly reverts to "offline, secret-free" since no dial ran. `NOT READY` here is again solely the pre-existing `privacy-eligibility` check, proving the skip path is independent of it.

### (c) RED proof — `HERMES_KIMISUB_BASE_URL=http://127.0.0.1:39217 node --env-file=.env ops/phase1-doctor.mjs` (env override in the spawned process only; `.env` file and running proxy untouched)

```
TORQCLAW Phase-1 doctor (live provider dial)
PASS  chains-parse: provider-chain JSON is parseable
PASS  revision: chain revision is present
PASS  ordered-distinct-ids: chains contain two ordered accepted Hermes selectors
PASS  finite-ceilings: all provider ceilings are finite non-negative integers
FAIL  privacy-eligibility: privacy eligibility is incomplete
PASS  referenced-env-presence: all referenced environment variables are present
FAIL  provider-dial:default:kimi-sub-primary: PRIMARY UNREACHABLE -- kimi-sub-primary (127.0.0.1:39217): ECONNREFUSED. Every FRONTIER turn on this chain will burn the engine retry budget (~90s) cascading past this provider before it can fail over.
WARN  provider-dial:default:glm-fallback: fallback unreachable -- glm-fallback (api.z.ai): ECONNRESET
FAIL  provider-dial:coding:kimi-sub-primary: PRIMARY UNREACHABLE -- kimi-sub-primary (127.0.0.1:39217): ECONNREFUSED. Every FRONTIER turn on this chain will burn the engine retry budget (~90s) cascading past this provider before it can fail over.
PASS  provider-dial:coding:glm-fallback: glm-fallback (api.z.ai): reachable, 9 models
FAIL  provider-dial: at least one chain primary is unreachable
WARN  maintenance: no shutdown maintenance snapshot is available; no checkpoint was triggered
Result: NOT READY
```
Exit code: 1

Confirms: (i) the loud actionable line naming provider id, host, and the exact consequence fires for a dead PRIMARY; (ii) nonzero exit; (iii) a transient real-network `ECONNRESET` on the GLM fallback during this run graded as `WARN`, not `FAIL` (proving fallback-down does not fail doctor, and that the grading is driven by chain position, not by which provider happens to be flaky at dial time) — the `coding` chain's `glm-fallback` dial in the same run succeeded, confirming this was a one-off blip, not a code defect.

### Supporting checks

- `node --check ops/phase1-doctor.mjs` → syntax OK (run after every edit).
- `git diff --stat -- ops/phase1-doctor.mjs` → `1 file changed, 92 insertions(+), 4 deletions(-)`.
- `git status --short` before and after: confirmed no file other than `ops/phase1-doctor.mjs` was modified by this work; all other modified/untracked files in the tree pre-existed as other agents' WIP and were left untouched.
- `grep -rl "phase1-doctor\|phase1Doctor" tests/` → no matches (no vitest coverage exists or was broken).
- `grep -rn "runPhase1Doctor"` (whole repo) → only `ops/phase1-doctor.mjs` (definition) and `ops/doctor.mjs` (the one caller, itself `async` and already `await`ed) — no other caller needed updating for the new `async` signature.
- `grep -n "doctor" .github/workflows/ci.yml` → no matches; CI does not run doctor, so left untouched per task instruction 4.

## Runtime/browser/a11y evidence

Not applicable — this is a Node CLI ops script with no UI surface.

## Known limitations

- The pre-existing `privacy-eligibility` check fails in this environment because the operator's live `~/.torqclaw/provider-chains.json` only declares `"privacyClasses": ["standard"]` for both providers in both chains, not `"sensitive"`. This is a **pre-existing condition**, reproduced identically by running the unmodified `HEAD` version of `ops/phase1-doctor.mjs` against the same `.env`/chain document (confirmed via `git show HEAD:ops/phase1-doctor.mjs` executed standalone). It is a config/data state issue, not a code defect, and is out of this task's scope (touch only the named file for the named purpose). It does mean **`Result: NOT READY` / exit 1 is expected on this box even with the provider-dial section fully healthy** — readers of this evidence should look at the `provider-dial:*` and `provider-dial` lines specifically, not the final `Result:` line, to judge this change.
- The 3000 ms timeout and dial are real network calls; on a slower or more congested proxy than the one probed here, an occasional false-positive timeout on a healthy primary is possible. No retry is implemented (matching the task's ask for a single fast probe, not a retry-budget imitation).
- Model-count extraction only recognizes an OpenAI-style `{data: [...]}` or an Ollama-style `{models: [...]}` response body; a provider returning models under a different key still passes/fails correctly (2xx is still `pass`) but reports `"reachable"` without a count.

## Deviations from the packet

- **URL-join bug found and fixed during verification**: an initial implementation used `new URL('/models', baseUrl)`, which is root-relative and silently discards any path segment already in `baseUrl` (e.g. a base of `http://host/v1` would probe `http://host/models`, not `http://host/v1/models`). Caught because the first live run against the real proxy returned 404 where a manual `fetch` had returned 200. Fixed by concatenating `/models` onto the full base path instead. This is a bug-fix-during-build, not a scope change — no interface or file outside `ops/phase1-doctor.mjs` was touched to fix it.
- **Error-message improvement**: undici's `fetch` wraps real connection errors (e.g. `ECONNREFUSED`) inside `TypeError('fetch failed').cause`. The implementation was adjusted mid-build to unwrap `error.cause.code` so the doctor's FAIL line names the actual reason instead of the generic `"fetch failed"` wrapper text, matching the task's explicit ask for a loud, actionable line.
- No other deviation. CI was left untouched per instruction 4's conditional ("only if CI currently runs doctor") — it does not.

## Addendum (2026-08-25) — D-1 fix: credentialed-URL leak in the error-message fallback

Independent verification returned **RETURN_TO_BUILDER** with one bounded MEDIUM/latent defect. All other findings passed (grading matrix, all three scenarios, the skip path, the URL-join fix, the timeout, the full suite at 2690/0, and the bearer API key never leaking on any path).

**D-1**: `ops/phase1-doctor.mjs:47` (pre-fix) — the error-message fallback `error?.cause?.message || error?.message` can echo a full credentialed URL (`http://user:secretpw@host/...`) when a `baseUrlEnvName` value carries HTTP userinfo. Node's fetch guard rejects such a URL with `TypeError: Request cannot be constructed from a URL that includes credentials: {full URL with password}` — this error has no `.code` and no `.cause`, so the pre-fix code fell all the way through to `error.message`, which embeds the password verbatim. Reproduced by the verifier with real `fetch`; confirmed independently during this fix using the same shape. **Not currently exploitable** against this deployment (neither `HERMES_KIMISUB_BASE_URL` nor `GLM_CODING_BASE_URL` carries userinfo), but the code did not enforce that, and the original evidence doc's "never logs the credentialed URL" claim (lines 13, 27 as originally written) was incorrect as a general statement about the code's behavior. Both lines are corrected above with dated notes.

### Fix

Added a `stripCredentials` helper in the `catch` block of `dialProvider` that removes any `scheme://user:pass@` substring from `error.cause?.message` / `error.message` before either is used as the recorded fallback reason, and reordered the fallback chain so `error.cause.code` / `error.code` (which never carry the raw message) are still preferred first:

```js
const stripCredentials = (value) => typeof value === 'string' ? value.replace(/\/\/[^/@\s]+@/g, '//') : value;
const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
  ? `timed out after ${PROVIDER_DIAL_TIMEOUT_MS}ms`
  : error?.cause?.code || error?.code || stripCredentials(error?.cause?.message) || stripCredentials(error?.message) || 'unreachable';
```

No interface change (same helper signature, same return shape, same call sites). Diff for this fix alone: `ops/phase1-doctor.mjs`, +5/-1 lines inside the existing `catch` block.

### Proof — before/after capture

All runs used a **child-env-only** override (`.env` file and the running proxy were never modified). Secret used in the reproduction is `secretpw` (a throwaway value invented for this test, not a real credential).

**BEFORE** (D-1-vulnerable code, isolated to a scratch copy outside the repo for comparison only — never committed, never the file doctor actually runs), `HERMES_KIMISUB_BASE_URL='http://user:secretpw@127.0.0.1:1/v1'`:

```
FAIL  provider-dial:default:kimi-sub-primary: PRIMARY UNREACHABLE -- kimi-sub-primary (127.0.0.1:1): Request cannot be constructed from a URL that includes credentials: http://user:secretpw@127.0.0.1:1/v1/models. Every FRONTIER turn on this chain will burn the engine retry budget (~90s) cascading past this provider before it can fail over.
```
`secretpw` is visible in this line — this is the leak the verifier found.

**AFTER** (fix applied to the actual repo file `ops/phase1-doctor.mjs`), same override:

```
FAIL  provider-dial:default:kimi-sub-primary: PRIMARY UNREACHABLE -- kimi-sub-primary (127.0.0.1:1): Request cannot be constructed from a URL that includes credentials: http://127.0.0.1:1/v1/models. Every FRONTIER turn on this chain will burn the engine retry budget (~90s) cascading past this provider before it can fail over.
```
`user:secretpw@` is stripped; the URL now reads `http://127.0.0.1:1/v1/models`. Grep-confirmed zero occurrences of `secretpw` in the full AFTER output. Loud FAIL line and nonzero exit are preserved (exit 1).

**Scenario (a) re-run, plain, proxy up** (`node --env-file=.env ops/phase1-doctor.mjs`, no override): unchanged from the original evidence — `provider-dial:default:kimi-sub-primary: kimi-sub-primary (127.0.0.1:8317): reachable, 23 models`, all four provider-dial checks PASS, `provider-dial: pass`. Exit 1 overall, driven solely by the pre-existing, out-of-scope `privacy-eligibility: FAIL` (documented in Known limitations above) — unaffected by the D-1 fix.

**Scenario (c) re-run, plain-refused** (`HERMES_KIMISUB_BASE_URL=http://127.0.0.1:39217 node --env-file=.env ops/phase1-doctor.mjs`, real closed port, no userinfo): unchanged — `FAIL provider-dial:default:kimi-sub-primary: PRIMARY UNREACHABLE -- kimi-sub-primary (127.0.0.1:39217): ECONNREFUSED. Every FRONTIER turn on this chain will burn the engine retry budget (~90s) cascading past this provider before it can fail over.`, exit 1. This path never reaches the `error.message` fallback (it resolves via `error.cause.code`), so it was never affected by D-1 and is not affected by the fix.

### Tallies

- Files touched by this fix: `ops/phase1-doctor.mjs` (+5/-1 inside the existing `catch` block) and this evidence file. Nothing else.
- Cumulative diff for the whole task (original build + D-1 fix): `ops/phase1-doctor.mjs` — 97 insertions, 4 deletions (`git diff --stat` against `HEAD`).
- Secret leak check: `secretpw` occurrences in AFTER output — 0 (grep-confirmed).
- Scenario (a): PASS (unchanged). Scenario (b) skip path: not re-run in this addendum (untouched by the fix — the fix is inside the `catch` block of `dialProvider`, which the skip path never reaches). Scenario (c): PASS (unchanged, loud FAIL, exit 1).
- No vitest coverage exists for this file (`grep -rl "phase1-doctor|phase1Doctor" tests/` → no matches, both before and after); the fix does not change any interface, so the coordinator's reported full-suite 2690/0 is unaffected and was not re-run for this internal 5-line change.

## Status

**READY_FOR_INDEPENDENT_VERIFICATION** (D-1 addressed; awaiting re-verification of this specific fix)
