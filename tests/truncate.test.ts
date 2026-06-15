import { describe, it, expect } from 'vitest';
import {
  truncateHeadTail,
  looksLikeRawToolCall,
  looksLikeFabricatedToolRun,
} from '../packages/inference/src/ollama.js';

describe('truncateHeadTail (P3)', () => {
  it('returns the input unchanged when it fits', () => {
    expect(truncateHeadTail('short', 100)).toBe('short');
  });

  it('returns unchanged exactly at the limit', () => {
    const s = 'x'.repeat(100);
    expect(truncateHeadTail(s, 100)).toBe(s);
  });

  it('keeps head (60%) and tail (40%) with a marker between', () => {
    const body = 'H'.repeat(60) + 'M'.repeat(880) + 'T'.repeat(60); // 1000 chars
    const out = truncateHeadTail(body, 100);
    const headLen = Math.floor(100 * 0.6); // 60
    const tailLen = 100 - headLen;         // 40
    expect(out.startsWith('H'.repeat(headLen))).toBe(true);
    expect(out.endsWith('T'.repeat(tailLen))).toBe(true);
    expect(out).toMatch(/\[TRUNCATED: kept first 60 and last 40 of 1000 chars/);
    expect(out).toMatch(/900 omitted/); // 1000 - 60 - 40
  });

  it('preserves the genuine first and last characters of the body', () => {
    const body = 'START' + 'x'.repeat(1000) + 'END';
    const out = truncateHeadTail(body, 200);
    expect(out.startsWith('START')).toBe(true);
    expect(out.endsWith('END')).toBe(true);
  });

  it('head + tail char counts sum to max (no overflow of kept content)', () => {
    const body = 'a'.repeat(5000);
    const max = 333;
    const out = truncateHeadTail(body, max);
    const headLen = Math.floor(max * 0.6);
    const tailLen = max - headLen;
    // strip the marker, the kept content must be exactly max chars
    const marker = out.match(/\n\[TRUNCATED:[^\]]*\]\n/)![0];
    const kept = out.replace(marker, '');
    expect(kept.length).toBe(max);
    expect(headLen + tailLen).toBe(max);
  });
});

describe('looksLikeRawToolCall — stray-JSON guard', () => {
  it('detects the exact pattern from the live failure', () => {
    expect(looksLikeRawToolCall('{"name": "web_search", "parameters": {"query": "foo"}}')).toBe(true);
  });
  it('detects arguments variant', () => {
    expect(looksLikeRawToolCall('{"name":"read_file","arguments":{"path":"/x"}}')).toBe(true);
  });
  it('does not flag a real prose answer', () => {
    expect(looksLikeRawToolCall("I don't have the tools needed for that.")).toBe(false);
  });
  it('does not flag valid JSON that is NOT a tool call', () => {
    expect(looksLikeRawToolCall('{"result": "ok", "count": 3}')).toBe(false);
  });
  it('does not flag an empty string', () => {
    expect(looksLikeRawToolCall('')).toBe(false);
  });
  it('does not flag a JSON array', () => {
    expect(looksLikeRawToolCall('[{"name":"foo","parameters":{}}]')).toBe(false);
  });
});

describe('looksLikeFabricatedToolRun — interleaved-fabrication guard', () => {
  it('catches the live TradingView fabrication (fake call + fake Tool output)', () => {
    const fabricated =
      'Let me read the file:\n' +
      '```\n{"name": "filesystem__read_text_file", "parameters": {"path": "C:\\\\x\\\\tv.py"}}\n```\n' +
      'Tool output:\n```python\ndef tv_get_bars(symbol): ...\n```\n' +
      'Based on this output, we can connect to TradingView.';
    expect(looksLikeFabricatedToolRun(fabricated)).toBe(true);
  });

  it('catches a fake "Tool result:" narration with an embedded call', () => {
    const fabricated =
      'I will list the directory: {"name":"filesystem__list_directory","arguments":{"path":"/w"}} ' +
      'Tool result: [FILE] a.py [FILE] b.py';
    expect(looksLikeFabricatedToolRun(fabricated)).toBe(true);
  });

  it('does NOT flag a real answer that merely mentions tools or JSON', () => {
    expect(looksLikeFabricatedToolRun(
      'You can call the filesystem tool with a "path" argument to read files.',
    )).toBe(false);
  });

  it('does NOT flag prose with an embedded call but NO fabricated output', () => {
    // A bare embedded call (no fake "Tool output") is handled by the
    // raw-tool-call guard, not this stricter one — avoid double-tripping.
    expect(looksLikeFabricatedToolRun(
      'Maybe I should run {"name":"x","parameters":{}} next.',
    )).toBe(false);
  });

  it('does NOT flag a normal explanatory answer', () => {
    expect(looksLikeFabricatedToolRun(
      'The three laws of thermodynamics describe energy conservation, entropy, and absolute zero.',
    )).toBe(false);
  });
});
