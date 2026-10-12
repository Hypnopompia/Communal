#!/usr/bin/env node
/**
 * Headless client. `communal daemon` keeps a session with the hub (the full core engine and
 * local API arrive in later milestones); `communal init` creates an account on a hub.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
import { HubClient, type HubClientState } from '@communal/core';
import { PROTOCOL_VERSION } from '@communal/protocol';

const VERSION = '0.0.0';
const log = pino({ name: 'communal', level: process.env.LOG_LEVEL ?? 'info' });
const dataDir = process.env.COMMUNAL_DATA ?? join(process.env.HOME ?? '.', '.communal');
/** Dev-only conveniences need a dev build (see docs/adr/0006-hub-sessions-and-tls.md). */
const devBuild = (process.env.COMMUNAL_BUILD ?? 'release') === 'dev';

interface Config {
  hub: string;
  state: HubClientState;
}

const paths = {
  key: () => join(dataDir, 'device.key'),
  config: () => join(dataDir, 'hub.json'),
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

function loadConfig(): Config | null {
  try {
    return JSON.parse(readFileSync(paths.config(), 'utf8')) as Config;
  } catch {
    return null;
  }
}

function saveConfig(c: Config) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = paths.config() + '.tmp';
  writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  renameSync(tmp, paths.config());
}

function makeClient(
  cfg: Config,
  key: KeyPair,
  createAccount?: { display_name: string; device_name: string },
) {
  return new HubClient({
    url: cfg.hub,
    device: key,
    state: cfg.state,
    saveState: (state) => saveConfig({ ...cfg, state }),
    createAccount: createAccount && {
      ...createAccount,
      platform:
        process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
    },
    client: { name: 'communal-cli', version: VERSION },
    insecureTls: devBuild && process.env.COMMUNAL_DEV_TLS === 'self-signed',
    log,
  });
}

const program = new Command()
  .name('communal')
  .description('Communal headless client')
  .version(`${VERSION} (protocol v${PROTOCOL_VERSION})`);

program
  .command('init')
  .description('create a new account on a hub with this device')
  .requiredOption('--hub <url>', 'hub address, e.g. wss://hub.example.org/v1')
  .requiredOption('--name <display_name>', 'your display name on the hub')
  .option('--device-name <name>', 'name for this device', hostname())
  .action(async (opts: { hub: string; name: string; deviceName: string }) => {
    const existing = loadConfig();
    if (existing?.state.registered) {
      console.error(`already registered on ${existing.hub} as ${existing.state.userId}`);
      process.exitCode = 1;
      return;
    }
    const key = ensureDeviceKey();
    const cfg: Config = { hub: opts.hub, state: { registered: false } };
    const client = makeClient(cfg, key, { display_name: opts.name, device_name: opts.deviceName });
    client.on('pending_approval', async () => {
      console.log('Account created. The hub admin must approve it before you can sign in.');
      await client.stop();
    });
    client.start();
    try {
      const w = await client.waitReady(30_000);
      console.log(`Signed in to ${opts.hub}`);
      console.log(`  user:        ${w.user_id}`);
      console.log(`  device:      ${w.device_id}`);
      console.log(`  fingerprint: ${formatFingerprint(cfg.state.fingerprint ?? '')}`);
    } catch (err) {
      if (!cfg.state.registered) {
        console.error(`init failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    } finally {
      await client.stop();
    }
  });

program
  .command('daemon')
  .description('run the client engine in the foreground')
  .action(async () => {
    const key = ensureDeviceKey();
    let cfg = loadConfig();
    let createAccount: { display_name: string; device_name: string } | undefined;
    if (!cfg?.state.registered) {
      const hub = process.env.COMMUNAL_HUB;
      const name = process.env.COMMUNAL_DISPLAY_NAME;
      if (devBuild && process.env.COMMUNAL_AUTO_INIT === 'true' && hub && name) {
        cfg = { hub, state: cfg?.state ?? { registered: false } };
        createAccount = { display_name: name, device_name: hostname() };
        log.warn('dev build: COMMUNAL_AUTO_INIT will create an account on first start');
      } else {
        log.fatal('this device has no account yet; run `communal init --hub <url> --name <name>`');
        process.exitCode = 1;
        return;
      }
    }
    const client = makeClient(cfg, key, createAccount);
    client.on('ready', (w) =>
      log.info({ user_id: w.user_id, observed_addr: w.observed_addr }, 'connected to hub'),
    );
    client.on('presence', (p) => log.info(p, 'presence'));
    client.on('pending_approval', () => log.warn('account is waiting for hub admin approval'));
    client.on('fatal', (e) => {
      log.fatal({ reason: e.reason }, e.message);
      process.exitCode = 1;
      process.kill(process.pid, 'SIGTERM');
    });
    client.start();
    await new Promise<void>((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
    await client.stop();
    log.info('daemon stopped');
  });

program
  .command('status')
  .description('show this device and its hub')
  .action(() => {
    const kp = loadDeviceKey();
    const cfg = loadConfig();
    console.log(
      JSON.stringify(
        {
          device_id: kp ? deviceId(kp.publicKey) : null,
          hub: cfg?.hub ?? null,
          registered: cfg?.state.registered ?? false,
          user_id: cfg?.state.userId ?? null,
          fingerprint: cfg?.state.fingerprint ? formatFingerprint(cfg.state.fingerprint) : null,
          hub_key_pinned: !!cfg?.state.hubPubkey,
          data_dir: dataDir,
        },
        null,
        2,
      ),
    );
  });

await program.parseAsync();
