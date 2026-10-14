/**
 * EXPERIMENTAL (Android spike, docs/adr/0023-android-client-spike.md). The phone's core host:
 * like `communal daemon` and the desktop `core-host.ts`, it runs `CommunalCore` and serves the
 * local API on 127.0.0.1 with a bearer token. The Kotlin app starts it as a child process and
 * talks to the API; Kotlin owns the foreground service, WorkManager and MediaStore.
 *
 * Settings come from the environment, set by the Kotlin side:
 *   COMMUNAL_DATA       data dir (the app's filesDir/communal)
 *   COMMUNAL_DOWNLOADS  where downloads land
 *   COMMUNAL_API_PORT   API port (default 0 = any; the chosen URL is printed as `API <url>`)
 *   COMMUNAL_API_TOKEN  bearer token for the API (required in practice; random if unset)
 *   COMMUNAL_INSECURE_TLS=true  accept the dev hub's self-signed certificate (spike only)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { pino } from 'pino';
import { generateKeyPair, keyPairFromSecret } from '@communal/crypto';
import { CommunalCore, LocalApi } from '@communal/core';

const env = process.env;
const dataDir = env.COMMUNAL_DATA ?? join(process.cwd(), 'communal-data');
const log = pino({ level: env.COMMUNAL_LOG ?? 'info' });
const t0 = Date.now();

function deviceKey() {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, 'device.key');
  try {
    return keyPairFromSecret(new Uint8Array(readFileSync(file)));
  } catch {
    const kp = generateKeyPair();
    writeFileSync(file, kp.secretKey, { mode: 0o600 });
    return kp;
  }
}

const rootFile = join(dataDir, 'root.key');
function loadRoot(): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(rootFile));
  } catch {
    return undefined;
  }
}

const root = loadRoot();
const core = new CommunalCore({
  dataDir,
  device: deviceKey(),
  hubClient: {
    client: { name: 'communal-android-spike', version: '0.0.0' },
    insecureTls: env.COMMUNAL_INSECURE_TLS === 'true',
  },
  // No UPnP mapper on a phone: the carrier or Wi-Fi router is someone else's (and a phone only
  // downloads, so the uploader's reachability matters more than ours).
  network: {},
  ...(env.COMMUNAL_DOWNLOADS ? { downloadsDir: env.COMMUNAL_DOWNLOADS } : {}),
  // No OS trash on Android: mirrored deletions go to an app folder instead. The real app would
  // hand them to Kotlin (MediaStore.createTrashRequest for files in the Music collection).
  subscriptions: {
    trash: async (path) => {
      const dir = join(dataDir, 'trash', String(Date.now()));
      await mkdir(dir, { recursive: true });
      await rename(path, join(dir, basename(path)));
    },
  },
  root: {
    ...(root ? { secret: root } : {}),
    save: (secret) => writeFileSync(rootFile, secret, { mode: 0o600 }),
  },
  log,
});
core.hubs.on('ready', ({ hub, welcome }) =>
  log.info({ hub, user_id: welcome.user_id }, 'connected to hub'),
);
core.hubs.on('fatal', ({ hub, error }) => log.error({ hub, reason: error.reason }, error.message));

async function main() {
  await core.start();
  const api = new LocalApi(core);
  const url = await api.listen({
    host: '127.0.0.1',
    port: Number(env.COMMUNAL_API_PORT ?? 0),
    token: env.COMMUNAL_API_TOKEN ?? randomBytes(24).toString('hex'),
  });
  // The Kotlin side reads this line to find the API.
  console.log(`API ${url}`);
  log.info(
    {
      device_id: core.deviceId,
      node: process.version,
      startup_ms: Date.now() - t0,
      rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    },
    'android core ready',
  );

  // Memory samples for the ADR, every 30 s.
  setInterval(() => {
    const m = process.memoryUsage();
    log.info(
      { rss_mb: +(m.rss / 1048576).toFixed(1), heap_mb: +(m.heapUsed / 1048576).toFixed(1) },
      'mem',
    );
  }, 30_000).unref();

  await new Promise<void>((done) => {
    process.once('SIGTERM', done);
    process.once('SIGINT', done);
  });
  await api.close();
  await core.stop();
}

main().catch((err: Error) => {
  log.fatal({ err }, 'core failed');
  process.exit(1);
});
