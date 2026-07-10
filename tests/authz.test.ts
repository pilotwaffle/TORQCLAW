import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClientCommand } from '@torqclaw/contracts';
import { authorize, checkResumeRole, type Role, type AuthzContext } from '../packages/gateway/src/authz.js';

const OWNER_SID = 'session-owner';
const OTHER_SID = 'session-other';

/** lookupTaskSession stub: 'known-task' is owned by OWNER_SID; anything else
 *  (including 'unknown-task') is not found. */
function ctxFor(sessionId: string): AuthzContext {
  return {
    sessionId,
    lookupTaskSession: (taskId: string) => (taskId === 'known-task' ? OWNER_SID : null),
  };
}

const submitPrompt: ClientCommand = {
  action: 'SUBMIT_PROMPT',
  prompt: 'hello',
  sensitive: false,
  urgent: false,
  attachmentIds: [],
  executionMode: 'AUTO',
  useMemory: true,
};
const memoryShow: ClientCommand = { action: 'MEMORY', op: 'SHOW' };
const memoryForget: ClientCommand = { action: 'MEMORY', op: 'FORGET_SESSION' };
const approveTool: ClientCommand = { action: 'APPROVE_TOOL', approvalId: 'a1', decision: 'APPROVE' };
const approveSkill: ClientCommand = { action: 'APPROVE_SKILL', queueId: 'q1', decision: 'APPROVE' };
const getSkillDraft: ClientCommand = { action: 'GET_SKILL_DRAFT', queueId: 'q1' };
const cancelKnown: ClientCommand = { action: 'CANCEL_TASK', taskId: 'known-task' };
const cancelUnknown: ClientCommand = { action: 'CANCEL_TASK', taskId: 'unknown-task' };
const listReceipts: ClientCommand = { action: 'LIST_RECEIPTS', limit: 20 };
const getReceipt: ClientCommand = {
  action: 'GET_RECEIPT',
  taskId: '7c1a9e2b-4d3f-4a8c-9b2e-6f5d4c3b2a1f',
  includeEvents: false,
};
const getCostSummary: ClientCommand = { action: 'GET_COST_SUMMARY', recentLimit: 20 };

const future = { action: 'SOME_FUTURE_ACTION' } as any as ClientCommand;

describe('authorize() — role-based command authorization', () => {
  describe('channel role', () => {
    const ctx = ctxFor(OWNER_SID);

    it.each([
      ['APPROVE_TOOL', approveTool],
      ['APPROVE_SKILL', approveSkill],
      ['GET_SKILL_DRAFT', getSkillDraft],
      ['MEMORY FORGET_SESSION', memoryForget],
      ['LIST_RECEIPTS', listReceipts],
      ['GET_RECEIPT', getReceipt],
      ['GET_COST_SUMMARY', getCostSummary],
    ])('%s -> deny', (_name, cmd) => {
      const d = authorize('channel', cmd, ctx);
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toBeTruthy();
    });

    it.each([
      ['SUBMIT_PROMPT', submitPrompt],
      ['MEMORY SHOW', memoryShow],
    ])('%s -> allow', (_name, cmd) => {
      expect(authorize('channel', cmd, ctx)).toEqual({ ok: true });
    });

    it('CANCEL_TASK on own-session task -> allow', () => {
      expect(authorize('channel', cancelKnown, ctxFor(OWNER_SID))).toEqual({ ok: true });
    });

    it('CANCEL_TASK on another session\'s task -> deny', () => {
      const d = authorize('channel', cancelKnown, ctxFor(OTHER_SID));
      expect(d.ok).toBe(false);
    });

    it('CANCEL_TASK on unknown task -> deny', () => {
      const d = authorize('channel', cancelUnknown, ctxFor(OWNER_SID));
      expect(d.ok).toBe(false);
    });

    it('unmapped/future action -> deny (default-deny for non-operator)', () => {
      const d = authorize('channel', future, ctx);
      expect(d.ok).toBe(false);
    });
  });

  describe('operator role', () => {
    const ctx = ctxFor(OWNER_SID);

    it.each([
      ['SUBMIT_PROMPT', submitPrompt],
      ['APPROVE_TOOL', approveTool],
      ['APPROVE_SKILL', approveSkill],
      ['GET_SKILL_DRAFT', getSkillDraft],
      ['MEMORY SHOW', memoryShow],
      ['MEMORY FORGET_SESSION', memoryForget],
      ['CANCEL_TASK known task', cancelKnown],
      ['LIST_RECEIPTS', listReceipts],
      ['GET_RECEIPT', getReceipt],
      ['GET_COST_SUMMARY', getCostSummary],
    ])('%s -> allow', (_name, cmd) => {
      expect(authorize('operator', cmd, ctx)).toEqual({ ok: true });
    });

    it('CANCEL_TASK on unknown task -> allow (harmless no-op downstream)', () => {
      expect(authorize('operator', cancelUnknown, ctx)).toEqual({ ok: true });
    });

    it('unmapped/future action -> allow (operator has full surface)', () => {
      expect(authorize('operator', future, ctx)).toEqual({ ok: true });
    });
  });

  describe('node role', () => {
    const ctx = ctxFor(OWNER_SID);

    it.each([
      ['SUBMIT_PROMPT', submitPrompt],
      ['APPROVE_TOOL', approveTool],
      ['APPROVE_SKILL', approveSkill],
      ['GET_SKILL_DRAFT', getSkillDraft],
      ['MEMORY SHOW', memoryShow],
      ['MEMORY FORGET_SESSION', memoryForget],
      ['CANCEL_TASK known task', cancelKnown],
      ['CANCEL_TASK unknown task', cancelUnknown],
      ['unmapped/future action', future],
      ['LIST_RECEIPTS', listReceipts],
      ['GET_RECEIPT', getReceipt],
      ['GET_COST_SUMMARY', getCostSummary],
    ])('%s -> deny', (_name, cmd) => {
      const d = authorize('node', cmd, ctx);
      expect(d.ok).toBe(false);
    });
  });

  it('deny reasons never leak internals', () => {
    const ctx = ctxFor(OWNER_SID);
    const denials = [
      authorize('channel', approveTool, ctx),
      authorize('channel', cancelUnknown, ctx),
      authorize('node', submitPrompt, ctx),
    ];
    for (const d of denials) {
      expect(d.ok).toBe(false);
      if (!d.ok) {
        expect(d.reason).not.toMatch(/session-|sql|select|table|db\.|stack/i);
      }
    }
  });
});

