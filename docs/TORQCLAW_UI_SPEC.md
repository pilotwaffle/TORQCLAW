# TorqClaw Console — Visual Redesign Spec (PRD-UI-1)

**Status:** Approved design target. This document is the visual source of truth.
**Companion artifact:** `docs/ui-concept.html` — the interactive reference mockup. When this document and implementation disagree, this document wins; when this document is silent, match `ui-concept.html`.
**Scope:** `apps/console` frontend only. No gateway, contract, or kernel changes. Where required data is not on the WS stream, implement presentation-only behind a feature flag and note the gap in the commit message. Never fabricate data.

---

## 0. Design tokens (apply first, as CSS variables / Tailwind theme)

```
--bg:        #0A0B0D   app background
--panel:     #121316   cards, header, sidebar
--panel-2:   #17191D   receipts, hover states, composer box
--panel-3:   #1D2026   inner fills (meters, code chips)
--border:    #23262C   hairlines
--border-strong: #2E323A
--text:      #F4F5F6
--muted:     #A7ADB8
--faint:     #6A717C
--torque:    #FF9E40   BRAND accent — focus, active nav, prompt sigil, answer edge
--cloud:     #22D3EE   cloud route ONLY
--good:      #34D399   local route, success, "done"
--mem:       #A78BFA   memory, snapshots, undo
--bad:       #F87171   errors + destructive ONLY
```

**Hard color rules:**
1. Red (`--bad`) is reserved for errors and destructive actions. The current console's red brand marks, red `[you]`, red `cloud model` tags are ALL reassigned per tokens above. If any red remains on a non-error element, the item fails review.
2. Fonts: **JetBrains Mono** for all UI chrome, labels, log lines, data. **Inter** for answer body text and any paragraph-length reading. Nothing else.
3. Base type: 13px / 1.6 line-height. Uppercase micro-labels: 9–10px, letter-spacing .12–.22em, 700 weight.
4. App background carries a subtle scanline overlay: `repeating-linear-gradient(0deg, rgba(255,255,255,.012) 0 1px, transparent 1px 3px)`, pointer-events none.
5. Radii: 4px (chips/tags), 6px (buttons/badges), 8–10px (cards, composer). No shadows except the composer focus glow (§6).

---

## 1. App shell — schematic

```
┌────────────────────────────────────────────────────────────────────────────┐
│ HEADER (52px, --panel, bottom hairline)                        [§2 detail] │
├──────────────┬─────────────────────────────────────────────────────────────┤
│  SIDEBAR     │                                                             │
│  236px       │              MAIN VIEW (scrolls)                            │
│  --panel     │              max-width 860px content column,                │
│  right       │              centered, 28px top padding                     │
│  hairline    │                                                             │
│  [§3]        │                                                             │
│              │                                                             │
├──────────────┴─────────────────────────────────────────────────────────────┤
│ COMPOSER (fixed, --panel, top hairline)                        [§6 detail] │
└────────────────────────────────────────────────────────────────────────────┘
```

- Sidebar hidden below 900px viewport width.
- No card-in-card nesting anywhere. Spacing and hairlines do the separating.

---

## 2. Header — schematic

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [⬡logo] TORQCLAW   ● CONNECTED   [◍ working · <phase>  0:07 │TURN f44c19d0]  …  │
│                                   (liveness chip, only while a task runs)        │
│                          …  [● SESSION BUDGET ▓▓▓░░░░░ $3.42/$10.00 ↻ synced 0:06]│
│                             [hermes kernel · v0.9.4]                             │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Left to right:
1. **Logo mark + wordmark** `TORQCLAW` — 14px, 700, letter-spacing .18em. The `CLAW` half (or final glyph cluster) in `--torque`. No red.
2. **Connection status** — 7px dot + `CONNECTED`, 10px, `--good`, dot pulses (1.5s). On disconnect: dot + text go `--torque` and text reads `RECONNECTING…`. When data is stale (>30s without an event) or disconnected, a `stale · reconnecting…` badge replaces this element entirely.
3. **Liveness chip** (§5) — present only while a task is in flight.
4. **Session budget meter** (right cluster): label `SESSION BUDGET` (9px micro-label), 110×4px meter bar (`--panel-3` track, `--torque`→`#FFC38A` gradient fill), value `$X.XX / $10.00` (amount in `--text` 600 weight, rest `--muted`), refresh icon-button, and `synced M:SS` (8.5px, `#4A505A`). Sync dot: 5px, `--good`; turns `--bad`-adjacent amber pulse when stale. Value climbs with real usage events — never static.
5. **Kernel tag** — `hermes kernel · v0.9.4`, 10px `--faint`, bordered pill (`--border`, 4px radius). Read from the runtime kernel handshake, not a config file.

