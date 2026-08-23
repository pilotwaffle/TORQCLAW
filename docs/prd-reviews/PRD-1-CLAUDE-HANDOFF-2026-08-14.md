# PRD-1 Claude Team Handoff — 2026-08-14

## RESULT

Work is **stopped safely but incomplete**. The implementation candidate exists as immutable commit `726161781f2e7683e999c51748a07eb158c27ab1`; the governed evidence pipeline stopped before executing the v3 raw-process-wrapper corpus. No final mutation packet, independent verifier verdict, or Gate 2 approval exists.

The durable PRD is:

```text
E:\TorqClaw\docs\prd-reviews\PRD-1-PROFILE-CONFORMANCE-SUITE.md
```

## CLAUDE BOOT ORDER

Read before resuming:

1. `E:\.claude\model-handoff\00_BOOT_CARD.md`
2. `E:\.claude\model-handoff\01_FABLE_CORE_OPERATING_MANUAL.md`
3. Sonnet executor: `E:\.claude\model-handoff\02_SONNET_5_EXECUTOR_CONTRACT.md`
4. Opus reviewer: `E:\.claude\model-handoff\03_OPUS_4_8_REVIEWER_CONTRACT.md`
5. Repository/global instructions already named by the PRD bootstrap, including `E:\.claude\CLAUDE.md`, repository `CLAUDE.md`/`AGENTS.md`, memory files, and applicable skills/agents.

Use Sonnet as executor/builder and a separate Opus thread as reviewer. The reviewer must not implement and approve its own correction.

## APPROVAL UNIT

Do not treat the dirty root worktree as the approval unit.

```text
Base:      9324cbc6e195807ff6849c6b2d646e745e66fa0d
Candidate: 726161781f2e7683e999c51748a07eb158c27ab1
Parent:    fec1f0d4eb7121108ed0c2314157b495cf98cf32
Tree:      24f7af59c7b81e6d589b6064e18563fee5591267
```

Verified base→candidate change set: exactly eight additions, zero deletions:

```text
docs/security/profile-conformance.md
scripts/run-profile-conformance-mutants.mjs
tests/fixtures/profile-conformance-golden.json
tests/helpers/profile-conformance.ts
tests/profile-conformance-c2.test.ts
tests/profile-conformance-caller-audit.test.ts
tests/profile-conformance-declared.test.ts
tests/profile-conformance-runtime.test.ts
```

The root branch was `phase1-server-owned-authority` at `76b81892a0131c3c9a05f8b5ec6119dabeb48874` and was already heavily dirty with operator-owned/untracked work. Preserve it. Do not clean, reset, delete, or overwrite it.

## LAST SAFE STOP POINT

Phase: Terra-approved v3 raw-process-wrapper validation, **presealed but not executed**.

Newest evidence root:

```text
E:\tmp\torqclaw-prd1-dotnet-capture-v3-20260814-215057935-39eda82b
```

Frozen inputs:

```text
wrapper SHA-256:
a20777d3a7dfa2904e7a9d4528431fddc593fd05b034ab441f0ba179269507fe

corpus SHA-256:
ab1af3b9bdb2a2c7696b2120c582efe18d691bd032fbf9e84cc028d5df0ed701

preseal SHA-256:
e79f14bb1bbe02ab19feb2010fc4901260b13ef09910fc60d4fb8b545d531e3a

helper SHA prefix/suffix: 3e2b253a…530c
vectors SHA prefix/suffix: 0055164d…5e49
schema SHA prefix/suffix: 4ac973df…def4
contract SHA prefix/suffix: 15c662dd…1da
```

Planned corpus: 16 cases, 10 accept and 6 reject. The v3 corpus has not run. No v3 child receipt or result exists.

Immediate resume rule:

1. Re-read the v3 preseal and full-hash every input.
2. Confirm all declared result/receipt paths remain absent.
3. Run the v3 corpus exactly once.
4. It must exercise the real wrapper entry point and prove:
   - raw `object[]` validation occurs before coercion;
   - null collection/elements, `AutomationNull`, non-string/nested arrays, and NUL reject before child creation;
   - empty strings and valid Unicode/whitespace args survive exactly;
   - no flattening or binder erasure occurs.
5. If any case fails, stop and route the frozen evidence to a fresh Opus review. Do not patch/rerun in place.
6. If fully green, freeze the corpus and run exactly one diagnostic-only invocation of the unchanged image auditor through the same wrapper.
7. Regardless of diagnostic exit, stop and send raw stdout/stderr/exit/receipt to fresh Opus. The diagnostic is not acceptance evidence.

## HELD DOCKER / ARTIFACT STATE

Held derived image:

```text
sha256:f9a65c0e62f2ee597149e02a4b2382c10073124df419952f7f0060f34346eb8f
```

Held never-started target:

```text
b22ce32d8789cb7f5507b9675dac9d098281dfa1839948cb58a46fbebb7d945d
```

Read-only inspection at handoff verified:

```text
state=created
running=false
StartedAt=0001-01-01T00:00:00Z
NetworkMode=none
mounts=0
container image=sha256:1dc2dc4d3fe9e181b0472342a7af1885f3d0f757fb241f815b617f470770f660
```

Important correction: `1dc2dc4d…` is the GCC12 source/parent image. `73d85a96694a…` is the separately pinned devcontainer/Git/strace source image, not the GCC parent. A prior checkpoint mislabeled this; do not propagate that error.

Derived image facts:

