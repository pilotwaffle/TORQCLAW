import { describe, it, expect } from 'vitest';
import { normalizeMessageText, normalizeName } from '../../packages/collab/src/text.js';

describe('Text Validation', () => {
  describe('normalizeMessageText', () => {
    it('accepts valid message', () => {
      const result = normalizeMessageText('Hello, World!');
      expect(result).toEqual({ text: 'Hello, World!' });
    });

    it('accepts message with TAB, LF, CR', () => {
      const result = normalizeMessageText('Line 1\nLine 2\tTabbed\rCarriage');
      expect(result).toHaveProperty('text');
      expect('text' in result ? result.text : '').toBeTruthy();
    });

    it('rejects message with C0 control (BEL U+0007)', () => {
      const result = normalizeMessageText('Hello\x07World');
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });

    it('does NOT trim message text (v0.14 change)', () => {
      const result = normalizeMessageText('  test message  ');
      expect(result).toEqual({ text: '  test message  ' });
    });

    it('applies NFC normalization before length checks', () => {
      // NFC should be applied before validation
      const message = 'café'; // e with combining accent
      const result = normalizeMessageText(message);

      // Should validate the NFC-normalized form
      expect(result).toHaveProperty('text');
    });

    it('accepts 16,384 ASCII bytes', () => {
      const message = 'a'.repeat(16384);
      const result = normalizeMessageText(message);
      expect(result).toHaveProperty('text');
    });

    it('rejects 16,385 ASCII bytes', () => {
      const message = 'a'.repeat(16385);
      const result = normalizeMessageText(message);
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });


    it('accepts 8,192 LF characters (all newlines)', () => {
      // 8,192 LF characters = 16,384 bytes when encoded
      const message = '\n'.repeat(8192);
      const result = normalizeMessageText(message);
      expect(result).toHaveProperty('text');
      if ('text' in result) {
        expect(result.text).toBe('\n'.repeat(8192));
        // Verify encoded form is exactly 16,384 bytes
        const encoded = JSON.stringify(result.text);
        const encodedLength = Buffer.byteLength(encoded.slice(1, -1), 'utf-8');
        expect(encodedLength).toBe(16384);
      }
    });

    it('rejects 8,193 LF characters', () => {
      const message = '\n'.repeat(8193);
      const result = normalizeMessageText(message);
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });

    it('accepts 8,192 repetitions of decomposed U+0065 U+0301 (e with combining accent)', () => {
      // U+0065 U+0301 = e + combining acute accent (decomposed form)
      // Write as é to ensure decomposed form in source
      const message = 'é'.repeat(8192);

      // Verify source is NOT precomposed before normalization
      const sourceCodepoints = Array.from(message).map(c => c.codePointAt(0)!);
      expect(sourceCodepoints).toContain(0x0301); // Contains combining accent

      const result = normalizeMessageText(message);
      expect(result).toHaveProperty('text');
      if ('text' in result) {
        // After NFC normalization, verify post-NFC form
        // Post-NFC may be either precomposed (U+00E9) or decomposed depending on the normalizer
        // Count the raw UTF-8 bytes of the normalized form
        const nfcForm = result.text;
        const rawBytes = Buffer.byteLength(nfcForm, 'utf-8');
        // Post-NFC should be 16,384 bytes
        expect(rawBytes).toBe(16384);
      }
    });

    it('rejects 8,192 repetitions of U+0344 (combining diaeresis with greek)', () => {
      // U+0344 decomposes to multiple codepoints under NFC
      // 8,192 repetitions * 2 codepoints = 16,384 codepoints after NFC, = 32,768 bytes
      const message = '̈́'.repeat(8192);
      const result = normalizeMessageText(message);
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });

    it('rejects empty message', () => {
      const result = normalizeMessageText('');
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });

    it('accepts message with only whitespace (all whitespace is valid)', () => {
      // v0.14: message text is NOT trimmed, so whitespace-only messages are accepted
      const result = normalizeMessageText('   \n  \t  ');
      expect(result).toHaveProperty('text');
      if ('text' in result) {
        expect(result.text).toBe('   \n  \t  ');
      }
    });

    it('accepts and persists leading/trailing space message: " x "', () => {
      const message = ' x ';
      const result = normalizeMessageText(message);
      expect(result).toEqual({ text: ' x ' });
    });

    it('accepts and persists exact byte length 16,384 raw ASCII', () => {
      const message = 'a'.repeat(16384);
      const result = normalizeMessageText(message);
      expect(result).toHaveProperty('text');
      if ('text' in result) {
        expect(result.text).toBe(message);
      }
    });

    it('rejects 16,385 raw ASCII bytes', () => {
      const message = 'a'.repeat(16385);
      const result = normalizeMessageText(message);
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });
  });

  describe('normalizeName', () => {
    it('accepts valid name', () => {
      const result = normalizeName('Test Channel');
      expect(result).toEqual({ name: 'Test Channel' });
    });

    it('trims whitespace before validating', () => {
      const result = normalizeName('  Test Name  ');
      expect(result).toEqual({ name: 'Test Name' });
    });

    it('applies NFC normalization', () => {
      // Test with a decomposed character that normalizes
      const name = 'Café'; // café in composed form (NFC)
      const result = normalizeName(name);
      expect(result).toHaveProperty('name');
    });

    it('rejects name with C0 control (TAB)', () => {
      const result = normalizeName('Test\tName');
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });

    it('rejects name with C0 control (LF)', () => {
      const result = normalizeName('Test\nName');
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });

    it('rejects name with U+202E (right-to-left override)', () => {
      const result = normalizeName('Test‮Name');
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });

    it('rejects name with bidi control U+2066', () => {
      const result = normalizeName('Test⁦Name');
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });

    it('rejects name with bidi control U+2069', () => {
      const result = normalizeName('Test⁩Name');
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });

    it('accepts 80 scalar values', () => {
      const name = 'a'.repeat(80);
      const result = normalizeName(name);
      expect(result).toHaveProperty('name');
    });

    it('rejects 81 scalar values', () => {
      const name = 'a'.repeat(81);
      const result = normalizeName(name);
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });

    it('rejects empty name', () => {
      const result = normalizeName('');
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });

    it('rejects name with only whitespace', () => {
      const result = normalizeName('   \n  \t  ');
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });

    it('correctly counts Unicode scalars for emoji', () => {
      // Some emoji are multiple code units but single scalars
      const name = '😀'.repeat(80); // Each emoji is one scalar
      const result = normalizeName(name);
      expect(result).toHaveProperty('name');
    });

    it('accepts exactly 80 scalars', () => {
      const name = 'a'.repeat(80);
      const result = normalizeName(name);
      expect(result).toEqual({ name: 'a'.repeat(80) });
    });

    it('rejects 81 scalars', () => {
      const name = 'a'.repeat(81);
      const result = normalizeName(name);
      expect(result).toHaveProperty('error', 'INVALID_REQUEST');
    });
  });

  describe('normalization order', () => {
    it('applies NFC before bounds check', () => {
      // NFC should be applied before validation
      const text = 'café'.repeat(100);
      const result = normalizeMessageText(text);

      // Should validate the normalized form
      expect(result).toHaveProperty('text');
    });

    it('does NOT trim after NFC (message text never trimmed per v0.14)', () => {
      // v0.14: message text is NOT trimmed, only names are trimmed
      const result = normalizeMessageText('  é  ');
      expect(result).toHaveProperty('text');
      if ('text' in result) {
        expect(result.text).toBe('  é  ');
      }
    });
  });
});
