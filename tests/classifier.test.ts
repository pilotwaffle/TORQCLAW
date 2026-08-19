import { describe, it, expect } from 'vitest';
import { keywordFallback, overrideReadTypeForFileWrite } from '../packages/gateway/src/classifier.js';
import type { Classification } from '../packages/gateway/src/classifier.js';

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

// A task that must write a file needs the workspace_write profile (files
// toolset). If the classifier landed it on a read/research type it would run
// web-only and never be able to write the file — the override promotes it to
// ROUTINE_AUTOMATION so the engine receives the (approval-gated) files toolset.
describe('file-write intent override', () => {
  const mk = (taskType: Classification['taskType']): Classification => ({
    taskType,
    confidence: 0.5,
    method: 'KEYWORD_FALLBACK',
    latencyMs: 1,
  });

  it('promotes a research/read classification to ROUTINE_AUTOMATION for a file-path write', () => {
    // The operator-reported failure: "create a mock up of <path>.png" was
    // classified research and ran web-only with no write tool.
    const prompt = 'create a mock up of docs/assets/screenshots/channel-thread.png';
    expect(overrideReadTypeForFileWrite(prompt, mk('AUTONOMOUS_RESEARCH')).taskType).toBe('ROUTINE_AUTOMATION');
    expect(overrideReadTypeForFileWrite(prompt, mk('DATA_EXTRACTION')).taskType).toBe('ROUTINE_AUTOMATION');
    expect(overrideReadTypeForFileWrite(prompt, mk('SUMMARIZATION')).taskType).toBe('ROUTINE_AUTOMATION');
  });

  it('promotes for explicit file nouns ("write a file called notes.md")', () => {
    expect(overrideReadTypeForFileWrite('please write a file called notes.md', mk('SUMMARIZATION')).taskType).toBe('ROUTINE_AUTOMATION');
  });

  it('does NOT touch COMPLEX_CODING — terminal_power is already broader than workspace_write', () => {
    expect(overrideReadTypeForFileWrite('create utils.py', mk('COMPLEX_CODING')).taskType).toBe('COMPLEX_CODING');
  });

  it('does NOT promote when there is no file-write intent', () => {
    expect(overrideReadTypeForFileWrite('compare these two options', mk('AUTONOMOUS_RESEARCH')).taskType).toBe('AUTONOMOUS_RESEARCH');
    expect(overrideReadTypeForFileWrite('research MCP gateways', mk('AUTONOMOUS_RESEARCH')).taskType).toBe('AUTONOMOUS_RESEARCH');
  });

  it('does NOT treat version numbers as file extensions', () => {
    expect(overrideReadTypeForFileWrite('write about version 3.14 changes', mk('SUMMARIZATION')).taskType).toBe('SUMMARIZATION');
  });

  it('is a no-op for ROUTINE_AUTOMATION and raises confidence to at least 0.6', () => {
    const promoted = overrideReadTypeForFileWrite('create report.pdf', mk('AUTONOMOUS_RESEARCH'));
    expect(promoted.taskType).toBe('ROUTINE_AUTOMATION');
    expect(promoted.confidence).toBeGreaterThanOrEqual(0.6);
    expect(overrideReadTypeForFileWrite('create a file', mk('ROUTINE_AUTOMATION')).taskType).toBe('ROUTINE_AUTOMATION');
  });
});
