# Sprint 2 / 3 refinements (from PRD v2 review)

Carry these into the relevant P-items when building Sprints 2–3. Each is a
review catch that does **not** apply to already-shipped Sprint 1 code (the two
that did — usage-API throttle and privacy-regex debounce — are already fixed in
commit `aa18076`).

## P2 (Tool approval) — define the REJECT terminal state
Invariant 7 requires exactly one terminal event per task. `APPROVE` mints a new
request and routes it; **`REJECT` must emit a terminal `ERROR`** ("Task aborted
by user: tool denied"), not a `RESULT` and not a silent SYSTEM-only end. The
ERROR carries P3.5 `recovery` metadata so the user gets retry / copy-diagnostic
chips. Add an acceptance assertion: a rejected approval ends the task `failed`
with one ERROR event.

## P4 (Approve-with-edits) — textarea Tab key
The skill-draft `<textarea>` holds SKILL.md with Python (indentation-sensitive).
Plain `<textarea>` maps Tab to focus-change. Add an `onKeyDown` that intercepts
Tab, `preventDefault()`, and inserts two spaces at the cursor (and Shift+Tab to
dedent). Keeps the lean no-Monaco approach usable for code edits.

## P5 (Workspace scoping) — normalize before matching
`servers.json` path scopes `{ read, write, deny }` must be checked against
`path.resolve()`-normalized argument paths, never raw substring match — else
`~/projects/../.ssh` bypasses a `~/.ssh` deny. `deny` always wins. Resolve the
tilde and relative segments first, then compare. Defense-in-depth alongside the
MCP server's own allowed-dirs; document both layers.

## Already fixed in Sprint 1 (for the record)
- **Usage-API rate-limit trap (P0):** `get_spend_usd`'s provider-usage fallback
  is throttled to `HERMES_USAGE_POLL_S` (default 20s) — it was firing an HTTP
  call every ~2s poll. The free `get_credits_spent_micros` path is per-call.
- **Privacy regex on keystroke hot path (P0.5):** debounced 500ms.
