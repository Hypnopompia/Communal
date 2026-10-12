import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import selfsigned from 'selfsigned';
import { generateKeyPair, keyPairFromSecret, type KeyPair } from '@communal/crypto';

/**
 * Dev-only conveniences (COMMUNAL_DEV_TLS, COMMUNAL_AUTO_INIT) are honoured only in dev builds.
 * Docker images bake COMMUNAL_BUILD from a build arg (compose.dev.yml passes `dev`), and
 * source runs via `pnpm dev` default to dev. See docs/adr/0006-hub-sessions-and-tls.md.
 */
export function isDevBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.COMMUNAL_BUILD ?? 'release') === 'dev';
}

export function loadOrCreateHubKey(dir: string): { key: KeyPair; created: boolean } {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'hub.key');
  try {
    return { key: keyPairFromSecret(new Uint8Array(readFileSync(file))), created: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const key = generateKeyPair();
    writeFileSync(file, key.secretKey, { mode: 0o600 });
    return { key, created: true };
  }
}

export type TlsConfig = { key: string; cert: string } | undefined;

/**
 * Resolution order: explicit COMMUNAL_TLS_CERT/KEY files → dev self-signed (dev builds only)
 * → plain when COMMUNAL_TLS=off (TLS terminated by a reverse proxy) → refuse to start.
 */
export async function resolveTls(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TlsConfig> {
  if (env.COMMUNAL_TLS_CERT && env.COMMUNAL_TLS_KEY) {
    return {
      cert: readFileSync(env.COMMUNAL_TLS_CERT, 'utf8'),
      key: readFileSync(env.COMMUNAL_TLS_KEY, 'utf8'),
    };
  }
  if (env.COMMUNAL_DEV_TLS === 'self-signed' && isDevBuild(env)) return devSelfSigned(dataDir);
  if (env.COMMUNAL_TLS === 'off') return undefined;
  throw new Error(
    'TLS is not configured: set COMMUNAL_TLS_CERT and COMMUNAL_TLS_KEY, or COMMUNAL_TLS=off behind a TLS-terminating proxy',
  );
}

export async function devSelfSigned(dataDir: string): Promise<{ key: string; cert: string }> {
  const keyFile = join(dataDir, 'dev-tls.key');
  const certFile = join(dataDir, 'dev-tls.crt');
  try {
    return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') };
  } catch {
    mkdirSync(dataDir, { recursive: true });
    const notAfter = new Date();
    notAfter.setFullYear(notAfter.getFullYear() + 5);
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'communal-dev-hub' }], {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notAfterDate: notAfter,
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 2, value: 'hub' },
            { type: 7, ip: '127.0.0.1' },
          ],
        },
      ],
    });
    writeFileSync(keyFile, pems.private, { mode: 0o600 });
    writeFileSync(certFile, pems.cert);
    return { key: pems.private, cert: pems.cert };
  }
}
