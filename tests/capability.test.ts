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

describe('classifyCapability() — P1 config annotation (operator override, always wins)', () => {
  it.each([
    ['read', 'read'],
    ['write', 'write'],
    ['exec', 'exec'],
    ['send', 'send'],
  ] as [Capability, Capability][])('configCapability %s passes through as %s', (configCap, expected) => {
    expect(classifyCapability('anything', undefined, configCap)).toBe(expected);
  });
});

describe('classifyCapability() — P3 MCP annotations', () => {
  it('readOnlyHint true -> read', () => {
    expect(classifyCapability('mytool', { readOnlyHint: true }, undefined)).toBe('read');
  });

  it('destructiveHint true -> write', () => {
    expect(classifyCapability('mytool', { destructiveHint: true }, undefined)).toBe('write');
  });

  it('openWorldHint true -> write', () => {
    expect(classifyCapability('mytool', { openWorldHint: true }, undefined)).toBe('write');
  });

  it('P1 config overrides P3 annotation: readOnlyHint true + config write -> write', () => {
    expect(classifyCapability('x', { readOnlyHint: true }, 'write')).toBe('write');
  });

  it('annotations object present but all fields undefined -> falls through (fail-closed write, no name-based read)', () => {
    const cap = classifyCapability('get_thing', {}, undefined);
    expect(cap).toBe('write');
  });
});

describe('classifyCapability() — P4 write-name patterns (token-bounded)', () => {
  it.each([
    ['delete_file', 'write'],
    ['remove_item', 'write'],
    ['push_changes', 'write'],
    ['git_push', 'write'],
    ['create_record', 'write'],
    ['send_email', 'write'],
    ['exec_shell', 'write'], // category assertion covered separately below
    ['run_command', 'write'],
    ['encrypt_blob', 'write'],
    ['rotate_key', 'write'],
    ['deploy_stack', 'write'],
  ] as [string, Capability][])('%s -> write-class', (name) => {
    const cap = classifyCapability(name, undefined, undefined);
    expect(isWriteClass(cap)).toBe(true);
  });

  // Category correctness: destructive/exec/send verbs resolve to their own
  // sub-kind, not just the generic 'write' bucket (matters for the approval
  // card's displayed capability class).
  it.each([
    ['delete_file', 'write'],
    ['remove_item', 'write'],
    ['exec_shell', 'exec'],
    ['run_command', 'exec'],
    ['send_email', 'send'],
  ] as [string, Capability][])('%s -> exact category %s', (name, expected) => {
    expect(classifyCapability(name, undefined, undefined)).toBe(expected);
  });

  it('push_changes / git_push / push_branch -> write (unanchored push token)', () => {
    for (const name of ['push_changes', 'git_push', 'push_branch']) {
      expect(classifyCapability(name, undefined, undefined)).toBe('write');
    }
  });

  it('token-bounding: get_process_list does NOT match the exec set (process is a noun here) -> fail-closed write, not gated as read', () => {
    // 'process' is deliberately excluded from P4_EXEC. This falls through to
    // P6 fail-closed 'write' — acceptable/correct, since there is no read
    // path from names at all anymore.
    expect(classifyCapability('get_process_list', undefined, undefined)).toBe('write');
  });

  it('token-bounding: get_deployment does NOT match the write set (deployment != deploy token) -> fail-closed write', () => {
    expect(classifyCapability('get_deployment', undefined, undefined)).toBe('write');
  });

  it('token-bounding: get_deploy_config DOES match (deploy is an exact token) -> write', () => {
    expect(classifyCapability('get_deploy_config', undefined, undefined)).toBe('write');
  });

  it('legacy 7 write tokens (old DEFAULT_WRITE_PATTERNS) still write-class', () => {
    const OLD_TOKENS = ['write', 'delete', 'push', 'create', 'update', 'send', 'exec'];
    for (const token of OLD_TOKENS) {
      const cap = classifyCapability(`some_${token}_tool`, undefined, undefined);
      expect(isWriteClass(cap)).toBe(true);
    }
  });

  it('delete_after_read -> write (destructive token wins; no read grammar exists to contest it)', () => {
    expect(classifyCapability('delete_after_read', undefined, undefined)).toBe('write');
  });
});

