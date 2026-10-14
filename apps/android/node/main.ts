/**
 * The Android app's core host (ADR 0023): like `communal daemon` and the desktop `core-host.ts`,
 * it runs `CommunalCore` and serves the local API on 127.0.0.1 behind a bearer token. The Kotlin
 * app starts it as a child process and talks to the API; Kotlin owns the foreground service,
 * WorkManager, MediaStore and the device key (wrapped by the Android Keystore).
 *
 * The phone only downloads: no shares, so the indexer and media worker stay idle, and sharp,
 * ffmpeg, pdf.js and the OS trash aren't shipped (scripts/build.mjs).
 *
 * Secrets come on stdin as one JSON line, so they never sit in the environment or a file:
 *   { "device_key": "<base64url 32-byte seed>", "api_token": "<hex>" }
 * Settings come from the environment, set by the Kotlin side:
 *   COMMUNAL_DATA       data dir (the app's filesDir/communal)
 *   COMMUNAL_DOWNLOADS  the downloads folder (Download/Communal on shared storage)
 *   COMMUNAL_TRASH      where mirrored deletions go (the app's folder on shared storage, next
 *                       to the downloads; emptied after 30 days)
 *   COMMUNAL_VERSION    the app's version, sent to hubs
 *   COMMUNAL_BUILD=dev  with COMMUNAL_DEV_TLS=self-signed: accept a dev hub's certificate
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pino } from 'pino';
import { fromB64, keyPairFromSecret } from '@communal/crypto';
import { CommunalCore, LocalApi } from '@communal/core';

const env = process.env;
const dataDir = env.COMMUNAL_DATA ?? join(process.cwd(), 'communal-data');
const trashDir = env.COMMUNAL_TRASH ?? join(dataDir, 'trash');
const log = pino({ level: env.COMMUNAL_LOG ?? 'info' });
const TRASH_DAYS = 30;

interface Secrets {
  device_key: string;
  api_token: string;
}

async function readSecrets(): Promise<Secrets> {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    rl.close();
    const s = JSON.parse(line) as Partial<Secrets>;
    if (typeof s.device_key !== 'string' || typeof s.api_token !== 'string')
      throw new Error('secrets line is missing device_key or api_token');
    return s as Secrets;
  }
  throw new Error('no secrets on stdin');
}

/** Mirrored deletions wait in app storage for a while, like the desktop OS trash. */
function emptyOldTrash() {
  const cutoff = Date.now() - TRASH_DAYS * 86_400_000;
  let entries: string[] = [];
  try {
    entries = readdirSync(trashDir);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(trashDir, e);
    try {
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
    } catch {
      /* gone already */
    }
  }
}

async function main() {
  const secrets = await readSecrets();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  emptyOldTrash();
  const device = keyPairFromSecret(fromB64(secrets.device_key));
  const dev = env.COMMUNAL_BUILD === 'dev';
  const core = new CommunalCore({
    dataDir,
    device,
    hubClient: {
      client: { name: 'communal-android', version: env.COMMUNAL_VERSION ?? '0.0.0' },
      insecureTls: dev && env.COMMUNAL_DEV_TLS === 'self-signed',
    },
    // No UPnP mapper: a phone doesn't own the Wi-Fi router or the carrier's network.
    network: {},
    ...(env.COMMUNAL_DOWNLOADS ? { downloadsDir: env.COMMUNAL_DOWNLOADS } : {}),
    subscriptions: {
      trash: async (path) => {
        const dir = join(trashDir, String(Date.now()));
        await mkdir(dir, { recursive: true });
        const to = join(dir, basename(path));
        try {
          await rename(path, to);
        } catch (err) {
          // Another file system (shared storage and app storage can be): copy, then remove.
          if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
          await copyFile(path, to);
          await unlink(path);
        }
        // The app drops it from the media library (a protocol line on stdout, not a log).
        console.log(`TRASHED ${path}`);
      },
    },
    // A phone that started its own account holds the root as its device key; nothing to keep.
    root: {},
    log,
  });
  core.hubs.on('ready', ({ hub, welcome }) =>
    log.info({ hub, user_id: welcome.user_id }, 'connected to hub'),
  );
  core.hubs.on('fatal', ({ hub, error }) =>
    log.error({ hub, reason: error.reason }, error.message),
  );

  await core.start();
  const api = new LocalApi(core);
  const url = await api.listen({ host: '127.0.0.1', port: 0, token: secrets.api_token });
  // The Kotlin side reads this line to find the API.
  console.log(`API ${url}`);
  log.info({ device_id: core.deviceId, node: process.version }, 'android core ready');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await api.close();
    await core.stop();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  // The app closing our stdin (or dying) means stop: never outlive it.
  process.stdin.once('end', () => void stop());
  process.stdin.resume();
}

main().catch((err: Error) => {
  log.fatal({ err }, 'core failed');
  process.exit(1);
});