```text
9 RootFS layers
top DiffID sha256:de0b320a6ecea88bc55ee91891a9f4480fdb2222295830e42dbe91548203fe00
Config.Cmd=["/bin/true"]
Config.Labels={"desktop.docker.io/ports.scheme":"v2"}
```

Saved tar:

```text
E:\tmp\torqclaw-prd1-save-audit-v3-20260814-204515607-50903324\derived-image.tar
SHA-256 e5697efef1ec32da33f783271c42075212b1c7ece1235da4cc00e6f2008527fc
size 500982784 bytes
```

Python closure TAR proof already passed:

```text
closure TAR SHA-256 8ad0d7dfc6573269fe9ebbc4fbf48b44e8f5554e7d146958bdc74a51ae9a304c
manifest SHA-256 e4488fd6f1c1a3562d00e03b3bdc3ae2be6ce89bfd0718f997ff890234916ec9
canonical Docker-diff map SHA-256 f510fecab28b47e0675bc4a4b2f539485185f18fd5835ec7f734860ec949750d
logical members 1477 = 1240 files + 235 directories including root + 2 symlinks
Docker diff 1476 = 1472 A + 4 C + 0 D
```

Production raw-TAR comparator passed once; result:

```text
E:\tmp\torqclaw-prd1-direct-copy-none-ps51-20260814-191718490-fce393c4\recovery-raw-tar-result-v4-production.json
SHA-256 0ce2e377…
```

## COMPLETED EVIDENCE THAT MAY BE REUSED AFTER HASH VERIFICATION

- Base/C3 strict paired host run completed green:
  - base `9324cbc…`: 98/98 files, 1861/1861 tests;
  - C3 `fec1f0d…`: 102/102 files, 1895/1895 tests.
- Candidate lineage and eight-file scope were proven clean in retained detached worktrees.
- C4 contains the final 36-test acceptance inventory, but final isolated C4 canonical/mutation evidence is still missing.
- Python closure TAR/raw parser/diff comparator passed as listed above.
- Port-binding guard corpora passed:
  - PowerShell 14/14;
  - Python 27/27.
- Saved-config normalization corpus passed 38/38.
- Durable writer corpus passed 24/24.
- Hash-launcher corpus passed 25/25 and the production preseal writer completed successfully.

These are builder-stage receipts, not independent final verification.

## RETAINED DIAGNOSTICS — NOT ACCEPTANCE EVIDENCE

- Wrapper v1 rejected intentional empty strings.
- Wrapper v2 exposed PowerShell `[string[]]` null-to-empty coercion and launched diagnostic PID 47508. It is rejected evidence.
- The first auditor attempt emitted an uncaptured traceback because PowerShell converted native stderr to `NativeCommandError`; zero-byte sinks do not prove empty child output.
- Multiple earlier parser/corpus/launcher failures are retained intentionally. Do not delete, overwrite, or present them as passing evidence.
- Quarantined paths from earlier governance incidents must remain unused and untouched, including the rogue root worktree and original candidate path identified in prior evidence.

## WHAT REMAINS

1. Run the presealed v3 wrapper corpus once.
2. Capture the unchanged saved-image auditor diagnostically through the proven wrapper.
3. Fresh Opus review of the captured exception/result.
4. If needed, create a newly named auditor/corpus correction; then obtain one accepted saved-image audit.
5. Run the corrected benign no-network synthetic `node-gyp`/`make`/`strace` trace.
6. Fresh Opus approval of the static-audit + trace recipe.
7. Perform two independent no-network `better-sqlite3@11.10.0` native builds and prove byte identity/loadability/ABI.
8. Bind the approved v11 build and pinned v12 publisher artifact into the final offline toolchain.
9. Finish isolated dependency provisioning, source archives/GitDB, baseline oracle, and clean candidate volumes.
10. Run same-environment base and C4 canonical suites; reconcile only the frozen baseline timeout signatures.
11. Run all eight mutations P1a/P1b/P2-namespace/P2-capability/P2-side-effect/P3a/P3b/P4 with exact RED/restoration receipts.
12. Run final C4 canonical suite and prove no new failures, exact source/archive identity, and clean approval unit.
13. Produce the Builder Evidence Packet.
14. Run an independent verifier thread that modifies no source and returns `READY_FOR_G2A` only if evidence reproduces.
15. Run a fresh isolated final Opus/Sol-equivalent Gate 2 audit against the final source state.
16. Only after approval, update memory/evidence status. Stop before push, merge, release, deployment, or cleanup.

## UNRESOLVED PRD INPUTS

- Exact AUTH-005 merged PR/SHA is not durably recorded in this handoff.
- Operator dispositions are recommended in the PRD but are not formally signed in its sign-off block.
- Canonical full-suite command used by the builder was `pnpm test`; Claude must confirm this remains canonical at the pinned base.
- No final clean C4 canonical receipt exists.
- No complete mutation packet exists.
- No independent verifier or final Gate 2 verdict exists.

## NON-DELETION / OPERATOR BOUNDARY

- Do not delete, reset, clean, overwrite, or remove any pre-existing repository code, operator-owned file, evidence root, worktree, image, container, cache, or quarantine artifact.
- Session-created scratch may be discarded only with explicit human approval; no cleanup is needed to resume.
- Do not push, merge, deploy, release, change credentials/providers/billing, or perform irreversible actions.

## STRONGEST ALTERNATIVE CONCLUSION

The strongest contrary claim is that the suite is effectively finished because the code and several host suites are green. The evidence rules that out: the final C4 isolated canonical run, full mutation receipts, independent verifier recommendation, and fresh final audit are all absent.

