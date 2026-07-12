# Graphify consumer integration report (profiles adoption)

**Date:** 2026-07-12
**Branch:** `chore/graphify-consumer-profile` (isolated worktree; base `origin/master` @ `41bd648`)
**Scope:** Graphify consumer configuration + Graphify-specific validation only. No product runtime, approval, governance, gateway, contracts, UI, or engine changes.

## Dependency

```text
Depends on pilotwaffle/Torq-graphify#1 (feature/project-graph-profiles).
Audited upstream head: f7d593971b2f0b2a7ddd5d0865359b78a187b1fe (second review-repair head; supersedes d48c5c6, c6e89a2)
Do not merge until PR #1 is merged and this integration is retested against
its final merge SHA.
```

This integration replaces the reverted bespoke dual-graph scripting
(`build_graphify_graphs.py` / `check_graphify_fitness.py`) with the upstream
primitives: a committed `graphify.toml`, `GRAPHIFY_PROFILE=product` as the
Claude Code default, `graphify fitness --profile product --strict` as the
trust gate, and one TorqClaw-specific read-only smoke test.

## Controlling invariant

Product architecture conclusions must be derived from the product-scoped
graph; vendored implementation details may enter only through an explicit
vendor investigation.

## Measured results (worktree validation, upstream @ f7d5939)

| Metric | product | vendor |
|---|---|---|
| Nodes | 1,777 | 122,521 |
| Edges | 2,254 | 222,219 |
| Vendor share | **0.0%** | 100% (`kind = "vendor"`, exempt) |
| Cross-package edges | 228 | n/a |
| Communities (label coverage) | 147 (100%) | 4,290 |
| Graph size | 1.4 MB | ~119 MB |
| Fitness | **PASS under `--strict`** | **PASS** (kind exemption) |
| Smoke | ALL PASSED | ALL PASSED |

Hook-guard direct-payload tests emit the MANDATORY nudge naming the resolved
`graphify-product/graph.json` (exit 0), resolved from `graphify.toml`
`default_profile` alone - no env var required; `.claude/settings.json` pins
`GRAPHIFY_PROFILE=product` for assistant sessions regardless.

## Build commands (validated syntax)

```bash
pnpm graphify:build:product   # graphify update .  (resolves product via toml)
pnpm graphify:build:vendor    # scan root engines/hermes_kernel/vendor/hermes-agent,
                              # output forced to repo-root graphify-vendor/ via
                              # absolute GRAPHIFY_OUT (see limitation 2)
pnpm graphify:fitness         # graphify fitness --profile product --strict
pnpm graphify:smoke           # python scripts/test_graphify_smoke.py (read-only)
```

The vendor tree is a git submodule (`NousResearch/hermes-agent`); run
`git submodule update --init engines/hermes_kernel/vendor/hermes-agent`
before the vendor build in a fresh clone/worktree.

## Known limitations (upstream v1, tracked for follow-up on Torq-graphify)

1. **Undirected update builds.** `graphify update` produces
   `directed: false`; the profile's `directed = true` parses but is not yet
   build-wired. `graphify affected` still works as neighbor traversal; the
   smoke test accepts `directed: false` with an explicit note. Upstream
   follow-up: wire `profile.directed` into the update/build path.
2. **`update` writes output relative to the scan root**, so the vendor
   build passes an absolute `GRAPHIFY_OUT` to land the graph at the repo
   root instead of inside `engines/**`. (RESOLVED upstream @ d48c5c6:
   profile `exclude` patterns now apply on every rebuild path — retested
   here with a temporary vendor fixture that update did not introduce.
   `.graphifyignore` is retained as defense-in-depth. `include` remains
   unwired; `out` anchoring remains a follow-up.)
3. **Interpreter sidecar.** `update` does not write `.graphify_python`;
   fitness reports it as a note (never verdict-affecting). Skill flows
   re-resolve the interpreter on demand.
4. **Clean-clone reproducibility hold.** Validated against the local audited
   editable install (import resolves to `E:\graphify` @ `f7d5939`). The
   draft PR stays blocked until PR #1 merges, the final merge SHA is
   recorded, graphify is installed from that exact commit
   (`pip install git+https://github.com/pilotwaffle/Torq-graphify@<merge-sha>`),
   and this worktree is retested against it.
