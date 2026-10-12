#!/usr/bin/env node
/**
 * Headless client. `communal daemon` keeps sessions with every configured hub (the full core
 * engine and local API arrive in later milestones); `communal hub add` / `init` join a hub.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { pino } from 'pino';
import {
  deviceId,
  formatFingerprint,
  generateKeyPair,
  keyPairFromSecret,
  type KeyPair,
} from '@communal/crypto';
import { HubManager, newHubId, type HubClientState, type HubEntry } from '@communal/core';
import { PROTOCOL_VERSION } from '@communal/protocol';

const VERSION = '0.0.0';
const log = pino({ name: 'communal', level: process.env.LOG_LEVEL ?? 'info' });
const dataDir = process.env.COMMUNAL_DATA ?? join(process.env.HOME ?? '.', '.communal');
/** Dev-only conveniences need a dev build (see docs/adr/0006-hub-sessions-and-tls.md). */
const devBuild = (process.env.COMMUNAL_BUILD ?? 'release') === 'dev';

const paths = {
  key: () => join(dataDir, 'device.key'),
  hubs: () => join(dataDir, 'hubs.json'),
  /** Single-hub config written before multi-hub support; migrated on first load. */
  legacyHub: () => join(dataDir, 'hub.json'),
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
    // ignore: fall through to the legacy file / empty config
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

function manager(key: KeyPair, hubs: HubEntry[]) {
  return new HubManager({
    device: key,
    hubs,
    save: saveHubs,
    client: { name: 'communal-cli', version: VERSION },
    insecureTls: devBuild && process.env.COMMUNAL_DEV_TLS === 'self-signed',
    log,
  });
}

const platform = (): 'darwin' | 'win32' | 'linux' =>
  process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';

/** Joins one hub: creates the account there and waits for sign-in (or pending approval). */
async function joinHub(url: string, name: string, deviceName: string): Promise<boolean> {
  const key = ensureDeviceKey();
  const hubs = new HubManager({
    device: key,
    hubs: loadHubs(),
    save: saveHubs,
    client: { name: 'communal-cli', version: VERSION },
    insecureTls: devBuild && process.env.COMMUNAL_DEV_TLS === 'self-signed',
    log: pino({ level: 'warn' }),
  });
  if (hubs.find(url)) {
    console.error(`already configured: ${url}`);
    return false;
  }
  // Only the new hub connects; the others are left alone.
  const entry = await hubs.add(url, {
    display_name: name,
    device_name: deviceName,
    platform: platform(),
  });
  const client = hubs.get(entry.id)!;
  const outcome = new Promise<'ready' | 'pending' | Error>((resolve) => {
    client.once('ready', () => resolve('ready'));
    client.once('pending_approval', () => resolve('pending'));
    client.once('fatal', (e) => resolve(e));
    setTimeout(() => resolve(new Error('timed out connecting to the hub')), 30_000).unref();
  });
  client.start();
  const result = await outcome;
  await client.stop();
  if (result instanceof Error) {
    if (!entry.state.registered) await hubs.remove(entry.id);
    console.error(`could not join ${url}: ${result.message}`);
    return false;
  }
  if (result === 'pending') {
    console.log(`Joined ${url} (${entry.id}). The hub admin must approve the account first.`);
  } else {
    console.log(`Joined ${url} (${entry.id})`);
  }
  console.log(`  user:        ${entry.state.userId}`);
  console.log(`  fingerprint: ${formatFingerprint(entry.state.fingerprint ?? '')}`);
  return true;
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
  .action(() => {
    const hubs = loadHubs();
    if (hubs.length === 0)
      console.log('no hubs; add one with `communal hub add <url> --name <name>`');
    for (const h of hubs) {
      console.log(`${h.id}  ${h.state.registered ? 'joined ' : 'pending'}  ${h.url}`);
    }
  });

hub
  .command('remove <id_or_url>')
  .description('stop using a hub on this device (your account stays on the hub)')
  .action(async (target: string) => {
    const hubs = manager(ensureDeviceKey(), loadHubs());
    if (await hubs.remove(target)) console.log(`removed ${target}`);
    else {
      console.error(`no such hub: ${target}`);
      process.exitCode = 1;
    }
  });

program
  .command('daemon')
  .description('run the client engine in the foreground, connected to every configured hub')
  .action(async () => {
    const key = ensureDeviceKey();
    const hubs = manager(key, loadHubs());

    // Dev only: COMMUNAL_HUB (comma-separated) + COMMUNAL_DISPLAY_NAME join hubs on first start.
    const pending: string[] = [];
    if (
      devBuild &&
      process.env.COMMUNAL_AUTO_INIT === 'true' &&
      process.env.COMMUNAL_DISPLAY_NAME
    ) {
      for (const url of (process.env.COMMUNAL_HUB ?? '').split(',').map((u) => u.trim())) {
        if (url && !hubs.find(url)) pending.push(url);
      }
    }
    for (const url of pending) {
      log.warn({ hub: url }, 'dev build: COMMUNAL_AUTO_INIT is joining this hub');
      await hubs.add(url, {
        display_name: process.env.COMMUNAL_DISPLAY_NAME!,
        device_name: hostname(),
        platform: platform(),
      });
    }
    if (hubs.list().length === 0) {
      log.fatal('no hubs configured; run `communal hub add <url> --name <name>`');
      process.exitCode = 1;
      return;
    }

    hubs.on('ready', ({ hub, welcome }) =>
      log.info(
        { hub, user_id: welcome.user_id, observed_addr: welcome.observed_addr },
        'connected to hub',
      ),
    );
    hubs.on('presence', ({ hub, presence }) => log.info({ hub, ...presence }, 'presence'));
    hubs.on('pending_approval', ({ hub }) =>
      log.warn({ hub }, 'account is waiting for hub admin approval'),
    );
    // A fatal error on one hub (banned, key changed) leaves the others running.
    hubs.on('fatal', ({ hub, error }) => log.error({ hub, reason: error.reason }, error.message));
    hubs.start();
    await new Promise<void>((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
    await hubs.stop();
    log.info('daemon stopped');
  });

program
  .command('status')
  .description('show this device and its hubs')
  .action(() => {
    const kp = loadDeviceKey();
    const hubs = loadHubs();
    console.log(
      JSON.stringify(
        {
          device_id: kp ? deviceId(kp.publicKey) : null,
          user_id: hubs.find((h) => h.state.userId)?.state.userId ?? null,
          fingerprint: hubs.find((h) => h.state.fingerprint)?.state.fingerprint
            ? formatFingerprint(hubs.find((h) => h.state.fingerprint)!.state.fingerprint!)
            : null,
          hubs: hubs.map((h) => ({
            id: h.id,
            url: h.url,
            registered: h.state.registered,
            hub_key_pinned: !!h.state.hubPubkey,
          })),
          data_dir: dataDir,
        },
        null,
        2,
      ),
    );
  });

await program.parseAsync();
