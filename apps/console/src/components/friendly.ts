// Translation layer: raw pipeline vocabulary -> end-user language.
// Raw values stay available via tooltips; users should never need to
// decode enum names or router diagnostics.
import type { GatewayEvent } from '@torqclaw/contracts';

export const TASK_LABELS: Record<string, string> = {
  DATA_EXTRACTION: 'Extracting data',
  SUMMARIZATION: 'Summarizing',
  ROUTINE_AUTOMATION: 'Quick task',
  AUTONOMOUS_RESEARCH: 'Research task',
  COMPLEX_CODING: 'Coding task',
};

export const TYPE_LABELS: Record<string, string> = {
  CONNECTED: 'connected',
  USER_PROMPT: 'you',
  ROUTING: 'understood',
  TIER_SELECTED: 'routed',
  TOOL_CALL: 'working',
  SYSTEM: 'status',
  RESULT: 'answer',
  PENDING_APPROVAL: 'needs you',
  ERROR: 'problem',
};

export function tierLabel(tier: GatewayEvent['tier']): { text: string; hint: string } | null {
  if (tier === 'OLLAMA_LOCAL')
    return { text: 'on this machine', hint: 'Running on your local model — private, no API cost' };
  if (tier === 'API_EXTERNAL')
    return { text: 'cloud model', hint: 'Using a frontier cloud model for deeper reasoning' };
  return null;
}

/** Human rendering of an event message; falls back to the raw message. */
export function friendlyMessage(ev: GatewayEvent): string {
  const meta = (ev.metadata ?? {}) as Record<string, any>;
  switch (ev.type) {
    case 'CONNECTED':
      return meta.resumed ? 'Picked up where you left off' : 'Ready — type a task below';
    case 'ROUTING': {
      const m = ev.message.match(/Classified as (\w+)/);
      return m ? `Got it — ${(TASK_LABELS[m[1]!] ?? m[1]!).toLowerCase()}` : ev.message;
    }
    case 'TIER_SELECTED': {
      const r = String(meta.reason ?? ev.message);
      if (r.startsWith('PRIVACY_OVERRIDE')) return 'Marked private — staying on this machine';
      if (r.startsWith('USER_LOCAL_ONLY')) return 'This machine only — as you asked';
      if (r.startsWith('TOOL_COUNT_OVERFLOW')) return 'Needs several tools — using the cloud model';
      if (r.startsWith('LOW_CLASSIFIER_CONFIDENCE')) return 'Tricky to size up — using the cloud model to be safe';
      if (r.startsWith('LATENCY_CRITICAL')) return 'Local model is waking up — using the cloud for a fast answer';
      const score = Number(meta.score ?? NaN);
      if (!Number.isNaN(score))
        return score < 50
          ? 'Simple enough to run locally — free and private'
          : 'Complex task — using the cloud model';
      return ev.message;
    }
    case 'TOOL_CALL': {
      const m = ev.message.match(/Executing (?:(\w+)__)?(\w+)/);
      if (m) {
        const action = m[2]!.replace(/_/g, ' ');
        return m[1] ? `Using ${action} (${m[1]})` : `Using ${action}`;
      }
      return ev.message;
    }
    case 'PENDING_APPROVAL': {
      const m = ev.message.match(/Tool (?:(\w+)__)?(\w+)/);
      if (m) return `Wants to ${m[2]!.replace(/_/g, ' ')} — needs your OK`;
      if (ev.message.toLowerCase().includes('skill')) return 'Learned a new skill — review before it can be used';
      return ev.message;
    }
    case 'ERROR':
      return `Something went wrong: ${ev.message.replace(/^Execution failed: /, '')}`;
    default:
      return ev.message;
  }
}

/**
 * Client-side privacy SUGGESTION patterns. Rules (load-bearing — invariant 2):
 *  - This is suggest-only. A match surfaces an inline hint; it must NEVER set
 *    or clear the private flag itself, NEVER block or delay submission, and a
 *    false positive must be dismissible for the current prompt without changing
 *    the stored private-mode preference.
 *  - No automatic system may clear containsSensitiveData; automation may only
 *    suggest setting it.
 * Patterns target obvious credential/PII shapes, anchored to avoid tripping on
 * ordinary words (e.g. "ski", "ssn" inside "lesson").
 */
export const PRIVACY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/, label: 'an API key' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/, label: 'a GitHub token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'an AWS access key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'a private key' },
  { re: /\b\d{3}-\d{2}-\d{4}\b/, label: 'an SSN' },
  { re: /\b(?:\d[ -]?){13,16}\b/, label: 'a card number' },
];

/** Returns a hint label if the text looks like it carries credentials/PII,
 *  else null. Pure + synchronous so it can run on every keystroke cheaply. */
export function privacyHint(text: string): string | null {
  for (const { re, label } of PRIVACY_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

/** P4: minimal line-level diff (LCS) — added/removed/unchanged rows. No
 *  dependency; enough to review a SKILL.md edit. Pure, exported for testing. */
export function lineDiff(a: string, b: string): Array<{ t: '+' | '-' | ' '; line: string }> {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  const W = m + 1;
  const dp = new Int32Array((n + 1) * (m + 1));
  const g = (k: number): number => dp[k] as number; // Int32Array never holds undefined
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * W + j] = A[i] === B[j]
        ? g((i + 1) * W + (j + 1)) + 1
        : Math.max(g((i + 1) * W + j), g(i * W + (j + 1)));
  const out: Array<{ t: '+' | '-' | ' '; line: string }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', line: A[i] ?? '' }); i++; j++; }
    else if (g((i + 1) * W + j) >= g(i * W + (j + 1))) { out.push({ t: '-', line: A[i] ?? '' }); i++; }
    else { out.push({ t: '+', line: B[j] ?? '' }); j++; }
  }
  while (i < n) out.push({ t: '-', line: A[i++] ?? '' });
  while (j < m) out.push({ t: '+', line: B[j++] ?? '' });
  return out;
}
