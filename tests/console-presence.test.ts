import { describe, it, expect } from 'vitest';
import {
  selectTurnStartMs,
  selectLastSyncedMs,
  isStale,
  selectCostSummaryMeta,
  selectLivePhase,
  isPhaseStuck,
  STALE_AFTER_MS,
} from '../apps/console/src/components/presence.js';
import type { GatewayEvent } from '@torqclaw/contracts';

function ev(p: Partial<GatewayEvent>): GatewayEvent {
  return {
    id: 'id',
    requestId: null,
    sessionId: 's',
    tier: null,
    type: 'SYSTEM',
    message: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...p,
  } as GatewayEvent;
}

describe('console presence / liveness selectors', () => {
  describe('selectTurnStartMs — the liveness anchor', () => {
    it('null activeRequestId -> null', () => {
      expect(selectTurnStartMs([], null)).toBeNull();
    });

    it('no event matches the active request -> null', () => {
      const events = [ev({ type: 'TIER_SELECTED', requestId: 'other' })];
      expect(selectTurnStartMs(events, 'r1')).toBeNull();
    });

    it('returns the EARLIEST timestamp among events carrying the requestId', () => {
      const events = [
        ev({ type: 'TIER_SELECTED', requestId: 'r1', timestamp: '2026-01-01T00:00:05.000Z' }),
        ev({ type: 'TOOL_CALL', requestId: 'r1', timestamp: '2026-01-01T00:00:05.500Z' }),
        ev({ type: 'TOOL_CALL', requestId: 'other', timestamp: '2026-01-01T01:00:00.000Z' }),
      ];
      expect(selectTurnStartMs(events, 'r1')).toBe(Date.parse('2026-01-01T00:00:05.000Z'));
    });

    it('is independent of array order and of events from earlier tasks', () => {
      const events = [
        ev({ type: 'TOOL_CALL', requestId: 'r1', timestamp: '2026-01-01T00:00:07.000Z' }),
        ev({ type: 'RESULT', requestId: 'prevTask', timestamp: '2026-01-01T00:00:00.000Z' }),
        ev({ type: 'TIER_SELECTED', requestId: 'r1', timestamp: '2026-01-01T00:00:03.000Z' }),
      ];
      // Earlier task's timestamps never leak into the anchor for r1.
      expect(selectTurnStartMs(events, 'r1')).toBe(Date.parse('2026-01-01T00:00:03.000Z'));
    });

    it('survives a reconnect backlog replay — the anchor never resets', () => {
      // Pre-reconnect view: task r1, two events in, anchor at the first.
      const backlog = [
        ev({ type: 'TIER_SELECTED', requestId: 'r1', timestamp: '2026-01-01T00:00:05.000Z' }),
        ev({ type: 'TOOL_CALL', requestId: 'r1', timestamp: '2026-01-01T00:00:06.000Z' }),
      ];
      const before = selectTurnStartMs(backlog, 'r1');
      // Reconnect: the gateway replays from lastSeenSeq — seq is the replay
      // cursor, so replayed frames carry their PERSISTED timestamps, then
      // live events resume after them.
      const after = [
        ...backlog,
        ev({ type: 'TOOL_CALL', requestId: 'r1', timestamp: '2026-01-01T00:00:18.000Z' }),
      ];
      expect(before).toBe(Date.parse('2026-01-01T00:00:05.000Z'));
      expect(selectTurnStartMs(after, 'r1')).toBe(before);
    });
  });

  describe('selectLastSyncedMs', () => {
    it('empty events -> null', () => {
      expect(selectLastSyncedMs([])).toBeNull();
    });

    it('max timestamp across events, malformed skipped', () => {
      const events = [
        ev({ timestamp: '2026-01-01T00:00:10.000Z' }),
        ev({ timestamp: 'not-a-date' }),
        ev({ type: 'TIER_SELECTED', timestamp: '2026-01-01T01:00:00.000Z' }),
      ];
      expect(selectLastSyncedMs(events)).toBe(Date.parse('2026-01-01T01:00:00.000Z'));
    });
  });

  describe('isStale', () => {
    it('null (never synced) is NOT stale', () => {
      expect(isStale(null, Date.now(), STALE_AFTER_MS)).toBe(false);
    });

    it('within threshold is not stale', () => {
      const now = Date.parse('2026-01-01T00:02:00.000Z');
      expect(isStale(Date.parse('2026-01-01T00:01:30.000Z'), now, 30_000)).toBe(false);
    });

    it('beyond threshold is stale', () => {
      const now = Date.parse('2026-01-01T00:02:00.000Z');
      expect(isStale(Date.parse('2026-01-01T00:01:00.000Z'), now, 30_000)).toBe(true);
    });

    it('honors a custom threshold', () => {
      const now = Date.parse('2026-01-01T00:01:40.000Z');
      expect(isStale(Date.parse('2026-01-01T00:01:00.000Z'), now, 60_000)).toBe(false);
    });
  });

  describe('selectCostSummaryMeta', () => {
    it('null when no costSummary frame has arrived', () => {
      expect(selectCostSummaryMeta([ev({ type: 'RESULT' })])).toBeNull();
    });

    it('returns the LATEST costSummary frame regardless of position', () => {
      const frame = ev({
        type: 'SYSTEM',
        metadata: { costSummary: true, sessionRemaining: 4.75, dailyRemaining: 1.1 },
      });
      const events = [frame, ev({ type: 'TIER_SELECTED' }), frame];
      const meta = selectCostSummaryMeta(events);
      expect(meta).not.toBeNull();
      expect(meta!.sessionRemaining).toBe(4.75);
    });

    it('does not treat a non-summary frame as a summary', () => {
      expect(selectCostSummaryMeta([ev({ type: 'SYSTEM', metadata: { costSummary: false } })])).toBeNull();
      expect(selectCostSummaryMeta([ev({ type: 'SYSTEM', metadata: {} })])).toBeNull();
    });
  });

  describe('selectLivePhase — the liveness chip anchor', () => {
    it('null activeRequestId -> null', () => {
      expect(selectLivePhase([ev({ type: 'TOOL_CALL', requestId: 'r1' })], null)).toBeNull();
    });

    it('no event matches the active request -> null', () => {
      expect(selectLivePhase([ev({ type: 'TOOL_CALL', requestId: 'other' })], 'r1')).toBeNull();
    });

    it('phase text comes from the NEWEST non-SYSTEM task event, never an invented label', () => {
      const events = [
        ev({ type: 'TIER_SELECTED', requestId: 'r1', message: 'routed' }),
        ev({ type: 'TOOL_CALL', requestId: 'r1', message: 'Executing filesystem__read_file' }),
        ev({ type: 'SYSTEM', requestId: 'r1', message: 'panel frame' }),
      ];
      const phase = selectLivePhase(events, 'r1');
      expect(phase).not.toBeNull();
      // friendlyMessage(TOOL_CALL) — the honest humanization of the real event.
      expect(phase!.text).toBe('Using read file (filesystem)');
      expect(phase!.waitingOnApproval).toBe(false);
    });

    it('SYSTEM frames still advance the stuck anchor (a task emitting notes is emitting)', () => {
      const events = [
        ev({ type: 'TOOL_CALL', requestId: 'r1', message: 'Executing filesystem__read_file', timestamp: '2026-01-01T00:00:01.000Z' }),
        ev({ type: 'SYSTEM', requestId: 'r1', message: 'note', timestamp: '2026-01-01T00:00:09.000Z' }),
      ];
      const phase = selectLivePhase(events, 'r1');
      expect(phase!.lastEventMs).toBe(Date.parse('2026-01-01T00:00:09.000Z'));
    });

    it('skips terminal RESULT/ERROR for the phase text', () => {
      const events = [
        ev({ type: 'TOOL_CALL', requestId: 'r1', message: 'Executing filesystem__read_file' }),
        ev({ type: 'RESULT', requestId: 'r1', message: 'done' }),
      ];
      const phase = selectLivePhase(events, 'r1');
      expect(phase!.text).toBe('Using read file (filesystem)');
    });

    it('waitingOnApproval when the freshest work-truth event is PENDING_APPROVAL', () => {
      const events = [
        ev({ type: 'TIER_SELECTED', requestId: 'r1', message: 'routed' }),
        ev({ type: 'PENDING_APPROVAL', requestId: 'r1', message: 'Tool filesystem__write_file requires approval', metadata: { approvalId: 'a1' } }),
      ];
      const phase = selectLivePhase(events, 'r1');
      expect(phase!.waitingOnApproval).toBe(true);
      expect(phase!.text).toBe('Wants to write file — needs your OK');
    });
  });

  describe('isPhaseStuck — 30s quiet rule', () => {
    const phase = { text: 'x', lastEventMs: Date.parse('2026-01-01T00:00:00.000Z'), waitingOnApproval: false };

    it('null phase is never stuck', () => {
      expect(isPhaseStuck(null, Date.parse('2026-01-01T01:00:00.000Z'))).toBe(false);
    });

    it('quiet longer than the threshold is stuck', () => {
      expect(isPhaseStuck(phase, Date.parse('2026-01-01T00:00:31.000Z'))).toBe(true);
    });

    it('within the threshold is not stuck', () => {
      expect(isPhaseStuck(phase, Date.parse('2026-01-01T00:00:30.000Z'))).toBe(false);
    });

    it('a task waiting on the OPERATOR is never stuck — the bottleneck is human', () => {
      expect(isPhaseStuck({ ...phase, waitingOnApproval: true }, Date.parse('2026-01-01T01:00:00.000Z'))).toBe(false);
    });
  });
});