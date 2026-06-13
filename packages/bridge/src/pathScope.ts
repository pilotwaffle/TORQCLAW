import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';

/** Per-server filesystem scope. Empty arrays = unconstrained for that mode.
 *  `deny` ALWAYS wins. All comparisons are on RESOLVED paths (P5 refinement):
 *  `~/projects/../.ssh` must not bypass a `~/.ssh` deny — so we expand `~`,
 *  collapse `..`, and prefix-match on path boundaries, never raw substrings. */
export interface PathScope {
  read?: string[];
  write?: string[];
  deny?: string[];
}

/** Expand a leading ~ to the home dir, then resolve to an absolute, normalized
 *  path (collapses .., ., duplicate separators). */
export function normalizePath(p: string): string {
  const expanded = p === '~' || p.startsWith('~/') || p.startsWith('~\\')
    ? homedir() + p.slice(1)
    : p;
  return resolve(expanded);
}

/** True if `child` is `base` or lives under it — boundary-aware so `/a/bcd` is
 *  NOT under `/a/b`. Both must already be normalized. */
function isUnder(child: string, base: string): boolean {
  if (child === base) return true;
  const b = base.endsWith(sep) ? base : base + sep;
  return child.startsWith(b);
}

export type ScopeMode = 'read' | 'write';

/** Decide whether a resolved path may be touched. Returns null if allowed, or a
 *  human-readable denial reason. deny wins; then an allowlist (if present for
 *  the mode) must contain the path; an empty allowlist means unconstrained. */
export function checkPath(rawPath: string, scope: PathScope, mode: ScopeMode): string | null {
  const p = normalizePath(rawPath);

  for (const d of scope.deny ?? []) {
    if (isUnder(p, normalizePath(d))) return `denied: ${rawPath} is under a blocked path (${d})`;
  }

  const allow = scope[mode] ?? [];
  if (allow.length === 0) return null; // no allowlist for this mode = unconstrained
  for (const a of allow) {
    if (isUnder(p, normalizePath(a))) return null;
  }
  return `denied: ${rawPath} is outside the allowed ${mode} paths`;
}

/** Pull path-like argument values out of a tool's args. Uses the per-server
 *  pathArgKeys hint when provided (precise); otherwise falls back to common
 *  keys (path/file/filename/dir/directory/source/destination + plurals). */
const COMMON_PATH_KEYS = [
  'path', 'paths', 'file', 'filepath', 'file_path', 'filename',
  'dir', 'directory', 'source', 'destination', 'src', 'dst', 'target',
];
export function extractPaths(args: unknown, pathArgKeys?: string[]): string[] {
  if (!args || typeof args !== 'object') return [];
  const keys = pathArgKeys && pathArgKeys.length > 0 ? pathArgKeys : COMMON_PATH_KEYS;
  const out: string[] = [];
  for (const k of keys) {
    const v = (args as Record<string, unknown>)[k];
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const item of v) if (typeof item === 'string') out.push(item);
  }
  return out;
}