---

## 3. Sidebar — schematic

```
┌───────────────────┐
│ CONSOLE           │  ← 9px micro-label, --faint
│ ┌───────────────┐ │
│ │ ☰ Task Stream │ │  ← active: --torque text, 14% --torque bg, 1px torque-25% border
│ └───────────────┘ │
│   ⛨ Approvals [2] │  ← badge: --torque bg, #0A0B0D text, 9px 700, pill
│   ▣ Memory        │
│                   │
│ SESSIONS          │
│ ┌───────────────┐ │
│ │▍cost-audit →  │ │  ← current session: --panel-2 bg + 2px inset --torque left bar
│ │▍NOW·4·CLOUD   │ │     meta line 9.5px --faint, letter-spacing .06em
│ └───────────────┘ │
│   vendor-eval…    │
│   weekly spend…   │
│                   │
│ ───────────────── │  ← footer hairline
│ EPISODES    1,284 │
│ UPTIME     6d 14h │
└───────────────────┘
```

- Nav item: 12px, 500 weight, `--muted`; hover → `--panel-2` bg, `--text`.
- Icons: inline SVG, 15px, 1.5–2px stroke, currentColor. No emoji, no icon fonts.
- Approvals badge counts pending items live; removed at zero.

---

## 4. Task stream — task card anatomy (the core change)

The flat log stream becomes a stack of **task cards**. One card per request. Schematic:

```
┌─────────────────────────────────────────────────────────────────────┐
│ [YOU] compare our cloud vs local inference cost…   [● CLOUD] 14:02  │ ← head
├─────────────────────────────────────────────────────────────────────┤
│ ▶ 6 STEPS · hermes kernel · memory recall                          │ ← collapsed plumbing
├─────────────────────────────────────────────────────────────────────┤
│ ▍ANSWER                                                             │
│ ▍Cloud ran $212.40 vs an estimated $61.00 local — a 3.5× premium…  │ ← hero
│ ▍  • Weird flag: 3 retries billed at full price on May 13…         │
├─────────────────────────────────────────────────────────────────────┤
│ [✓ done] [$0.004] [2.1s] [41,202 calls] [3 episodes]  view context ↗│ ← receipt
└─────────────────────────────────────────────────────────────────────┘
```

### 4a. Card container
`--panel` bg, 1px `--border`, 10px radius, 18px margin between cards. Entrance animation: 280ms fade + 10px rise, `cubic-bezier(.22,.9,.3,1)`.

### 4b. Card head
- Avatar tile: 26×26px, 6px radius, `--torque` at 14% bg + torque-30% border, text `YOU` 10px 700 `--torque`.
- Prompt: JetBrains Mono 13.5px, 600, `--text`, full text (no truncation).
- Route chip, right-aligned: 9.5px 700 uppercase, letter-spacing .14em, 4px radius, 3px/9px padding, 5px dot before label.
  - cloud → `--cloud` text, 12% bg, 28% border
  - local → `--good` text, 12% bg, 28% border
- One timestamp per task (HH:MM:SS, 10px `--faint`). **Never** per-line timestamps.

### 4c. Collapsed plumbing
- All KERNEL / SYS / MEMORY / routing status lines collapse into one row: `▶ N STEPS · hermes kernel · memory recall`, 10.5px `--faint`, full-width click target, 8px/18px padding. Chevron rotates 90° on open; body expands with max-height transition (320ms).
- Expanded step lines: 11px, `--faint`, indented 30px; tag colored (`KERNEL`→`--torque`, `MEMORY`→`--mem`, `SYS`→`--faint`); per-line timestamps only visible inside this expansion.
- **Default state: collapsed.** A stream of 20 tasks shows 20 clean cards, not 200 log lines.

### 4d. Answer hero
- Separated by top hairline; 2px left edge gradient `--torque`→transparent (85% fade).
- Eyebrow: `ANSWER`, 9px, 700, .22em, `--torque`.
- Body: **Inter** 14.5px / 1.72, `#E8EAED`, max-width 72ch. Bold = `#fff`. Inline numbers/money in JetBrains Mono 13px `--cloud`. Key figure callouts in `--torque` 600. `code` chips: `--panel-3` bg, 12px, 4px radius.
- This is the visual hero of every card. If the answer doesn't visibly dominate the card, the item fails review.

