#!/usr/bin/env node
/**
 * M0 headless skeleton. `communal daemon` creates (or loads) the device key and stays up as
 * PID 1's child under tini; the real core and local API arrive in later milestones.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { pino } from 'pino';
import { deviceId, generateKeyPair, keyPairFromSecret, type KeyPair } from '@communal/crypto';
import { PROTOCOL_VERSION } from '@communal/protocol';

const log = pino({ name: 'communal' });
const dataDir = process.env.COMMUNAL_DATA ?? join(process.env.HOME ?? '.', '.communal');

function deviceKeyPath() {
  return join(dataDir, 'device.key');
}

function loadDeviceKey(): KeyPair | null {
  try {
    return keyPairFromSecret(new Uint8Array(readFileSync(deviceKeyPath())));
  } catch {
    return null;
  }
}

function ensureDeviceKey(): KeyPair {
  const existing = loadDeviceKey();
  if (existing) return existing;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const kp = generateKeyPair();
  writeFileSync(deviceKeyPath(), kp.secretKey, { mode: 0o600 });
  return kp;
}

const program = new Command()
  .name('communal')
  .description('Communal headless client')
  .version(`0.0.0 (protocol v${PROTOCOL_VERSION})`);

program
  .command('daemon')
  .description('run the client engine in the foreground')
  .action(async () => {
    const kp = ensureDeviceKey();
    log.info(
      { device_id: deviceId(kp.publicKey), hub: process.env.COMMUNAL_HUB ?? null },
      'daemon started (core engine not implemented yet)',
    );
    // Nothing else holds the event loop open until the core lands, so keep a timer alive.
    const keepAlive = setInterval(() => {}, 60_000);
    await new Promise<void>((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
    clearInterval(keepAlive);
    log.info('daemon stopped');
  });

program
  .command('status')
  .description('show this device and its configuration')
  .action(() => {
    const kp = loadDeviceKey();
    console.log(
      JSON.stringify(
        {
          device_id: kp ? deviceId(kp.publicKey) : null,
          hub: process.env.COMMUNAL_HUB ?? null,
          data_dir: dataDir,
        },
        null,
        2,
      ),
    );
  });

await program.parseAsync();
