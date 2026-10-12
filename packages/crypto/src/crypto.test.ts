import { describe, expect, it } from 'vitest';
import {
  checkTransferToken,
  deviceId,
  fingerprint,
  formatFingerprint,
  fromB64,
  generateKeyPair,
  importRecoveryFile,
  exportRecoveryFile,
  issueDeviceCert,
  issueRevocation,
  keyPairFromSecret,
  openSealed,
  SealError,
  sealTo,
  RecoveryError,
  rootSecretToWords,
  safetyCode,
  sign,
  signTransferToken,
  toB64,
  userId,
  verify,
  verifyCertChain,
  verifyRevocation,
  wordsToRootSecret,
  type DeviceCert,
} from './index.js';

const FAST_KDF = { t: 1, m: 256, p: 1 };

function account() {
  const root = generateKeyPair();
  return { root, uid: userId(root.publicKey) };
}

describe('identifiers', () => {
  it('derives stable, prefixed ids', () => {
    const kp = keyPairFromSecret(new Uint8Array(32).fill(7));
    expect(deviceId(kp.publicKey)).toMatch(/^d_[a-z2-7]{26}$/);
    expect(userId(kp.publicKey)).toMatch(/^u_[a-z2-7]{26}$/);
    expect(fingerprint(kp.publicKey)).toMatch(/^[a-z2-7]{52}$/);
    expect(deviceId(kp.publicKey)).toBe(deviceId(keyPairFromSecret(kp.secretKey).publicKey));
  });

  it('formats fingerprints in groups of 4', () => {
    expect(formatFingerprint('abcdefghij')).toBe('abcd efgh ij');
  });
});

describe('domain-separated signatures', () => {
  it('does not accept a signature under another domain', () => {
    const kp = generateKeyPair();
    const msg = new Uint8Array([1, 2, 3]);
    const sig = sign('communal/auth/v1', msg, kp.secretKey);
    expect(verify('communal/auth/v1', sig, msg, kp.publicKey)).toBe(true);
    expect(verify('communal/device-cert/v1', sig, msg, kp.publicKey)).toBe(false);
  });
});

describe('cert chains', () => {
  it('accepts the root device with an empty chain', () => {
    const { root, uid } = account();
    expect(verifyCertChain(root.publicKey, root.publicKey, [])).toEqual({
      ok: true,
      user_id: uid,
      device_id: deviceId(root.publicKey),
    });
  });

  it('accepts a multi-hop chain and rejects tampering', () => {
    const { root, uid } = account();
    const d2 = generateKeyPair();
    const d3 = generateKeyPair();
    const chain = [
      issueDeviceCert(root, uid, d2.publicKey),
      issueDeviceCert(d2, uid, d3.publicKey),
    ];
    expect(verifyCertChain(root.publicKey, d3.publicKey, chain).ok).toBe(true);

    const other = generateKeyPair();
    expect(verifyCertChain(root.publicKey, other.publicKey, chain)).toEqual({
      ok: false,
      reason: 'device_mismatch',
    });
    expect(verifyCertChain(root.publicKey, d3.publicKey, [chain[1]!])).toMatchObject({
      reason: 'broken_link',
    });
    const forged: DeviceCert = { ...chain[1]!, issued_at: chain[1]!.issued_at + 1 };
    expect(verifyCertChain(root.publicKey, d3.publicKey, [chain[0]!, forged])).toMatchObject({
      reason: 'bad_signature',
    });
  });

  it('rejects a cert issued for another account', () => {
    const a = account();
    const b = account();
    const d = generateKeyPair();
    const cert = issueDeviceCert(a.root, b.uid, d.publicKey);
    expect(verifyCertChain(a.root.publicKey, d.publicKey, [cert])).toMatchObject({
      reason: 'wrong_account',
    });
  });

  it('rejects chains through a revoked device', () => {
    const { root, uid } = account();
    const d2 = generateKeyPair();
    const d3 = generateKeyPair();
    const chain = [
      issueDeviceCert(root, uid, d2.publicKey),
      issueDeviceCert(d2, uid, d3.publicKey),
    ];
    const revoked = new Set([deviceId(d2.publicKey)]);
    expect(verifyCertChain(root.publicKey, d3.publicKey, chain, revoked)).toMatchObject({
      reason: 'revoked',
    });
  });
});

