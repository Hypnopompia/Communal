import { base32nopad, base64urlnopad } from '@scure/base';

/** Lowercase RFC 4648 base32 without padding (see docs/adr/0002-identity-encoding.md). */
export function toBase32(bytes: Uint8Array): string {
  return base32nopad.encode(bytes).toLowerCase();
}

export function fromBase32(s: string): Uint8Array {
  return base32nopad.decode(s.toUpperCase());
}

/** Binary values on the wire (keys, signatures) are base64url without padding. */
export function toB64(bytes: Uint8Array): string {
  return base64urlnopad.encode(bytes);
}

export function fromB64(s: string): Uint8Array {
  return base64urlnopad.decode(s);
}

const te = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return te.encode(s);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** u32 big-endian length prefix + bytes; makes concatenations unambiguous. */
export function lp(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

export function u64(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`not a u64-safe integer: ${n}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
