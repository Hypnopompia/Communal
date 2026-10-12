/**
 * M4 done-when: files transfer between peers; a killed transfer resumes; a corrupted chunk is
 * detected and re-fetched; a peer with a forged/expired token is rejected. Plus multi-source,
 * the uploader's own access re-check, limits, and the upload log.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPair, signTransferToken, type KeyPair } from '@communal/crypto';
import { CommunalCore, CHUNK_SIZE, type UploaderTestHooks } from '@communal/core';
import { HubDb } from '@communal/hub';
import { sleep, startTestHub, type TestHub } from '@communal/hub/testing';

const quiet = pino({ level: process.env.M4_LOG ?? 'silent' });
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
  const dir = tmp('communal-m4-hub-');
  const db = new HubDb(join(dir, 'hub.db'));
  const t = await startTestHub({ dir, db, silenceMs: 10_000 });
  cleanups.push(async () => {
    await t.close();
    db.close();
  });
  return t;
}

async function core(
  name: string,
  opts: {
    dataDir?: string;
    device?: KeyPair;
    testHooks?: UploaderTestHooks;
    window?: number;
    uploads?: { maxConcurrent?: number; bytesPerSecond?: number; lanOnly?: boolean };
  } = {},
) {
  const c = new CommunalCore({
    dataDir: opts.dataDir ?? tmp(`communal-m4-${name}-`),
    device: opts.device ?? generateKeyPair(),
    hubClient: { pingIntervalMs: 1_000, silenceMs: 10_000, backoff: { initialMs: 50, maxMs: 300 } },
    indexer: { flushMs: 100 },
    peer: { loopback: true },
    downloads: {
      retryMs: 300,
      chunkTimeoutMs: 5_000,
      ...(opts.window ? { window: opts.window } : {}),
    },
    uploads: opts.uploads,
    testHooks: opts.testHooks,
    log: quiet,
  });
  let stopped = false;
  cleanups.push(() => (stopped ? undefined : c.stop()));
  await c.start();
  return Object.assign(c, { markStopped: () => (stopped = true) });
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

/** alice shares one random file publicly; returns its bytes and hash. */
async function sharer(
  h: TestHub,
  name: string,
  bytesOrData: number | Buffer,
  opts: Parameters<typeof core>[1] = {},
) {
  const c = await core(name, opts);
  const hubId = (await c.addHub(h.url, acct(name))).hub.id;
  const root = tmp(`communal-m4-share-${name}-`);
  const data = typeof bytesOrData === 'number' ? randomBytes(bytesOrData) : bytesOrData;
  writeFileSync(join(root, 'movie.mkv'), data);
  await c.addShare('Share', root);
  await c.setRule(hubId, 'Share/', 'hub');
  await until(() => c.store.counts().hashed === 1, 10_000, 'hash');
  await until(async () => (await c.sync.idle(), h.db.entryCount(c.deviceId) === 1), 10_000, 'sync');
  const hash = c.store.file('Share', 'movie.mkv')!.hash!;
  await until(
    () => !!h.db.raw.prepare('SELECT 1 FROM entries WHERE hash = ?').get(hash),
    5_000,
    'hash on hub',
  );
  return { c, hubId, data, hash, root };
}

async function finished(c: CommunalCore, id: string, ms = 30_000) {
  await until(() => ['done', 'failed'].includes(c.store.transfer(id)!.state), ms, `transfer ${id}`);
  return c.store.transfer(id)!;
}