describe('classifyCapability() — FAIL-CLOSED READS (finding-2 v3: the key behavior change)', () => {
  // These are all genuinely read-only tools by name/intent. Under the new
  // design there is NO name->read path at all, so — absent a P1 config
  // annotation or P3 readOnlyHint — every one of these now correctly
  // fail-closes to write-class. This is intentional over-gating per
  // PRD-TCLAW-TRUSTOS-001 ("unknown never means read"); the remedy is for
  // the operator to annotate these tools via servers.json `capabilities`
  // (P1) or for the server to publish readOnlyHint (P3). See the
  // "ANNOTATION REMEDY" describe block below for the fix in action.
  it.each([
    'get_all_secrets',
    'read_private_key',
    'fetch_credentials',
    'quote_get',
    'symbol_info',
    'chart_get_state',
    'get_user_profile',
    'list_tables',
    'read_file',
    'poll_status',
    'whoami',
    'get_process_list',
    'get_deployment',
    'slack_get_users',
  ])('%s -> write-class (fail-closed; no name-based read path exists)', (name) => {
    const cap = classifyCapability(name, undefined, undefined);
    expect(isWriteClass(cap)).toBe(true);
    expect(cap).toBe('write');
  });

  it('get_all_secrets specifically -> write (was a P5-leaking honest-dangerous name in the prior design; now correctly gated)', () => {
    expect(classifyCapability('get_all_secrets', undefined, undefined)).toBe('write');
  });

  it('read_private_key specifically -> write (was a P5-leaking honest-dangerous name in the prior design; now correctly gated)', () => {
    expect(classifyCapability('read_private_key', undefined, undefined)).toBe('write');
  });

  it('quote_get (TradingView) -> write until annotated (this repo\'s entire TradingView read surface fails closed by default)', () => {
    expect(classifyCapability('quote_get', undefined, undefined)).toBe('write');
  });
});

describe('classifyCapability() — ANNOTATION REMEDY (proves the operator fix works)', () => {
  it('quote_get with configCapability "read" -> read (P1 annotation remedy)', () => {
    expect(classifyCapability('quote_get', undefined, 'read')).toBe('read');
  });

  it('get_all_secrets with configCapability "read" -> read (operator can still explicitly opt in, by design; this is P1\'s job)', () => {
    expect(classifyCapability('get_all_secrets', undefined, 'read')).toBe('read');
  });

  it('a read-only server publishing readOnlyHint gets read without any config (P3 remedy)', () => {
    expect(classifyCapability('quote_get', { readOnlyHint: true }, undefined)).toBe('read');
  });
});

describe('classifyCapability() — homoglyph name (now moot: no name->read path exists at all)', () => {
  it('get_рush_remote (Cyrillic р U+0440), no annotation -> write (fail-closed, same as any other unannotated name)', () => {
    const name = 'get_рush_remote';
    expect(/[^\x00-\x7F]/.test(name)).toBe(true); // sanity: fixture really is non-ASCII
    expect(classifyCapability(name, undefined, undefined)).toBe('write');
  });
});

describe('classifyCapability() — legacy names that used to classify read now correctly fail-closed to write', () => {
  // Previously (P5 whole-name read grammar), these read-verb+noun names
  // classified as ungated 'read'. There is no such grammar anymore — they
  // now correctly fail-closed to write-class, remedied by annotation.
  it.each([
    'get_user',
    'list_tables',
    'read_file',
    'search_docs',
    'get_user_profile',
    'describe_schema',
    'fetch_url',
    'query_status',
    'get_account_balance',
    'list_open_orders',
    'get_address',
    'list_additional_info',
  ])('%s -> write (fail-closed; remedied via P1/P3 annotation, not name inference)', (name) => {
    const cap = classifyCapability(name, undefined, undefined);
    expect(cap).toBe('write');
    // And the remedy still works for each:
    expect(classifyCapability(name, undefined, 'read')).toBe('read');
  });
});

