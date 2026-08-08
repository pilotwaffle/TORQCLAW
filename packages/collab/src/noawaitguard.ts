/**
 * noawaitguard.ts — (H6) the no-await guard MECHANISM.
 *
 * G1R H6 requires the no-await guard on two critical sections to be a REAL
 * mechanism — "a test that instruments/inspects runAuthorizationMutation's
 * post-commit close loop and fanoutOne's read-lock critical section for an
 * await/microtask yield between commit-return and lock-release" — not a
 * prose comment.
 *
 * MECHANISM USED: source-AST scan (TypeScript compiler API), not runtime
 * yield-detection. Rationale: coordinator.ts and fanout.ts are Slice 3/4
 * logic outside this slice's writable surface (HARD RULE: do not touch
 * other slices' logic), so this guard cannot instrument those functions by
 * modifying them to record microtask-yield timestamps. A static scan reads
 * the ALREADY-BUILT source unmodified and proves, from the actual parsed
 * syntax tree, that no `await` expression (and no `yield`, defensively —
 * this module has no generators, but the check is general) appears inside
 * the two pinned code ranges:
 *
 *  - `runAuthorizationMutation`'s synchronous block from the line after
 *    `result = await txBody()` through the end of the `for` loop that
 *    calls `subscription.close(reason)` (coordinator.ts) — i.e. everything
 *    from `commitReturnMs = nowMs()` through the closing brace of the
 *    `deriveAffected`+close-loop block, BEFORE the `finally`'s
 *    `releaseWrite()`.
 *  - `fanoutOne`'s critical section from immediately after
 *    `await deps.lock.acquireRead()` through `deps.lock.releaseRead()` in
 *    the `finally` (fanout.ts) — the whole `try` body between acquire and
 *    the point release is called.
 *
 * This is a STRUCTURAL proof (the parser sees every token; an `await`
 * hidden by formatting/whitespace cannot evade an AST walk the way a
 * regex substring match could), stronger than a comment and stronger than
 * a regex scan, without requiring any modification to coordinator.ts or
 * fanout.ts.
 */

import { readFileSync } from 'node:fs';
import * as ts from 'typescript';

export interface NoAwaitScanResult {
  ok: boolean;
  awaitNodesFound: number;
  yieldNodesFound: number;
  scannedFunctionName: string;
  scannedByteRange: { start: number; end: number };
}

/**
 * Parse `sourcePath` and scan the body of the function named
 * `functionName` for `await`/`yield` expressions that occur strictly
 * AFTER `afterMarker` (a unique source substring marking the start of the
 * critical section, e.g. `'commitReturnMs = nowMs()'`) and strictly BEFORE
 * `beforeMarker` (e.g. `'} finally {'` or a specific closing marker). Both
 * markers must appear exactly once in the function's text; this function
 * throws if either is missing or ambiguous, so a future refactor that
 * renames/removes the anchor text fails loudly instead of silently
 * scanning the wrong range.
 */
export function scanForAwaitInRange(
  sourcePath: string,
  functionName: string,
  afterMarker: string,
  beforeMarker: string
): NoAwaitScanResult {
  const sourceText = readFileSync(sourcePath, 'utf8');
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);

  const fn = findFunctionByName(sourceFile, functionName);
  if (!fn || !fn.body) {
    throw new Error(`scanForAwaitInRange: function "${functionName}" not found (or has no body) in ${sourcePath}`);
  }

  const fnStart = fn.getStart(sourceFile);
  const fnEnd = fn.getEnd();
  const fnText = sourceText.slice(fnStart, fnEnd);

  const afterIdx = indexOfExactlyOnce(fnText, afterMarker, `afterMarker ${JSON.stringify(afterMarker)}`);
  const beforeIdx = indexOfExactlyOnce(fnText, beforeMarker, `beforeMarker ${JSON.stringify(beforeMarker)}`);
  if (beforeIdx <= afterIdx) {
    throw new Error(
      `scanForAwaitInRange: beforeMarker occurs before (or at) afterMarker in ${functionName} — markers are misordered.`
    );
  }

  const rangeStartInFile = fnStart + afterIdx + afterMarker.length;
  const rangeEndInFile = fnStart + beforeIdx;

  let awaitNodesFound = 0;
  let yieldNodesFound = 0;

  function visit(node: ts.Node): void {
    const nodeStart = node.getStart(sourceFile);
    const nodeEnd = node.getEnd();
    // Only descend into / count nodes that overlap the target range at all.
    if (nodeEnd <= rangeStartInFile || nodeStart >= rangeEndInFile) {
      return;
    }
    if (ts.isAwaitExpression(node) && nodeStart >= rangeStartInFile && nodeEnd <= rangeEndInFile) {
      awaitNodesFound++;
    }
    if (ts.isYieldExpression(node) && nodeStart >= rangeStartInFile && nodeEnd <= rangeEndInFile) {
      yieldNodesFound++;
    }
    ts.forEachChild(node, visit);
  }
  visit(fn.body);

  return {
    ok: awaitNodesFound === 0 && yieldNodesFound === 0,
    awaitNodesFound,
    yieldNodesFound,
    scannedFunctionName: functionName,
    scannedByteRange: { start: rangeStartInFile, end: rangeEndInFile },
  };
}

function indexOfExactlyOnce(haystack: string, needle: string, label: string): number {
  const first = haystack.indexOf(needle);
  if (first === -1) {
    throw new Error(`scanForAwaitInRange: ${label} not found in scanned function text.`);
  }
  const second = haystack.indexOf(needle, first + 1);
  if (second !== -1) {
    throw new Error(`scanForAwaitInRange: ${label} occurs more than once in scanned function text — ambiguous anchor.`);
  }
  return first;
}

function findFunctionByName(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}