describe('checkResumeRole() — resume-role escalation guard (production path)', () => {
  const ROLES: Role[] = ['operator', 'channel', 'node'];

  describe('resume + matching role -> ok', () => {
    it.each(ROLES)('resume as %s with stored %s -> ok', (r) => {
      expect(checkResumeRole(true, r, r)).toEqual({ ok: true });
    });
  });

  describe('resume + mismatched role -> reject (every ordered pair)', () => {
    const mismatches = ROLES.flatMap((stored) =>
      ROLES.filter((frame) => frame !== stored).map((frame) => [stored, frame] as const),
    );
    it.each(mismatches)('stored=%s, frame=%s -> reject', (stored, frame) => {
      const d = checkResumeRole(true, stored, frame);
      expect(d.ok).toBe(false);
      if (!d.ok) {
        expect(d.reason).toBeTruthy();
        // Reason must not leak internals.
        expect(d.reason).not.toMatch(/sql|select|table|db\.|stack/i);
      }
    });
  });

  describe('fresh session (resumed=false) -> guard does not apply', () => {
    it.each(ROLES)('fresh session as %s -> ok even against a differing stored value', (r) => {
      // On the create path the frame role IS the persisted role, but the guard
      // must be inert for ANY input when resumed=false — it only polices RESUME.
      const other = ROLES.find((x) => x !== r)!;
      expect(checkResumeRole(false, other, r)).toEqual({ ok: true });
      expect(checkResumeRole(false, r, r)).toEqual({ ok: true });
    });
  });
});

describe('sessions.resolve() + checkResumeRole — connect-path integration (TCLAW-0B)', () => {
  it('resume with the same session id returns the persisted role', async () => {
    process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-authz-'));
    const { sessions } = await import('../packages/gateway/src/sessions.js');

    const created = sessions.resolve({
      role: 'operator',
      token: 't',
      clientInfo: { name: 'x', version: '0' },
    } as any);
    expect(created.resumed).toBe(false);
    expect(created.role).toBe('operator');

    const resumed = sessions.resolve({
      role: 'operator',
      token: 't',
      sessionId: created.sessionId,
      clientInfo: { name: 'x', version: '0' },
    } as any);
    expect(resumed.resumed).toBe(true);
    expect(resumed.role).toBe('operator');
  });

  it('operator session resumed as channel is rejected by the guard (and vice versa)', async () => {
    // Same two calls the production connect path makes, in order:
    // resolve() against the real sqlite sessions table, then checkResumeRole()
    // with the resolved (persisted) role vs the incoming frame role.
    process.env.TORQCLAW_DATA_DIR = mkdtempSync(join(tmpdir(), 'torq-authz-guard-'));
    const { sessions } = await import('../packages/gateway/src/sessions.js');

    const connect = (role: string, sessionId?: string) =>
      sessions.resolve({
        role, token: 't', sessionId, clientInfo: { name: 'x', version: '0' },
      } as any);

    // (1) operator session hijacked by a channel client -> reject.
    const op = connect('operator');
    const hijackAsChannel = connect('channel', op.sessionId);
    expect(hijackAsChannel.resumed).toBe(true); // row matched — resolve alone does NOT protect
    const d1 = checkResumeRole(hijackAsChannel.resumed, hijackAsChannel.role, 'channel');
    expect(d1.ok).toBe(false);

    // (2) inverse: channel session escalated to operator -> reject.
    const ch = connect('channel');
    const escalateAsOperator = connect('operator', ch.sessionId);
    expect(escalateAsOperator.resumed).toBe(true);
    const d2 = checkResumeRole(escalateAsOperator.resumed, escalateAsOperator.role, 'operator');
    expect(d2.ok).toBe(false);

    // (3) legitimate resume with the matching role -> ok.
    const legit = connect('operator', op.sessionId);
    const d3 = checkResumeRole(legit.resumed, legit.role, 'operator');
    expect(d3).toEqual({ ok: true });
  });
});