describe('M4: direct transfers', () => {
  it('downloads a multi-chunk file directly from a peer and logs the upload', async () => {
    const h = await hub();
    const alice = await sharer(h, 'alice', CHUNK_SIZE * 5 + 12_345);
    const bob = await core('bob');
    await bob.addHub(h.url, acct('bob'));

    const t = bob.downloads.add({ hash: alice.hash, name: 'movie.mkv' });
    const done = await finished(bob, t.id);
    expect(done).toMatchObject({ state: 'done', size: alice.data.length });
    expect(readFileSync(done.final_path!).equals(alice.data)).toBe(true);
    expect(existsSync(`${done.final_path}.part`)).toBe(false);

    await until(() => alice.c.store.uploadLog().length > 0, 3_000, 'upload log');
    expect(alice.c.store.uploadLog()[0]).toMatchObject({
      requester_dev: bob.deviceId,
      path: 'Share/movie.mkv',
      hash: alice.hash,
      bytes: alice.data.length,
      status: 'completed',
      kind: 'file',
    });
  });

  it('downloads from several sources at once', async () => {
    const h = await hub();
    const data = randomBytes(CHUNK_SIZE * 12);
    const alice = await sharer(h, 'alice', data);
    const carol = await sharer(h, 'carol', data);
    const bob = await core('bob', { window: 2 });
    await bob.addHub(h.url, acct('bob'));
    const done = await finished(bob, bob.downloads.add({ hash: alice.hash, name: 'm.mkv' }).id);
    expect(readFileSync(done.final_path!).equals(data)).toBe(true);
    await until(
      () => alice.c.store.uploadLog().length > 0 && carol.c.store.uploadLog().length > 0,
      3_000,
      'logs',
    );
    const fromA = alice.c.store.uploadLog()[0]!.bytes;
    const fromC = carol.c.store.uploadLog()[0]!.bytes;
    expect(fromA).toBeGreaterThan(0);
    expect(fromC).toBeGreaterThan(0);
    expect(fromA + fromC).toBeGreaterThanOrEqual(data.length);
  });

  it('detects a corrupted chunk and fetches it again from another source', async () => {
    const h = await hub();
    const data = randomBytes(CHUNK_SIZE * 8);
    // mallory corrupts every chunk she sends; carol is honest.
    const mallory = await sharer(h, 'mallory', data, { testHooks: { corruptChunk: () => true } });
    await sharer(h, 'carol', data);
    const bob = await core('bob', { window: 2 });
    await bob.addHub(h.url, acct('bob'));
    const done = await finished(bob, bob.downloads.add({ hash: mallory.hash, name: 'm.mkv' }).id);
    expect(done.state).toBe('done');
    expect(readFileSync(done.final_path!).equals(data)).toBe(true);
  });

  it('recovers from a source that corrupts a chunk once', async () => {
    const h = await hub();
    const data = randomBytes(CHUNK_SIZE * 4);
    let corrupted = 0;
    const alice = await sharer(h, 'alice', data, {
      testHooks: { corruptChunk: (_h, i) => i === 2 && corrupted++ === 0 },
    });
    const bob = await core('bob');
    await bob.addHub(h.url, acct('bob'));
    const done = await finished(bob, bob.downloads.add({ hash: alice.hash, name: 'm.mkv' }).id);
    expect(corrupted).toBe(2); // sent bad once, then good
    expect(readFileSync(done.final_path!).equals(data)).toBe(true);
  });

  it(
    'resumes a killed download, fetching only the missing chunks',
    { timeout: 60_000 },
    async () => {
      const h = await hub();
      const size = CHUNK_SIZE * 40;
      // Throttled so the download is still running when we kill it.
      const alice = await sharer(h, 'alice', size, { uploads: { bytesPerSecond: 8 * CHUNK_SIZE } });
      const bobDir = tmp('communal-m4-bob-');
      const bobKey = generateKeyPair();
      const bob1 = await core('bob', { dataDir: bobDir, device: bobKey });
      await bob1.addHub(h.url, acct('bob'));
      const id = bob1.downloads.add({ hash: alice.hash, name: 'big.bin' }).id;
      await until(
        () => (bob1.store.transfer(id)?.bytes_done ?? 0) >= size * 0.25,
        20_000,
        'partial progress',
      );
      const haveAtKill = bob1.store.transfer(id)!.bytes_done;
      await bob1.stop(); // killed mid-transfer
      bob1.markStopped();
      expect(haveAtKill).toBeLessThan(size);

      alice.c.uploadLimits = { ...alice.c.uploadLimits, bytesPerSecond: 0 };
      const bob2 = await core('bob', { dataDir: bobDir, device: bobKey });
      const done = await finished(bob2, id);
      expect(readFileSync(done.final_path!).equals(alice.data)).toBe(true);
      // The second session only had to send what bob was missing (plus chunks that were in
      // flight when it died), not the whole file again.
      await until(
        () => alice.c.store.uploadLog().some((l) => l.status === 'completed'),
        5_000,
        'second session logged',
      );
      const second = alice.c.store.uploadLog().find((l) => l.status === 'completed')!;
      expect(second.bytes).toBeLessThanOrEqual(size - haveAtKill + 33 * CHUNK_SIZE);
      expect(second.bytes).toBeLessThan(size);
    },
  );

  it('rejects hello with a forged, expired or foreign token', async () => {
    const h = await hub();
    const alice = await sharer(h, 'alice', 10_000);
    const bob = await core('bob');
    const bobHub = (await bob.addHub(h.url, acct('bob'))).hub.id;

    const tryHello = async (
      mutate: (t: Awaited<ReturnType<typeof bob.broker.open>>['token']) => typeof t,
    ) => {
      const { channel, token } = await bob.broker.open(bobHub, alice.c.deviceId, alice.hash);
      await channel.send({ t: 'hello', token: mutate(token) });
      const r = await channel.next((x) => x.t === 'denied' || x.t === 'hello.ok', 5_000);
      channel.close();
      return r.header;
    };
    expect(await tryHello((t) => t)).toEqual({ t: 'hello.ok' });
    // Signed by someone other than the hub.
    expect(await tryHello((t) => signTransferToken(generateKeyPair(), t.claims))).toEqual({
      t: 'denied',
      reason: 'bad_token',
    });
    // Genuinely hub-signed, but expired.
    expect(await tryHello((t) => signTransferToken(h.hubKey, { ...t.claims, exp: 1 }))).toEqual({
      t: 'denied',
      reason: 'expired',
    });
    // Genuinely hub-signed and fresh, but issued for a different session.
    expect(
      await tryHello((t) =>
        signTransferToken(h.hubKey, { ...t.claims, session_id: 'x_01J9Z3QX7M8N4P5R6S7T8V9W0X' }),
      ),
    ).toEqual({ t: 'denied', reason: 'bad_token' });
    // A real token for someone else.
    expect(
      await tryHello((t) => signTransferToken(h.hubKey, { ...t.claims, from: alice.c.deviceId })),
    ).toEqual({ t: 'denied', reason: 'wrong_sender' });
  });

  it('re-checks access itself even when the hub would allow it', async () => {
    const h = await hub();
    const alice = await sharer(h, 'alice', 10_000);
    // alice makes the file private again, but a stale or malicious hub still says "hub".
    alice.c.store.setRule(alice.hubId, 'Share/', null);
    const bob = await core('bob');
    await bob.addHub(h.url, acct('bob'));
    const t = bob.downloads.add({ hash: alice.hash, name: 'x' });
    await until(() => bob.store.transfer(t.id)!.state === 'waiting', 10_000, 'refused');
    expect(bob.store.transfer(t.id)!.error).toMatch(/could not connect/);
    await until(
      () => alice.c.store.uploadLog().some((l) => l.status === 'denied'),
      3_000,
      'denied logged',
    );
    expect(alice.c.store.uploadLog()[0]).toMatchObject({
      requester_dev: bob.deviceId,
      status: 'denied',
      bytes: 0,
    });
  });

  it(
    'answers busy at the upload limit, and queues until the owner is back online',
    { timeout: 60_000 },
    async () => {
      const h = await hub();
      const aliceDir = tmp('communal-m4-alice-');
      const aliceKey = generateKeyPair();
      const alice = await sharer(h, 'alice', 50_000, {
        dataDir: aliceDir,
        device: aliceKey,
        uploads: { maxConcurrent: 0 },
      });
      const bob = await core('bob');
      await bob.addHub(h.url, acct('bob'));
      const t = bob.downloads.add({ hash: alice.hash, name: 'x' });
      await until(() => bob.store.transfer(t.id)!.state === 'waiting', 10_000, 'busy → waiting');

      // Owner goes offline: the download keeps waiting…
      await alice.c.stop();
      alice.c.markStopped();
      await sleep(500);
      expect(bob.store.transfer(t.id)!.state).toBe('waiting');
      // …and completes when the owner comes back (with room to upload).
      const alice2 = await core('alice', { dataDir: aliceDir, device: aliceKey });
      void alice2;
      const done = await finished(bob, t.id, 30_000);
      expect(readFileSync(done.final_path!).equals(alice.data)).toBe(true);
    },
  );
});
