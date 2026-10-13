/**
 * M7 done-when: adding and deleting files at the source propagates as specified (HANDOFF §5
 * "Subscriptions"), including after the subscriber was offline. Plus: queueing while the owner
 * is offline, mirror_deletes on and off, edits and moves at the source, local changes left
 * alone, losing access, and the local API.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPair, type KeyPair } from '@communal/crypto';
import { CommunalCore, GONE, LocalApi, LocalApiClient, apiSocketPath } from '@communal/core';
import { HubDb } from '@communal/hub';
import { sleep, startTestHub, type TestHub } from '@communal/hub/testing';

const quiet = pino({ level: process.env.M7_LOG ?? 'silent' });
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
  const dir = tmp('communal-m7-hub-');
  const db = new HubDb(join(dir, 'hub.db'));
  const t = await startTestHub({ dir, db, silenceMs: 10_000 });
  cleanups.push(async () => {
    await t.close();
    db.close();
  });
  return t;
}

type Core = CommunalCore & { trashed: string[]; markStopped(): void };

/** A core whose "OS trash" is a folder we can look into. */
async function core(name: string, opts: { dataDir?: string; device?: KeyPair } = {}) {
  const trashDir = tmp(`communal-m7-trash-${name}-`);
  const trashed: string[] = [];
  const c = new CommunalCore({
    dataDir: opts.dataDir ?? tmp(`communal-m7-${name}-`),
    device: opts.device ?? generateKeyPair(),
    hubClient: { pingIntervalMs: 1_000, silenceMs: 10_000, backoff: { initialMs: 50, maxMs: 300 } },
    indexer: { flushMs: 100 },
    peer: { loopback: true },
    downloads: { retryMs: 300, chunkTimeoutMs: 5_000 },
    subscriptions: {
      retryMs: 300,
      trash: async (p) => {
        trashed.push(basename(p));
        await rename(p, join(trashDir, `${trashed.length}-${basename(p)}`));
      },
    },
    log: quiet,
  });
  let stopped = false;
  cleanups.push(() => (stopped ? undefined : c.stop()));
  await c.start();
  return Object.assign(c, { trashed, markStopped: () => (stopped = true) }) as Core;
}

async function until(
  cond: () => boolean | Promise<boolean>,
  ms: number,
  label: string | (() => string),
) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end)
      throw new Error(`timed out waiting for ${typeof label === 'string' ? label : label()}`);
    await sleep(25);
  }
}

const acct = (n: string) => ({
  display_name: n,
  device_name: `${n}-box`,
  platform: 'linux' as const,
});