### 4e. Working state (replaces 4d while running)
```
│ ◌ working… <current phase>                          0:07            │
│ ▓▓▓▓▓▓▓▓ shimmer bar (3px, --torque sweep, 1.4s)                    │
│ ┌──────────────────────────────────────────────────────────┐       │
│ │ TOKENS      COST                    EST CAP              │       │
│ │ 382 (--cloud) $0.0008 (--torque)   ▓▓░░░░░ $0.001        │       │
│ └──────────────────────────────────────────────────────────┘       │
```
- Live panel: `--panel-2` bg, 6px radius. Tokens and cost tick live **if** mid-task usage exists on the wire; otherwise render the phase row only and state `cost records at completion` in the receipt — no fake ticker.
- Est-cap bar fills toward the SAME estimate shown pre-flight (§6). One number, one source.
- Elapsed anchored to task-start epoch (see PRD-core item 1 — already landed; keep).

### 4f. Receipt row
`--panel-2` bg, top hairline, chips: 10px `--muted`, `--border`, 4px radius, tabular-nums.
- `done` chip: `--good` text + 30% border + ✓ glyph.
- File-touching tasks add: snapshot chip (`--mem`, camera-frame SVG) + `↩ UNDO` button (outlined `--mem`). **Render only if the kernel exposes snapshot/rollback. Otherwise omit — no dead buttons.**
- `view context used ↗` ghost button right-aligned: transparent, `--faint`; hover → `--torque` text + torque-30% border + 14% bg.

---

## 5. Liveness chip (header)

```
[ ◍ working · composing answer   0:07 │ ACTIONSTATUS · TURN f44c19d0 ]
```
- `--panel-2` bg, torque-35% border, 6px radius, 4px/10px padding.
- Spinner: 10px ring, `--torque` sweep (GlyphSpinner-style braille glyph acceptable).
- Phase text: freshest real kernel event for the active turn, 10.5px `--muted`; `working` keyword in `--torque` 600.
- Elapsed: 10px tabular-nums `--faint`, same epoch anchor as the card's timer.
- Turn tag: 8px uppercase `--mem`, separated by left hairline.
- Visible on **every view** while any task is in flight. Click → jump to Task Stream, scroll to the running card.
- Stuck state: no kernel event for 30s → border and spinner go `--bad`, text reads `no output for 30s+ · <last phase>`. **Exception:** a task waiting on a pending approval is NOT stuck — show `waiting on your approval` in normal state.

---

## 6. Composer — schematic

```
┌─────────────────────────────────────────────────────────────────────┐
│ [📎] ❯ │ What do you need done?________________________  [ RUN ⏎ ] │
│ [q3-pricing.pdf · 2.1 MB ✕] [screenshot.png (thumb) ✕]             │ ← attach row (if any)
│ ⚠ 2 attachments will be uploaded with this task — route is cloud   │ ← only when cloud
│ [● ROUTE: CLOUD ▾] [MODEL: HERMES-3-70B] [● UNDER BUDGET] [MEM: ON]│
│                                          [EST ~$0.004] ⌘K · ↑ hist │
└─────────────────────────────────────────────────────────────────────┘
```

- Box: `--panel-2` bg, `--border-strong`, 10px radius. Focus-within: border → torque-50%, outer ring `0 0 0 3px rgba(255,158,64,.08)` + faint top glow. The composer is the app's home base — it must feel like it.
- Prompt sigil `❯` in `--torque` 700. Input: 13px JetBrains Mono, `--torque` caret, placeholder `#4A505A`.
- RUN button: `--torque` bg, `#0A0B0D` text, 11px 700, 7px radius.
- **Paperclip** (16px SVG, `--faint`; hover → `--torque` + 14% bg tile): opens file picker; drag-and-drop onto the box shows dashed `--torque` border state. Attachments render as chips: type tile 24×24 (PDF `--bad`, IMG `--cloud` with real image thumbnail, DOC `--torque`), name 10.5px `--text` truncated at 150px, size 9px `--faint`, ✕ remove (hover `--bad`). Attachments echo into the task card as a file row under the head.
- Cloud-route upload warning: 9.5px `--torque` with warning-triangle SVG; visible only when attachments exist AND route = cloud. **Gate submission on a real upload pipeline; if none exists, flag-gate the whole feature (`NEXT_PUBLIC_ATTACHMENTS`) — never mint fake file IDs.**
- Chips row: route chip (click toggles cloud/local, dot colored per route), model, budget state (`--good` when under), memory state (`--mem` when on). Right side: `EST ~$X.XXX` chip (torque styling; `$0.00 · local` in `--good` when local) that appears **as the user types**, fed by the kernel's real sizing/preview pass. If no dollar estimate exists on the wire, show `~N tokens · cloud` — never an invented dollar figure. Keyboard hints `⌘K`/`↑` as bordered kbd chips, 9.5px `#4A505A`.

