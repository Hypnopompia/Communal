/**
 * M8 done-when (HANDOFF §12): link a second desktop and a headless node, and both see all own
 * files; a revoked device is refused by peers; restoring from a recovery key works with every
 * device wiped. Linking and restore cover both hubs of a two-hub account (ADR 0007, 0014).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  deviceId,
  generateKeyPair,
  importRecoveryFile,
  type KeyPair,
  type RecoveryFile,
} from '@communal/crypto';
import {
  AccountFile,
  CommunalCore,
  CoreError,
  HubManager,
  LocalApi,
  LocalApiClient,
  linkDevice,
  type HubEntry,
} from '@communal/core';
import { HubDb } from '@communal/hub';
import { sleep, startTestHub, type TestHub } from '@communal/hub/testing';

const quiet = pino({ level: process.env.M8_LOG ?? 'silent' });
const FAST_KDF = { t: 1, m: 256, p: 1 };
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
  const dir = tmp('communal-m8-hub-');
  const db = new HubDb(join(dir, 'hub.db'));
  const t = await startTestHub({ dir, db, silenceMs: 10_000 });
  cleanups.push(async () => {
    await t.close();
    db.close();
  });
  return t;
}

type Core = CommunalCore & { dataDir: string; device: KeyPair; stopNow(): Promise<void> };

async function core(name: string, opts: { dataDir?: string; device?: KeyPair } = {}) {
  const dataDir = opts.dataDir ?? tmp(`communal-m8-${name}-`);
  const device = opts.device ?? generateKeyPair();
  const c = new CommunalCore({
    dataDir,
    device,
    hubClient: hubTimers,
    indexer: { flushMs: 100 },
    peer: { loopback: true },
    downloads: { retryMs: 300, chunkTimeoutMs: 5_000, answerTimeoutMs: 2_000 },
    log: quiet,
  });
  let stopped = false;
  const stopNow = async () => {
    if (!stopped) await c.stop();
    stopped = true;
  };
  cleanups.push(stopNow);
  await c.start();
  return Object.assign(c, { dataDir, device, stopNow }) as Core;
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

/** Alice's first device, on two hubs, sharing two files that stay "only me". */
async function alice(h1: TestHub, h2: TestHub) {
  const c = await core('alice');
  const hub1 = (await c.addHub(h1.url, acct('alice'))).hub.id;
  const hub2 = (await c.addHub(h2.url, acct('alice'))).hub.id;
  const root = tmp('communal-m8-share-');
  await writeFile(join(root, 'report.txt'), 'quarterly numbers');
  await writeFile(join(root, 'notes.md'), '# notes');
  await c.addShare('Docs', root);
  await until(
    async () => {
      await c.sync.idle();
      const hashed = (t: TestHub) =>
        t.db.raw
          .prepare('SELECT count(*) FROM entries WHERE device_id = ? AND hash IS NOT NULL')
          .pluck()
          .get(c.deviceId);
      return hashed(h1) === 2 && hashed(h2) === 2;
    },
    15_000,
    'alice indexed on both hubs',
  );
  return { c, hub1, hub2, uid: c.account!.user_id };
}

/** Runs the approval side of a link: waits for the claim and approves it. */
async function approveNext(owner: CommunalCore, expectDevice: string) {
  await until(() => owner.linkRequests().length > 0, 10_000, 'link request');
  const req = owner.linkRequests()[0]!;
  // The new device shows its id too, so the person can compare the two.
  expect(req.device_id).toBe(expectDevice);
  await owner.approveLink(req.request_id);
}

/** A second desktop: a running core that links through the local engine. */
async function linkDesktop(owner: CommunalCore, ownerHub: string, url: string) {
  const c = await core('laptop2');
  const { code } = await owner.createLinkCode(ownerHub);
  const [r] = await Promise.all([c.link(url, code, 'laptop2'), approveNext(owner, c.deviceId)]);
  return { c, r };
}

/**
 * A headless node set up the way `communal link` does while the daemon is stopped: a bare
 * HubManager and the account file, then the daemon's core starts from the same data dir.
 */