describe('classifyCapability() — opaque/unknown name, no signal at all', () => {
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

// ---------------------------------------------------------------------------
// PERMANENT REGRESSION GUARD (do not remove/weaken without re-running the
// adversarial audit that motivated it).
//
// WHY THIS EXISTS: the classifier's core invariant is that there is NO path
// from a bare tool name to 'read' — 'read' can only be reached via P1
// (explicit servers.json `capabilities` annotation) or P3 (a trustworthy MCP
// `readOnlyHint`). Every other name, including honest read-only ones, MUST
// fail closed to a write-class capability (isWriteClass === true). This
// invariant was proven by adversarial audit, but it was NOT the first design:
// two prior name-based classifiers both looked reasonable and both leaked —
// a prefix allowlist leaked 196 dangerous names as 'read', and a whole-name
// "read grammar" leaked 62 honest-dangerous names (get_all_secrets-shaped
// names) as 'read' while ALSO over-gating 100% of real read tools anyway.
// Because the failure mode is "silently classify something dangerous as
// read, with no runtime signal," a future refactor of classifyByNameTokens /
// classifyCapability could reintroduce a name->read shortcut without any
// other test noticing (most other tests exercise a handful of specific
// names). This corpus is a broad, frozen, adversarially-curated sample
// spanning multiple attack shapes; it exists specifically to catch that
// regression class. Do not delete or ASCII-ify the unicode fixtures below —
// see the local non-ASCII assertions guarding against that.
describe('no name→read path (security invariant regression guard)', () => {
  // Frozen corpus (~34 names) spanning:
  //  - honest-dangerous exfil names (no obfuscation at all — these should be
  //    the most "obviously bad if they classified as read" entries)
  //  - read-verb + missing-denylist-verb (a "get_" read-shaped prefix in
  //    front of a write/destructive verb that ISN'T in a denylist, i.e. no
  //    denylist can save you — the classifier must not special-case "get_")
  //  - tokenization-split evasion (verbs split with digits/extra chars to
  //    dodge a hypothetical exact-match denylist, e.g. "de_provision",
  //    "del_ete", "dr0p_table", "w1pe_disk", "rm_rf")
  //  - homoglyph / unicode evasion (Cyrillic look-alike characters and a
  //    fullwidth-character variant standing in for ASCII letters)
  //  - ordinary read-shaped names that must ALSO fail closed (these are not
  //    attacks at all — they're the intentional over-gating this design
  //    accepts; included here to prove the corpus isn't cherry-picked to
  //    only include "attacks")
  const NO_READ_CORPUS = Object.freeze([
    // -- honest-dangerous exfil (no obfuscation) --
    'get_all_secrets',
    'read_private_key',
    'fetch_credentials',
    'get_ssh_keys',
    'read_env_file',
    'get_service_account_key',
    'dump_secrets',
    'get_seed_phrase',

    // -- read-verb + missing-denylist-verb (no denylist entry can save you) --
    'get_rotate_secret',
    'get_impersonate_user',
    'get_deprovision_user',
    'get_wire_money',
    'get_liquidate_position',
    'get_market_sell',

    // -- tokenization-split evasion --
    'get_de_provision',
    'get_del_ete',
    'get_dr0p_table',
    'get_w1pe_disk',
    'get_rm_rf',

    // -- homoglyph / unicode evasion --
    'get_рush_remote', // Cyrillic а/р stand-in: U+0440 CYRILLIC SMALL LETTER ER ("р")
    'list_ѕtatus', // U+0455 CYRILLIC SMALL LETTER DZE ("ѕ")
    'get_ｓtatus', // U+FF53 FULLWIDTH LATIN SMALL LETTER S ("ｓ")

    // -- ordinary read-shaped names that must ALSO fail closed --
    'quote_get',
    'symbol_info',
    'chart_get_state',
    'get_user_profile',
    'list_tables',
    'read_file',
    'poll_status',
    'whoami',
    'slack_get_users',
    'get_process_list',
    'get_deployment',
  ]);

  it('sanity: NO_READ_CORPUS has ~34 representative entries', () => {
    expect(NO_READ_CORPUS.length).toBeGreaterThanOrEqual(30);
    expect(NO_READ_CORPUS.length).toBeLessThanOrEqual(40);
  });

  // Local non-ASCII guard: these three entries specifically MUST contain a
  // non-ASCII character, so a future editor can't "clean up" the fixture by
  // silently replacing the homoglyphs with plain ASCII letters (which would
  // quietly delete the homoglyph-evasion coverage while leaving the test
  // green). If this fails, the unicode fixtures were tampered with.
  it.each([
    'get_рush_remote',
    'list_ѕtatus',
    'get_ｓtatus',
  ])('unicode fixture %s is genuinely non-ASCII', (name) => {
    expect(/[^\x00-\x7F]/.test(name)).toBe(true);
  });

  it.each(NO_READ_CORPUS)(
    '%s must classify as write-class (never read) with no annotation/config',
    (name) => {
      const result = classifyCapability(name, undefined, undefined);
      expect(isWriteClass(result), `expected "${name}" to be write-class but got "${result}"`).toBe(true);
    },
  );

  // NON-VACUOUS CONTROLS: prove the guard above can actually fail, i.e. that
  // 'read' is a reachable outcome of classifyCapability at all. Without
  // these, the corpus test could pass trivially forever even if 'read' were
  // completely unreachable from any input (a vacuous, meaningless guard).
  describe('non-vacuousness controls (read IS reachable via P1/P3, proving the guard has teeth)', () => {
    it('P3 control: get_all_secrets with readOnlyHint:true -> read', () => {
      expect(classifyCapability('get_all_secrets', { readOnlyHint: true }, undefined)).toBe('read');
    });

    it('P1 control: get_all_secrets with configCapability "read" -> read', () => {
      expect(classifyCapability('get_all_secrets', undefined, 'read')).toBe('read');
    });
  });
});

describe('classifyCapability() — innocuous or misleading names with explicit config/annotation', () => {
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
