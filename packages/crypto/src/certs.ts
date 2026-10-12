import { bytesEqual, concatBytes, fromB64, lp, toB64, u64, utf8 } from './encoding.js';
import { deviceId, sign, userId, verify, type KeyPair } from './keys.js';

/**
 * A device cert: an existing device of the account vouches for a new device key.
 * Binary fields are base64url so certs can travel inside JSON messages unchanged.
 */
export interface DeviceCert {
  user_id: string;
  device_pubkey: string;
  issued_at: number;
  signer_pubkey: string;
  sig: string;
}

/**
 * Chain from the root toward a device: chain[0] is signed by the root key and each later
 * cert is signed by the previous cert's device. The root device itself has an empty chain.
 */
export type CertChain = DeviceCert[];

function certMessage(user_id: string, devicePubkey: Uint8Array, issued_at: number): Uint8Array {
  return concatBytes(lp(utf8(user_id)), lp(devicePubkey), u64(issued_at));
}

export function issueDeviceCert(
  signer: KeyPair,
  user_id: string,
  newDevicePubkey: Uint8Array,
  issued_at: number = Math.floor(Date.now() / 1000),
): DeviceCert {
  const sig = sign(
    'communal/device-cert/v1',
    certMessage(user_id, newDevicePubkey, issued_at),
    signer.secretKey,
  );
  return {
    user_id,
    device_pubkey: toB64(newDevicePubkey),
    issued_at,
    signer_pubkey: toB64(signer.publicKey),
    sig: toB64(sig),
  };
}

export function verifyCertSignature(cert: DeviceCert): boolean {
  try {
    return verify(
      'communal/device-cert/v1',
      fromB64(cert.sig),
      certMessage(cert.user_id, fromB64(cert.device_pubkey), cert.issued_at),
      fromB64(cert.signer_pubkey),
    );
  } catch {
    return false;
  }
}

export type ChainResult =
  { ok: true; user_id: string; device_id: string } | { ok: false; reason: ChainFailure };

export type ChainFailure =
  'device_mismatch' | 'bad_signature' | 'broken_link' | 'wrong_account' | 'revoked' | 'malformed';

/**
 * Verifies that `devicePubkey` belongs to the account whose root key is `rootPubkey`.
 * `revoked` holds device_ids; a revoked device anywhere in the chain invalidates it, since
 * its signatures can no longer be trusted.
 */
export function verifyCertChain(
  rootPubkey: Uint8Array,
  devicePubkey: Uint8Array,
  chain: CertChain,
  revoked: ReadonlySet<string> = new Set(),
): ChainResult {
  const uid = userId(rootPubkey);
  if (revoked.has(deviceId(rootPubkey))) return { ok: false, reason: 'revoked' };

  let expectedSigner = rootPubkey;
  for (const cert of chain) {
    let signer: Uint8Array;
    let subject: Uint8Array;
    try {
      signer = fromB64(cert.signer_pubkey);
      subject = fromB64(cert.device_pubkey);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (cert.user_id !== uid) return { ok: false, reason: 'wrong_account' };
    if (!bytesEqual(signer, expectedSigner)) return { ok: false, reason: 'broken_link' };
    if (!verifyCertSignature(cert)) return { ok: false, reason: 'bad_signature' };
    if (revoked.has(deviceId(subject))) return { ok: false, reason: 'revoked' };
    expectedSigner = subject;
  }
  if (!bytesEqual(expectedSigner, devicePubkey)) return { ok: false, reason: 'device_mismatch' };
  return { ok: true, user_id: uid, device_id: deviceId(devicePubkey) };
}

/** Signed statement that a device of the account is revoked. */
export interface Revocation {
  user_id: string;
  device_id: string;
  revoked_at: number;
  signer_pubkey: string;
  sig: string;
}

function revocationMessage(user_id: string, device_id: string, revoked_at: number): Uint8Array {
  return concatBytes(lp(utf8(user_id)), lp(utf8(device_id)), u64(revoked_at));
}

export function issueRevocation(
  signer: KeyPair,
  user_id: string,
  device_id: string,
  revoked_at: number = Math.floor(Date.now() / 1000),
): Revocation {
  const sig = sign(
    'communal/revocation/v1',
    revocationMessage(user_id, device_id, revoked_at),
    signer.secretKey,
  );
  return {
    user_id,
    device_id,
    revoked_at,
    signer_pubkey: toB64(signer.publicKey),
    sig: toB64(sig),
  };
}

/**
 * Valid when signed by a device whose chain verifies for the same account. Revocations
 * already in force are applied to the signer's chain, so a revoked device can't revoke others.
 */
export function verifyRevocation(
  rev: Revocation,
  rootPubkey: Uint8Array,
  signerChain: CertChain,
  alreadyRevoked: ReadonlySet<string> = new Set(),
): boolean {
  let signer: Uint8Array;
  try {
    signer = fromB64(rev.signer_pubkey);
  } catch {
    return false;
  }
  const chain = verifyCertChain(rootPubkey, signer, signerChain, alreadyRevoked);
  if (!chain.ok || chain.user_id !== rev.user_id) return false;
  try {
    return verify(
      'communal/revocation/v1',
      fromB64(rev.sig),
      revocationMessage(rev.user_id, rev.device_id, rev.revoked_at),
      signer,
    );
  } catch {
    return false;
  }
}
