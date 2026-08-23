import { describe, expect, it, vi } from 'vitest';
import {
  AgentTurnClaimError,
  claimAgentTurn,
  type AutoreplyDb,
} from '../packages/collab/src/autoReply.js';

const params = {
  channelId: 'channel-1',
  agentPrincipalId: 'agent-1',
  channelSeq: 1,
  triggerEventId: 'event-1',
  nowIso: '2026-08-21T00:00:00.000Z',
};

function dbWithRun(run: (...args: unknown[]) => unknown): AutoreplyDb {
  return {
    prepare: () => ({ run, get: vi.fn(), all: vi.fn() }),
  };
}

function sqliteError(code: string, message = 'raw SQL and sensitive row detail'): Error {
  return Object.assign(new Error(message), { code });
}

describe('claimAgentTurn SQLite error classification', () => {
  it.each(['SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_UNIQUE'])(
    'keeps duplicate claim %s idempotent',
    (code) => {
      const run = vi.fn(() => { throw sqliteError(code); });
      expect(claimAgentTurn(dbWithRun(run), params)).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it('retries a bounded SQLITE_BUSY claim and succeeds', () => {
    const run = vi.fn()
      .mockImplementationOnce(() => { throw sqliteError('SQLITE_BUSY'); })
      .mockImplementationOnce(() => { throw sqliteError('SQLITE_BUSY_SNAPSHOT'); })
      .mockImplementationOnce(() => ({ changes: 1 }));

    expect(claimAgentTurn(dbWithRun(run), params)).toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('surfaces exhausted locking without leaking the raw SQLite message', () => {
    const run = vi.fn(() => { throw sqliteError('SQLITE_LOCKED', 'SECRET_ROW_CONTENT'); });
    let caught: unknown;
    try {
      claimAgentTurn(dbWithRun(run), params);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentTurnClaimError);
    expect(String(caught)).toContain('AGENT_TURN_CLAIM_FAILED sqlite_code=SQLITE_LOCKED');
    expect(String(caught)).not.toContain('SECRET_ROW_CONTENT');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('surfaces non-duplicate database errors instead of misclassifying them', () => {
    const run = vi.fn(() => { throw sqliteError('SQLITE_IOERR', 'SECRET_SQL_TEXT'); });
    expect(() => claimAgentTurn(dbWithRun(run), params)).toThrow(
      'AGENT_TURN_CLAIM_FAILED sqlite_code=SQLITE_IOERR',
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});
