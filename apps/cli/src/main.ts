#!/usr/bin/env node
/**
 * Headless client (HANDOFF §11). `communal daemon` runs the core engine and serves the local
 * API on a Unix socket; the other commands talk to it. `init` / `hub add` also work while the
 * daemon is stopped, so a device can be set up before its service starts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { pino } from 'pino';
import {
  deviceId,
  formatFingerprint,
  generateKeyPair,
  keyPairFromSecret,
  type KeyPair,
} from '@communal/crypto';
import {
  CommunalCore,
  HubManager,
  LocalApi,
  LocalApiClient,
  newHubId,
  type HubClientState,
  type HubEntry,
  type MergedSearch,
} from '@communal/core';
import { PROTOCOL_VERSION } from '@communal/protocol';

const VERSION = '0.0.0';
const log = pino({ name: 'communal', level: process.env.LOG_LEVEL ?? 'info' });
const dataDir = process.env.COMMUNAL_DATA ?? join(process.env.HOME ?? '.', '.communal');
/** Dev-only conveniences need a dev build (see docs/adr/0006-hub-sessions-and-tls.md). */
const devBuild = (process.env.COMMUNAL_BUILD ?? 'release') === 'dev';
const insecureTls = devBuild && process.env.COMMUNAL_DEV_TLS === 'self-signed';
const client = { name: 'communal-cli', version: VERSION };

const paths = {
  key: () => join(dataDir, 'device.key'),
  hubs: () => join(dataDir, 'hubs.json'),
  /** Single-hub config written before multi-hub support; migrated on first load. */
  legacyHub: () => join(dataDir, 'hub.json'),
  socket: () => process.env.COMMUNAL_API_SOCKET ?? join(dataDir, 'api.sock'),
};

function loadDeviceKey(): KeyPair | null {
  try {
    return keyPairFromSecret(new Uint8Array(readFileSync(paths.key())));
  } catch {
    return null;
  }
}

function ensureDeviceKey(): KeyPair {
  const existing = loadDeviceKey();
  if (existing) return existing;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const kp = generateKeyPair();
  writeFileSync(paths.key(), kp.secretKey, { mode: 0o600 });
  return kp;
}

function saveHubs(hubs: HubEntry[]) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = paths.hubs() + '.tmp';
  writeFileSync(tmp, JSON.stringify({ hubs }, null, 2), { mode: 0o600 });
  renameSync(tmp, paths.hubs());
}

function loadHubs(): HubEntry[] {
  try {
    return (JSON.parse(readFileSync(paths.hubs(), 'utf8')) as { hubs: HubEntry[] }).hubs;
  } catch {
    // fall through to the legacy file / empty config
  }
  if (existsSync(paths.legacyHub())) {
    const legacy = JSON.parse(readFileSync(paths.legacyHub(), 'utf8')) as {
      hub: string;
      state: HubClientState;
    };
    const hubs = [{ id: newHubId(), url: legacy.hub, state: legacy.state }];
    saveHubs(hubs);
    renameSync(paths.legacyHub(), paths.legacyHub() + '.migrated');
    return hubs;
  }
  return [];
}

const platform = (): 'darwin' | 'win32' | 'linux' =>
  process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';

const api = () => new LocalApiClient({ socketPath: paths.socket() });

async function daemonRunning(): Promise<boolean> {
  if (!existsSync(paths.socket())) return false;
  return api()
    .get('/v1/status')
    .then(() => true)
    .catch(() => false);
}