describe('revocation', () => {
  it('lets any valid device revoke another, but not a revoked one', () => {
    const { root, uid } = account();
    const d2 = generateKeyPair();
    const d2chain = [issueDeviceCert(root, uid, d2.publicKey)];
    const rev = issueRevocation(d2, uid, deviceId(root.publicKey));
    expect(verifyRevocation(rev, root.publicKey, d2chain)).toBe(true);
    expect(verifyRevocation(rev, root.publicKey, d2chain, new Set([deviceId(d2.publicKey)]))).toBe(
      false,
    );
    const outsider = generateKeyPair();
    const bad = issueRevocation(outsider, uid, deviceId(d2.publicKey));
    expect(verifyRevocation(bad, root.publicKey, [])).toBe(false);
  });
});

describe('safety codes', () => {
  it('is symmetric and formatted as 4×5 digits', () => {
    const a = fingerprint(generateKeyPair().publicKey);
    const b = fingerprint(generateKeyPair().publicKey);
    const code = safetyCode(a, b);
    expect(code).toMatch(/^\d{5} \d{5} \d{5} \d{5}$/);
    expect(safetyCode(b, a)).toBe(code);
    expect(safetyCode(a, fingerprint(generateKeyPair().publicKey))).not.toBe(code);
  });
});

describe('recovery key', () => {
  it('round-trips through the encrypted file', async () => {
    const { root, uid } = account();
    const hubs = [{ url: 'wss://hub.example/v1', hub_pubkey: toB64(generateKeyPair().publicKey) }];
    const file = await exportRecoveryFile(root.secretKey, uid, 'correct horse', FAST_KDF, hubs);
    expect(file.hubs).toEqual(hubs);
    const restored = await importRecoveryFile(JSON.parse(JSON.stringify(file)), 'correct horse');
    expect(toB64(restored)).toBe(toB64(root.secretKey));
    await expect(importRecoveryFile(file, 'wrong')).rejects.toBeInstanceOf(RecoveryError);
    await expect(
      importRecoveryFile({ ...file, user_id: 'u_someoneelse' }, 'correct horse'),
    ).rejects.toBeInstanceOf(RecoveryError);
  });

  it('round-trips through 24 words', () => {
    const { root } = account();
    const words = rootSecretToWords(root.secretKey);
    expect(words).toHaveLength(24);
    expect(toB64(wordsToRootSecret(words))).toBe(toB64(root.secretKey));
    expect(toB64(wordsToRootSecret('  ' + words.join('  ').toUpperCase()))).toBe(
      toB64(root.secretKey),
    );
    const swapped = [words[1]!, words[0]!, ...words.slice(2)];
    if (swapped.join() !== words.join()) {
      expect(() => wordsToRootSecret(swapped)).toThrow(RecoveryError);
    }
  });
});

describe('sealed box', () => {
  it('opens only for the recipient key', () => {
    const to = generateKeyPair();
    const msg = new TextEncoder().encode('{"hubs":[]}');
    const sealed = sealTo(to.publicKey, msg);
    expect(new TextDecoder().decode(openSealed(to, sealed))).toBe('{"hubs":[]}');
    expect(() => openSealed(generateKeyPair(), sealed)).toThrow(SealError);
    // Any bit flip fails authentication.
    const raw = fromB64(sealed);
    raw[raw.length - 1]! ^= 1;
    expect(() => openSealed(to, toB64(raw))).toThrow(SealError);
    expect(() => openSealed(to, 'AAAA')).toThrow(SealError);
  });
});

describe('transfer tokens', () => {
  const hub = generateKeyPair();
  const claims = { session_id: 'x_1', from: 'd_down', to: 'd_up', hash: 'h', exp: 1000 };
  const token = signTransferToken(hub, claims);
  const expect_ = { self: 'd_up', peer: 'd_down', now: 500 };

  it('accepts a valid token', () => {
    expect(checkTransferToken(token, hub.publicKey, expect_)).toEqual({ ok: true });
  });

  it.each([
    ['expired', { ...expect_, now: 1000 }, token],
    ['wrong_target', { ...expect_, self: 'd_other' }, token],
    ['wrong_sender', { ...expect_, peer: 'd_other' }, token],
    ['bad_signature', expect_, { ...token, claims: { ...claims, exp: 99999 } }],
  ] as const)('rejects %s', (reason, exp, tok) => {
    expect(checkTransferToken(tok, hub.publicKey, exp)).toEqual({ ok: false, reason });
  });

  it('rejects a token signed by another key', () => {
    const forged = signTransferToken(generateKeyPair(), claims);
    expect(checkTransferToken(forged, hub.publicKey, expect_)).toMatchObject({
      reason: 'bad_signature',
    });
    expect(fromB64(forged.sig)).toHaveLength(64);
  });
});
