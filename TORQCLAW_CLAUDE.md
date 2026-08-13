# TORQCLAW_CLAUDE.md — SUPERSEDED 2026-08-12

**This file is no longer the TORQCLAW contract. Read `CLAUDE.md` in this repo's root instead.**

## Why

Claude Code only auto-loads a file named `CLAUDE.md`. This file was never loaded, so its 380 lines of routing, approval, cost, and MCP safety rules were silently inert in every session.

Its full content has been merged into `CLAUDE.md`, which previously held only the graphify policy (preserved at `CLAUDE.md.graphify-orig.bak`).

## What changed in the merge

- **Role map corrected** to the operator contract of 2026-08-12: G1R is **Opus 5** (was Opus 4.7); G2A is **Opus 4.8** and audits rather than scopes; G1D is **Fable 5**. Historical gate records referencing Opus 4.7 are not retroactively invalidated.
- Restructured to the shared 10-section skeleton used by `E:\TORQ-CONSOLE\CLAUDE.md` and `E:\TORQ-CLI\CLAUDE.md`.
- Added a pre-merge deletion audit rule, from the GS-COORD near-miss of 2026-08-09.
- Everything else — the ten core invariants, cost/routing safety, tool approval paths, MCP server rules, workspace path scoping, shell editing safety, startup continuity scan — carried over intact.

The verbatim pre-merge original is at `TORQCLAW_CLAUDE.md.bak-2026-08-12`.

Delete this stub once you are satisfied the merge is correct.
