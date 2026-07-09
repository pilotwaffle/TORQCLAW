import { randomUUID } from 'node:crypto';
import { db } from './storage.js';
import type { ConnectFrame, GatewayEvent } from '@torqclaw/contracts';

const PER_EVENT_CHAR_CAP = 1_200;   // one giant RESULT must not eat the window
const TOTAL_CONTEXT_CHAR_BUDGET = 8_000; // ~2k tokens of assembled history

const clip = (s: string, n: number) =>
  s.length > n ? s.slice(0, n) + ` …[+${s.length - n} chars]` : s;

/** FTS5 query hygiene: quote each token so user symbols can't inject syntax. */
function toFtsQuery(prompt: string): string | null {
  const tokens = prompt
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export const sessions = {
  /** Resume if the client presented a known sessionId; create otherwise.
   *  Sessions are durable identity — sockets are ephemeral plumbing. */
  resolve(frame: ConnectFrame): { sessionId: string; resumed: boolean; role: string } {
    if (frame.sessionId) {
      const row = db.prepare('SELECT id, role FROM sessions WHERE id = ?').get(frame.sessionId) as
        | { id: string; role: string }
        | undefined;
      if (row) {
        db.prepare('UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(frame.sessionId);
        return { sessionId: frame.sessionId, resumed: true, role: row.role };
      }
    }
    const sessionId = randomUUID();
    db.prepare('INSERT INTO sessions (id, role, client_name) VALUES (?, ?, ?)')
      .run(sessionId, frame.role, frame.clientInfo.name);
    return { sessionId, resumed: false, role: frame.role };
  },

  /** Replay by monotonic seq cursor — never by timestamp. */
  getEventLogSince(sessionId: string, lastSeenSeq: number | null): GatewayEvent[] {
    const rows = lastSeenSeq == null
      ? db.prepare(
          `SELECT * FROM (
             SELECT * FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 100
           ) ORDER BY seq ASC`,
        ).all(sessionId)
      : db.prepare(
          'SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC',
        ).all(sessionId, lastSeenSeq);
    return (rows as any[]).map(rowToEvent);
  },

  /**
   * Tiered context assembly (Hermes pattern):
   *   Tier 1 — recent verbatim turns (USER_PROMPT + RESULT), char-capped.
   *   Tier 2 — FTS5-recalled summaries of relevant past episodes.
   * One indexed query + one sub-ms FTS5 match; no LLM in the hot path.
   */
  getContextWindow(sessionId: string, currentPrompt: string): string {
    const recent = db.prepare(
      `SELECT type, message FROM (
         SELECT seq, type, message FROM events
         WHERE session_id = ? AND type IN ('USER_PROMPT', 'RESULT')
         ORDER BY seq DESC LIMIT 10
       ) ORDER BY seq ASC`,
    ).all(sessionId) as Array<{ type: string; message: string }>;

    let budget = TOTAL_CONTEXT_CHAR_BUDGET;
    const shortTerm: string[] = [];
    for (const e of recent.reverse()) {       // newest-first while spending budget
      const line = `${e.type === 'USER_PROMPT' ? 'USER' : 'AGENT'}: ${clip(e.message, PER_EVENT_CHAR_CAP)}`;
      if (budget - line.length < 0) break;
      budget -= line.length;
      shortTerm.unshift(line);                // restore chronological order
    }

    let longTerm = '';
    const fts = toFtsQuery(currentPrompt);
    if (fts) {
      try {
        const recall = db.prepare(
          'SELECT summary FROM task_search WHERE task_search MATCH ? ORDER BY rank LIMIT 3',
        ).all(fts) as Array<{ summary: string }>;
        if (recall.length > 0) {
          longTerm =
            '[RELEVANT PAST KNOWLEDGE]\n' +
            recall.map((r) => clip(r.summary, PER_EVENT_CHAR_CAP)).join('\n') + '\n\n';
        }
      } catch { /* malformed FTS query — recall is best-effort, never fatal */ }
    }

    return shortTerm.length > 0
      ? `${longTerm}[RECENT CONTEXT]\n${shortTerm.join('\n---\n')}`
      : longTerm;
  },

  /** v1: naive truncation summary. v2: pipe through the local model. */
  storeEpisode(
    requestId: string, sessionId: string, taskType: string,
    prompt: string, result: string,
  ): void {
    const summary = `Task(${taskType}): ${clip(prompt, 200)} -> ${clip(result, 500)}`;
    db.prepare(
      `INSERT OR IGNORE INTO task_episodes
       (request_id, session_id, task_type, original_prompt, final_result, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(requestId, sessionId, taskType, prompt, result, summary);
  },

  /** P4.5: episode summaries this session remembers (newest first). */
  showEpisodes(sessionId: string): Array<{ taskType: string; summary: string; timestamp: string }> {
    return db.prepare(
      `SELECT task_type AS taskType, summary, timestamp
         FROM task_episodes WHERE session_id = ? ORDER BY rowid DESC LIMIT 50`,
    ).all(sessionId) as Array<{ taskType: string; summary: string; timestamp: string }>;
  },

  /** P4.5: forget this session's memory. Deleting the rows fires the FTS5
   *  delete trigger (schema §6), which keeps the search index consistent — the
   *  exact reason those triggers exist. Returns the number forgotten. */
  forgetSession(sessionId: string): number {
    const info = db.prepare('DELETE FROM task_episodes WHERE session_id = ?').run(sessionId);
    return Number(info.changes);
  },
};

function rowToEvent(r: any): GatewayEvent {
  return {
    seq: r.seq, id: r.id, requestId: r.request_id, sessionId: r.session_id,
    tier: r.tier, type: r.type, message: r.message,
    metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    timestamp: new Date(r.timestamp + 'Z').toISOString(),
  };
}
