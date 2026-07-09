import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveBudget } from '../packages/gateway/src/dispatch.js';
import { makeRequest } from './helpers.js';

/** TCLAW-0D — cost-breaker unit tests: budget precedence.
 *
 *  resolveBudget resolves the single number the bridge enforces against:
 *    per-request constraints.maxCost  →  env TORQCLAW_DEFAULT_MAX_COST  →  undefined (unlimited).
 *  These tests pin that precedence and the env-parsing edge cases. No pricing
 *  tables, no static model cost — the resolved value is only a user/env budget.
 */

describe('resolveBudget — budget precedence (TCLAW-0D)', () => {
  const ENV = 'TORQCLAW_DEFAULT_MAX_COST';
  let saved: string | undefined;

  beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV]; });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it('per-request maxCost wins over everything', () => {
    process.env[ENV] = '5.00';
    expect(resolveBudget(makeRequest({ maxCost: 0.25 }))).toBe(0.25);
  });

  it('per-request maxCost of 0 is honored (a real, explicit "free-only" budget), not treated as unset', () => {
    // 0 is a number, so precedence rule 1 applies — it must NOT fall through to
    // the env default. A task budgeted at $0 should breaker-trip on any spend.
    process.env[ENV] = '5.00';
    expect(resolveBudget(makeRequest({ maxCost: 0 }))).toBe(0);
  });

  it('falls back to the env default when no per-request maxCost', () => {
    process.env[ENV] = '1.00';
    expect(resolveBudget(makeRequest({}))).toBe(1.0);
  });

  it('returns undefined (unlimited) when neither is set', () => {
    expect(resolveBudget(makeRequest({}))).toBeUndefined();
  });

  it('ignores a non-numeric env default (unlimited)', () => {
    process.env[ENV] = 'not-a-number';
    expect(resolveBudget(makeRequest({}))).toBeUndefined();
  });

  it('ignores a zero or negative env default (unlimited, not a $0 cap)', () => {
    // env default only applies when finite AND > 0 — an accidental 0/negative
    // env value must not silently impose a zero-spend cap on every cloud task.
    process.env[ENV] = '0';
    expect(resolveBudget(makeRequest({}))).toBeUndefined();
    process.env[ENV] = '-1';
    expect(resolveBudget(makeRequest({}))).toBeUndefined();
  });

  it('ignores an empty-string env default (unlimited)', () => {
    process.env[ENV] = '';
    expect(resolveBudget(makeRequest({}))).toBeUndefined();
  });

  it('a per-request maxCost overrides even an unusable env default', () => {
    process.env[ENV] = 'garbage';
    expect(resolveBudget(makeRequest({ maxCost: 2.5 }))).toBe(2.5);
  });
});
