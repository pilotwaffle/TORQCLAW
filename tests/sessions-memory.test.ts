import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// sessions.ts opens the gateway DB at import time, so DATA_DIR must be set
// before it loads. Set it at module top, then a plain import binds to a temp DB.
process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-mem-'));
const { sessions } = await import('../packages/gateway/src/sessions.js');

const newSession = () =>
  sessions.resolve({ role: 'operator', token: 't', clientInfo: { name: 'x', version: '0' } } as any).sessionId;

describe('P4.5 memory controls (sessions)', () => {
  it('SHOW lists stored episodes; FORGET_SESSION removes them', () => {
    const sid = newSession();
    sessions.storeEpisode('r1', sid, 'SUMMARIZATION', 'p1', 'res1');
    sessions.storeEpisode('r2', sid, 'DATA_EXTRACTION', 'p2', 'res2');

    const shown = sessions.showEpisodes(sid);
    expect(shown.length).toBe(2);
    expect(shown.map((e) => e.taskType).sort()).toEqual(['DATA_EXTRACTION', 'SUMMARIZATION']);

    const n = sessions.forgetSession(sid);
    expect(n).toBe(2);
    expect(sessions.showEpisodes(sid)).toEqual([]);
  });

  it('forgetting keeps the FTS index consistent (no ghost recall after)', () => {
    const sid = newSession();
    sessions.storeEpisode('r3', sid, 'AUTONOMOUS_RESEARCH', 'namespacing gateways', 'compared them');
    expect(sessions.getContextWindow(sid, 'namespacing')).toMatch(/namespacing|compared/i);
    sessions.forgetSession(sid);
    expect(sessions.getContextWindow(sid, 'namespacing')).not.toMatch(/compared them/);
  });

  it('episodes are scoped per session', () => {
    const a = newSession();
    const b = newSession();
    sessions.storeEpisode('ra', a, 'SUMMARIZATION', 'pa', 'ra');
    expect(sessions.showEpisodes(a).length).toBe(1);
    expect(sessions.showEpisodes(b).length).toBe(0);
  });
});