/** Runs a command against the daemon, turning errors into a message and exit code. */
async function viaDaemon(fn: (c: LocalApiClient) => Promise<void>) {
  if (!(await daemonRunning())) {
    console.error('the communal daemon is not running (start it with `communal daemon`)');
    process.exitCode = 1;
    return;
  }
  try {
    await fn(api());
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

function printJoined(url: string, id: string, status: string, userId?: string, fp?: string) {
  console.log(
    status === 'pending_approval'
      ? `Joined ${url} (${id}). The hub admin must approve the account first.`
      : `Joined ${url} (${id})`,
  );
  console.log(`  user:        ${userId}`);
  console.log(`  fingerprint: ${formatFingerprint(fp ?? '')}`);
}

/** Joins a hub, through the daemon if it's running, otherwise directly. */
async function joinHub(url: string, name: string, deviceName: string): Promise<boolean> {
  if (await daemonRunning()) {
    try {
      const r = await api().post<{
        hub: { id: string; user_id?: string; fingerprint?: string };
        status: string;
      }>('/v1/hubs', { url, display_name: name, device_name: deviceName });
      printJoined(url, r.hub.id, r.status, r.hub.user_id, r.hub.fingerprint);
      return true;
    } catch (err) {
      console.error(`could not join ${url}: ${(err as Error).message}`);
      return false;
    }
  }
  const hubs = new HubManager({
    device: ensureDeviceKey(),
    hubs: loadHubs(),
    save: saveHubs,
    client,
    insecureTls,
    log: pino({ level: 'warn' }),
  });
  if (hubs.find(url)) {
    console.error(`already configured: ${url}`);
    return false;
  }
  const entry = await hubs.add(url, {
    display_name: name,
    device_name: deviceName,
    platform: platform(),
  });
  const c = hubs.get(entry.id)!;
  const outcome = new Promise<'ready' | 'pending_approval' | Error>((resolve) => {
    c.once('ready', () => resolve('ready'));
    c.once('pending_approval', () => resolve('pending_approval'));
    c.once('fatal', (e) => resolve(e));
    setTimeout(() => resolve(new Error('timed out connecting to the hub')), 30_000).unref();
  });
  c.start();
  const result = await outcome;
  await c.stop();
  if (result instanceof Error) {
    if (!entry.state.registered) await hubs.remove(entry.id);
    console.error(`could not join ${url}: ${result.message}`);
    return false;
  }
  printJoined(url, entry.id, result, entry.state.userId, entry.state.fingerprint);
  return true;
}

function humanSize(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const program = new Command()
  .name('communal')
  .description('Communal headless client')
  .version(`${VERSION} (protocol v${PROTOCOL_VERSION})`);

program
  .command('init')
  .description('set up this device and join a first hub (same as `hub add`)')
  .requiredOption('--hub <url>', 'hub address, e.g. wss://hub.example.org/v1')
  .requiredOption('--name <display_name>', 'your display name on the hub')
  .option('--device-name <name>', 'name for this device', hostname())
  .action(async (opts: { hub: string; name: string; deviceName: string }) => {
    if (!(await joinHub(opts.hub, opts.name, opts.deviceName))) process.exitCode = 1;
  });

// ── hubs ────────────────────────────────────────────────────────────────────

const hub = program.command('hub').description('manage the hubs this device is on');

hub
  .command('add <url>')
  .description('join another hub with this device')
  .requiredOption('--name <display_name>', 'your display name on that hub')
  .option('--device-name <name>', 'name for this device', hostname())
  .action(async (url: string, opts: { name: string; deviceName: string }) => {
    if (!(await joinHub(url, opts.name, opts.deviceName))) process.exitCode = 1;
  });

hub
  .command('list')
  .description('list configured hubs')
  .action(async () => {
    if (await daemonRunning()) {
      const { hubs } = await api().get<{ hubs: { id: string; url: string; ready: boolean }[] }>(
        '/v1/hubs',
      );
      for (const h of hubs) console.log(`${h.id}  ${h.ready ? 'online ' : 'offline'}  ${h.url}`);
      if (hubs.length === 0)
        console.log('no hubs; add one with `communal hub add <url> --name <name>`');
      return;
    }
    const hubs = loadHubs();
    if (hubs.length === 0)
      console.log('no hubs; add one with `communal hub add <url> --name <name>`');
    for (const h of hubs)
      console.log(`${h.id}  ${h.state.registered ? 'joined ' : 'pending'}  ${h.url}`);
  });

hub
  .command('remove <id_or_url>')
  .description('stop using a hub on this device (your account stays on the hub)')
  .action(async (target: string) => {
    if (await daemonRunning()) {
      return viaDaemon(async (c) => {
        await c.delete(`/v1/hubs/${encodeURIComponent(target)}`);
        console.log(`removed ${target}`);
      });
    }
    const hubs = new HubManager({
      device: ensureDeviceKey(),
      hubs: loadHubs(),
      save: saveHubs,
      log,
    });
    if (await hubs.remove(target)) console.log(`removed ${target}`);
    else {
      console.error(`no such hub: ${target}`);
      process.exitCode = 1;
    }
  });

// ── shares ──────────────────────────────────────────────────────────────────

const share = program.command('share').description('manage shared folders');

share
  .command('add <path>')
  .description('share a folder (published to every hub this device is on, unless --hub is given)')
  .requiredOption('--name <name>', 'share name, shown to others as the top-level folder')
  .option('--hub <id...>', 'publish only to these hubs')
  .action((path: string, opts: { name: string; hub?: string[] }) =>
    viaDaemon(async (c) => {
      await c.post('/v1/shares', { name: opts.name, path: resolve(path), hubs: opts.hub });
      console.log(`sharing ${opts.name} (only you can see it until access rules land in M3)`);
    }),
  );

share
  .command('remove <name>')
  .description('stop sharing a folder (files stay on disk)')
  .action((name: string) =>
    viaDaemon(async (c) => {
      await c.delete(`/v1/shares/${encodeURIComponent(name)}`);
      console.log(`stopped sharing ${name}`);
    }),
  );

share
  .command('list')
  .description('list shared folders')
  .action(() =>
    viaDaemon(async (c) => {
      const { shares } = await c.get<{ shares: { name: string; root: string; hubs: string[] }[] }>(
        '/v1/shares',
      );
      if (shares.length === 0)
        console.log('no shares; add one with `communal share add <path> --name <name>`');
      for (const s of shares)
        console.log(`${s.name}  ${s.root}  hubs: ${s.hubs.join(', ') || '(none)'}`);
    }),
  );

share
  .command('hubs <name> [hub_ids...]')
  .description('set which hubs a share is published to (none = unpublished everywhere)')
  .action((name: string, hubIds: string[]) =>
    viaDaemon(async (c) => {
      await c.put(`/v1/shares/${encodeURIComponent(name)}/hubs`, { hubs: hubIds });
      console.log(`${name} is published to: ${hubIds.join(', ') || '(no hubs)'}`);
    }),
  );

// ── search & browse ─────────────────────────────────────────────────────────

program
  .command('search [query...]')
  .description('search every connected hub at once')
  .option('--kind <kind>', 'image, video, audio, document, archive, code, text, disk_image, other')
  .option('--min-size <bytes>', 'smallest file size')
  .option('--limit <n>', 'results per hub', '50')
  .option('--json', 'machine-readable output')
  .action(
    (words: string[], opts: { kind?: string; minSize?: string; limit: string; json?: boolean }) =>
      viaDaemon(async (c) => {
        const p = new URLSearchParams({ q: words.join(' '), limit: opts.limit });
        if (opts.kind) p.set('kind', opts.kind);
        if (opts.minSize) p.set('min_size', opts.minSize);
        const r = await c.get<MergedSearch>(`/v1/search?${p}`);
        if (opts.json) return console.log(JSON.stringify(r, null, 2));
        for (const h of r.hits) {
          const online = h.sources.filter((s) => s.online).length;
          console.log(
            `${h.name}  ${humanSize(h.size)}  ${h.kind}  ${h.sources.length} source(s), ${online} online  ${h.hash.slice(0, 12)}`,
          );
        }
        const down = r.hubs.filter((h) => !h.ok);
        console.log(
          `${r.hits.length} result(s)` +
            (down.length
              ? `; unavailable: ${down.map((h) => `${h.hub} (${h.error})`).join(', ')}`
              : ''),
        );
      }),
  );

program
  .command('browse <hub> <device_id> [path]')
  .description('list a folder on a device you can see (your own devices, for now)')
  .action((hubId: string, device: string, path = '') =>
    viaDaemon(async (c) => {
      const p = new URLSearchParams({ hub: hubId, device, path });
      const r = await c.get<{
        online: boolean;
        dirs: { name: string }[];
        files: { path: string; size: number; hash: string | null }[];
      }>(`/v1/browse?${p}`);
      for (const d of r.dirs) console.log(`${d.name}/`);
      for (const f of r.files) {
        console.log(
          `${f.path.slice(f.path.lastIndexOf('/') + 1)}  ${humanSize(f.size)}${f.hash ? '' : '  (hashing…)'}`,
        );
      }
      console.log(`device ${r.online ? 'online' : 'offline'}`);
    }),
  );

// ── daemon & status ─────────────────────────────────────────────────────────

program
  .command('daemon')
  .description('run the client engine in the foreground, connected to every configured hub')
  .action(async () => {
    if (await daemonRunning()) {
      log.fatal(
        { socket: paths.socket() },
        'another communal daemon is already running for this data dir',
      );
      process.exitCode = 1;
      return;
    }
    const key = ensureDeviceKey();
    loadHubs(); // migrates a legacy hub.json before the core reads hubs.json
    const rescanMinutes = Number(process.env.COMMUNAL_RESCAN_MINUTES ?? 15);
    const core = new CommunalCore({
      dataDir,
      device: key,
      hubClient: { client, insecureTls },
      indexer: { rescanMs: rescanMinutes * 60_000 },
      log,
    });
    const localApi = new LocalApi(core);

    core.hubs.on('ready', ({ hub, welcome }) =>
      log.info(
        { hub, user_id: welcome.user_id, observed_addr: welcome.observed_addr },
        'connected to hub',
      ),
    );
    core.hubs.on('presence', ({ hub, presence }) => log.info({ hub, ...presence }, 'presence'));
    core.hubs.on('pending_approval', ({ hub }) =>
      log.warn({ hub }, 'account is waiting for hub admin approval'),
    );
    // A fatal error on one hub (banned, key changed) leaves the others running.
    core.hubs.on('fatal', ({ hub, error }) =>
      log.error({ hub, reason: error.reason }, error.message),
    );

    await core.start();
    await localApi.listen({ socketPath: paths.socket() });
    log.info({ device_id: core.deviceId }, 'daemon ready');

    // Dev only: COMMUNAL_HUB (comma-separated) + COMMUNAL_DISPLAY_NAME join hubs on first start.
    if (
      devBuild &&
      process.env.COMMUNAL_AUTO_INIT === 'true' &&
      process.env.COMMUNAL_DISPLAY_NAME
    ) {
      for (const url of (process.env.COMMUNAL_HUB ?? '').split(',').map((u) => u.trim())) {
        if (!url || core.hubs.find(url)) continue;
        log.warn({ hub: url }, 'dev build: COMMUNAL_AUTO_INIT is joining this hub');
        core
          .addHub(url, {
            display_name: process.env.COMMUNAL_DISPLAY_NAME,
            device_name: hostname(),
            platform: platform(),
          })
          .catch((err: Error) => log.error({ hub: url, err: err.message }, 'auto-join failed'));
      }
    } else if (core.hubs.list().length === 0) {
      log.warn('no hubs configured yet; run `communal hub add <url> --name <name>`');
    }

    await new Promise<void>((done) => {
      process.once('SIGTERM', done);
      process.once('SIGINT', done);
    });
    await localApi.close();
    await core.stop();
    log.info('daemon stopped');
  });

program
  .command('status')
  .description('show this device, its hubs and indexing progress')
  .action(async () => {
    if (await daemonRunning()) {
      console.log(JSON.stringify(await api().get('/v1/status'), null, 2));
      return;
    }
    const kp = loadDeviceKey();
    const hubs = loadHubs();
    const withFp = hubs.find((h) => h.state.fingerprint);
    console.log(
      JSON.stringify(
        {
          daemon: 'stopped',
          device_id: kp ? deviceId(kp.publicKey) : null,
          user_id: hubs.find((h) => h.state.userId)?.state.userId ?? null,
          fingerprint: withFp ? formatFingerprint(withFp.state.fingerprint!) : null,
          hubs: hubs.map((h) => ({ id: h.id, url: h.url, registered: h.state.registered })),
          data_dir: dataDir,
        },
        null,
        2,
      ),
    );
  });

await program.parseAsync();
