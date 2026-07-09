import { describe, it, expect } from 'vitest';
import {
  classifyCapability,
  isWriteClass,
  scopeModeFor,
  type Capability,
} from '../packages/bridge/src/capability.js';

describe('isWriteClass()', () => {
  it.each([
    ['write', true],
    ['exec', true],
    ['send', true],
    ['read', false],
  ] as [Capability, boolean][])('%s -> %s', (cap, expected) => {
    expect(isWriteClass(cap)).toBe(expected);
  });
});

describe('scopeModeFor()', () => {
  it.each([
    ['write', 'write'],
    ['exec', 'write'],
    ['send', 'write'],
    ['read', 'read'],
  ] as [Capability, 'read' | 'write'][])('%s -> %s', (cap, expected) => {
    expect(scopeModeFor(cap)).toBe(expected);
  });
});

describe('classifyCapability() — PRESERVED-DEFAULT (anti-regression vs old DEFAULT_WRITE_PATTERNS)', () => {
  // Every token that used to appear in registry.ts's DEFAULT_WRITE_PATTERNS
  // must still classify write-class under the new behavior-based classifier.
  // 'push' required extending P4_WRITE with an UNANCHORED `push` — `_` is a
  // regex word character, so \bpush\b would not match push_changes/git_push;
  // the unanchored form is the real P4 signal (G2A finding 3).
  const OLD_TOKENS = ['write', 'delete', 'push', 'create', 'update', 'send', 'exec'];

  it.each(OLD_TOKENS)('name containing "%s" classifies write-class', (token) => {
    const name = `some_${token}_tool`;
    const cap = classifyCapability(name, undefined, undefined);
    expect(isWriteClass(cap)).toBe(true);
  });

  it('bare old-default tokens (exact name) all classify write-class', () => {
    for (const token of OLD_TOKENS) {
      const cap = classifyCapability(token, undefined, undefined);
      expect(isWriteClass(cap)).toBe(true);
    }
  });

  it('explicit parity table: old-default-gated names still write-class', () => {
    const examples: Record<string, string> = {
      write: 'write_file',
      delete: 'delete_row',
      push: 'push_branch',
      create: 'create_issue',
      update: 'update_record',
      send: 'send_email',
      exec: 'exec_command',
    };
    for (const [token, name] of Object.entries(examples)) {
      const cap = classifyCapability(name, undefined, undefined);
      expect(isWriteClass(cap), `token "${token}" (name "${name}") should be write-class, got "${cap}"`).toBe(true);
    }
  });

  // G2A finding 3: \bpush\b did NOT match underscore-joined names (`_` is a
  // word character, so there is no \b boundary before/after it) — these only
  // reached write-class via the P6 fail-closed default. The unanchored `push`
  // makes them genuine P4 matches.
  it.each(['push_changes', 'git_push', 'push_branch'])(
    '%s -> write via the P4 push signal',
    (name) => {
      expect(classifyCapability(name, undefined, undefined)).toBe('write');
    },
  );

  it('get_push_status -> write (proves the P4 push signal fires, not P6: a dead push pattern would fall to P5 read)', () => {
    // Name starts with a P5 read-safe prefix, so if the push pattern were
    // still dead (as \bpush\b was), P5 would classify this 'read'. Only a
    // live P4 match can yield 'write' here — this cannot pass via P6.
    expect(classifyCapability('get_push_status', undefined, undefined)).toBe('write');
  });
});

describe('classifyCapability() — read tools ungated', () => {
  it.each(['get_quote', 'list_tables', 'read_file', 'search_docs', 'fetch_url'])(
    '%s -> read, isWriteClass=false',
    (name) => {
      const cap = classifyCapability(name, undefined, undefined);
      expect(cap).toBe('read');
      expect(isWriteClass(cap)).toBe(false);
    },
  );
});

describe('classifyCapability() — BUG FIX: config/annotation overrides on innocuous or misleading names', () => {
  it('innocent-named "apply" with configCapability "write" -> write-class', () => {
    const cap = classifyCapability('apply', undefined, 'write');
    expect(cap).toBe('write');
    expect(isWriteClass(cap)).toBe(true);
  });

  it('innocent-named "commit" with annotations {destructiveHint:true} -> write-class', () => {
    const cap = classifyCapability('commit', { destructiveHint: true }, undefined);
    expect(cap).toBe('write');
    expect(isWriteClass(cap)).toBe(true);
  });
});

describe('classifyCapability() — FAIL-CLOSED default', () => {
  it('opaque name "frobnicate", no annotations, no config -> write (fail-closed)', () => {
    const cap = classifyCapability('frobnicate', undefined, undefined);
    expect(cap).toBe('write');
    expect(isWriteClass(cap)).toBe(true);
  });
});

describe('classifyCapability() — PRIORITY (P1 config overrides everything)', () => {
  it('config "read" on a "delete_thing" name -> read (override wins)', () => {
    const cap = classifyCapability('delete_thing', undefined, 'read');
    expect(cap).toBe('read');
  });

  it('annotations {readOnlyHint:true} overridden by config "write" -> write', () => {
    const cap = classifyCapability('some_tool', { readOnlyHint: true }, 'write');
    expect(cap).toBe('write');
  });
});

describe('classifyCapability() — PRECEDENCE (P4 beats P5)', () => {
  it('"delete_after_read" -> write (delete pattern wins over read-safe allowlist)', () => {
    const cap = classifyCapability('delete_after_read', undefined, undefined);
    expect(cap).toBe('write');
  });

  // G2A finding 2: destructive verbs outside the original P4 set slipped
  // through to P5 when the name started with a read-safe prefix, classifying
  // as ungated read. destroy/drop/kill/wipe/purge/truncate are now in
  // P4_DELETE, so P4 catches them before P5 can.
  it.each([
    'query_drop_table',
    'searchAndDestroy',
    'status_kill',
    'info_wipe',
    'describe_and_purge',
    'lookup_truncate',
  ])('read-prefixed destructive name %s -> write-class (P4 destructive verb beats P5 prefix)', (name) => {
    const cap = classifyCapability(name, undefined, undefined);
    expect(cap).toBe('write');
    expect(isWriteClass(cap)).toBe(true);
  });
});

describe('classifyCapability() — P3 MCP annotations (no config, no P4/P5 name match)', () => {
  it('readOnlyHint true on an opaque name -> read', () => {
    const cap = classifyCapability('frobnicate_status_thing_xyz', { readOnlyHint: true }, undefined);
    // NOTE: name contains no P4/P5 pattern token; annotation should decide.
    expect(cap).toBe('read');
  });

  it('destructiveHint true on an opaque name -> write', () => {
    const cap = classifyCapability('zzz_opaque_zzz', { destructiveHint: true }, undefined);
    expect(cap).toBe('write');
  });

  it('openWorldHint true on an opaque name -> write', () => {
    const cap = classifyCapability('zzz_opaque_zzz2', { openWorldHint: true }, undefined);
    expect(cap).toBe('write');
  });

  it('annotations object present but all fields undefined -> falls through to name/default', () => {
    const cap = classifyCapability('get_thing', {}, undefined);
    expect(cap).toBe('read'); // P5 read-safe allowlist catches it
  });
});