---

## 7. Approvals view

```
┌───────────────────────────────────────────────────────────┐
│ ● PENDING  [READ-ONLY]              14:06 · task f44c19d0 │  ← green left edge
│ Read ~/finance/q3-pricing-sheet.xlsx                      │
│ Scope: read-only · this file only · expires after task.   │
│ [ Approve ]  [ Deny ]                                     │
├───────────────────────────────────────────────────────────┤
│ ● PENDING  [SPEND]                                        │  ← amber left edge
│ Spend $0.40 over per-task cap…  estimate $0.90 vs cap $0.50│
├───────────────────────────────────────────────────────────┤
│ ● PENDING  [DESTRUCTIVE]                                  │  ← red left edge
│ Delete 147 cached render files in ~/projects/landing/dist │
│ ▸ 147 files permanently removed                           │
│ ▸ dist/ is gitignored — not covered by snapshot           │
│ type [DELETE] to arm: [______] [Execute(disabled)] [Deny] │
└───────────────────────────────────────────────────────────┘
```

- Card: `--panel`, 1px `--border`, 8px radius, **3px left edge** colored by tier: read-only `--good`, spend `--torque`, destructive `--bad`.
- Tier tag pill beside the PENDING pill, matching tier color at 12–14% bg.
- Pending pill: 9px 700 uppercase pill, `--torque`, dot pulses.
- Destructive: risk list (10.5px `--faint`, `▸` markers in `--bad`), type-to-confirm input (130px, red-40% border, red caret); Execute button disabled at 35% opacity until exact match, then full `--bad` fill. Card states whether a checkpoint covers the action — and if the kernel exposes no checkpoint facility, the text says so plainly (e.g. `kernel exposes none`).
- Decision flips pill to `✓ approved` (`--good`) or `✕ denied` (`--bad`), re-colors the left edge, removes action buttons, decrements the sidebar badge live.
- Empty history state: dashed `--border-strong` box, centered — icon, `No approval history yet` (12px `--muted`), one-line explainer (10.5px `--faint`, max 44ch). Never a blank wall.
- Keep the existing `last refresh` footer pattern; extend it to CostPanel and ReceiptsPanel per PRD-core item 5.

---

## 8. Memory view

Two-column grid (gap 12px) of episode cards: `--panel`, `--border`, 8px radius, hover border → `--mem` 40%. Card content: episode tag (9px 700 .18em `--mem` uppercase), relevance weight right-aligned (9.5px `--faint` tabular-nums), body in **Inter** 12.5px/1.65 `--muted`.

---

## 9. Acceptance checklist (verify in order; each maps to a commit)

| # | Check | Pass condition |
|---|-------|----------------|
| 1 | Epoch elapsed | Start task, wait 10s, remount/reconnect UI → elapsed continues from wall clock, never resets to 0:00 |
| 2 | Liveness chip | Visible on all views while running; click scrolls to task; 30s silence → stuck state EXCEPT when awaiting approval |
| 3 | Task cards | Stream renders as cards; plumbing collapsed by default; answer visually dominant (Inter, larger, amber edge); one timestamp per task |
| 4 | Color audit | No red anywhere except errors/destructive. Brand = `--torque`. Route chips cyan/green |
| 5 | Pre-flight + cost | Estimate chip appears while typing (real sizing pass or `~N tokens`, never fake dollars); working panel matches the same estimate; header meter moves with real spend |
| 6 | Sync state | `synced M:SS` + refresh on budget meter; stale >30s → amber pulse; stale badge replaces CONNECTED on disconnect |
| 7 | Approvals | Three tiers with correct edge colors; destructive requires typing DELETE; decisions update badge live |
| 8 | Attachments | Flag-gated if no upload pipeline; chips with type tiles/thumbnails; cloud-only warning; files echo into task card |
| 9 | Fonts/texture | JetBrains Mono chrome + Inter answers only; scanline overlay present; no icon fonts/emoji |
| 10 | Honesty | No dead buttons, no fake tickers, no invented IDs; every gap named in its commit message |

## 10. Process

- One commit per §4–§8 item, plus a tokens-first commit (§0). Run the console and verify the matching checklist row before moving on.
- Do not modify `packages/contracts`, gateway, or kernel. If a check cannot pass without backend data, flag-gate the UI, note the gap in the commit, and continue.
- Reference `docs/ui-concept.html` for spacing, motion timing, and micro-interactions not enumerated here.
