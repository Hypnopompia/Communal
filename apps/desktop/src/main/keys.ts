/**
 * Device and root keys at rest (HANDOFF §3: "Electron safeStorage encrypting the key file").
 * With OS encryption available (Keychain, DPAPI, libsecret/kwallet), keys live in `*.key.enc`.
 * Without it (Linux with no keyring), they fall back to `*.key` with mode 0600, like the
 * headless client, and main logs a warning (ADR 0016). A plain file left over from such a
 * setup is encrypted and removed as soon as encryption becomes available.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { generateKeyPair } from '@communal/crypto';

export class KeyStore {
  /** `useOsEncryption: false` for throwaway smoke-test profiles, which must never prompt. */
  constructor(
    private readonly dir: string,
    private readonly useOsEncryption = true,
  ) {}

  get encrypted(): boolean {
    return this.useOsEncryption && safeStorage.isEncryptionAvailable();
  }

  /** This device's secret key, created on first launch. */
  deviceSecret(): Uint8Array {
    const existing = this.load('device');
    if (existing) return existing;
    const { secretKey } = generateKeyPair();
    this.save('device', secretKey);
    return secretKey;
  }

  rootSecret(): Uint8Array | undefined {
    return this.load('root');
  }

  saveRoot(secret: Uint8Array) {
    this.save('root', secret);
  }

  private load(name: 'device' | 'root'): Uint8Array | undefined {
    const enc = join(this.dir, `${name}.key.enc`);
    const plain = join(this.dir, `${name}.key`);
    if (existsSync(enc)) {
      const b = Buffer.from(safeStorage.decryptString(readFileSync(enc)), 'base64');
      return b.length === 32 ? new Uint8Array(b) : undefined;
    }
    if (!existsSync(plain)) return undefined;
    const b = new Uint8Array(readFileSync(plain));
    if (b.length !== 32) return undefined;
    if (this.encrypted) {
      this.save(name, b);
      rmSync(plain);
    }
    return b;
  }

  private save(name: 'device' | 'root', secret: Uint8Array) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const enc = this.encrypted;
    const file = join(this.dir, enc ? `${name}.key.enc` : `${name}.key`);
    const data = enc
      ? safeStorage.encryptString(Buffer.from(secret).toString('base64'))
      : Buffer.from(secret);
    writeFileSync(file + '.tmp', data, { mode: 0o600 });
    renameSync(file + '.tmp', file);
  }
}

/**
 * "Start over" on a computer removed from its account: its keys can never sign in again, so it
 * needs a new identity. Nothing is deleted. The keys and the core's data (account, hubs, index,
 * caches) move to `<userData>/set-aside-<date>`, and the next start is a fresh install.
 * Settings and the files people shared stay where they are.
 */
export function setAside(dir: string): string {
  const to = join(dir, `set-aside-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of ['core', 'device.key.enc', 'device.key', 'root.key.enc', 'root.key'])
    if (existsSync(join(dir, name))) renameSync(join(dir, name), join(to, name));
  return to;
}
