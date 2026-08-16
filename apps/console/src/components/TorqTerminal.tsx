'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GatewayEvent, ClientCommand, RouterDiagnostics } from '@torqclaw/contracts';
import { useGatewayStream } from './useGatewayStream';
import { friendlyMessage, tierLabel, TYPE_LABELS, privacyHint, lineDiff, canRenderAction, formatLockState, formatRouteExplanation, formatBlockedAlternatives, formatProfile, selectActiveRouteDiag, selectLatestRoutePreview, isBusyNeutralEvent, isPanelSystemFrame, formatGateFacts, selectSafeExportViewByTaskId, renderSafeExportMarkdown, groupStreamIntoTasks, derivePreflightEstimate, approvalTierFromGate, attachmentKind, type SafeExportFrameLike, type TaskGroup, type PreflightEstimate, type AttachmentKind } from './friendly';
import { selectTurnStartMs, selectLastSyncedMs, isStale, selectCostSummaryMeta, selectLivePhase, isPhaseStuck, STALE_AFTER_MS } from './presence';
import { LiveDuration, formatElapsed } from './LiveDuration';
import { LivenessChip } from './LivenessChip';
import PresenceCard from './PresenceCard';
import ReceiptsPanel from './ReceiptsPanel';
import CostPanel from './CostPanel';
import ApprovalHistoryPanel from './ApprovalHistoryPanel';

// TCLAW-5B-2 [G1R RC-5 proof, commit 2]: the terminal "copy safe export" chip
// requires that an ERROR event's requestId equals the taskId GET_SAFE_EXPORT
// looks up (getReceipt(taskId) -> run_receipts.task_id). Verified read-only
// from packages/gateway/src/{events,dispatch,receipts}.ts:
//   1. dispatch.ts's `emit` is `makeEmitter(req.sessionId, req.id, diag.tier)`
//      (dispatch.ts:169), used for every ERROR emission on this task's path.
//   2. events.ts:84-91 `makeEmitter(sessionId, requestId, tier)` returns an
//      emitter that stamps `requestId` (== req.id) directly onto EVERY
//      published GatewayEvent, including ERROR — so an ERROR event's
//      `.requestId` field IS `req.id`.
//   3. dispatch.ts:185 `taskStore.create(effectiveReq, diag)` runs before
//      execution; events.ts:97-101 `taskStore.create` does
//      `INSERT INTO tasks (request_id, ...) VALUES (req.id, ...)` — so
//      `tasks.request_id === req.id`.
//   4. receipts.ts:380-382 (the stale-task backfill query) joins
//      `run_receipts r ON r.task_id = t.request_id` — i.e. `run_receipts.
//      task_id` IS PROJECTED FROM `tasks.request_id`, never a different id.
//   5. receipts.ts:468/474 `getReceipt(taskId)` is
//      `SELECT * FROM run_receipts WHERE task_id = ?` — the same column.
// Chain: ERROR.requestId === req.id === tasks.request_id === run_receipts.
// task_id === what getReceipt(taskId)/GET_SAFE_EXPORT key on. PROVEN — the
// chip ships.

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'ws://localhost:18790/ws';
const GATEWAY_TOKEN = process.env.NEXT_PUBLIC_GATEWAY_TOKEN ?? '';

// Redesign 7/7: composer attachments are feature-flagged. KERNEL GAP: the
// wire carries attachmentIds on SUBMIT_PROMPT, but the gateway exposes NO
// upload command and NO storage (gatewayClient hardcodes attachmentIds: []),
// so with the flag ON the composer collects files, warns on the cloud route,
// and GATES submission — it never sends fake ids and never silently submits
// without the files the operator attached. Flag OFF (default): no paperclip,
// zero behavior change.
const ATTACHMENTS_ENABLED = process.env.NEXT_PUBLIC_ATTACHMENTS === '1';

type ExecutionMode = 'AUTO' | 'LOCAL_ONLY' | 'CLOUD_OK';
// '' = no budget (falls to env default). 'free' = local-only, $0.
type BudgetChoice = '' | 'free' | '0.25' | '1' | '5' | 'custom';

const CONTROLS_KEY = 'torqclaw.controls';

interface Controls {
  budget: BudgetChoice;
  customBudget: string;
  mode: ExecutionMode;
  fast: boolean;
  privateMode: boolean;
  useMemory: boolean;
}

const DEFAULT_CONTROLS: Controls = {
  budget: '', customBudget: '', mode: 'AUTO', fast: false, privateMode: false, useMemory: true,
};

function loadControls(): Controls {
  if (typeof window === 'undefined') return DEFAULT_CONTROLS;
  try {
    const raw = sessionStorage.getItem(CONTROLS_KEY);
    return raw ? { ...DEFAULT_CONTROLS, ...JSON.parse(raw) } : DEFAULT_CONTROLS;
  } catch {
    return DEFAULT_CONTROLS;
  }
}

/** Redesign 7/7: a composer attachment awaiting a kernel upload pipeline.
 *  `id` is a LOCAL identity only — it is never sent as an attachmentId. */
interface PendingAttachment {
  id: string;
  file: File;
  kind: AttachmentKind;
  previewUrl: string | null;
}

/** TCLAW-2D-2: the judgment fields shared verbatim by SUBMIT_PROMPT and
 *  PREVIEW_ROUTE (field-parity per commands.ts — preview and submit must
 *  never drift). */
function buildJudgment(prompt: string, c: Controls): {
  prompt: string; sensitive: boolean; urgent: boolean;
  executionMode: ExecutionMode; useMemory: boolean;
  maxCostUsd?: number;
} {
  // "Free (local only)" forces LOCAL_ONLY; otherwise mode is the user's pick.
  const mode: ExecutionMode = c.budget === 'free' ? 'LOCAL_ONLY' : c.mode;
  let maxCostUsd: number | undefined;
  if (c.budget === 'custom') {
    const n = Number(c.customBudget);
    if (Number.isFinite(n) && n > 0) maxCostUsd = n;
  } else if (c.budget !== '' && c.budget !== 'free') {
    maxCostUsd = Number(c.budget);
  }
  return {
    prompt,
    sensitive: c.privateMode,
    urgent: c.fast,
    executionMode: mode,
    useMemory: c.useMemory,
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
  };
}

/** Translate the budget/mode controls into the SUBMIT_PROMPT fields. */
function buildSubmit(prompt: string, c: Controls): Extract<ClientCommand, { action: 'SUBMIT_PROMPT' }> {
  return { action: 'SUBMIT_PROMPT', ...buildJudgment(prompt, c), attachmentIds: [] };
}

