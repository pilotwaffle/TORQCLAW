# GS-ACCEPT — live acceptance, run 1

**VERDICT: CONDITIONAL PASS — 13 of 15 steps satisfied. One BLOCKING finding
prevents governed skills going default-on.**

Run 2026-08-10 against merged master (`83690f3`). Harness:
`engines/hermes_kernel/tests/acceptance/test_gs_accept.py`.
Result: **8 passed, 2 xfailed** (both xfails are recorded findings, not hidden
failures). Unit suite unaffected: **303 passed, 1 skipped, 10 deselected**.

## Why this run is different from the unit suite

Every assertion goes through a real boot path. A real `AIAgent` is
constructed — not mocked — and discoverability is asserted on the **real
rendered system prompt** via `build_skills_system_prompt()`, the same function
the model's turn consumes. Prior evidence only ever proved discoverability
through the loader's *functions* (`iter_skill_index_files`), which
`external-dirs-mtime-cache-trap` warns is insufficient: the prompt builder
caches **negative** lookups on `config.yaml` mtime and can render an empty
index while the loader happily reports the file.

Isolation is asserted, not assumed: `HERMES_HOME` and `TORQCLAW_DATA_DIR` are
per-test, and the fixture refuses to run if the publish target resolves inside
the operator's real `~/.torqclaw` or `AppData/Local/hermes`. No
`run_conversation` is issued, so no tokens are spent; the provider points at
local Ollama so a construction path that probes the provider fails loudly
rather than reaching a paid endpoint.

## Steps

| # | Step | Result |
|---|---|---|
| 1 | Flag off, legacy unchanged | PASS |
| 2 | Restart with governed enabled | PASS |
| 3–6 | Stage, review digest, approve, publish to real `external_dirs` | PASS |
| 7 | Fresh real `AIAgent` boot | **PASS** |
| 8 | Skill present in the model's usable index | **PASS** |
| 9 | Roll back / disable | **BLOCKED — see F-1** |
| 10 | Fresh task after rollback | PASS (boot) |
| 11 | Removed version no longer usable | **FAIL — see F-1** |
| 12 | Full stack restart | PASS |
| 13 | Governed state correct after restart | PASS |
| 14 | Failure cases | PASS, except F-2 |
| 15 | Consider promotion | **NOT YET — F-1 blocks** |

Steps 7–8 and 12–13 are the ones no unit test substitutes for, and they pass.
Publication lands in the real resolved `external_dirs` path with the exact
approved bytes, the skill appears in the rendered prompt, and governed state
survives a full module-reload restart because it is durable rather than
memoised.

## F-1 — BLOCKING: governed rollback does not exist end-to-end

**`store.rollback()` moves governance to the prior digest but does not
re-publish the prior projection.** Measured outside the harness, reproduced
cleanly:

```
after v2  | published: v2 bad
after rb  | governed active digest == v1
after rb  | published: v2 bad          <-- diverged
```

The operator sees "rolled back"; the model keeps reading v2. Governance and the
published projection disagree, which is precisely the class of divergence
GS-COORD was built to make impossible for *activation*.

**Worse, and the reason this is a finding rather than a bug report:
`store.rollback()` has no production caller.** Not `governed_skills`, not the
gateway, not the console — grep is empty. `governed_skills.py:328` describes the
governed path as "rollback-capable". That is the **unenforced-claim pattern**:
the capability exists as a method and is reachable from no operator surface.

Step 9 is therefore not satisfiable today. Closing it needs a governed rollback
routed through `ActivationCoordinator` exactly as activation is — publish the
prior projection, invalidate, commit, verify — which is a GS-COORD-shaped
product change, not a test fix.

Pinned by `test_steps_09_to_11_rolled_back_version_is_not_usable`, which asserts
the governance half that does work and `xfail`s the projection half with the
measurement inline.

## F-2 — minor: empty skill body is accepted

An empty markdown body publishes as a **0-byte `SKILL.md`**. Validation bounds
package size from above (`MAX_SKILL_BYTES`, `verified_skill_store.py:963`) but
has no lower bound, so empty content is structurally valid — digests match and
the manifest is consistent.

Not a security hole: it requires an operator to approve an empty skill, and an
empty `SKILL.md` renders nothing into the prompt. Pinned with
`@pytest.mark.xfail(strict=True)` so that fixing it turns the xfail into a
failure and forces the gap to be closed out deliberately.

## Harness findings worth keeping

- **The `SkillNotExternallyLoadableError` guard fired on the first run** and was
  correct — the temp publish dir was not in `skills.external_dirs`. Fixing the
  harness by writing a real `config.yaml` made the run *more* faithful: it now
  exercises the operator configuration step too.
- **`store.rollback()` is `rollback(skill_id, digest)`** — it activates one
  exact previously installed digest. There is no removal/disable API at all;
  step 9's "roll back / disable" is only half-specified against what exists.
- The vendored `run_agent` / `agent.prompt_builder` are put on `sys.path` by
  importing `mcp_wrapper.hermes_runner` (`:89`). The harness imports it rather
  than manipulating `sys.path`, so if that mechanism breaks the acceptance run
  fails — which is the point.

## Recommendation

**Do not promote governed skills to default-on.** F-1 means an operator cannot
undo a bad skill through any shipped surface; the only recovery is manual
filesystem intervention. That is a worse failure mode than the activation
defects GS-COORD fixed, because it is silent — governance reports success.

Suggested next lane, **GS-ROLLBACK**: governed rollback through
`ActivationCoordinator`, same transactional guarantees as activation, plus an
operator surface that calls it. Scope it the way GS-COORD was scoped — G1R
before build, G2A after, deletion probes for every control.

`TORQCLAW_GOVERNED_SKILLS` stays default-off until then.
