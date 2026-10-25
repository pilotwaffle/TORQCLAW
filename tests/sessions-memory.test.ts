import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// sessions.ts opens the gateway DB at import time, so DATA_DIR must be set
// before it loads. Set it at module top, then a plain import binds to a temp DB.
process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-mem-'));
const { sessions } = await import('../packages/gateway/src/sessions.js');
const { makeEmitter } = await import('../packages/gateway/src/events.js');

const newSession = () =>
  sessions.resolve(
    { role: 'operator', token: 't', clientInfo: { name: 'x', version: '0' } } as any,
    { authClass: 'legacy_gateway', role: 'operator', binding: null },
  ).sessionId;

describe('P4.5 memory controls (sessions)', () => {
  it('private_prompt_and_result_excluded_from_context_window', () => {
    const sid = newSession();
    const emit = makeEmitter(sid, null, null);
    emit('USER_PROMPT', 'PRIVATE-PROMPT-MARKER', { sensitive: true });
    emit('RESULT', 'PRIVATE-RESULT-MARKER', { sensitive: true });
    emit('USER_PROMPT', 'PUBLIC-PROMPT-MARKER');
    emit('RESULT', 'PUBLIC-RESULT-MARKER', { engineUsed: 'test' });
    for (const context of [sessions.getContextWindow(sid, 'x'), sessions.getContextWindow(sid, 'x', { includeSensitive: false })]) {
      expect.soft(context).not.toContain('PRIVATE-PROMPT-MARKER');
      expect.soft(context).not.toContain('PRIVATE-RESULT-MARKER');
      expect(context).toContain('PUBLIC-PROMPT-MARKER');
      expect(context).toContain('PUBLIC-RESULT-MARKER');
    }
    const privateContext = sessions.getContextWindow(sid, 'x', { includeSensitive: true });
    for (const marker of ['PRIVATE-PROMPT-MARKER', 'PRIVATE-RESULT-MARKER', 'PUBLIC-PROMPT-MARKER', 'PUBLIC-RESULT-MARKER']) {
      expect(privateContext).toContain(marker);
    }
  });

  it('non_private_task_still_stores_and_recalls', () => {
    const sid = newSession();
    const emit = makeEmitter(sid, null, null);
    emit('USER_PROMPT', 'public conversation prompt');
    emit('RESULT', 'public conversation result', { engineUsed: 'test' });
    sessions.storeEpisode('public-memory-preservation', sid, 'SUMMARIZATION', 'publicepisodicmarker', 'public episode result');
    expect(sessions.showEpisodes(sid)).toHaveLength(1);
    const context = sessions.getContextWindow(sid, 'publicepisodicmarker');
    expect(context).toContain('public conversation prompt');
    expect(context).toContain('public conversation result');
    expect(context).toContain('public episode result');
    expect(sessions.getContextWindow(sid, 'publicepisodicmarker', { includeSensitive: true })).toBe(context);
  });

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
