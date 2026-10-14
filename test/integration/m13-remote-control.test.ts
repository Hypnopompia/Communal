/**
 * Remote control (ADR 0023): a phone asks one of your computers to download something. Requests
 * go through the hub as sealed, signed `device.message`s between devices of one account; the
 * computer only acts while its Remote control setting is on, and only for its own account.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPair, sealTo, toB64 } from '@communal/crypto';
import { CommunalCore, RemoteError } from '@communal/core';
import type { RemoteTransfer } from '@communal/protocol';
import { sleep, startTestHub, type TestHub } from '@communal/hub/testing';

const quiet = pino({ level: process.env.M13_LOG ?? 'silent' });
const hubTimers = {
  pingIntervalMs: 1_000,
  silenceMs: 10_000,
  backoff: { initialMs: 50, maxMs: 300 },
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function hub(): Promise<TestHub> {
  const t = await startTestHub({ silenceMs: 10_000 });
  cleanups.push(() => t.close());
  return t;
}

async function core(name: string) {
  const c = new CommunalCore({
    dataDir: tmp(`communal-m13-${name}-`),
    device: generateKeyPair(),
    hubClient: hubTimers,
    indexer: { flushMs: 100 },
    peer: { loopback: true },
    downloads: { retryMs: 300, chunkTimeoutMs: 5_000, answerTimeoutMs: 2_000 },
    log: quiet,
  });
  let stopped = false;
  const stop = async () => {
    if (!stopped) await c.stop();
    stopped = true;
  };
  cleanups.push(stop);
  await c.start();
  return Object.assign(c, { stopNow: stop });
}

async function until(cond: () => boolean | Promise<boolean>, ms: number, label: string) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

const acct = (n: string) => ({
  display_name: n,
  device_name: `${n}-box`,
  platform: 'linux' as const,
});

/** Links a new core to `owner`'s account, approving the request on the owner. */
async function link(owner: CommunalCore, ownerHub: string, url: string, name: string) {
  const c = await core(name);
  const { code } = await owner.createLinkCode(ownerHub);
  const approve = (async () => {
    await until(() => owner.linkRequests().length > 0, 10_000, 'link request');
    await owner.approveLink(owner.linkRequests()[0]!.request_id);
  })();
  await Promise.all([c.link(url, code, name), approve]);
  await until(() => c.hubs.list().every((h) => h.ready), 10_000, `${name} signed in`);
  return c;
}

/**
 * Alice's desktop and phone on one hub, and Bob (a connection) sharing a song with her:
 * the file her phone asks the desktop to fetch.
 */
async function world() {
  const h = await hub();
  const desktop = await core('desktop');
  const hubId = (await desktop.addHub(h.url, acct('alice'))).hub.id;
  const phone = await link(desktop, hubId, h.url, 'Pixel');
  const bob = await core('bob');
  const bobHub = (await bob.addHub(h.url, acct('bob'))).hub.id;
  const alice = desktop.account!.user_id;
  await bob.people.request(bobHub, alice);
  await until(async () => (await desktop.people.connections(hubId)).length > 0, 10_000, 'request');
  await desktop.people.accept(hubId, bob.account!.user_id);
  const music = tmp('communal-m13-music-');
  await writeFile(join(music, 'song.mp3'), 'not really an mp3, but bytes all the same');
  await bob.addShare('Music', music);
  await bob.setRule(bobHub, 'Music/', 'hub');
  let hash = '';
  await until(
    async () => {
      const r = await phone.search({ q: 'song', limit: 10 });
      hash = r.hits[0]?.hash ?? '';
      return hash !== '';
    },
    15_000,
    'song indexed',
  );
  return { h, hubId, desktop, phone, bob, hash };
}

describe('remote control', () => {
  it('lists the account’s other devices, and asks first whether remote control is on', async () => {
    const { desktop, phone } = await world();
    const devices = await phone.remote.devices();
    expect(devices).toEqual([
      expect.objectContaining({ device_id: desktop.deviceId, name: 'alice-box', online: true }),
    ]);
    expect(await phone.remote.request(desktop.deviceId, { op: 'hello' })).toEqual({
      allowed: false,
    });
  });

  it('refuses everything but hello while the setting is off', async () => {
    const { desktop, phone, hash } = await world();
    await expect(
      phone.remote.request(desktop.deviceId, { op: 'download', hash }),
    ).rejects.toMatchObject({ code: 'not_allowed' });
    expect(desktop.downloads.list()).toEqual([]);
  });

  it('downloads to the computer, shows who asked, and reports progress back', async () => {
    const { desktop, phone, hash } = await world();
    await desktop.updateSettings({ remote_control: true });
    const started = (await phone.remote.request(desktop.deviceId, {
      op: 'download',
      hash,
    })) as { id: string; name: string };
    expect(started.name).toBe('song.mp3');
    await until(
      () => desktop.downloads.list().some((t) => t.state === 'done'),
      15_000,
      'download done',
    );
    const t = desktop.downloads.list()[0]!;
    expect(t.requested_by).toBe('Pixel');
    expect(await readFile(t.final_path!, 'utf8')).toContain('bytes all the same');
    // The phone never gets the file, only the progress, and no local paths.
    expect(phone.downloads.list()).toEqual([]);
    const r = (await phone.remote.request(desktop.deviceId, { op: 'transfers' })) as {
      transfers: RemoteTransfer[];
    };
    expect(r.transfers[0]).toMatchObject({ id: started.id, state: 'done', requested_by: 'Pixel' });
    expect(JSON.stringify(r)).not.toContain(desktop.downloadsDir);
  });

  it('follows a folder from the computer when asked', async () => {
    const { h, desktop, phone, bob } = await world();
    await desktop.updateSettings({ remote_control: true });
    const r = (await phone.remote.request(desktop.deviceId, {
      op: 'subscribe',
      hub: h.url,
      device_id: bob.deviceId,
      path: 'Music/',
      mirror_deletes: false,
    })) as { id: string };
    expect(desktop.subscriptions.list().map((s) => s.id)).toEqual([r.id]);
    await expect(
      phone.remote.request(desktop.deviceId, {
        op: 'subscribe',
        hub: 'wss://elsewhere.example/v1',
        device_id: bob.deviceId,
        path: 'Music/',
        mirror_deletes: false,
      }),
    ).rejects.toBeInstanceOf(RemoteError);
  });

  it('ignores messages from another account and forged or replayed ones', async () => {
    const { desktop, phone, bob, hash } = await world();
    await desktop.updateSettings({ remote_control: true });
    // Bob's devices aren't Alice's: the hub won't even forward to them.
    await expect(bob.remote.request(desktop.deviceId, { op: 'hello' })).rejects.toMatchObject({
      code: 'not_found',
    });
    // Junk sealed to the desktop's key, sent from Alice's own phone, is dropped unanswered.
    const client = phone.hubs.get(phone.hubs.list()[0]!.id)!;
    await client.request('device.message', {
      to: desktop.deviceId,
      sealed: sealTo(generateKeyPair().publicKey, new Uint8Array(100)),
    });
    await client.request('device.message', {
      to: desktop.deviceId,
      sealed: toB64(new Uint8Array(200)),
    });
    await sleep(200);
    expect(desktop.downloads.list()).toEqual([]);
    // A real request still works afterwards.
    await phone.remote.request(desktop.deviceId, { op: 'download', hash });
    expect(desktop.downloads.list()).toHaveLength(1);
  });

  it('says so when the computer is offline', async () => {
    const { desktop, phone } = await world();
    await phone.remote.devices();
    await desktop.stopNow();
    await expect(phone.remote.request(desktop.deviceId, { op: 'hello' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
