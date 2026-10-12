import { ed25519 } from '@noble/curves/ed25519.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { concatBytes, lp, toBase32, utf8 } from './encoding.js';

export interface KeyPair {
  /** 32-byte Ed25519 secret seed. */
  secretKey: Uint8Array;
  /** 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey, publicKey };
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  if (secretKey.length !== 32) throw new RangeError('Ed25519 secret key must be 32 bytes');
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

/**
 * Every signature in Communal is over `lp(domain) ‖ message`, so a signature made for one
 * purpose (a device cert, say) can never be replayed as another (a hub auth response).
 */
export type SigDomain =
  | 'communal/auth/v1'
  | 'communal/device-cert/v1'
  | 'communal/revocation/v1'
  | 'communal/restore/v1'
  | 'communal/transfer-token/v1';

function domainSeparated(domain: SigDomain, message: Uint8Array): Uint8Array {
  return concatBytes(lp(utf8(domain)), message);
}

export function sign(domain: SigDomain, message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(domainSeparated(domain, message), secretKey);
}

export function verify(
  domain: SigDomain,
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, domainSeparated(domain, message), publicKey);
  } catch {
    return false;
  }
}

/** `d_` + base32 of the first 16 bytes of BLAKE3(pubkey). */
export function deviceId(publicKey: Uint8Array): string {
  return 'd_' + toBase32(blake3(publicKey).subarray(0, 16));
}

/** `u_` + base32 of the first 16 bytes of BLAKE3(root pubkey). See ADR 0002. */
export function userId(rootPublicKey: Uint8Array): string {
  return 'u_' + toBase32(blake3(rootPublicKey).subarray(0, 16));
}

/** Full base32 BLAKE3(root pubkey), 52 characters. */
export function fingerprint(rootPublicKey: Uint8Array): string {
  return toBase32(blake3(rootPublicKey));
}

/** Fingerprint in groups of 4 characters for display. */
export function formatFingerprint(fp: string): string {
  return (fp.match(/.{1,4}/g) ?? []).join(' ');
}
