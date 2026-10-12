import { blake3 } from '@noble/hashes/blake3.js';
import { utf8 } from './encoding.js';

/**
 * Safety code for a connection: sort both root fingerprints, BLAKE3 the concatenation,
 * render as 4 groups of 5 digits. Each group is a 40-bit big-endian slice mod 100000
 * (bias is ~1e-7, negligible for a human comparison code).
 */
export function safetyCode(fingerprintA: string, fingerprintB: string): string {
  const [x, y] = [fingerprintA, fingerprintB].sort();
  const digest = blake3(utf8(x! + y!));
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let n = 0;
    for (let i = 0; i < 5; i++) n = n * 256 + digest[g * 5 + i]!;
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}
