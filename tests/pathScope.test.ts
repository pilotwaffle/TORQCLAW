import { describe, it, expect } from 'vitest';
import { checkPath, extractPaths, normalizePath } from '../packages/bridge/src/pathScope.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

describe('normalizePath', () => {
  it('expands a leading ~', () => {
    expect(normalizePath('~/x')).toBe(resolve(homedir(), 'x'));
  });
  it('collapses .. segments', () => {
    expect(normalizePath('/a/b/../c')).toBe(resolve('/a/c'));
  });
});

describe('checkPath — deny always wins (P5 traversal guard)', () => {
  const scope = { read: ['/work'], write: ['/work'], deny: ['/work/secrets', '~/.ssh'] };

  it('allows a path inside the allowed dir', () => {
    expect(checkPath('/work/notes.txt', scope, 'read')).toBeNull();
  });
  it('denies a path outside the allowed dir', () => {
    expect(checkPath('/etc/passwd', scope, 'read')).toMatch(/outside the allowed/);
  });
  it('denies a path under a deny dir even if under an allow dir', () => {
    expect(checkPath('/work/secrets/key', scope, 'read')).toMatch(/blocked path/);
  });
  it('THE TRAVERSAL CASE: /work/../etc resolves out of scope and is denied', () => {
    expect(checkPath('/work/../etc/passwd', scope, 'read')).toMatch(/outside the allowed/);
  });
  it('THE TRAVERSAL CASE: a deny cannot be bypassed via ..', () => {
    // /work/sub/../secrets resolves to /work/secrets which is denied
    expect(checkPath('/work/sub/../secrets/k', scope, 'read')).toMatch(/blocked path/);
  });
  it('~ deny is honored after expansion', () => {
    expect(checkPath('~/.ssh/id_rsa', scope, 'read')).toMatch(/blocked path/);
    expect(checkPath('~/.ssh/../.ssh/id_rsa', scope, 'read')).toMatch(/blocked path/);
  });
  it('boundary-aware: /workshop is NOT under /work', () => {
    expect(checkPath('/workshop/file', scope, 'read')).toMatch(/outside the allowed/);
  });
  it('empty allowlist for a mode = unconstrained (deny still applies)', () => {
    const s = { deny: ['/secret'] };
    expect(checkPath('/anything', s, 'write')).toBeNull();
    expect(checkPath('/secret/x', s, 'write')).toMatch(/blocked path/);
  });
});

describe('extractPaths', () => {
  it('uses pathArgKeys hint when provided', () => {
    expect(extractPaths({ path: '/a', other: '/b' }, ['path'])).toEqual(['/a']);
  });
  it('falls back to common keys', () => {
    expect(extractPaths({ filename: '/a', destination: '/b' })).toEqual(expect.arrayContaining(['/a', '/b']));
  });
  it('handles array-valued path args', () => {
    expect(extractPaths({ paths: ['/a', '/b'] }, ['paths'])).toEqual(['/a', '/b']);
  });
  it('ignores non-string / missing keys', () => {
    expect(extractPaths({ path: 42, nope: '/x' }, ['path'])).toEqual([]);
    expect(extractPaths(null)).toEqual([]);
  });
});