async function linkHeadless(owner: CommunalCore, ownerHub: string, url: string) {
  const dataDir = tmp('communal-m8-nas-');
  const device = generateKeyPair();
  const hubs = new HubManager({
    device,
    hubs: [],
    save: (hs: HubEntry[]) =>
      writeFileSync(join(dataDir, 'hubs.json'), JSON.stringify({ hubs: hs }), { mode: 0o600 }),
    ...hubTimers,
    log: quiet,
  });
  const { code } = await owner.createLinkCode(ownerHub);
  const ctx = { hubs, device, account: new AccountFile(dataDir) };
  const lower = code.toLowerCase().replace('-', ' '); // typed by hand
  const [r] = await Promise.all([
    linkDevice(ctx, { url, code: lower, device_name: 'nas', platform: 'linux' }),
    approveNext(owner, deviceId(device.publicKey)),
  ]);
  await hubs.stop();
  const c = await core('nas', { dataDir, device });
  await Promise.all(c.hubs.list().map((h) => c.hubs.get(h.id)!.waitReady()));
  return { c, r };
}

const docNames = async (c: CommunalCore, hub: string, owner: string) =>
  (await c.browse(hub, owner, 'Docs/')).files.map((f) => f.path).sort();

describe('M8: devices and recovery', () => {
  it('links a second desktop and a headless node; both see all own files on every hub', async () => {
    const [h1, h2] = [await hub(), await hub()];
    const a = await alice(h1, h2);

    const laptop = await linkDesktop(a.c, a.hub1, h1.url);
    const nas = await linkHeadless(a.c, a.hub1, h1.url);

    for (const d of [laptop, nas]) {
      // Same account, a chain back to alice's first device, and both hubs joined from the
      // sealed bundle with the keys alice had pinned.
      expect(d.c.account).toMatchObject({ user_id: a.uid, chain: [expect.anything()] });
      expect(d.r.others).toEqual([{ url: h2.url, ok: true, status: 'ready' }]);
      const pins = Object.fromEntries(d.c.hubs.list().map((h) => [h.url, h.state.hubPubkey]));
      expect(pins).toEqual({ [h1.url]: h1.hub.hubPubkey, [h2.url]: h2.hub.hubPubkey });
      for (const t of [h1, h2]) expect(t.db.getDevice(d.c.deviceId)?.user_id).toBe(a.uid);

      // "Only me" files are visible to all of the owner's devices, on both hubs.
      const [l1, l2] = [d.c.hubs.list()[0]!.id, d.c.hubs.list()[1]!.id];
      expect(await docNames(d.c, l1, a.c.deviceId)).toEqual(['Docs/notes.md', 'Docs/report.txt']);
      expect(await docNames(d.c, l2, a.c.deviceId)).toEqual(['Docs/notes.md', 'Docs/report.txt']);
      const found = await d.c.search({ q: 'report', limit: 10 });
      expect(found.hits.map((x) => x.sources.length)).toEqual([2]);
    }

    const devs = await nas.c.devices();
    expect(devs.map((d) => [d.name, d.root, d.this_device, d.hubs.length]).sort()).toEqual(
      [
        ['alice-box', true, false, 2],
        ['laptop2', false, false, 2],
        ['nas', false, true, 2],
      ].sort(),
    );
  });

  it('refuses a wrong or used code, and a denied link leaves no trace', async () => {
    const [h1, h2] = [await hub(), await hub()];
    const a = await alice(h1, h2);
    const b = await core('laptop2');
    await expect(b.link(h1.url, 'ZZZZ-ZZZZ', 'laptop2')).rejects.toThrow(/unknown or expired/);
    expect(b.hubs.list()).toEqual([]);

    const { code } = await a.c.createLinkCode(a.hub1);
    const linking = b.link(h1.url, code, 'laptop2');
    await until(() => a.c.linkRequests().length > 0, 10_000, 'request');
    await a.c.denyLink(a.c.linkRequests()[0]!.request_id);
    await expect(linking).rejects.toMatchObject({ code: 'forbidden' });
    expect(b.account).toBeUndefined();
    expect(b.hubs.list()).toEqual([]);
    expect(h1.db.devicesOf(a.uid)).toEqual([a.c.deviceId]);
  });

  it('revokes a device everywhere, and peers refuse it even when a hub forgets', async () => {
    const [h1, h2] = [await hub(), await hub()];
    const a = await alice(h1, h2);
    const laptop = await linkDesktop(a.c, a.hub1, h1.url);
    const nas = await linkHeadless(a.c, a.hub1, h1.url);
    const hash = fileHash(a.c, 'report.txt');
    const lhub = laptop.c.hubs.find(h1.url)!.id;

    // Before: the laptop can open a session to alice's first device.
    const ok = await laptop.c.broker.session(lhub, a.c.deviceId, hash, { answerTimeoutMs: 3_000 });
    ok.close();

    const r = await nas.c.revokeDevice(laptop.c.deviceId);
    expect(r.hubs.every((x) => x.ok)).toBe(true);
    for (const t of [h1, h2]) expect(t.db.getDevice(laptop.c.deviceId)?.revoked_at).not.toBeNull();
    // The other devices hear about it and keep the proof.
    await until(() => a.c.revocations.proofs(a.uid).length === 1, 5_000, 'alice learns');
    expect(await a.c.devices()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ device_id: laptop.c.deviceId, revoked: true }),
      ]),
    );
    // The laptop is out: the hubs refuse it.
    await until(() => !laptop.c.hubs.list().some((h) => h.ready), 5_000, 'laptop dropped');
    await laptop.c.stopNow();

    // A hub "forgets" the revocation (an old backup, or a malicious admin) and lets the laptop
    // back in. Alice's device still refuses it: it kept the proof.
    h1.db.raw.prepare('UPDATE devices SET revoked_at = NULL WHERE id = ?').run(laptop.c.deviceId);
    h1.db.raw.prepare('DELETE FROM revocations').run();
    const back = await core('laptop2-again', {
      dataDir: laptop.c.dataDir,
      device: laptop.c.device,
    });
    const bh = back.hubs.find(h1.url)!.id;
    await back.hubs.get(bh)!.waitReady();
    await expect(
      back.broker.session(bh, a.c.deviceId, hash, { answerTimeoutMs: 2_000 }),
    ).rejects.toThrow();
    // Gossip repairs the hub: the next device to sign in to it pushes the proof back.
    await nas.c.stopNow();
    const nas2 = await core('nas-again', { dataDir: nas.c.dataDir, device: nas.c.device });
    await until(() => h1.db.revokedSet(a.uid).has(laptop.c.deviceId), 5_000, 'hub repaired');
    expect(nas2.account?.user_id).toBe(a.uid);

    // Not the first device, and not twice.
    await expect(nas2.revokeDevice(a.c.deviceId)).rejects.toThrow(/first device/);
    await expect(nas2.revokeDevice(laptop.c.deviceId)).rejects.toThrow(/already revoked/);
  });

  it('restores from a recovery key with every device wiped', async () => {
    const [h1, h2] = [await hub(), await hub()];
    const a = await alice(h1, h2);
    const nas = await linkHeadless(a.c, a.hub1, h1.url);
    const bob = await core('bob');
    const bobHub = (await bob.addHub(h1.url, acct('bob'))).hub.id;
    await a.c.people.request(a.hub1, bob.account!.user_id);
    await bob.people.accept(bobHub, a.uid);

    // Only a device that holds the root key can export it.
    await expect(nas.c.exportRecovery({ format: 'words' })).rejects.toBeInstanceOf(CoreError);
    const { file } = (await a.c.exportRecovery({
      format: 'file',
      passphrase: 'correct horse battery',
      kdf: FAST_KDF,
    })) as { file: RecoveryFile };
    const { words } = (await a.c.exportRecovery({ format: 'words' })) as { words: string[] };
    expect(file.hubs?.map((h) => h.url)).toEqual([h1.url, h2.url]);

    // Every device is wiped.
    for (const d of [a.c, nas.c]) {
      await d.stopNow();
      rmSync(d.dataDir, { recursive: true, force: true });
    }

    const fresh = await core('restored');
    const secret = await importRecoveryFile(file, 'correct horse battery');
    const r = await fresh.restore({
      rootSecret: secret,
      user_id: file.user_id,
      hubs: file.hubs ?? [],
      deviceName: 'new-laptop',
    });
    expect(r.account.user_id).toBe(a.uid);
    expect(r.hubs.map((h) => h.ok)).toEqual([true, true]);
    expect(fresh.identity()).toMatchObject({
      user_id: a.uid,
      root_device: false,
      holds_root_key: true,
    });
    expect(fresh.hubs.list().map((h) => h.state.hubPubkey)).toEqual([
      h1.hub.hubPubkey,
      h2.hub.hubPubkey,
    ]);

    // Same account everywhere: bob is still a connection, and the old devices are listed.
    const fh1 = fresh.hubs.find(h1.url)!.id;
    const conns = await fresh.people.connections(fh1);
    expect(conns).toEqual(
      expect.arrayContaining([expect.objectContaining({ user_id: bob.account!.user_id })]),
    );
    expect((await fresh.devices()).map((d) => d.name).sort()).toEqual(
      ['alice-box', 'nas', 'new-laptop'].sort(),
    );
    // The lost headless node is revoked from here; the restored device can export again.
    await fresh.revokeDevice(nas.c.deviceId);
    expect(h2.db.getDevice(nas.c.deviceId)?.revoked_at).not.toBeNull();
    expect(await fresh.exportRecovery({ format: 'words' })).toEqual({ words });

    // A wrong key restores nothing.
    const other = await core('other');
    await expect(
      other.restore({
        rootSecret: generateKeyPair().secretKey,
        hubs: [{ url: h1.url }],
        deviceName: 'x',
      }),
    ).rejects.toThrow(/could not restore on any hub/);
    expect(other.account).toBeUndefined();
  });

  it('serves the account, devices and link requests over the local API', async () => {
    const [h1, h2] = [await hub(), await hub()];
    const a = await alice(h1, h2);
    const api = new LocalApi(a.c);
    const socketPath = join(a.c.dataDir, 'api.sock');
    await api.listen({ socketPath });
    cleanups.push(() => api.close());
    const c = new LocalApiClient({ socketPath });

    expect(await c.get('/v1/account')).toMatchObject({
      user_id: a.uid,
      root_device: true,
      holds_root_key: true,
    });
    const code = await c.post<{ code: string; hub: string }>('/v1/link/codes', {});
    expect(code.hub).toBe(a.hub1);
    const b = await core('laptop2');
    const linking = b.link(h1.url, code.code, 'laptop2');
    await until(
      async () => (await c.get<{ requests: unknown[] }>('/v1/link/requests')).requests.length === 1,
      10_000,
      'request over the API',
    );
    const { requests } = await c.get<{ requests: { request_id: string }[] }>('/v1/link/requests');
    await c.post(`/v1/link/requests/${requests[0]!.request_id}/approve`, {});
    await linking;
    const { devices } = await c.get<{ devices: { device_id: string }[] }>('/v1/devices');
    expect(devices.map((d) => d.device_id).sort()).toEqual([a.c.deviceId, b.deviceId].sort());
    await expect(c.post(`/v1/devices/${a.c.deviceId}/revoke`, {})).rejects.toMatchObject({
      status: 400,
    });
    const words = await c.post<{ words: string[] }>('/v1/recovery', { format: 'words' });
    expect(words.words).toHaveLength(24);
  });
});

function fileHash(c: CommunalCore, name: string): string {
  const row = c.store.raw
    .prepare('SELECT hash FROM files WHERE rel = ? AND hash IS NOT NULL')
    .pluck()
    .get(name) as string | undefined;
  if (!row) throw new Error(`no hash for ${name}`);
  return row;
}
