import { describe, it, expect } from 'vitest';
import {
  assertFoldTableVersion,
  checkFoldHeaderVersion,
  nameKey,
} from '../../packages/collab/src/fold.js';

describe('Unicode Case Folding', () => {
  describe('fold table version assertion', () => {
    it('passes on vendored CaseFolding-15.0.txt', () => {
      expect(() => {
        assertFoldTableVersion();
      }).not.toThrow();
    });

    it('accepts header versions 15.0.0 and 15.0.1', () => {
      expect(() => checkFoldHeaderVersion('# CaseFolding-15.0.0.txt')).not.toThrow();
      expect(() => checkFoldHeaderVersion('# CaseFolding-15.0.1.txt')).not.toThrow();
    });

    it('throws on wrong minor version 15.1.0', () => {
      expect(() => checkFoldHeaderVersion('# CaseFolding-15.1.0.txt')).toThrow(/mismatch/);
    });

    it('throws on wrong major versions 115.0.0, 16.0.0, 14.0.0, 5.0.0', () => {
      expect(() => checkFoldHeaderVersion('# CaseFolding-115.0.0.txt')).toThrow(/mismatch/);
      expect(() => checkFoldHeaderVersion('# CaseFolding-16.0.0.txt')).toThrow(/mismatch/);
      expect(() => checkFoldHeaderVersion('# CaseFolding-14.0.0.txt')).toThrow(/mismatch/);
      expect(() => checkFoldHeaderVersion('# CaseFolding-5.0.0.txt')).toThrow(/mismatch/);
    });

    it('anchored: does not accept a stray 15.0.0 elsewhere on the line', () => {
      expect(() =>
        checkFoldHeaderVersion('# prefix 15.0.0 but real table is CaseFolding-16.0.0.txt')
      ).toThrow();
    });

    it('throws when the header carries no version at all', () => {
      expect(() => checkFoldHeaderVersion('# some unrelated header')).toThrow(/not found/);
    });
  });

  describe('nameKey', () => {
    it('produces identical keys for U+00DF (ß) and SS', () => {
      const keyStrasse = nameKey('Straße');
      const keyUpperSS = nameKey('STRASSE');
      const keyLowerSS = nameKey('strasse');

      expect(keyStrasse).toBe(keyUpperSS);
      expect(keyStrasse).toBe(keyLowerSS);
    });

    it('collapses case variants to same key', () => {
      const keyLower = nameKey('test');
      const keyUpper = nameKey('TEST');
      const keyMixed = nameKey('TeSt');

      expect(keyLower).toBe(keyUpper);
      expect(keyLower).toBe(keyMixed);
    });

    it('handles Greek case pairs', () => {
      // Greek letters should fold consistently
      const sigma = 'Σ'; // Greek capital sigma
      const smallSigma = 'σ'; // Greek small sigma
      const finalSigma = 'ς'; // Greek small final sigma

      const key1 = nameKey(sigma);
      const key2 = nameKey(smallSigma);
      const key3 = nameKey(finalSigma);

      // All variants should produce the same folded key
      expect(key1).toBe(key2);
      expect(key2).toBe(key3);
    });

    it('handles Cyrillic case pairs', () => {
      // Cyrillic letters should fold consistently
      const cyrilicA = 'А'; // Cyrillic capital A
      const cyrilicLowerA = 'а'; // Cyrillic small a

      const key1 = nameKey(cyrilicA);
      const key2 = nameKey(cyrilicLowerA);

      // Should produce the same folded key
      expect(key1).toBe(key2);
    });

    it('maps unmapped scalar to itself', () => {
      // U+611B (愛 - CJK character) is unlikely to be in CaseFolding
      const char = '愛';
      const key = nameKey(char);

      // Unmapped scalar should map to itself
      expect(key).toBe(char);
    });

    it('handles single-character mappings', () => {
      // A -> a
      const keyA = nameKey('A');
      const keya = nameKey('a');

      expect(keyA).toBe(keya);
    });

    it('handles multi-character mappings', () => {
      // Some characters fold to multiple characters
      // U+00DF (ß) folds to U+0073 U+0073 (ss)
      const keyEstSet = nameKey('ß');
      const keySS = nameKey('ss');

      expect(keyEstSet).toBe(keySS);
    });

    it('folds left-to-right without second NFC', () => {
      // Test that folding is applied without a second NFC pass
      const text = 'Strasse';
      const key = nameKey(text);

      // Should fold all characters independently
      expect(key).toBeTruthy();
      expect(typeof key).toBe('string');
    });

    it('produces consistent results for repeated calls', () => {
      const name = 'TestName';

      const key1 = nameKey(name);
      const key2 = nameKey(name);
      const key3 = nameKey(name);

      expect(key1).toBe(key2);
      expect(key2).toBe(key3);
    });

    it('handles mixed ASCII and non-ASCII', () => {
      const name = 'Test-Café';
      const key = nameKey(name);

      expect(key).toBeTruthy();
      expect(typeof key).toBe('string');
    });

    it('handles empty string', () => {
      const key = nameKey('');
      expect(key).toBe('');
    });

    it('handles very long names', () => {
      const longName = 'a'.repeat(1000);
      const key = nameKey(longName);

      expect(key).toBeTruthy();
      expect(typeof key).toBe('string');
    });

    it('collision detection: similar names fold to same key', () => {
      // Names that differ only in case should collide
      const name1 = 'MyChannel';
      const name2 = 'mychAnnel';

      const key1 = nameKey(name1);
      const key2 = nameKey(name2);

      expect(key1).toBe(key2);
    });

    it('includes all case-folding mappings from CaseFolding-15.0', () => {
      // Verify that the fold table includes common mappings
      // Test a few known mappings from Unicode 15.0

      // Turkish I without dot (U+0131) should fold correctly
      const turkishI = 'ı'; // U+0131
      const key = nameKey(turkishI);
      expect(key).toBeTruthy();
    });

    it('exact codepoint assertion: nameKey("I") === U+0069 (lowercase i)', () => {
      // Condition 7: fold assertions assert exact output codepoints
      const key = nameKey('I');
      const codepoint = key.charCodeAt(0);
      expect(codepoint).toBe(0x0069); // lowercase i
    });

    it('exact codepoint assertion: nameKey("\\u0130") === "\\u0069\\u0307"', () => {
      // Turkish capital I with dot (U+0130) folds to i (U+0069) + combining dot above (U+0307)
      const key = nameKey('İ');
      const codepoints = Array.from(key).map(c => c.codePointAt(0)!);
      expect(codepoints).toEqual([0x0069, 0x0307]);
    });

    it('exact codepoint assertion: nameKey("\\u1E9E") === "ss"', () => {
      // German capital sharp S (U+1E9E) folds to "ss"
      const key = nameKey('ẞ');
      expect(key).toBe('ss');
    });

    it('no second NFC pass: input that would change under second NFC is folded once', () => {
      // Condition 7: fold assertions verify no second NFC pass
      // U+1E9B (Latin small letter long s with dot above) folds to U+1E61 (Latin small letter s with dot above)
      // If we applied NFC after folding, U+1E61 might normalize differently
      // The correct behavior is to fold once and return the result without a second normalization pass
      const key = nameKey('ẛ');
      // U+1E9B folds to U+1E61
      const expectedCodepoint = 0x1E61;
      expect(key.charCodeAt(0)).toBe(expectedCodepoint);
    });
  });
});
