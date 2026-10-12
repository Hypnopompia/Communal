import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { fromB64, toB64, utf8 } from './encoding.js';

/**
 * Recovery key formats for the account root secret (see docs/adr/0003-recovery-key.md):
 * - a passphrase-encrypted JSON file (Argon2id → XChaCha20-Poly1305), or
 * - a 24-word BIP39 English word list encoding the 32-byte seed.
 */

export interface KdfParams {
  /** Iterations. */
  t: number;
  /** Memory in KiB. */
  m: number;
  /** Parallelism. */
  p: number;
}

/** OWASP-recommended floor for Argon2id. */
export const DEFAULT_KDF: KdfParams = { t: 3, m: 64 * 1024, p: 1 };

export interface RecoveryFile {
  format: 'communal-recovery';
  v: 1;
  user_id: string;
  kdf: { alg: 'argon2id'; salt: string } & KdfParams;
  cipher: 'xchacha20poly1305';
  nonce: string;
  ct: string;
}

function aad(user_id: string, kdf: RecoveryFile['kdf']): Uint8Array {
  return utf8(`communal-recovery/v1|${user_id}|${kdf.salt}|${kdf.t}|${kdf.m}|${kdf.p}`);
}

async function deriveKey(passphrase: string, salt: Uint8Array, k: KdfParams): Promise<Uint8Array> {
  return argon2idAsync(utf8(passphrase.normalize('NFKC')), salt, {
    t: k.t,
    m: k.m,
    p: k.p,
    dkLen: 32,
  });
}

export async function exportRecoveryFile(
  rootSecret: Uint8Array,
  user_id: string,
  passphrase: string,
  params: KdfParams = DEFAULT_KDF,
): Promise<RecoveryFile> {
  if (rootSecret.length !== 32) throw new RangeError('root secret must be 32 bytes');
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const kdf = { alg: 'argon2id' as const, salt: toB64(salt), ...params };
  const key = await deriveKey(passphrase, salt, params);
  const ct = xchacha20poly1305(key, nonce, aad(user_id, kdf)).encrypt(rootSecret);
  return {
    format: 'communal-recovery',
    v: 1,
    user_id,
    kdf,
    cipher: 'xchacha20poly1305',
    nonce: toB64(nonce),
    ct: toB64(ct),
  };
}

export class RecoveryError extends Error {}

export async function importRecoveryFile(
  file: RecoveryFile,
  passphrase: string,
): Promise<Uint8Array> {
  if (file.format !== 'communal-recovery' || file.v !== 1 || file.kdf.alg !== 'argon2id') {
    throw new RecoveryError('unsupported recovery file');
  }
  const key = await deriveKey(passphrase, fromB64(file.kdf.salt), file.kdf);
  try {
    return xchacha20poly1305(key, fromB64(file.nonce), aad(file.user_id, file.kdf)).decrypt(
      fromB64(file.ct),
    );
  } catch {
    throw new RecoveryError('wrong passphrase or corrupted file');
  }
}

export function rootSecretToWords(rootSecret: Uint8Array): string[] {
  if (rootSecret.length !== 32) throw new RangeError('root secret must be 32 bytes');
  return entropyToMnemonic(rootSecret, wordlist).split(' ');
}

export function wordsToRootSecret(words: string[] | string): Uint8Array {
  const phrase = (Array.isArray(words) ? words.join(' ') : words)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .join(' ');
  if (!validateMnemonic(phrase, wordlist)) {
    throw new RecoveryError('invalid recovery words (check spelling and order)');
  }
  return mnemonicToEntropy(phrase, wordlist);
}
