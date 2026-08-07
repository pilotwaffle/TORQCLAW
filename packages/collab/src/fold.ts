import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Precompiled lookup table for Unicode 15.0 Default Case Folding
 * Maps Unicode scalar (as string key) to folded result (as string)
 * Covers status C (common) and F (full) mappings only
 */
const foldTable = new Map<string, string>();

/**
 * Read and parse CaseFolding-15.0.txt at module load time
 * Extracts C and F status mappings only
 */
function buildFoldTable(): void {
  const vendorPath = join(__dirname, '..', 'vendor', 'CaseFolding-15.0.txt');
  const content = readFileSync(vendorPath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.startsWith('#')) {
      continue;
    }

    // Parse format: <codepoint>; <status>; <mapping>; # <name>
    const parts = line.split(';').map((p: string) => p.trim());
    if (parts.length < 3) {
      continue;
    }

    const codepoint = parts[0];
    const status = parts[1];
    const mapping = parts[2];

    // Only include C (common) and F (full) status
    if (status !== 'C' && status !== 'F') {
      continue;
    }

    // Parse codepoint as hex to Unicode scalar
    const scalar = String.fromCodePoint(parseInt(codepoint || '0', 16));

    // Parse mapping: space-separated hex codepoints -> string
    const mappingStr = mapping || '';
    const hexCodes = mappingStr.split(' ');
    const mapped = hexCodes
      .map((hex: string) => String.fromCodePoint(parseInt(hex, 16)))
      .join('');

    foldTable.set(scalar, mapped);
  }
}

/**
 * assertFoldTableVersion(): void
 *
 * Reads the header of packages/collab/vendor/CaseFolding-15.0.txt
 * and asserts it declares version 15.0.x (major.minor match only).
 * Throws an error if the major.minor version is not exactly 15.0.
 */
export function checkFoldHeaderVersion(firstLine: string): void {
  // Header format: # CaseFolding-15.0.0.txt
  // Anchored: the version token must be the file's own name in the header,
  // not an arbitrary dotted triple appearing elsewhere on the line.
  const versionMatch = firstLine.match(/^# CaseFolding-(\d+\.\d+\.\d+)\.txt/);
  if (!versionMatch || !versionMatch[1]) {
    throw new Error(
      `Case folding table version not found in header: ${firstLine}`
    );
  }

  const version = versionMatch[1];
  const parts = version.split('.');
  const major = parts[0] || '';
  const minor = parts[1] || '';
  const majorMinor = `${major}.${minor}`;

  // Require exact major.minor match: 15.0
  if (majorMinor !== '15.0') {
    throw new Error(
      `Case folding table version mismatch. Expected 15.0.x, got ${version}`
    );
  }
}

export function assertFoldTableVersion(): void {
  const vendorPath = join(__dirname, '..', 'vendor', 'CaseFolding-15.0.txt');
  const content = readFileSync(vendorPath, 'utf-8');
  const firstLine = content.split('\n')[0] || '';
  checkFoldHeaderVersion(firstLine);
}

/**
 * nameKey(nfcName: string): string
 *
 * Takes a post-NFC-normalized name and folds it per Unicode 15.0
 * Default Case Folding (status C and F lines only).
 *
 * For each Unicode scalar in nfcName (left-to-right):
 * - If it appears in the C or F mapping table, replace with mapped value
 * - Unmapped scalars map to themselves
 * - NO second NFC pass after folding
 *
 * Returns the folded concatenation.
 */
export function nameKey(nfcName: string): string {
  let result = '';

  for (const scalar of nfcName) {
    // Look up scalar in the fold table; default to itself if not found
    const folded = foldTable.get(scalar) ?? scalar;
    result += folded;
  }

  return result;
}

// Build the fold table at module load time
buildFoldTable();