/**
 * Lists a folder tree as sorted relative paths → contents. A download in progress can rename
 * its `.part` file between listing and reading; such a file is skipped, and polling callers see
 * the finished file next time.
 */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else {
        try {
          out[`${rel}${e.name}`] = readFileSync(join(d, e.name), 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

/** Alice shares `Photos` with the whole hub. */
async function owner(
  h: TestHub,
  files: Record<string, string>,
  opts: Parameters<typeof core>[1] = {},
) {
  const c = await core('alice', opts);
  const hubId = (await c.addHub(h.url, acct('alice'))).hub.id;
  const root = tmp('communal-m7-share-');
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    await writeFile(join(root, rel), data);
  }
  await c.addShare('Photos', root);
  await c.setRule(hubId, 'Photos/', 'hub');
  await settled(h, c, Object.keys(files).length);
  return { c, hubId, root };
}

/** Waits until the owner's files are hashed and the hub has exactly `n` hashed entries. */
async function settled(h: TestHub, c: CommunalCore, n: number) {
  let seen = '';
  await until(
    async () => {
      await c.sync.idle();
      const counts = c.store.counts();
      const onHub = h.db.raw
        .prepare('SELECT count(*) FROM entries WHERE device_id = ? AND hash IS NOT NULL')
        .pluck()
        .get(c.deviceId);
      seen = `files ${counts.files}, hashed ${counts.hashed}, on hub ${String(onHub)}`;
      return counts.files === n && counts.hashed === n && onHub === n;
    },
    15_000,
    () => `owner index at ${n} files (last saw ${seen})`,
  );
}

async function subscriber(h: TestHub, opts: Parameters<typeof core>[1] = {}) {
  const c = await core('bob', opts);
  // A restarted subscriber is already on the hub.
  const hubId = c.hubs.list()[0]?.id ?? (await c.addHub(h.url, acct('bob'))).hub.id;
  return { c, hubId, dest: join(c.store.raw.name, '..', 'sub') };
}

/** Waits for the destination to hold exactly `want`, and for the subscription to be quiet. */
async function expectTree(c: CommunalCore, dest: string, want: Record<string, string>) {
  await until(
    async () => {
      await c.subscriptions.idle();
      return JSON.stringify(tree(dest)) === JSON.stringify(sortKeys(want));
    },
    20_000,
    `destination to be ${JSON.stringify(want)} (is ${JSON.stringify(tree(dest))})`,
  );
}

const sortKeys = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

const fileTransfers = (c: CommunalCore) => c.store.transfers().length;

describe('M7: subscriptions', () => {
  it('propagates adds and deletes, and catches up after the subscriber was offline', async () => {
    const h = await hub();
    const alice = await owner(h, {
      'a.txt': 'aaa',
      'trip/b.txt': 'bbb',
      'trip/same-as-a.txt': 'aaa',
    });
    const bobData = tmp('communal-m7-bob-');
    const bobKey = generateKeyPair();
    const bob = await subscriber(h, { dataDir: bobData, device: bobKey });
    const sub = await bob.c.subscriptions.add({
      hub: bob.hubId,
      device: alice.c.deviceId,
      path: 'Photos',
      dest: bob.dest,
      mirrorDeletes: true,
    });
    expect(sub).toMatchObject({ path: 'Photos/', recursive: true, mirror_deletes: true });
    await expectTree(bob.c, bob.dest, {
      'a.txt': 'aaa',
      'trip/b.txt': 'bbb',
      'trip/same-as-a.txt': 'aaa',
    });
    // The same content twice is downloaded once (the second copy comes from the first, or
    // both were queued before either landed: never more than one transfer per file).
    expect(fileTransfers(bob.c)).toBeLessThanOrEqual(3);

    // Live: a new file arrives, a deleted one goes to the trash, an emptied folder goes away.
    await writeFile(join(alice.root, 'c.txt'), 'ccc');
    await rm(join(alice.root, 'trip'), { recursive: true });
    await settled(h, alice.c, 2);
    await expectTree(bob.c, bob.dest, { 'a.txt': 'aaa', 'c.txt': 'ccc' });
    expect(bob.c.trashed.sort()).toEqual(['b.txt', 'same-as-a.txt']);
    expect(existsSync(join(bob.dest, 'trip'))).toBe(false);

    // Bob goes away; alice adds, edits and deletes meanwhile.
    bob.c.markStopped();
    await bob.c.stop();
    await writeFile(join(alice.root, 'd.txt'), 'ddd');
    await writeFile(join(alice.root, 'a.txt'), 'aaa, edited');
    await rm(join(alice.root, 'c.txt'));
    await settled(h, alice.c, 2);

    const back = await subscriber(h, { dataDir: bobData, device: bobKey });
    await expectTree(back.c, bob.dest, { 'a.txt': 'aaa, edited', 'd.txt': 'ddd' });
    // The old version of a.txt and the deleted c.txt went to the trash.
    expect(back.c.trashed.sort()).toEqual(['a.txt', 'c.txt']);
    expect(back.c.subscriptions.list()[0]).toMatchObject({
      status: 'ok',
      files: { done: 2, pending: 0, failed: 0, removed: 0 },
    });
  });

  it('keeps deleted files without mirror_deletes, and never touches files changed locally', async () => {
    const h = await hub();
    const alice = await owner(h, { 'a.txt': 'aaa', 'b.txt': 'bbb', 'c.txt': 'ccc' });
    const bob = await subscriber(h);
    const sub = await bob.c.subscriptions.add({
      hub: bob.hubId,
      device: alice.c.deviceId,
      path: 'Photos/',
      dest: bob.dest,
      mirrorDeletes: false,
    });
    await expectTree(bob.c, bob.dest, { 'a.txt': 'aaa', 'b.txt': 'bbb', 'c.txt': 'ccc' });

    await rm(join(alice.root, 'a.txt'));
    await settled(h, alice.c, 2);
    await until(
      () => bob.c.store.subFile(sub.id, 'Photos/a.txt')?.state === 'removed',
      10_000,
      'a.txt marked removed',
    );
    expect(tree(bob.dest)['a.txt']).toBe('aaa');

    // With mirror_deletes on, a file bob edited himself still stays.
    await bob.c.subscriptions.update(sub.id, { mirror_deletes: true });
    await writeFile(join(bob.dest, 'b.txt'), 'bob was here');
    await rm(join(alice.root, 'b.txt'));
    await rm(join(alice.root, 'c.txt'));
    await settled(h, alice.c, 0);
    await expectTree(bob.c, bob.dest, { 'a.txt': 'aaa', 'b.txt': 'bob was here' });
    expect(bob.c.trashed).toEqual(['c.txt']);
  });

  it('moves a file moved at the source instead of fetching it again', async () => {
    const h = await hub();
    const alice = await owner(h, { 'a.txt': 'aaa' });
    const bob = await subscriber(h);
    await bob.c.subscriptions.add({
      hub: bob.hubId,
      device: alice.c.deviceId,
      path: 'Photos/',
      dest: bob.dest,
      mirrorDeletes: true,
    });
    await expectTree(bob.c, bob.dest, { 'a.txt': 'aaa' });
    const before = fileTransfers(bob.c);
    mkdirSync(join(alice.root, 'moved'));
    await rename(join(alice.root, 'a.txt'), join(alice.root, 'moved', 'a.txt'));
    await expectTree(bob.c, bob.dest, { 'moved/a.txt': 'aaa' });
    expect(fileTransfers(bob.c)).toBe(before);
    expect(bob.c.trashed).toEqual([]);
  });

  it('keeps a folder in step between two of your own devices that follow each other', async () => {
    const h = await hub();
    const desk = await core('desk');
    const deskHub = (await desk.addHub(h.url, acct('alice'))).hub.id;
    const deskRoot = tmp('communal-m7-desk-');
    await writeFile(join(deskRoot, 'a.txt'), 'aaa');
    await desk.addShare('Both', deskRoot);

    const laptop = await core('laptop');
    const { code } = await desk.createLinkCode(deskHub);
    await Promise.all([
      laptop.link(h.url, code, 'laptop'),
      (async () => {
        await until(() => desk.linkRequests().length > 0, 10_000, 'link request');
        await desk.approveLink(desk.linkRequests()[0]!.request_id);
      })(),
    ]);
    const laptopHub = laptop.hubs.list()[0]!.id;
    const laptopRoot = tmp('communal-m7-laptop-');
    await laptop.addShare('Both', laptopRoot);

    // Each follows the other's folder into its own shared one. Your own devices see
    // everything, so no rule is needed.
    await desk.subscriptions.add({
      hub: deskHub,
      device: laptop.deviceId,
      path: 'Both/',
      dest: deskRoot,
      mirrorDeletes: true,
    });
    await laptop.subscriptions.add({
      hub: laptopHub,
      device: desk.deviceId,
      path: 'Both/',
      dest: laptopRoot,
      mirrorDeletes: true,
    });
    const both = async (want: Record<string, string>) => {
      await expectTree(desk, deskRoot, want);
      await expectTree(laptop, laptopRoot, want);
    };
    // Copies coming back are recognised, never saved again as "a (1).txt".
    await both({ 'a.txt': 'aaa' });

    await writeFile(join(laptopRoot, 'b.txt'), 'bbb');
    await both({ 'a.txt': 'aaa', 'b.txt': 'bbb' });

    await writeFile(join(laptopRoot, 'a.txt'), 'edited on the laptop');
    await both({ 'a.txt': 'edited on the laptop', 'b.txt': 'bbb' });

    await rm(join(deskRoot, 'b.txt'));
    await both({ 'a.txt': 'edited on the laptop' });
    expect(laptop.trashed).toEqual(['b.txt']);
  });

  it('queues while the owner is offline and finishes when they are back', async () => {
    const h = await hub();
    const aliceData = tmp('communal-m7-alice-');
    const aliceKey = generateKeyPair();
    const alice = await owner(h, { 'a.txt': 'aaa' }, { dataDir: aliceData, device: aliceKey });
    const bob = await subscriber(h);
    const sub = await bob.c.subscriptions.add({
      hub: bob.hubId,
      device: alice.c.deviceId,
      path: 'Photos/',
      dest: bob.dest,
      mirrorDeletes: false,
    });
    await expectTree(bob.c, bob.dest, { 'a.txt': 'aaa' });

    // A new file reaches the hub, then alice goes offline before bob can fetch it.
    await bob.c.subscriptions.update(sub.id, { paused: true });
    await writeFile(join(alice.root, 'late.txt'), 'late');
    await settled(h, alice.c, 2);
    alice.c.markStopped();
    await alice.c.stop();
    await bob.c.subscriptions.update(sub.id, { paused: false });
    await until(
      () => bob.c.store.transfers().some((t) => t.name === 'late.txt' && t.state === 'waiting'),
      10_000,
      'download waiting for the owner',
    );

    const back = await core('alice', { dataDir: aliceData, device: aliceKey });
    expect(back.deviceId).toBe(alice.c.deviceId);
    await expectTree(bob.c, bob.dest, { 'a.txt': 'aaa', 'late.txt': 'late' });
  });

  it('stops new downloads when access is lost, and keeps what is already here', async () => {
    const h = await hub();
    const alice = await owner(h, { 'a.txt': 'aaa' });
    const bob = await subscriber(h);
    const sub = await bob.c.subscriptions.add({
      hub: bob.hubId,
      device: alice.c.deviceId,
      path: 'Photos/',
      dest: bob.dest,
      mirrorDeletes: true,
    });
    await expectTree(bob.c, bob.dest, { 'a.txt': 'aaa' });

    await alice.c.setRule(alice.hubId, 'Photos/', 'me');
    await writeFile(join(alice.root, 'secret.txt'), 'shh');
    await rm(join(alice.root, 'a.txt'));
    await settled(h, alice.c, 1);
    await sleep(500);
    await bob.c.subscriptions.idle();
    // Nothing new, and the lost file isn't treated as deleted.
    expect(tree(bob.dest)).toEqual({ 'a.txt': 'aaa' });
    expect(bob.c.trashed).toEqual([]);
    expect(bob.c.store.transfers().map((t) => t.name)).toEqual(['a.txt']);

    // A download of a file no hub offers any more fails instead of waiting forever.
    const hash = alice.c.store.file('Photos', 'secret.txt')!.hash!;
    const t = bob.c.downloads.add({ hash, name: 'secret.txt' });
    await until(() => bob.c.store.transfer(t.id)!.state === 'failed', 10_000, 'gone');
    expect(bob.c.store.transfer(t.id)!.error).toBe(GONE);

    // The watch is refused from now on (a reconnect re-watches): marked, not deleted.
    await h.hub.close();
    const again = await startTestHub({
      dir: h.dir,
      db: h.db,
      hubKey: h.hubKey,
      port: h.port,
      silenceMs: 10_000,
    });
    cleanups.push(() => again.close());
    await until(
      () => bob.c.subscriptions.list()[0]?.status === 'no_access',
      15_000,
      'subscription marked no_access',
    );
    expect(bob.c.store.subscription(sub.id)).toBeDefined();

    // Access back: the next retry catches up, including the deletion bob couldn't see then.
    await until(() => !!alice.c.hubs.get(alice.hubId)?.ready, 15_000, 'alice back on the hub');
    await alice.c.setRule(alice.hubId, 'Photos/', 'hub');
    await expectTree(bob.c, bob.dest, { 'secret.txt': 'shh' });
    expect(bob.c.trashed).toEqual(['a.txt']);
    expect(bob.c.subscriptions.list()[0]?.status).toBe('ok');
  });

  it('refuses folders that are not shared, and works over the local API', async () => {
    const h = await hub();
    const alice = await owner(h, { 'a.txt': 'aaa' });
    await alice.c.setRule(alice.hubId, 'Photos/private/', 'me');
    const bob = await subscriber(h);
    const api = new LocalApi(bob.c);
    const sock = apiSocketPath(tmp('communal-m7-sock-'));
    await api.listen({ socketPath: sock });
    cleanups.push(() => api.close());
    const cli = new LocalApiClient({ socketPath: sock });

    await expect(
      cli.post('/v1/subscriptions', {
        hub: bob.hubId,
        device: alice.c.deviceId,
        path: 'Photos/private/',
        mirror_deletes: false,
      }),
    ).rejects.toThrow(/not shared with you/);
    // mirror_deletes must be chosen, not defaulted silently.
    await expect(
      cli.post('/v1/subscriptions', { hub: bob.hubId, device: alice.c.deviceId, path: 'Photos/' }),
    ).rejects.toThrow();

    const { subscription } = await cli.post<{ subscription: { id: string; dest_dir: string } }>(
      '/v1/subscriptions',
      { hub: bob.hubId, device: alice.c.deviceId, path: 'Photos/', mirror_deletes: false },
    );
    // Default destination: <downloads>/<folder name>.
    expect(basename(subscription.dest_dir)).toBe('Photos');
    await expectTree(bob.c, subscription.dest_dir, { 'a.txt': 'aaa' });
    await cli.put(`/v1/subscriptions/${subscription.id}`, { mirror_deletes: true });
    const { subscriptions } = await cli.get<{
      subscriptions: { id: string; mirror_deletes: boolean; files: { done: number } }[];
    }>('/v1/subscriptions');
    expect(subscriptions).toMatchObject([
      { id: subscription.id, mirror_deletes: true, files: { done: 1 } },
    ]);
    await cli.delete(`/v1/subscriptions/${subscription.id}`);
    expect(
      (await cli.get<{ subscriptions: unknown[] }>('/v1/subscriptions')).subscriptions,
    ).toEqual([]);
    // Unsubscribing leaves the files.
    expect(tree(subscription.dest_dir)).toEqual({ 'a.txt': 'aaa' });
  });
});