export default function TorqTerminal() {
  const { events, isConnected, sendCommand, reconnect } = useGatewayStream(GATEWAY_URL, GATEWAY_TOKEN);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const [debouncedInput, setDebouncedInput] = useState('');
  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS);
  const [hintDismissed, setHintDismissed] = useState(false);
  const [decided, setDecided] = useState<Record<string, 'APPROVE' | 'REJECT'>>({});
  // TCLAW-4B-2: console receipt panel — overlay over the live scroll region.
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  // TCLAW-1B: Cost Control Center panel — same overlay pattern, read-only.
  const [costOpen, setCostOpen] = useState(false);
  // TCLAW-5A-2: approval history panel — third independent overlay sibling,
  // same pattern. No mutual-exclusion with receipts/cost (G1R SC-3): all
  // three may be open simultaneously, no coordination logic between them.
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  // Stop-button UX: 'requested' once a cancel is sent (button shows "stopping…"),
  // 'failed' if the send was dropped so the user knows to retry. Cleared when the
  // next task starts.
  const [stopState, setStopState] = useState<'idle' | 'requested' | 'failed'>('idle');
  // Redesign 7/7: composer attachments (flag-gated; see ATTACHMENTS_ENABLED).
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentGateNote, setAttachmentGateNote] = useState(false);

  // TCLAW-2D-2: route preview. previewNonce = latest-SENT nonce (the ONLY
  // staleness key). previewState is the RENDER SOURCE (useState snapshot,
  // write-on-present — ring-eviction safe, mirrors the 2C chip discipline).
  const [previewNonce, setPreviewNonce] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<
    | { kind: 'pending' } | { kind: 'result'; meta: Record<string, any> }
    | { kind: 'dropped' } | { kind: 'timeout' } | { kind: 'sendFailed' } | null
  >(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // P4: full skill-draft markdown fetched via GET_SKILL_DRAFT, keyed by queueId.
  const draftsByQueue = useMemo(() => {
    const m: Record<string, string> = {};
    for (const ev of events) {
      const md = (ev.metadata as any)?.skillMarkdown;
      const qid = (ev.metadata as any)?.queueId;
      if ((ev.metadata as any)?.skillDraft && qid && typeof md === 'string') m[qid] = md;
    }
    return m;
  }, [events]);
  const getDraft = (queueId: string) => sendCommand({ action: 'GET_SKILL_DRAFT', queueId });

  // Load persisted controls after mount (sessionStorage is client-only).
  useEffect(() => { setControls(loadControls()); }, []);
  useEffect(() => {
    try { sessionStorage.setItem(CONTROLS_KEY, JSON.stringify(controls)); } catch { /* quota */ }
  }, [controls]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [events]);

  // Track the active request id from the last TIER_SELECTED so cancel/resend
  // can target it. Reset on a terminal event.
  const activeRequestId = useMemo(() => {
    let id: string | null = null;
    for (const ev of events) {
      if (ev.type === 'TIER_SELECTED' && ev.requestId) id = ev.requestId;
      if ((ev.type === 'RESULT' || ev.type === 'ERROR') && ev.requestId === id) id = null;
    }
    return id;
  }, [events]);

  // TCLAW-2C: the live route diag for the CURRENT task, snapshotted by
  // requestId so it survives ring eviction of its own TIER_SELECTED frame
  // during a long task. selectActiveRouteDiag is the pure selection; the
  // useState snapshot is the RENDER SOURCE (never the selector over events).
  const liveRouteDiag = useMemo(
    () => selectActiveRouteDiag(events, activeRequestId),
    [events, activeRequestId],
  );
  const [routeSnapshot, setRouteSnapshot] = useState<Record<string, RouterDiagnostics>>({});
  useEffect(() => {
    // WRITE-ON-PRESENT (mirror ReceiptsPanel :129): only write when we have a
    // diag for the current anchor; NEVER clear on absent (so an evicted frame
    // doesn't blank a still-in-flight task). Keyed by requestId so a new task
    // never clobbers the current slot.
    if (activeRequestId && liveRouteDiag) {
      setRouteSnapshot((prev) => (prev[activeRequestId] ? prev : { ...prev, [activeRequestId]: liveRouteDiag }));
    }
  }, [activeRequestId, liveRouteDiag]);

  // TCLAW-2C: render the chip ONLY from the snapshot indexed by the CURRENT
  // live anchor. activeRequestId==null -> no chip (task terminal / none). This
  // is the invariant that prevents a stale route resurfacing for a different
  // task: never read a remembered id, never read busy, never read the selector
  // output directly.
  const chipDiag: RouterDiagnostics | null = activeRequestId ? (routeSnapshot[activeRequestId] ?? null) : null;

  // TCLAW-UIFIX-1 (generalizing 2D-2's RC-1): ALL SYSTEM frames are
  // busy-neutral — busy-truth rides on non-SYSTEM task events only (see
  // isBusyNeutralEvent's invariant in friendly.ts). Compute busy over the
  // last non-SYSTEM event: mid-task that is a non-terminal (TOOL_CALL/
  // TIER_SELECTED/ROUTING → busy stays true); at idle it is RESULT/ERROR/
  // CONNECTED/PENDING_APPROVAL (→ false). If nothing remains (a window of
  // only SYSTEM frames), busy is false. This fixes the spurious working/stop
  // state after every completed task (the SYSTEM 'Done' receipt frame is the
  // last event of every completion), after receipts/cost/memory use, and for
  // the markerless skill/approval confirmation frames.
  const busy = useMemo(() => {
    let last: GatewayEvent | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!e) continue;
      if (isBusyNeutralEvent(e)) continue;
      last = e;
      break;
    }
    return !!last && !['RESULT', 'ERROR', 'CONNECTED', 'PENDING_APPROVAL'].includes(last.type);
  }, [events]);

  // Live-turn liveness anchor: real task start read from event timestamps, so
  // a mid-task remount never resets the elapsed clock (see LiveDuration). The
  // anchor is a property of the task, not of this component's mount.
  const turnStartMs = useMemo(
    () => selectTurnStartMs(events, activeRequestId),
    [events, activeRequestId],
  );

  // Global liveness chip (redesign 2/7): phase text from the freshest kernel
  // event of the active task. Gated on activeRequestId (NOT busy) — a task
  // paused for approval is still in flight and the chip must say so, exactly
  // like the route chip's gating invariant below.
  const livePhase = useMemo(
    () => selectLivePhase(events, activeRequestId),
    [events, activeRequestId],
  );

  // Staleness: the newest event's timestamp vs now. The console is push-based,
  // so there is nothing to refetch — this is derived state from data already
  // in memory. `stale` is only surfaced as a warning while a task should be
  // producing events (`busy`) or the socket is down; an idle healthy console
  // is not "out of date".
  const lastSyncedMs = useMemo(() => selectLastSyncedMs(events), [events]);
  const nowMs = useNow(5000);
  const stale = isStale(lastSyncedMs, nowMs, STALE_AFTER_MS);
  // Chip stuck-state: the active task's own stream quiet for 30s+. Never fires
  // while the task waits on the operator (see isPhaseStuck).
  const phaseStuck = isPhaseStuck(livePhase, nowMs);

  // Presence meta for the current task: budget remaining from the live
  // costSummary frame (display-only — never fetches, never writes a cap).
  const budgetRemaining = useMemo(() => {
    const meta = selectCostSummaryMeta(events);
    const r = meta ? meta.sessionRemaining : null;
    return typeof r === 'number' ? (r as number) : null;
  }, [events]);

  // P2.5: friendly tool names actually executed, per request — reconstructed
  // from TOOL_CALL events so the receipt's toolsUsed is from real activity.
  const toolsByRequest = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const ev of events) {
      if (ev.type !== 'TOOL_CALL' || !ev.requestId) continue;
      const m = ev.message.match(/Executing (?:\w+__)?(.+)$/);
      const name = (m?.[1] ?? ev.message).replace(/_/g, ' ');
      (map[ev.requestId] ??= []).push(name);
    }
    return map;
  }, [events]);

  // Redesign 3/7: the raw log stream grouped into per-task cards. Pure
  // selector (friendly.ts) — events with a requestId join their task's card;
  // session-level frames stay loose and render exactly as before.
  const streamItems = useMemo(() => groupStreamIntoTasks(events), [events]);

  // Privacy SUGGESTION (suggest-only — never sets the flag, never blocks).
  // Debounced 500ms so the regex pass never runs on the keystroke hot path,
  // keeping typing smooth even at the 32K-char prompt ceiling.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedInput(input), 500);
    return () => clearTimeout(t);
  }, [input]);
  const hint = useMemo(
    () => (controls.privateMode ? null : privacyHint(debouncedInput)),
    [debouncedInput, controls.privateMode],
  );
  useEffect(() => { setHintDismissed(false); }, [debouncedInput]);

  // Redesign 7/7: attachment handlers. Files never leave the browser until
  // the kernel ships an upload pipeline — addFiles collects, removeAttachment
  // releases, submit GATES (never fake ids, never silent drop).
  const addFiles = (list: FileList | null) => {
    if (!ATTACHMENTS_ENABLED || !list || list.length === 0) return;
    const canPreview = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
    const added: PendingAttachment[] = Array.from(list).map((file) => {
      const kind = attachmentKind(file.name, file.type);
      return {
        id: crypto.randomUUID(),
        file,
        kind,
        previewUrl: kind === 'image' && canPreview ? URL.createObjectURL(file) : null,
      };
    });
    setAttachments((prev) => [...prev, ...added]);
    setAttachmentGateNote(false);
  };
  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
    setAttachmentGateNote(false);
  };
  // Revoke any live object URLs on unmount (ref keeps the latest list).
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => () => {
    for (const a of attachmentsRef.current) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt) return;
    if (ATTACHMENTS_ENABLED && attachments.length > 0) {
      // KERNEL GAP: no upload command exists — never send fake attachmentIds,
      // and never silently submit without the files the operator attached.
      setAttachmentGateNote(true);
      return;
    }
    sendCommand(buildSubmit(prompt, controls));
    setInput('');
    setStopState('idle'); // a fresh run clears any prior stop feedback
  };

  const resendLocal = (prompt: string) => {
    sendCommand(buildSubmit(prompt, { ...controls, mode: 'LOCAL_ONLY', budget: controls.budget === '' ? 'free' : controls.budget }));
  };

  // Slow local hardware fallback: resend forcing the cloud tier.
  const resendCloud = (prompt: string) => {
    sendCommand(buildSubmit(prompt, { ...controls, mode: 'CLOUD_OK', budget: controls.budget === 'free' ? '' : controls.budget }));
  };

  // P3.5: plain retry resubmits the same prompt with current controls; a
  // suggested budget (after a breach) raises the budget for the retry.
  const retry = (prompt: string, suggestedBudget?: number) => {
    if (typeof suggestedBudget === 'number') {
      sendCommand(buildSubmit(prompt, { ...controls, budget: 'custom', customBudget: String(suggestedBudget) }));
    } else {
      sendCommand(buildSubmit(prompt, controls));
    }
  };

  // P3.5: copy a paste-ready diagnostic — requestId, reason, last 10 messages.
  const copyDiagnostic = (errEvent: GatewayEvent) => {
    const recent = events.slice(-10).map((e) => `[${e.type}] ${e.message}`);
    const block = [
      `requestId: ${errEvent.requestId ?? '(none)'}`,
      `reason: ${errEvent.message}`,
      '--- last 10 events ---',
      ...recent,
    ].join('\n');
    navigator.clipboard?.writeText(block).catch(() => {});
  };

  // TCLAW-5B-2: terminal "copy safe export" chip — two-click fetch-then-copy
  // per-taskId state map (design §4.2). Uses the SAME shared
  // selectSafeExportViewByTaskId selector as ReceiptsPanel — sound across
  // surfaces because every GET_SAFE_EXPORT request for a taskId is
  // parameter-identical (see friendly.ts's selector doc comment).
  type SafeExportChipPhase = 'initial' | 'pending' | 'ready' | 'sendFailed' | 'timeout';
  const safeExportViewByTaskId = useMemo(() => selectSafeExportViewByTaskId(events), [events]);
  const [safeExportChipPhase, setSafeExportChipPhase] = useState<Record<string, SafeExportChipPhase>>({});
  const [safeExportChipCopied, setSafeExportChipCopied] = useState<Record<string, boolean>>({});
  const safeExportChipTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const safeExportChipCopiedTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    // Any snapshot landing for a taskId resolves that chip's phase to
    // 'ready' and clears its pending timer (2D-2 rule: frame arrival clears
    // the timer).
    for (const taskId of Object.keys(safeExportViewByTaskId)) {
      if (safeExportChipTimers.current[taskId]) {
        clearTimeout(safeExportChipTimers.current[taskId]);
        delete safeExportChipTimers.current[taskId];
      }
    }
    if (Object.keys(safeExportViewByTaskId).length > 0) {
      setSafeExportChipPhase((prev) => {
        const next = { ...prev };
        for (const taskId of Object.keys(safeExportViewByTaskId)) {
          if (next[taskId] === 'pending' || next[taskId] === undefined) next[taskId] = 'ready';
        }
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeExportViewByTaskId]);

  // Clear all timers on unmount.
  useEffect(() => {
    return () => {
      for (const t of Object.values(safeExportChipTimers.current)) clearTimeout(t);
      for (const t of Object.values(safeExportChipCopiedTimers.current)) clearTimeout(t);
    };
  }, []);

  const requestSafeExportChip = (taskId: string) => {
    if (safeExportChipTimers.current[taskId]) {
      clearTimeout(safeExportChipTimers.current[taskId]);
      delete safeExportChipTimers.current[taskId];
    }
    const sent = sendCommand({ action: 'GET_SAFE_EXPORT', taskId });
    if (!sent) {
      setSafeExportChipPhase((prev) => ({ ...prev, [taskId]: 'sendFailed' })); // 2D-2 rule: never arms the timer
      return;
    }
    setSafeExportChipPhase((prev) => ({ ...prev, [taskId]: 'pending' }));
    safeExportChipTimers.current[taskId] = setTimeout(() => {
      setSafeExportChipPhase((prev) => (prev[taskId] === 'pending' ? { ...prev, [taskId]: 'timeout' } : prev));
    }, 5000);
  };

  // Click #2: synchronous writeText of the ALREADY-SNAPSHOTTED Markdown —
  // never re-fetched, never re-assembled (cardinal rule).
  const copySafeExportChip = (taskId: string) => {
    const frame = safeExportViewByTaskId[taskId];
    if (!frame?.safeExport) return;
    const text = renderSafeExportMarkdown(frame.safeExport);
    const p = navigator.clipboard?.writeText(text);
    if (!p) return; // clipboard API absent — honest no-op, no fabricated flash
    p.then(() => {
      if (safeExportChipCopiedTimers.current[taskId]) clearTimeout(safeExportChipCopiedTimers.current[taskId]);
      setSafeExportChipCopied((prev) => ({ ...prev, [taskId]: true }));
      safeExportChipCopiedTimers.current[taskId] = setTimeout(() => {
        setSafeExportChipCopied((prev) => ({ ...prev, [taskId]: false }));
      }, 2000);
    }).catch(() => {});
  };

  const stop = () => {
    if (!activeRequestId) {
      // No tracked task to cancel — the run is between requests or already
      // finishing. Surface it rather than appear to do nothing.
      setStopState('failed');
      return;
    }
    const sent = sendCommand({ action: 'CANCEL_TASK', taskId: activeRequestId });
    setStopState(sent ? 'requested' : 'failed');
  };

  // P4: approve a skill, optionally with edited markdown.
  const decideSkill = (queueId: string, decision: 'APPROVE' | 'REJECT', editedMarkdown?: string) => {
    sendCommand(
      editedMarkdown !== undefined && decision === 'APPROVE'
        ? { action: 'APPROVE_SKILL', queueId, decision, editedMarkdown }
        : { action: 'APPROVE_SKILL', queueId, decision },
    );
    setDecided((d) => ({ ...d, [queueId]: decision }));
  };

  const decideTool = (approvalId: string, decision: 'APPROVE' | 'REJECT') => {
    sendCommand({ action: 'APPROVE_TOOL', approvalId, decision });
    setDecided((d) => ({ ...d, [approvalId]: decision }));
  };

  const set = <K extends keyof Controls>(k: K, v: Controls[K]) =>
    setControls((c) => ({ ...c, [k]: v }));

  // TCLAW-2D-2: snapshot the latest matching preview frame (write-on-present
  // — mirrors the 2C chip discipline). Clears the timeout timer once a real
  // frame lands (result or dropped), whichever comes first.
  const latestPreview = useMemo(
    () => selectLatestRoutePreview(events, previewNonce),
    [events, previewNonce],
  );
  useEffect(() => {
    if (!latestPreview) return;
    const meta = (latestPreview.metadata ?? {}) as Record<string, any>;
    if (previewTimer.current) { clearTimeout(previewTimer.current); previewTimer.current = null; }
    setPreviewState(meta.dropped ? { kind: 'dropped' } : { kind: 'result', meta });
  }, [latestPreview]);

  // Clear the timeout timer on unmount.
  useEffect(() => {
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, []);

  // TCLAW-2D-2 staleness clear (G1R S3): a preview result describes a SPECIFIC
  // draft + control set at the moment "simulate route" was clicked. If the
  // input or any control changes afterward, the shown preview no longer
  // describes what would be submitted — clear it rather than let it go stale.
  // Guarded by comparing against the PREVIOUS render's actual values (not a
  // run counter) so it never fires on mount, and never fires spuriously when
  // the post-mount sessionStorage controls load happens to produce a new
  // object reference with the SAME field values (JSON-compares equal).
  const prevStaleInputs = useRef<{ input: string; controls: string } | null>(null);
  useEffect(() => {
    const snapshot = { input, controls: JSON.stringify(controls) };
    const prev = prevStaleInputs.current;
    prevStaleInputs.current = snapshot;
    if (prev === null) return; // first run ever — nothing to compare, never clears
    if (prev.input === snapshot.input && prev.controls === snapshot.controls) return; // no real change
    if (previewTimer.current) { clearTimeout(previewTimer.current); previewTimer.current = null; }
    setPreviewState(null);
    setPreviewNonce(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, controls]);

  // Redesign 4/7: pre-flight estimate chip — the kernel's REAL sizing pass
  // (PREVIEW_ROUTE: real enrichment + real router evaluation, no dispatch).
  // Rides its OWN nonce channel, separate from the manual simulate-route
  // panel: each reads only frames matching its own nonce, so the two surfaces
  // never clobber each other.
  const [estimateNonce, setEstimateNonce] = useState<string | null>(null);
  // A changing draft invalidates the last estimate immediately — never show a
  // number sized for text that is no longer in the box.
  useEffect(() => { setEstimateNonce(null); }, [input]);
  useEffect(() => {
    const prompt = debouncedInput.trim();
    if (!prompt) { setEstimateNonce(null); return; }
    const nonce = crypto.randomUUID(); // fresh per settled draft
    const sent = sendCommand({ action: 'PREVIEW_ROUTE', previewOf: nonce, ...buildJudgment(prompt, controls) });
    if (sent) setEstimateNonce(nonce); // a dropped send never arms a lookup
  }, [debouncedInput, controls, sendCommand]);
  const estimateFrame = useMemo(
    () => selectLatestRoutePreview(events, estimateNonce),
    [events, estimateNonce],
  );
  const estimate = useMemo(() => derivePreflightEstimate(estimateFrame), [estimateFrame]);

  // Redesign 4/7: the working card's est-cap line must read the SAME number
  // the composer chip showed — snapshotted per request while the task is in
  // flight (write-on-present, never cleared on absent; mirrors the route-chip
  // snapshot discipline), never recomputed into a different figure that could
  // exceed its own cap.
  const [estimateByRequest, setEstimateByRequest] = useState<Record<string, PreflightEstimate>>({});
  useEffect(() => {
    if (activeRequestId && estimate) {
      setEstimateByRequest((prev) => (prev[activeRequestId] ? prev : { ...prev, [activeRequestId]: estimate }));
    }
  }, [activeRequestId, estimate]);
  const activeEstimate: PreflightEstimate | null = activeRequestId
    ? (estimateByRequest[activeRequestId] ?? estimate)
    : null;

  // Redesign 4/7: session budget meter + working-card spend readout. Events
  // are push-based, but cost totals are pull-based (GET_COST_SUMMARY) — poll
  // every 5s WHILE A TASK IS IN FLIGHT, so the meter climbs with REAL
  // recorded spend and the header and per-task panel read one frame source
  // (selectCostSummaryMeta) — they can never contradict each other. Idle
  // console, no poll: no new spend can land while idle, so an empty meter is
  // the honest read (it also fills whenever the cost panel's own mount fetch
  // lands a frame). Deliberately NO mount-time fetch — keeps the console's
  // dispatch surface event-driven.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => sendCommand({ action: 'GET_COST_SUMMARY', recentLimit: 20 }), 5000);
    return () => clearInterval(t);
  }, [busy, sendCommand]);
  const costMeta = useMemo(
    () => selectCostSummaryMeta(events) as Record<string, any> | null,
    [events],
  );
  // Redesign 6/7: budget context for the spend tier's approval cards — real
  // costSummary facts only (null when no frame has landed, never a guess).
  const budgetLine = useMemo(() => {
    if (!costMeta) return null;
    const remaining = typeof costMeta.sessionRemaining === 'number' ? costMeta.sessionRemaining : null;
    const cap = typeof costMeta.sessionCap === 'number' ? costMeta.sessionCap : null;
    if (remaining === null) return null;
    return cap !== null
      ? `$${remaining.toFixed(2)} remaining of $${cap.toFixed(2)} session cap`
      : `$${remaining.toFixed(2)} session budget remaining (no cap)`;
  }, [costMeta]);

  const simulateRoute = () => {
    const prompt = input.trim();
    if (!prompt) return; // belt-and-braces with the disabled attr
    const nonce = crypto.randomUUID(); // fresh PER CLICK — edit-back-race safety
    const sent = sendCommand({ action: 'PREVIEW_ROUTE', ...buildJudgment(prompt, controls), previewOf: nonce });
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (!sent) { setPreviewNonce(nonce); setPreviewState({ kind: 'sendFailed' }); return; } // never arms the timer
    setPreviewNonce(nonce);
    setPreviewState({ kind: 'pending' });
    previewTimer.current = setTimeout(
      () => setPreviewState((s) => (s?.kind === 'pending' ? { kind: 'timeout' } : s)),
      5000,
    );
  };

  const sessionTotal = costMeta && typeof costMeta.sessionTotal === 'number' ? costMeta.sessionTotal : null;
  const sessionCap = costMeta && typeof costMeta.sessionCap === 'number' ? costMeta.sessionCap : null;
  const budgetPct =
    sessionTotal !== null && sessionCap !== null && sessionCap > 0
      ? `${Math.min(100, (sessionTotal / sessionCap) * 100)}%`
      : '0%';

  return (
    <section className="flex h-screen flex-col bg-bg font-mono text-sm text-neutral-300">
      {/* PRD-UI-1 §2 header: 52px, --panel, bottom hairline. */}
      <header className="flex h-[52px] shrink-0 items-center gap-3.5 border-b border-edge bg-panel px-3.5">
        <div className="flex items-center gap-2.5">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 3 L20 7.5 V16.5 L12 21 L4 16.5 V7.5 Z" stroke="#FF9E40" strokeWidth="1.4" />
            <path d="M12 8 L12 13 M12 13 L8.5 15.5 M12 13 L15.5 15.5" stroke="#FF9E40" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="12" cy="7" r="1.4" fill="#FF9E40" />
          </svg>
          <span className="text-[14px] font-bold tracking-[0.18em] text-ink">
            TORQ<span className="text-torque">CLAW</span>
          </span>
        </div>
        {/* PRD §2: fresh + connected -> CONNECTED (good, pulsing dot). Stale
            >30s OR disconnected -> the 'stale · reconnecting…' badge REPLACES
            the element entirely. The badge stays actionable (click forces a
            reconnect) so the dead-WS affordance survives the restyle. */}
        {isConnected && !stale ? (
          <span className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.16em] text-good">
            <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-good" aria-hidden />
            CONNECTED
          </span>
        ) : (
          <button
            type="button"
            onClick={reconnect}
            title="force reconnect"
            className="flex items-center gap-2 rounded border border-torque/40 bg-torque/10 px-2 py-0.5 text-[10px] font-semibold tracking-[0.16em] text-torque"
          >
            <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-torque" aria-hidden />
            stale · reconnecting…
          </button>
        )}
        {/* Global liveness chip (redesign 2/7, polish in PRD §5): visible on
            EVERY view while a task is in flight. Reads the SAME turnStartMs
            anchor as the in-stream presence block. */}
        {livePhase && activeRequestId && (
          <LivenessChip
            phase={livePhase.text}
            stuck={phaseStuck}
            turnStartMs={turnStartMs}
            turnId={activeRequestId}
            onScrollToTask={() =>
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
            }
          />
        )}
        <div className="ml-auto flex items-center gap-3">
          {/* PRD §2 session budget meter: sync dot (amber pulse when stale),
              SESSION BUDGET micro-label, 110x4 gradient meter, $X.XX / $Y.YY,
              refresh, synced M:SS. Climbs with REAL costSummary frames only;
              absent frame renders '—', never a fabricated $0. */}
          <span className="flex items-center gap-2 whitespace-nowrap text-[10px] tabular-nums">
            <span
              className={`h-[5px] w-[5px] rounded-full ${stale ? 'animate-pulse bg-torque' : 'bg-good'}`}
              aria-hidden
            />
            <span className="text-[9px] uppercase tracking-[0.1em] text-faint">Session budget</span>
            <span className="h-1 w-[110px] overflow-hidden rounded-sm bg-panel-3">
              <span
                className="block h-full rounded-sm"
                style={{ width: budgetPct, background: 'linear-gradient(90deg, var(--torque), #FFC38A)' }}
              />
            </span>
            <span className="text-[11px] text-muted">
              {sessionTotal !== null ? (
                <>
                  <b className="font-semibold text-ink">${sessionTotal.toFixed(2)}</b>
                  {sessionCap !== null ? ` / $${sessionCap.toFixed(2)}` : ''}
                </>
              ) : (
                '—'
              )}
            </span>
            <button
              type="button"
              onClick={() => sendCommand({ action: 'GET_COST_SUMMARY', recentLimit: 20 })}
              title="refresh from runtime"
              className="rounded p-0.5 text-faint transition-colors hover:bg-torque/10 hover:text-torque"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5" />
              </svg>
            </button>
            <span className="text-[8.5px] tracking-[0.06em] text-[#4A505A]">
              {lastSyncedMs !== null
                ? `synced ${formatElapsed(Math.max(0, Math.round((nowMs - lastSyncedMs) / 1000)))}`
                : 'synced —'}
            </span>
          </span>
          {/* KERNEL GAP (PRD §2): the 'hermes kernel · vX' tag is OMITTED — no
              kernel version rides the WS wire, and reading a config file would
              be a lie. Add when the handshake carries it. */}
        </div>
      </header>

      <div className="relative flex-1 overflow-hidden">
      <div ref={scrollRef} className="h-full space-y-1 overflow-y-auto px-4 pr-2 pt-4" aria-live="polite">
        {events.length === 0 && (
          <p className="pt-8 text-center text-neutral-600">
            Nothing yet. Type what you need below — simple tasks run free on this
            machine, complex ones go to a cloud model automatically. Set a budget
            or keep a task local with the controls under the box.
          </p>
        )}
        {streamItems.map((item) => {
          if (item.kind === 'loose') {
            const ev = item.event;
            return (
              <EventRow
                key={ev.id}
                event={ev}
                decided={decided}
                toolsByRequest={toolsByRequest}
                draftsByQueue={draftsByQueue}
                onDecideSkill={decideSkill}
                onGetDraft={getDraft}
                onDecideTool={decideTool}
                onResendLocal={resendLocal}
                onResendCloud={resendCloud}
                onRetry={retry}
                onCopyDiagnostic={copyDiagnostic}
                safeExportFrame={ev.requestId ? (safeExportViewByTaskId[ev.requestId] ?? null) : null}
                safeExportChipPhase={ev.requestId ? (safeExportChipPhase[ev.requestId] ?? 'initial') : 'initial'}
                safeExportChipCopied={ev.requestId ? !!safeExportChipCopied[ev.requestId] : false}
                onGetSafeExportChip={requestSafeExportChip}
                onCopySafeExportChip={copySafeExportChip}
                budgetLine={budgetLine}
              />
            );
          }
          return (
            <TaskCard
              key={item.group.requestId}
              group={item.group}
              decided={decided}
              toolsByRequest={toolsByRequest}
              draftsByQueue={draftsByQueue}
              onDecideSkill={decideSkill}
              onGetDraft={getDraft}
              onDecideTool={decideTool}
              onResendLocal={resendLocal}
              onResendCloud={resendCloud}
              onRetry={retry}
              onCopyDiagnostic={copyDiagnostic}
              safeExportViewByTaskId={safeExportViewByTaskId}
              safeExportChipPhase={safeExportChipPhase}
              safeExportChipCopied={safeExportChipCopied}
              onGetSafeExportChip={requestSafeExportChip}
              onCopySafeExportChip={copySafeExportChip}
              budgetLine={budgetLine}
            />
          );
        })}
        {busy && (
          <>
          <p className="flex items-center gap-3 px-2 py-1 text-neutral-500">
            <span className="inline-block animate-pulse">
              {stopState === 'requested' ? 'stopping…' : 'working…'}
            </span>
            <LiveDuration since={turnStartMs} />
            <button
              onClick={stop}
              disabled={stopState === 'requested'}
              className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] uppercase tracking-widest text-neutral-400 transition-colors hover:border-torque/60 hover:text-torque disabled:opacity-40 disabled:hover:border-neutral-700 disabled:hover:text-neutral-400"
            >
              {stopState === 'requested' ? 'stopping' : 'stop'}
            </button>
            {stopState === 'failed' && (
              <span className="text-[10px] text-amber-400">
                couldn’t send stop — connection may be reconnecting; try again
              </span>
            )}
          </p>
          <PresenceCard
            tier={chipDiag ? (tierLabel(chipDiag.tier)?.text ?? null) : null}
            lock={chipDiag ? (formatLockState(chipDiag)?.value ?? null) : null}
            turnStartMs={turnStartMs}
            budgetRemaining={budgetRemaining}
          />
          <LiveCostPanel estimate={activeEstimate} costMeta={costMeta} />
          </>
        )}
        {/* TCLAW-2C: live current-task route chip.
            Gated on activeRequestId (NOT busy): busy excludes PENDING_APPROVAL, but a
            task paused for approval is still the current task — the chip stays visible
            during the approval pause intentionally, and swaps to the re-minted task's
            route (new requestId) on APPROVE. */}
        {chipDiag && (
          <p className="flex items-center gap-2 px-2 pb-1 text-[11px] text-neutral-600"
             title={formatRouteExplanation(chipDiag)[0]?.value}>
            <span className="text-neutral-500">↳</span>
            {tierLabel(chipDiag.tier) && <span>{tierLabel(chipDiag.tier)!.text}</span>}
            {formatLockState(chipDiag) && (
              <>
                <span className="text-neutral-700">·</span>
                <span>{formatLockState(chipDiag)!.value}</span>
              </>
            )}
          </p>
        )}
      </div>
      {receiptsOpen && (
        <ReceiptsPanel
          events={events}
          sendCommand={sendCommand}
          onClose={() => setReceiptsOpen(false)}
        />
      )}
      {costOpen && (
        <CostPanel events={events} sendCommand={sendCommand} onClose={() => setCostOpen(false)} />
      )}
      {approvalsOpen && (
        <ApprovalHistoryPanel
          events={events}
          sendCommand={sendCommand}
          onClose={() => setApprovalsOpen(false)}
          decidedCount={Object.keys(decided).length}
        />
      )}
      </div>

      {hint && !hintDismissed && (
        <div className="mt-3 flex items-center gap-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          <span>This looks like it may contain {hint} — keep it on this machine?</span>
          <button
            onClick={() => set('privateMode', true)}
            className="rounded border border-amber-400/50 px-2 py-0.5 text-amber-200 hover:bg-amber-400/15"
          >
            keep private
          </button>
          <button
            onClick={() => setHintDismissed(true)}
            className="text-amber-400/60 hover:text-amber-300"
          >
            dismiss
          </button>
        </div>
      )}

      <form onSubmit={submit} className="border-t border-edge px-4 pb-4 pt-3">
        <div
          className="flex items-center gap-3"
          onDragOver={(e) => { if (ATTACHMENTS_ENABLED) e.preventDefault(); }}
          onDrop={(e) => {
            if (!ATTACHMENTS_ENABLED) return;
            e.preventDefault();
            addFiles(e.dataTransfer?.files ?? null);
          }}
        >
          <span className="text-torque" aria-hidden>{'>'}</span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What do you need done?"
            aria-label="Describe your task"
            className="flex-1 bg-transparent py-1 text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
            autoFocus
          />
          {/* Redesign 7/7: paperclip (flag-gated). The hidden picker is the
              ONLY file entry point besides drag-and-drop on this row. */}
          {ATTACHMENTS_ENABLED && (
            <label
              className="cursor-pointer text-faint transition-colors hover:text-muted"
              title="attach files — preview only: the kernel has no upload pipeline yet"
            >
              <span aria-hidden>📎</span>
              <input
                type="file"
                multiple
                className="hidden"
                aria-label="attach files"
                onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
              />
            </label>
          )}
          {/* Pre-flight estimate chip (redesign 4/7): the kernel's real
              sizing pass, debounced as the operator types. Dollars only
              where true by construction (local = free); cloud shows the
              kernel's token estimate — a cloud dollar figure would be
              fabrication (spend.ts records provider-reported cost only).
              Hidden while the manual simulate-route panel is open: one
              route truth on screen at a time. */}
          {estimate && !previewState && (
            <span className="shrink-0 text-[10px] text-faint">
              est:{' '}
              <span className={estimate.route === 'local' ? 'text-good' : 'text-cloud'}>
                {estimate.label}
              </span>
            </span>
          )}
        </div>

        {/* Redesign 7/7: attachment chips — type-coded tiles (PDF red, IMG
            cyan with thumbnail, DOC amber), per-file remove. Flag-gated. */}
        {ATTACHMENTS_ENABLED && attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {attachments.map((a) => (
              <span
                key={a.id}
                className={`flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[10px] ${
                  a.kind === 'pdf' ? 'border-bad/40 bg-bad/10 text-bad'
                  : a.kind === 'image' ? 'border-cloud/40 bg-cloud/10 text-cloud'
                  : 'border-torque/40 bg-torque/10 text-torque'
                }`}
              >
                {a.previewUrl && (
                  <img src={a.previewUrl} alt="" className="h-4 w-4 rounded-sm object-cover" />
                )}
                <span className="max-w-[18ch] truncate" title={a.file.name}>{a.file.name}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={`remove ${a.file.name}`}
                  className="text-faint transition-colors hover:text-ink"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {/* Cloud-route privacy warning: real estimate route only — never a
            guess. Disappears on the local route (or with no attachments). */}
        {ATTACHMENTS_ENABLED && attachments.length > 0 && estimate?.route === 'cloud' && (
          <p className="mt-2 text-[10px] text-torque">
            {attachments.length} attachment{attachments.length === 1 ? '' : 's'} will be uploaded
            with this task — route is cloud
          </p>
        )}
        {/* Submit gate: the kernel exposes no upload pipeline, so attached
            files cannot ride the task yet — say so instead of faking it. */}
        {ATTACHMENTS_ENABLED && attachmentGateNote && attachments.length > 0 && (
          <p className="mt-2 text-[10px] text-torque">
            attachments can&apos;t ride this task yet — the kernel exposes no upload
            pipeline; remove them or submit without
          </p>
        )}

        {/* TCLAW-2D-2: route preview panel. Renders per previewState — ZERO
            interactive elements (no buttons/links/onClick anywhere below):
            this is display-only, never a dispatch surface, never the
            executed-task path. The caveat line is EXACT and appears in every
            state that shows any preview content. */}
        {previewState && (
          <div className="mt-3 rounded border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-[11px] text-neutral-500">
            {previewState.kind === 'pending' && <p>previewing…</p>}
            {previewState.kind === 'result' && (() => {
              const diag = previewState.meta.diagnostics as RouterDiagnostics | null | undefined;
              const tier = diag ? tierLabel(diag.tier) : null;
              const lock = formatLockState(diag);
              const blocked = formatBlockedAlternatives(diag);
              const profile = formatProfile(diag);
              const explanation = formatRouteExplanation(diag);
              const enrichment = previewState.meta.enrichment as Record<string, any> | undefined;
              const classifierUsed = enrichment?.classifierUsed;
              const fidelityNote =
                classifierUsed === 'KEYWORD_FALLBACK' ? 'classified by keyword fallback — lower confidence'
                : classifierUsed === 'DEFAULT' ? 'default classification (classifier unavailable)'
                : null; // never fabricate doubt for LOCAL_LLM or any other value (G1R S2)
              return (
                <>
                  <p className="text-neutral-300">
                    Would route: {tier ? tier.text : 'unknown'}
                  </p>
                  {explanation.map((row, i) => (
                    <p key={`exp-${i}`}>{row.label}: {row.value}</p>
                  ))}
                  {lock && (
                    <p>
                      {lock.value}
                      {diag?.overridable === true && ' — use the mode control below to change where this would run'}
                    </p>
                  )}
                  {blocked.map((row, i) => (
                    <p key={`blocked-${i}`}>{row.value}</p>
                  ))}
                  {profile && <p>{profile.label}: {profile.value}</p>}
                  {typeof previewState.meta.taskType === 'string' && (
                    <p>task type: {previewState.meta.taskType}</p>
                  )}
                  {typeof previewState.meta.contextSize === 'number' && (
                    <p>context size: {previewState.meta.contextSize}</p>
                  )}
                  {fidelityNote && <p className="text-amber-400">{fidelityNote}</p>}
                </>
              );
            })()}
            {previewState.kind === 'dropped' && (
              <p>Another preview is still running — try again in a moment.</p>
            )}
            {previewState.kind === 'timeout' && <p>No preview available — try again.</p>}
            {previewState.kind === 'sendFailed' && (
              <p>couldn’t send preview — connection may be reconnecting; try again</p>
            )}
            <p className="mt-1 text-neutral-600">
              Preview only. Enrichment and route may change when you submit.
            </p>
          </div>
        )}

        {/* Run controls: budget, where it runs, speed, privacy. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] uppercase tracking-widest text-neutral-500">
          <label className="flex items-center gap-1.5" title="Cap what a cloud task may spend">
            budget
            <select
              value={controls.budget}
              onChange={(e) => set('budget', e.target.value as BudgetChoice)}
              className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-neutral-300"
            >
              <option value="">default</option>
              <option value="free">Free (local only)</option>
              <option value="0.25">$0.25</option>
              <option value="1">$1</option>
              <option value="5">$5</option>
              <option value="custom">custom</option>
            </select>
          </label>
          {controls.budget === 'custom' && (
            <input
              type="number" min="0" max="100" step="0.25"
              value={controls.customBudget}
              onChange={(e) => set('customBudget', e.target.value)}
              placeholder="USD"
              aria-label="Custom budget in USD"
              className="w-16 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-neutral-300"
            />
          )}
          <label className="flex items-center gap-1.5" title="Where this task may run">
            mode
            <select
              value={controls.budget === 'free' ? 'LOCAL_ONLY' : controls.mode}
              disabled={controls.budget === 'free'}
              onChange={(e) => set('mode', e.target.value as ExecutionMode)}
              className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-neutral-300 disabled:opacity-50"
            >
              <option value="AUTO">Auto</option>
              <option value="LOCAL_ONLY">This machine only</option>
              <option value="CLOUD_OK">Cloud allowed</option>
            </select>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5" title="Prefer a fast answer">
            <input type="checkbox" checked={controls.fast} onChange={(e) => set('fast', e.target.checked)} className="accent-torque" />
            fast
          </label>
          <label className="flex cursor-pointer items-center gap-1.5" title="Private tasks never leave this machine — no cloud APIs, no exceptions">
            <input type="checkbox" checked={controls.privateMode} onChange={(e) => set('privateMode', e.target.checked)} className="accent-torque" />
            private
          </label>
          <label className="flex cursor-pointer items-center gap-1.5" title="Use past-task memory as context for this task">
            <input type="checkbox" checked={controls.useMemory} onChange={(e) => set('useMemory', e.target.checked)} className="accent-torque" />
            memory
          </label>
          <span className="text-neutral-700">·</span>
          <button type="button" onClick={() => sendCommand({ action: 'MEMORY', op: 'SHOW' })} className="text-neutral-500 hover:text-neutral-300">
            show memory
          </button>
          <button type="button" onClick={() => sendCommand({ action: 'MEMORY', op: 'FORGET_SESSION' })} className="text-neutral-500 hover:text-torque">
            forget session
          </button>
          <span className="text-neutral-700">·</span>
          <button type="button" onClick={() => setReceiptsOpen((v) => !v)} className="text-neutral-500 hover:text-neutral-300">
            {receiptsOpen ? 'hide receipts' : 'receipts'}
          </button>
          <span className="text-neutral-700">·</span>
          <button type="button" onClick={() => setCostOpen((v) => !v)} className="text-neutral-500 hover:text-neutral-300">
            {costOpen ? 'hide cost' : 'cost'}
          </button>
          <span className="text-neutral-700">·</span>
          <button type="button" onClick={() => setApprovalsOpen((v) => !v)} className="text-neutral-500 hover:text-neutral-300">
            {approvalsOpen ? 'hide approvals' : 'approvals'}
          </button>
          <span className="text-neutral-700">·</span>
          <button type="button" onClick={simulateRoute} disabled={!input.trim()} className="text-neutral-500 hover:text-neutral-300 disabled:opacity-40">
            simulate route
          </button>
        </div>
      </form>
    </section>
  );
}

/** Ticking wall-clock — drives staleness/last-synced without wiring a timer
 *  into render. Re-renders on an interval; the interval itself polls nothing
 *  (the console is push-based), it only re-reads `Date.now()`. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Redesign 4/7: the working card's live cost panel.
 *
 *  HONESTY (load-bearing): the gateway wire carries NO per-turn usage stream
 *  — provider-reported cost is recorded once, at completion (receipt), and
 *  spend.ts forbids estimated dollars. So there is no live per-task tick to
 *  render, and this panel says exactly that instead of animating a fake
 *  counter. What it DOES show, all from one frame source (costSummary):
 *   - est cap: the SAME pre-flight number the composer chip showed,
 *     snapshotted for this request — never recomputed into a different
 *     figure that could exceed its own cap;
 *   - session spend: real recorded spend, climbing on each 5s poll;
 *   - a cap bar only when a real session cap exists (fill = total/cap). */
function LiveCostPanel({
  estimate,
  costMeta,
}: {
  estimate: PreflightEstimate | null;
  costMeta: Record<string, any> | null;
}) {
  const total = typeof costMeta?.sessionTotal === 'number' ? costMeta.sessionTotal : null;
  const cap = typeof costMeta?.sessionCap === 'number' ? costMeta.sessionCap : null;
  const breach = costMeta?.breach ?? null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[10px] text-neutral-500">
      {estimate && (
        <span>
          est cap:{' '}
          <span className={estimate.route === 'local' ? 'text-good' : 'text-cloud'}>
            {estimate.label}
          </span>
        </span>
      )}
      {total !== null && (
        <span>
          session spend:{' '}
          <span className="tabular-nums text-neutral-300">${total.toFixed(2)}</span>
        </span>
      )}
      {total !== null && cap !== null && (
        <span className="flex items-center gap-1.5" title="session spend vs session cap">
          <span className="h-1 w-16 overflow-hidden rounded-sm bg-neutral-800">
            <span
              className={`block h-full ${breach ? 'bg-bad' : 'bg-torque'}`}
              style={{ width: `${Math.min(100, (total / cap) * 100)}%` }}
            />
          </span>
          <span className="tabular-nums">cap ${cap.toFixed(2)}</span>
        </span>
      )}
      {estimate?.route === 'cloud' && (
        <span className="text-neutral-600">
          task cost records on completion — no mid-task usage stream
        </span>
      )}
    </div>
  );
}

/** Redesign 3/7: the answer is the visual hero of a task card — Inter for
 *  long reading, a 72ch measure, the amber accent edge, and a mono ANSWER
 *  eyebrow. Same friendlyMessage text the raw row always rendered; only the
 *  presentation is elevated. */
function AnswerHero({ event }: { event: GatewayEvent }) {
  return (
    <div className="mt-2 border-l-2 border-torque pl-4">
      <p className="font-chrome text-[9px] tracking-[0.22em] text-faint">ANSWER</p>
      <div className="mt-1 max-w-[72ch] font-reading text-[14.5px] leading-[1.72] text-ink">
        {friendlyMessage(event)}
      </div>
    </div>
  );
}

/** Redesign 3/7: one task = one card. Header carries the user prompt (600
 *  weight), the token-colored route chip (cloud=cyan / local=green), and the
 *  ONE timestamp for the whole task. ROUTING/TIER_SELECTED/TOOL_CALL/SYSTEM
 *  plumbing collapses into a "N STEPS" row (default collapsed). Approvals,
 *  errors, the answer, and the receipt stay visible — action surfaces are
 *  never hidden inside a collapse. Every row keeps its exact pre-redesign
 *  behavior and dispatch surface; only the grouping/presentation changed. */
function TaskCard({
  group, decided, toolsByRequest, draftsByQueue, onDecideSkill, onGetDraft,
  onDecideTool, onResendLocal, onResendCloud, onRetry, onCopyDiagnostic,
  safeExportViewByTaskId, safeExportChipPhase, safeExportChipCopied,
  onGetSafeExportChip, onCopySafeExportChip, budgetLine,
}: {
  group: TaskGroup;
  decided: Record<string, 'APPROVE' | 'REJECT'>;
  toolsByRequest: Record<string, string[]>;
  draftsByQueue: Record<string, string>;
  onDecideSkill: (queueId: string, decision: 'APPROVE' | 'REJECT', editedMarkdown?: string) => void;
  onGetDraft: (queueId: string) => void;
  onDecideTool: (approvalId: string, decision: 'APPROVE' | 'REJECT') => void;
  onResendLocal: (prompt: string) => void;
  onResendCloud: (prompt: string) => void;
  onRetry: (prompt: string, suggestedBudget?: number) => void;
  onCopyDiagnostic: (errEvent: GatewayEvent) => void;
  safeExportViewByTaskId: Record<string, SafeExportFrameLike>;
  safeExportChipPhase: Record<string, 'initial' | 'pending' | 'ready' | 'sendFailed' | 'timeout'>;
  safeExportChipCopied: Record<string, boolean>;
  onGetSafeExportChip: (taskId: string) => void;
  onCopySafeExportChip: (taskId: string) => void;
  budgetLine: string | null;
}) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const tier = group.tier ? tierLabel(group.tier) : null;
  const isCloud = group.tier === 'API_EXTERNAL';

  const rowProps = (ev: GatewayEvent) => ({
    event: ev,
    hideTimestamp: true,
    decided,
    toolsByRequest,
    draftsByQueue,
    onDecideSkill,
    onGetDraft,
    onDecideTool,
    onResendLocal,
    onResendCloud,
    onRetry,
    onCopyDiagnostic,
    safeExportFrame: ev.requestId ? (safeExportViewByTaskId[ev.requestId] ?? null) : null,
    safeExportChipPhase: ev.requestId ? (safeExportChipPhase[ev.requestId] ?? 'initial') : 'initial',
    safeExportChipCopied: ev.requestId ? !!safeExportChipCopied[ev.requestId] : false,
    onGetSafeExportChip,
    onCopySafeExportChip,
    budgetLine,
  });

  return (
    <article className="rounded border border-edge bg-panel px-3 py-2">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {tier && (
          <span
            title={tier.hint}
            className={`rounded border px-1.5 py-0.5 text-[10px] tracking-wide ${
              isCloud
                ? 'border-cloud/40 bg-cloud/10 text-cloud'
                : 'border-good/40 bg-good/10 text-good'
            }`}
          >
            {tier.text}
          </span>
        )}
        {group.prompt && (
          <span className="min-w-0 flex-1 font-reading text-[13px] font-semibold text-ink">
            {group.prompt}
          </span>
        )}
        {group.startMs !== null && (
          <time
            className="shrink-0 text-[10px] tabular-nums text-faint"
            title={new Date(group.startMs).toISOString()}
          >
            {new Date(group.startMs).toLocaleTimeString([], { hour12: false })}
          </time>
        )}
      </header>

      {group.plumbing.length > 0 && (
        <button
          type="button"
          onClick={() => setStepsOpen((v) => !v)}
          aria-expanded={stepsOpen}
          className="mt-1.5 text-[10px] uppercase tracking-widest text-faint transition-colors hover:text-muted"
        >
          {group.plumbing.length} {group.plumbing.length === 1 ? 'step' : 'steps'} {stepsOpen ? '▾' : '▸'}
        </button>
      )}
      {stepsOpen && (
        <div className="mt-1 space-y-1">
          {group.plumbing.map((ev) => (
            <EventRow key={ev.id} {...rowProps(ev)} />
          ))}
        </div>
      )}

      {group.visible.length > 0 && (
        <div className="mt-1 space-y-1">
          {group.visible.map((ev) => {
            const meta = (ev.metadata ?? {}) as Record<string, any>;
            if (ev.type === 'SYSTEM' && meta.receipt) {
              return (
                <ReceiptCard
                  key={ev.id}
                  receipt={meta.receipt}
                  tools={ev.requestId ? (toolsByRequest[ev.requestId] ?? []) : []}
                />
              );
            }
            if (ev.type === 'RESULT') return <AnswerHero key={ev.id} event={ev} />;
            return <EventRow key={ev.id} {...rowProps(ev)} />;
          })}
        </div>
      )}
    </article>
  );
}

function EventRow({
  event, decided, toolsByRequest, draftsByQueue, onDecideSkill, onGetDraft,
  onDecideTool, onResendLocal, onResendCloud, onRetry, onCopyDiagnostic,
  safeExportFrame, safeExportChipPhase, safeExportChipCopied, onGetSafeExportChip, onCopySafeExportChip,
  hideTimestamp = false,
  budgetLine = null,
}: {
  event: GatewayEvent;
  decided: Record<string, 'APPROVE' | 'REJECT'>;
  toolsByRequest: Record<string, string[]>;
  draftsByQueue: Record<string, string>;
  onDecideSkill: (queueId: string, decision: 'APPROVE' | 'REJECT', editedMarkdown?: string) => void;
  onGetDraft: (queueId: string) => void;
  onDecideTool: (approvalId: string, decision: 'APPROVE' | 'REJECT') => void;
  onResendLocal: (prompt: string) => void;
  onResendCloud: (prompt: string) => void;
  onRetry: (prompt: string, suggestedBudget?: number) => void;
  onCopyDiagnostic: (errEvent: GatewayEvent) => void;
  // TCLAW-5B-2: the terminal safe-export chip's narrow props — plain data +
  // two per-taskId callbacks (fetch, copy), never raw sendCommand.
  safeExportFrame: SafeExportFrameLike | null;
  safeExportChipPhase: 'initial' | 'pending' | 'ready' | 'sendFailed' | 'timeout';
  safeExportChipCopied: boolean;
  onGetSafeExportChip: (taskId: string) => void;
  onCopySafeExportChip: (taskId: string) => void;
  /** Redesign 3/7: rows inside a task card hide their per-row clock — the
   *  card header carries the ONE timestamp for the whole task. */
  hideTimestamp?: boolean;
  /** Redesign 6/7: recorded session-budget context for the spend tier. */
  budgetLine?: string | null;
}) {
  const tier = tierLabel(event.tier);
  const meta = (event.metadata ?? {}) as Record<string, any>;
  // Two kinds of PENDING_APPROVAL: skill (queueId) and tool (approvalId).
  const queueId: string | undefined = meta.queueId ?? meta.queue_id;
  const approvalId: string | undefined = meta.approvalId ?? meta.approval_id;
  const cardId = approvalId ?? queueId; // the id this row decides under
  const decision = cardId ? decided[cardId] : undefined;
  const isToolApproval = event.type === 'PENDING_APPROVAL' && !!approvalId;
  const isUser = event.type === 'USER_PROMPT';
  const recovery: string[] = Array.isArray(meta.recovery) ? meta.recovery : [];

  // TCLAW-4B-2 / TCLAW-UIFIX-1: 4B panel frames (receipt list/detail/cost
  // summary/route preview responses) are publishOnly SYSTEM events meant
  // only for their respective panels — they must never render a stray inline
  // row/card in the live log. isPanelSystemFrame's coverage is byte-identical
  // to the inline check this replaces (see friendly.ts); it deliberately
  // excludes memory frames and the Done receipt frame, which stay visible.
  if (isPanelSystemFrame(event)) return null;

  // P2.5: a SYSTEM event carrying a receipt renders as a footer card, not a row.
  if (event.type === 'SYSTEM' && meta.receipt) {
    const tools = event.requestId ? (toolsByRequest[event.requestId] ?? []) : [];
    return <ReceiptCard receipt={meta.receipt} tools={tools} />;
  }

  return (
    <article
      className={`group flex gap-4 rounded px-2 py-1 transition-colors hover:bg-neutral-900/60 ${
        event.type === 'PENDING_APPROVAL' && !decision ? 'bg-torque/10' : ''
      }`}
      title={`${event.type}${meta.reason ? ` — ${meta.reason}` : ''}`}
    >
      {!hideTimestamp && (
        <time className="shrink-0 tabular-nums text-neutral-600">
          {new Date(event.timestamp).toLocaleTimeString([], { hour12: false })}
        </time>
      )}
      <div className="min-w-0 flex-1">
        {tier && (
          <span
            title={tier.hint}
            className={`mr-2 rounded border px-1.5 py-0.5 text-[10px] tracking-wide ${
              event.tier === 'OLLAMA_LOCAL'
                ? 'border-neutral-700 bg-neutral-900 text-neutral-400'
                : 'border-torque/40 bg-torque/10 text-torque'
            }`}
          >
            {tier.text}
          </span>
        )}
        <span
          className={`mr-2 text-[10px] font-bold ${
            event.type === 'TOOL_CALL' ? 'text-amber-400'
            : event.type === 'PENDING_APPROVAL' && !decision ? 'animate-pulse text-torque'
            : event.type === 'ERROR' ? 'text-bad'
            : isUser ? 'text-neutral-300'
            : 'text-neutral-600'
          }`}
        >
          [{TYPE_LABELS[event.type] ?? event.type.toLowerCase()}]
        </span>
        <span className={
          event.type === 'RESULT' ? 'font-semibold text-neutral-100'
          : isUser ? 'text-neutral-200'
          : 'text-neutral-400'
        }>
          {friendlyMessage(event)}
        </span>

        {/* Skill approval — allow / deny / edit-and-approve (P4). */}
        {event.type === 'PENDING_APPROVAL' && queueId && !approvalId && !decision && canRenderAction(event, false) && (
          <SkillApprovalCard
            queueId={queueId}
            skillName={String(meta.skillName ?? 'skill')}
            draft={typeof meta.skillMarkdown === 'string' ? meta.skillMarkdown : undefined}
            fetchedDraft={draftsByQueue[queueId]}
            onGetDraft={() => onGetDraft(queueId)}
            onDecide={onDecideSkill}
          />
        )}

        {/* Tool approval — expanded permission card (P2). */}
        {isToolApproval && approvalId && !decision && canRenderAction(event, false) && (
          <ToolPermissionCard
            toolName={String(meta.toolName ?? meta.tool_name ?? '')}
            args={meta.args}
            gate={meta.gate}
            budgetLine={budgetLine}
            onAllow={() => onDecideTool(approvalId, 'APPROVE')}
            onDeny={() => onDecideTool(approvalId, 'REJECT')}
          />
        )}

        {decision && (
          <span className="ml-3 text-[10px] text-neutral-500">
            {decision === 'APPROVE' ? '✓ allowed once' : '✕ denied'}
          </span>
        )}

        {/* P3.5 failure recovery: action chips chosen by the failure site. */}
        {event.type === 'ERROR' && recovery.length > 0 && canRenderAction(event, false) && (
          <div className="ml-14 mt-1 flex flex-wrap items-center gap-2">
            {recovery.includes('RETRY') && meta.prompt && (
              <button
                onClick={() => onRetry(String(meta.prompt), typeof meta.suggestedBudget === 'number' ? meta.suggestedBudget : undefined)}
                className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-torque/60 hover:text-torque"
              >
                {typeof meta.suggestedBudget === 'number' ? `retry at $${meta.suggestedBudget}` : 'retry'}
              </button>
            )}
            {recovery.includes('RETRY_LOCAL') && meta.prompt && (
              <button
                onClick={() => onResendLocal(String(meta.prompt))}
                className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-torque/60 hover:text-torque"
              >
                run on this machine
              </button>
            )}
            {recovery.includes('RETRY_CLOUD') && meta.prompt && (
              <button
                onClick={() => onResendCloud(String(meta.prompt))}
                className="rounded border border-torque/50 px-2 py-0.5 text-[10px] text-torque transition-colors hover:bg-torque/10"
              >
                run on cloud (faster)
              </button>
            )}
            {/* TCLAW-5B-2 [G1R RC-5 proven, see top-of-file comment]: the
                "copy safe export" chip — listed BEFORE the raw chip
                (preferred action first, design §4.2). Requires
                event.requestId (== the taskId GET_SAFE_EXPORT looks up);
                when absent, only the raw chip renders. Copies Markdown
                only; textual distinction from the raw chip, no chromatic
                safety-coding. */}
            {recovery.includes('COPY_DIAGNOSTIC') && event.requestId && (
              <SafeExportChip
                taskId={event.requestId}
                frame={safeExportFrame}
                phase={safeExportChipPhase}
                copied={safeExportChipCopied}
                onGetSafeExportChip={onGetSafeExportChip}
                onCopySafeExportChip={onCopySafeExportChip}
              />
            )}
            {recovery.includes('COPY_DIAGNOSTIC') && (
              <button
                onClick={() => onCopyDiagnostic(event)}
                title="copies requestId, reason, and the last 10 event messages exactly as shown in this terminal — no redaction"
                className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-neutral-500"
              >
                copy raw diagnostic (local, unredacted)
              </button>
            )}
            {typeof meta.sideEffectNote === 'string' && (
              <span className="text-[10px] text-neutral-600">{meta.sideEffectNote}</span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * TCLAW-5B-2: the terminal "copy safe export" chip (design §4.2). Two-click
 * fetch-then-copy: click #1 requests the export (narrow callback only —
 * never raw sendCommand reachable from this component); click #2 is a
 * SYNCHRONOUS writeText of the already-snapshotted Markdown (never
 * re-fetched, never client-reassembled — same cardinal-rule discipline as
 * ReceiptsPanel's copy buttons). States mirror the panel's failure/edge
 * copy exactly, but inert (no button) for not-found/too_large/failed —
 * only initial/pending/ready/sendFailed/timeout are interactive.
 */
function SafeExportChip({
  taskId,
  frame,
  phase,
  copied,
  onGetSafeExportChip,
  onCopySafeExportChip,
}: {
  taskId: string;
  frame: SafeExportFrameLike | null;
  phase: 'initial' | 'pending' | 'ready' | 'sendFailed' | 'timeout';
  copied: boolean;
  onGetSafeExportChip: (taskId: string) => void;
  onCopySafeExportChip: (taskId: string) => void;
}) {
  // Frame-terminal states are read from the snapshot, not from phase (mirrors
  // the panel's discipline) — a frame arriving flips phase to 'ready' via the
  // shared effect, and the FRAME's own shape decides which of the five
  // ready-adjacent renders below applies.
  if (frame && !frame.error && frame.exportOmitted) {
    return <span className="text-[10px] text-neutral-600">export exceeds the frame size limit — not available</span>;
  }
  if (frame && frame.error) {
    return <span className="text-[10px] text-neutral-600">safe export failed (nothing copied)</span>;
  }
  if (frame && !frame.error && !frame.exportOmitted && !frame.safeExport) {
    return <span className="text-[10px] text-neutral-600">no receipt for this task</span>;
  }
  if (frame && frame.safeExport) {
    const report = frame.safeExport.redactionReport;
    const hitEntries = Object.entries(report?.patternsHit ?? {});
    const summary =
      hitEntries.length > 0
        ? `removed: ${hitEntries.map(([label, n]) => `${label} ×${n}`).join(', ')} · prompt, context, events, tool args never included`
        : 'no known secret shapes found (known shapes only) · prompt, context, events, tool args never included';
    return (
      <span className="flex items-center gap-2">
        <button
          onClick={() => onCopySafeExportChip(taskId)}
          title="copies the redacted export as Markdown, including its redaction report"
          className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-neutral-500"
        >
          {copied ? 'copied' : 'copy safe export (ready)'}
        </button>
        <span className="text-[10px] text-neutral-600">{summary}</span>
      </span>
    );
  }
  if (phase === 'pending') {
    return (
      <button disabled className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-500 opacity-60">
        preparing…
      </button>
    );
  }
  if (phase === 'sendFailed') {
    return (
      <button
        onClick={() => onGetSafeExportChip(taskId)}
        className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-neutral-500"
      >
        couldn&apos;t request — try again
      </button>
    );
  }
  if (phase === 'timeout') {
    return (
      <button
        onClick={() => onGetSafeExportChip(taskId)}
        className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-neutral-500"
      >
        no response — try again
      </button>
    );
  }
  return (
    <button
      onClick={() => onGetSafeExportChip(taskId)}
      className="rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300 transition-colors hover:border-neutral-500"
    >
      copy safe export
    </button>
  );
}

/** P2.5 receipt footer, restyled as a chip row (redesign 3/7): a compact
 *  "what happened" line from REAL telemetry only. Renders whichever fields
 *  are present; never invents (invariant 6).
 *
 *  KERNEL GAP (redesign 3/7): the snapshot chip + UNDO button belong on this
 *  row for tasks that touched files — but the gateway exposes NO
 *  checkpoint/rollback command (packages/contracts has none; STATE.md F-1
 *  confirms governed rollback has no operator surface). Deliberately absent
 *  here until the kernel ships the API — never faked. */
function ReceiptCard({ receipt, tools }: { receipt: any; tools: string[] }) {
  const [showCtx, setShowCtx] = useState(false);
  const where = receipt.tier === 'OLLAMA_LOCAL' ? 'local' : 'cloud';
  const cost =
    receipt.tier === 'OLLAMA_LOCAL' ? 'free'
    : typeof receipt.costUsd === 'number' ? `$${receipt.costUsd.toFixed(2)}`
    : 'cost n/a';
  const parts: string[] = [where, cost];
  if (typeof receipt.elapsedMs === 'number') parts.push(`${(receipt.elapsedMs / 1000).toFixed(1)}s`);
  if (tools.length) parts.push(`tools: ${tools.join(', ')}`);
  if (receipt.cancelled) parts.push('cancelled');
  if (receipt.blockedOn) parts.push(`paused for ${receipt.blockedOn}`);
  // P4.5: memory transparency.
  if (receipt.memoryUsed === false) parts.push('memory off');
  else if (typeof receipt.contextChars === 'number') parts.push(`context: ${receipt.contextChars} chars`);
  const ctx: string | undefined = typeof receipt.assembledContext === 'string' ? receipt.assembledContext : undefined;

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="rounded border border-edge bg-panel-2 px-1.5 py-0.5 font-semibold text-muted">Done</span>
        {parts.map((p, i) => (
          <span key={i} className="rounded border border-edge bg-panel-2 px-1.5 py-0.5 tabular-nums text-faint">
            {p}
          </span>
        ))}
        {ctx && (
          <button
            onClick={() => setShowCtx((v) => !v)}
            className="rounded border border-transparent px-1.5 py-0.5 text-faint transition-colors hover:border-edge hover:text-muted"
          >
            {showCtx ? 'hide context' : 'view context used'}
          </button>
        )}
      </div>
      {showCtx && ctx && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 text-[11px] text-neutral-400">
          {ctx}
        </pre>
      )}
    </div>
  );
}

/** P2 tool-approval card: shows ONLY facts the system knows (action, exact tool
 *  name, args, one-time scope). No risk scores or invented assessments
 *  (invariant 6). Allow once -> APPROVE_TOOL re-runs the task with the grant. */
/** P4 skill approval: allow as-is, deny, or edit-and-approve. The editor is a
 *  plain textarea (no Monaco) with Tab->2-spaces so Python indentation is
 *  editable; an inline line-diff shows the operator's changes vs the draft. */
function SkillApprovalCard({
  queueId, skillName, draft, fetchedDraft, onGetDraft, onDecide,
}: {
  queueId: string;
  skillName: string;
  draft?: string;          // rode along in the event (<=8KB)
  fetchedDraft?: string;   // fetched via GET_SKILL_DRAFT (large)
  onGetDraft: () => void;
  onDecide: (queueId: string, decision: 'APPROVE' | 'REJECT', editedMarkdown?: string) => void;
}) {
  const original = draft ?? fetchedDraft;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');

  const startEdit = () => {
    if (original === undefined) { onGetDraft(); return; } // fetch then user clicks again
    setText(original);
    setEditing(true);
  };

  // Tab inserts two spaces (Shift+Tab dedents) so indentation-sensitive code is
  // editable in a plain textarea.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const ta = e.currentTarget;
    const { selectionStart: s, selectionEnd: en } = ta;
    if (e.shiftKey) {
      const lineStart = text.lastIndexOf('\n', s - 1) + 1;
      if (text.slice(lineStart, lineStart + 2) === '  ') {
        const next = text.slice(0, lineStart) + text.slice(lineStart + 2);
        setText(next);
        requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = Math.max(lineStart, s - 2); });
      }
    } else {
      const next = text.slice(0, s) + '  ' + text.slice(en);
      setText(next);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
    }
  };

  const diff = editing && original !== undefined ? lineDiff(original, text) : [];

  return (
    <div className="ml-2 mt-2 max-w-3xl rounded border border-torque/40 bg-torque/5 p-3">
      <p className="text-neutral-200">
        Learned a new skill: <span className="font-semibold text-neutral-100">{skillName}</span> — review before it can be used.
      </p>

      {editing && (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            className="mt-2 h-48 w-full resize-y rounded bg-black/50 p-2 font-mono text-[11px] text-neutral-200 focus:outline-none"
          />
          {diff.some((d) => d.t !== ' ') && (
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-black/40 p-2 font-mono text-[11px]">
              {diff.map((d, k) => (
                <div
                  key={k}
                  className={
                    d.t === '+' ? 'bg-green-500/10 text-green-400'
                    : d.t === '-' ? 'bg-faint/15 text-faint'
                    : 'text-neutral-500'
                  }
                >
                  {d.t} {d.line}
                </div>
              ))}
            </pre>
          )}
        </>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => onDecide(queueId, 'APPROVE', editing ? text : undefined)}
          className="rounded border border-torque/50 px-3 py-1 text-[11px] text-torque hover:bg-torque/10"
        >
          {editing ? 'Approve with edits' : 'Allow'}
        </button>
        {!editing && (
          <button
            onClick={startEdit}
            className="rounded border border-neutral-700 px-3 py-1 text-[11px] text-neutral-300 hover:border-neutral-500"
          >
            {original === undefined ? 'load draft to edit' : 'Edit'}
          </button>
        )}
        <button
          onClick={() => onDecide(queueId, 'REJECT')}
          className="rounded border border-neutral-700 px-3 py-1 text-[11px] text-neutral-400 hover:bg-neutral-800"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function ToolPermissionCard({
  toolName, args, gate, onAllow, onDeny, budgetLine = null,
}: {
  toolName: string;
  args: unknown;
  gate?: unknown;
  onAllow: () => void;
  onDeny: () => void;
  /** Redesign 6/7: recorded session-budget context (remaining vs cap) for
   *  the spend tier — real costSummary facts only, null when no frame has
   *  landed (never fabricated). */
  budgetLine?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [targetsExpanded, setTargetsExpanded] = useState(false);
  // Redesign 6/7: destructive tier arms only when the operator types DELETE.
  const [confirmText, setConfirmText] = useState('');

  // TCLAW-5A-2 HONESTY FORK 1 (absent gate !== registry miss): the caller
  // passes meta.gate straight through, so `gate === undefined` means the
  // `gate` KEY was absent on the wire (pre-5A-1 backlog frame) — the
  // registry was never consulted for this event, and the card renders
  // byte-identically to the pre-5A-2 card (no gate section, never
  // "unclassified"). formatGateFacts owns HONESTY FORK 2 (null/primitive
  // gate is ALSO treated as absent, never miss — see its doc comment) so a
  // single `gate === undefined` check here would be insufficient on its own;
  // routing every non-undefined value through formatGateFacts is what makes
  // gate:null safe.
  const gateFacts = gate === undefined ? null : formatGateFacts(gate);

  // Redesign 6/7: severity tier from the gate facts (pure selector, friendly.ts).
  // unknown = gate absent/null/malformed — the registry was never consulted,
  // so the card keeps its exact pre-redesign look (honesty forks 1+2).
  const tier = approvalTierFromGate(gate);
  const tierChrome =
    tier === 'read' ? 'border-good/40 bg-good/5'
    : tier === 'spend' ? 'border-torque/40 bg-torque/5'
    : tier === 'destructive' ? 'border-bad/40 bg-bad/5'
    : 'border-torque/40 bg-torque/5';
  const armed = confirmText === 'DELETE';
  const rawGate = gate !== undefined && gate !== null && typeof gate === 'object'
    ? (gate as Record<string, unknown>)
    : null;

  // Friendly verb: take the segment after the last "__", underscores -> spaces.
  // Use lastIndexOf (not a \w+ regex) so hyphenated/dotted MCP names survive.
  const friendly = (toolName.includes('__')
    ? toolName.slice(toolName.lastIndexOf('__') + 2)
    : toolName
  ).replace(/_/g, ' ');

  const pretty = useMemo(() => {
    try { return JSON.stringify(args ?? {}, null, 2); }
    catch { return String(args); }
  }, [args]);
  const TRUNC = 500;
  const isLong = pretty.length > TRUNC;
  const shown = expanded || !isLong ? pretty : pretty.slice(0, TRUNC) + '\n…';

  return (
    <div className={`ml-2 mt-2 max-w-2xl rounded border p-3 ${tierChrome}`}>
      <p className="text-neutral-200">
        This task wants to <span className="font-semibold text-neutral-100">{friendly}</span> to finish.
      </p>
      <dl className="mt-2 space-y-1 text-[11px]">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 uppercase tracking-widest text-neutral-500">tool</dt>
          <dd className="font-mono text-neutral-300">{toolName || '(unknown)'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 uppercase tracking-widest text-neutral-500">scope</dt>
          <dd className="text-neutral-400">One-time — applies to a single re-run</dd>
        </div>
      </dl>
      {/* TCLAW-5A-2 Card v2 gate block — additional dt/dd rows in a SECOND dl
          (G1R Q3 rec: smallest diff, inherits inertness). Renders NOTHING
          when gateFacts is null (HONESTY FORKS 1+2 — absent or malformed
          gate). All gate-present variants share the "may touch" targets row
          + heuristic caption (invariant 8). */}
      {gateFacts && (
        <dl className="mt-2 space-y-1 text-[11px]">
          {gateFacts.classRow && (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 uppercase tracking-widest text-neutral-500">class</dt>
              <dd className="text-neutral-400" title={gateFacts.classRow.title}>{gateFacts.classRow.text}</dd>
            </div>
          )}
          {gateFacts.whyGated && (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 uppercase tracking-widest text-neutral-500">why gated</dt>
              <dd className="text-neutral-400" title={gateFacts.whyGated.title}>{gateFacts.whyGated.text}</dd>
            </div>
          )}
          {gateFacts.server && (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 uppercase tracking-widest text-neutral-500">server</dt>
              <dd className="font-mono text-neutral-400">{gateFacts.server}</dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 uppercase tracking-widest text-neutral-500">may touch</dt>
            <dd className="min-w-0 text-neutral-400">
              {gateFacts.targets.items.length === 0 ? (
                <span>none detected</span>
              ) : (
                <>
                  {(targetsExpanded ? gateFacts.targets.items : gateFacts.targets.items.slice(0, 4)).map((t, i) => (
                    <span key={i} className="mr-2 inline-block break-all font-mono" title={t.full}>
                      {t.displayText}
                    </span>
                  ))}
                  {gateFacts.targets.items.length > 4 && (
                    <button
                      type="button"
                      onClick={() => setTargetsExpanded((v) => !v)}
                      className="ml-1 text-[10px] text-neutral-500 hover:text-neutral-300"
                    >
                      {targetsExpanded ? 'show less' : `show all (${gateFacts.targets.items.length})`}
                    </button>
                  )}
                  {targetsExpanded && gateFacts.targets.items.length > 4 && (
                    <div className="mt-1 max-h-40 overflow-auto rounded bg-black/30 p-1 font-mono">
                      {gateFacts.targets.items.map((t, i) => (
                        <div key={i} className="break-all" title={t.full}>{t.full}</div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </dd>
          </div>
          <p className="text-[10px] text-neutral-600">{gateFacts.targetsCaption}</p>
        </dl>
      )}
      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-black/40 p-2 text-[11px] text-neutral-400">
        {shown}
      </pre>
      {isLong && (
        <button onClick={() => setExpanded((v) => !v)} className="mt-1 text-[10px] text-neutral-500 hover:text-neutral-300">
          {expanded ? 'show less' : `show all (${pretty.length} chars)`}
        </button>
      )}
      {/* Redesign 6/7 — spend tier: recorded budget context inline. Real
          costSummary facts only (null -> renders nothing, never a guess). */}
      {tier === 'spend' && budgetLine && (
        <p className="mt-2 text-[10px] text-neutral-500">budget: {budgetLine}</p>
      )}

      {/* Redesign 6/7 — destructive tier: risk list, checkpoint truth, and
          type-to-confirm. Every line is derived from gate facts or kernel
          reality — no invented risk scores. */}
      {tier === 'destructive' && (
        <div className="mt-2 space-y-1.5 text-[10px]">
          <ul className="list-disc space-y-0.5 pl-4 text-neutral-400">
            {rawGate?.capability === 'exec' && (
              <li>runs code with this machine&apos;s privileges — effects are not bounded by the gateway</li>
            )}
            {rawGate?.capability === 'send' && (
              <li>sends data off this machine — outbound transfers cannot be recalled</li>
            )}
            {rawGate?.capability === undefined && (
              <li>the kernel could not classify this action — treat it as irreversible</li>
            )}
          </ul>
          <p className="text-bad">
            not covered by any checkpoint — the kernel exposes no checkpoint/rollback surface
          </p>
          <label className="block text-neutral-500">
            type DELETE to arm approve
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="DELETE"
              aria-label="type DELETE to arm approve"
              spellCheck={false}
              className="mt-1 block w-40 rounded border border-neutral-700 bg-black/40 px-2 py-1 font-mono text-[11px] text-neutral-200 focus:outline-none"
            />
          </label>
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <button
          onClick={onAllow}
          disabled={tier === 'destructive' && !armed}
          title={tier === 'destructive' && !armed ? 'type DELETE to arm' : undefined}
          className={`rounded border px-3 py-1 text-[11px] disabled:opacity-40 ${
            tier === 'read' ? 'border-good/50 text-good hover:bg-good/10'
            : tier === 'spend' ? 'border-torque/50 text-torque hover:bg-torque/10'
            : tier === 'destructive' ? 'border-bad/50 text-bad hover:bg-bad/10'
            : 'border-torque/50 text-torque hover:bg-torque/10'
          }`}
        >
          Allow once
        </button>
        <button onClick={onDeny} className="rounded border border-neutral-700 px-3 py-1 text-[11px] text-neutral-400 hover:bg-neutral-800">
          Deny
        </button>
      </div>
    </div>
  );
}

