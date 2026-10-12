import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { concatBytes, fromB64, lp, toB64, utf8 } from './encoding.js';
import type { KeyPair } from './keys.js';

/**
 * Anonymous sealed box to a device's Ed25519 key (ADR 0014): what an approving device sends
 * a newly linked device through the hub, which forwards it without being able to read it.
 * Layout: ephemeral X25519 pubkey (32) ‖ nonce (24) ‖ XChaCha20-Poly1305 ciphertext.
 */

const DOMAIN = 'communal/seal/v1';

function sealKey(shared: Uint8Array, ephPub: Uint8Array, recipientMont: Uint8Array): Uint8Array {
  return blake3(concatBytes(lp(utf8(DOMAIN)), lp(shared), lp(ephPub), lp(recipientMont)));
}

export function sealTo(recipientPubkey: Uint8Array, plaintext: Uint8Array): string {
  const recipientMont = ed25519.utils.toMontgomery(recipientPubkey);
  const eph = x25519.keygen();
  const shared = x25519.getSharedSecret(eph.secretKey, recipientMont);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(
    sealKey(shared, eph.publicKey, recipientMont),
    nonce,
    recipientPubkey,
  ).encrypt(plaintext);
  return toB64(concatBytes(eph.publicKey, nonce, ct));
}

export class SealError extends Error {}

export function openSealed(recipient: KeyPair, sealed: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = fromB64(sealed);
  } catch {
    throw new SealError('malformed sealed box');
  }
  if (raw.length < 32 + 24 + 16) throw new SealError('malformed sealed box');
  const ephPub = raw.subarray(0, 32);
  const nonce = raw.subarray(32, 56);
  try {
    const recipientMont = ed25519.utils.toMontgomery(recipient.publicKey);
    const shared = x25519.getSharedSecret(
      ed25519.utils.toMontgomerySecret(recipient.secretKey),
      ephPub,
    );
    return xchacha20poly1305(
      sealKey(shared, ephPub, recipientMont),
      nonce,
      recipient.publicKey,
    ).decrypt(raw.subarray(56));
  } catch {
    throw new SealError('cannot open sealed box');
  }
}
