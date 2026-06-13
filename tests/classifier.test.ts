import { describe, it, expect } from 'vitest';
import { keywordFallback } from '../packages/gateway/src/classifier.js';

describe('classifier keyword ladder', () => {
  it('COMPLEX_CODING rung', () => {
    expect(keywordFallback('refactor the ws handler').taskType).toBe('COMPLEX_CODING');
    expect(keywordFallback('debug this stack trace').taskType).toBe('COMPLEX_CODING');
  });

  it('AUTONOMOUS_RESEARCH rung', () => {
    expect(keywordFallback('research MCP gateways').taskType).toBe('AUTONOMOUS_RESEARCH');
    expect(keywordFallback('compare these two options').taskType).toBe('AUTONOMOUS_RESEARCH');
  });

  it('DATA_EXTRACTION rung', () => {
    expect(keywordFallback('extract the invoice fields').taskType).toBe('DATA_EXTRACTION');
    expect(keywordFallback('parse this csv').taskType).toBe('DATA_EXTRACTION');
  });

  it('SUMMARIZATION rung', () => {
    expect(keywordFallback('tldr this changelog').taskType).toBe('SUMMARIZATION');
    expect(keywordFallback('summarize the report').taskType).toBe('SUMMARIZATION');
  });

  it('order is load-bearing: a coding+research prompt lands COMPLEX_CODING (first rung)', () => {
    // "implement" (coding) and "compare" (research) both match; first rung wins.
    expect(keywordFallback('implement and compare two sorts').taskType).toBe('COMPLEX_CODING');
  });

  it('matched rungs carry 0.6 confidence (KEYWORD_FALLBACK)', () => {
    const c = keywordFallback('debug this');
    expect(c.method).toBe('KEYWORD_FALLBACK');
    expect(c.confidence).toBe(0.6);
  });

  it('no match -> ROUTINE_AUTOMATION at low (0.3) DEFAULT confidence', () => {
    const c = keywordFallback('what is the weather like today');
    expect(c.taskType).toBe('ROUTINE_AUTOMATION');
    expect(c.method).toBe('DEFAULT');
    expect(c.confidence).toBe(0.3); // < 0.5 -> router RULE 1.5 elevates to FRONTIER
  });
});
