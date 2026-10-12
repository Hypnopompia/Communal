import { fromB64, toB64, utf8 } from './encoding.js';
import { sign, verify, type KeyPair } from './keys.js';

/** Hub-signed transfer authorization carried in the peer `hello` frame. */
export interface TransferClaims {
  session_id: string;
  /** Downloader device_id. */
  from: string;
  /** Uploader device_id. */
  to: string;
  hash: string;
  /** Expiry, unix seconds. */
  exp: number;
}

export interface SignedToken {
  claims: TransferClaims;
  sig: string;
}

function canonical(c: TransferClaims): Uint8Array {
  // Fixed field order; values are validated strings/ints so JSON is unambiguous here.
  return utf8(JSON.stringify([c.session_id, c.from, c.to, c.hash, c.exp]));
}

export function signTransferToken(hub: KeyPair, claims: TransferClaims): SignedToken {
  return {
    claims,
    sig: toB64(sign('communal/transfer-token/v1', canonical(claims), hub.secretKey)),
  };
}

export type TokenCheck =
  | { ok: true }
  | { ok: false; reason: 'bad_signature' | 'expired' | 'wrong_target' | 'wrong_sender' };

/**
 * The uploader-side checks from HANDOFF §7 that are purely about the token. Cert-chain and
 * access-rule checks happen in core, where that state lives.
 */
export function checkTransferToken(
  token: SignedToken,
  hubPubkey: Uint8Array,
  expect: { self: string; peer: string; now?: number },
): TokenCheck {
  let sigOk: boolean;
  try {
    sigOk = verify(
      'communal/transfer-token/v1',
      fromB64(token.sig),
      canonical(token.claims),
      hubPubkey,
    );
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: 'bad_signature' };
  if (token.claims.exp <= (expect.now ?? Math.floor(Date.now() / 1000))) {
    return { ok: false, reason: 'expired' };
  }
  if (token.claims.to !== expect.self) return { ok: false, reason: 'wrong_target' };
  if (token.claims.from !== expect.peer) return { ok: false, reason: 'wrong_sender' };
  return { ok: true };
}
