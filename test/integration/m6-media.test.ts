/**
 * M6 done-when: a mixed folder shows the right icons and metadata, and thumbnails for a
 * 500-image folder load in one batched request. Plus: EXIF-free thumbnails, the uploader's
 * own access check on every thumbnail and peek, 1600 px previews on demand, the viewer's LRU
 * cache, and streaming a file in order without downloading it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPair } from '@communal/crypto';
import {
  CommunalCore,
  IndexStore,
  LocalApi,
  LocalApiClient,
  ThumbCache,
  isWebp,
  apiSocketPath,
} from '@communal/core';
import { mixedFolder, png } from '@communal/core/testing';
import { HubDb } from '@communal/hub';
import { sleep, startTestHub, type TestHub } from '@communal/hub/testing';

const quiet = pino({ level: process.env.M6_LOG ?? 'silent' });
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
  const dir = tmp('communal-m6-hub-');
  const db = new HubDb(join(dir, 'hub.db'));
  const t = await startTestHub({ dir, db, silenceMs: 20_000 });
  cleanups.push(async () => {
    await t.close();
    db.close();
  });
  return t;
}

async function core(
  name: string,
  opts: { onThumbGet?: (n: number) => void; cacheBytes?: number } = {},
) {
  const c = new CommunalCore({
    dataDir: tmp(`communal-m6-${name}-`),
    device: generateKeyPair(),
    hubClient: { pingIntervalMs: 1_000, silenceMs: 20_000, backoff: { initialMs: 50, maxMs: 300 } },
    indexer: { flushMs: 100 },
    peer: { loopback: true },
    downloads: { retryMs: 300, answerTimeoutMs: 5_000 },
    media: { concurrency: 4, ...(opts.cacheBytes ? { thumbCacheBytes: opts.cacheBytes } : {}) },
    testHooks: { thumbRequest: opts.onThumbGet },
    log: quiet,
  });
  cleanups.push(() => c.stop());
  await c.start();
  return c;
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

/** Shares `root` as `name`, public on `h`, and waits until hashes and media reached the hub. */
async function share(
  c: CommunalCore,
  h: TestHub,
  hubId: string,
  name: string,
  root: string,
  files: number,
) {
  await c.addShare(name, root);
  await c.setRule(hubId, `${name}/`, 'hub');
  await until(() => c.store.counts().hashed >= files, 30_000, 'hashing');
  await until(() => c.store.mediaCounts().pending === 0, 60_000, 'media');
  await until(
    async () => {
      await c.sync.idle();
      return c.store.mediaCounts().pending === 0;
    },
    10_000,
    'sync',
  );
}

async function api(c: CommunalCore) {
  const a = new LocalApi(c);
  const sock = apiSocketPath(tmp('communal-m6-sock-'));
  await a.listen({ socketPath: sock });
  cleanups.push(() => a.close());
  return { client: new LocalApiClient({ socketPath: sock }), sock };
}

/** Raw HTTP over the API socket (thumbnail bytes, ranged streams). */
function raw(sock: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>(
    (resolve, reject) => {
      const req = request({ socketPath: sock, path, headers }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (d: Buffer) => parts.push(d));
        res.on('end', () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts) }),
        );
      });
      req.on('error', reject);
      req.end();
    },
  );
}

type Listing = {
  files: {
    path: string;
    hash: string | null;
    thumb: boolean;
    meta: Record<string, unknown>;
    icon: string;
    kind: string;
  }[];
};

describe('M6: file types, metadata, thumbnails, previews', () => {
  it('a mixed folder shows the right kinds, icons and metadata, on the hub and in browse', async () => {
    const h = await hub();
    const alice = await core('alice');
    const hubId = (await alice.addHub(h.url, acct('alice'))).hub.id;
    const root = tmp('communal-m6-mixed-');
    await mixedFolder(root);
    await share(alice, h, hubId, 'Mixed', root, 9);

    const bob = await core('bob');
    const bobHub = (await bob.addHub(h.url, acct('bob'))).hub.id;
    const { client } = await api(bob);
    const q = new URLSearchParams({ hub: bobHub, device: alice.deviceId, path: 'Mixed/' });
    const { files } = await client.get<Listing>(`/v1/browse?${q}`);
    const by = Object.fromEntries(files.map((f) => [f.path.slice('Mixed/'.length), f]));
    expect(by['holiday.jpg']).toMatchObject({
      kind: 'image',
      icon: 'image',
      thumb: true,
      meta: { width: 300, height: 400 },
    });
    expect(by['holiday.jpg']!.meta.taken_at).toBeGreaterThan(1_600_000_000);
    expect(by['diagram.png']).toMatchObject({
      icon: 'image',
      thumb: true,
      meta: { width: 800, height: 200 },
    });
    expect(by['clip.mp4']).toMatchObject({
      kind: 'video',
      icon: 'video',
      thumb: true,
      meta: { width: 640, height: 360, codec: 'h264' },
    });
    expect(by['song.mp3']).toMatchObject({
      kind: 'audio',
      icon: 'audio',
      thumb: true,
      meta: { artist: 'The Testers', album: 'Fixtures', title: 'Sine Song' },
    });
    expect(by['report.pdf']).toMatchObject({
      kind: 'document',
      icon: 'pdf',
      thumb: true,
      meta: { pages: 3, title: 'Annual Report' },
    });
    expect(by['notes.md']).toMatchObject({
      kind: 'text',
      icon: 'markdown',
      thumb: false,
      meta: {},
    });
    expect(by['main.rs']).toMatchObject({ kind: 'code', icon: 'code', thumb: false });
    expect(by['data.csv']).toMatchObject({ icon: 'table', thumb: false });
    expect(by['blob.bin']).toMatchObject({ kind: 'other', icon: 'file', thumb: false });

    // Search results carry metadata and icons too.
    const s = await client.get<{
      hits: { name: string; icon: string; meta: { duration?: number } }[];
    }>('/v1/search?q=clip');
    expect(s.hits[0]).toMatchObject({ name: 'clip.mp4', icon: 'video' });
    expect(s.hits[0]!.meta.duration).toBeCloseTo(3, 0);

    // Peek at a text file; nothing to peek at in a video.
    const md = by['notes.md']!.hash!;
    const peek = await client.get<{ text: string; truncated: boolean }>(
      `/v1/peek?${new URLSearchParams({ hub: bobHub, device: alice.deviceId, hash: md })}`,
    );
    expect(peek).toEqual({ text: '# Notes\n\nhello world\n', truncated: false });
    await expect(
      client.get(
        `/v1/peek?${new URLSearchParams({ hub: bobHub, device: alice.deviceId, hash: by['clip.mp4']!.hash! })}`,
      ),
    ).rejects.toThrow();
  }, 120_000);

  it('thumbnails for a 500-image folder load in one batched request, then from the cache', async () => {
    const h = await hub();
    let thumbGets: number[] = [];
    const alice = await core('alice', { onThumbGet: (n) => thumbGets.push(n) });
    const hubId = (await alice.addHub(h.url, acct('alice'))).hub.id;
    const root = tmp('communal-m6-500-');
    mkdirSync(join(root, 'Trip'));
    await Promise.all(
      Array.from({ length: 500 }, (_, i) =>
        png(join(root, 'Trip', `img${String(i).padStart(3, '0')}.png`), 64, 48, i),
      ),
    );
    // The fill colours repeat every few hundred seeds; make every image's content unique.
    const sharp = (await import('sharp')).default;
    await Promise.all(
      Array.from({ length: 500 }, async (_, i) => {
        const p = join(root, 'Trip', `img${String(i).padStart(3, '0')}.png`);
        const buf = await sharp(p)
          .png({ compressionLevel: i % 10 })
          .withMetadata({ density: 72 + i })
          .toBuffer();
        writeFileSync(p, buf);
      }),
    );
    await share(alice, h, hubId, 'Photos', root, 500);
    let offers = 0;
    alice.hubs.on('event', ({ msg }) => void (msg.t === 'connect.offer' && offers++));

    const bob = await core('bob');
    const bobHub = (await bob.addHub(h.url, acct('bob'))).hub.id;
    const { client, sock } = await api(bob);
    const { files } = await client.get<Listing>(
      `/v1/browse?${new URLSearchParams({ hub: bobHub, device: alice.deviceId, path: 'Photos/Trip/' })}`,
    );
    expect(files).toHaveLength(500);
    expect(files.every((f) => f.thumb && f.hash)).toBe(true);
    const hashes = files.map((f) => f.hash!);
    expect(new Set(hashes).size).toBe(500);

    const t0 = Date.now();
    const { thumbs } = await client.post<{ thumbs: Record<string, boolean> }>('/v1/thumbs', {
      hub: bobHub,
      device: alice.deviceId,
      hashes,
      size: 320,
    });
    const ms = Date.now() - t0;
    expect(Object.values(thumbs).filter(Boolean)).toHaveLength(500);
    // One connection, one thumb.get carrying all 500.
    expect(offers).toBe(1);
    expect(thumbGets).toEqual([500]);
    const one = await raw(sock, `/v1/thumbs/${hashes[123]}?size=320`);
    expect(one.status).toBe(200);
    expect(one.headers['content-type']).toBe('image/webp');
    expect(isWebp(one.body)).toBe(true);
    console.log(`[m6] 500 thumbnails in one batch: ${ms} ms`);

    // Again: all from the cache, no new connection.
    thumbGets = [];
    await client.post('/v1/thumbs', { hub: bobHub, device: alice.deviceId, hashes, size: 320 });
    expect(offers).toBe(1);
    expect(thumbGets).toEqual([]);

    // The upload log has one thumbnail-batch row for it.
    const batch = alice.store.uploadLog({ limit: 10 }).filter((r) => r.kind === 'thumbnail');
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ status: 'completed', path: 'Photos/Trip/' });
  }, 180_000);

  it('the uploader checks every thumbnail and peek itself; refusals look like "nothing there"', async () => {
    const h = await hub();
    const alice = await core('alice');
    const hubId = (await alice.addHub(h.url, acct('alice'))).hub.id;
    const pub = tmp('communal-m6-pub-');
    const priv = tmp('communal-m6-priv-');
    await png(join(pub, 'open.png'), 120, 90, 1);
    writeFileSync(join(pub, 'readme.txt'), 'x'.repeat(100_000));
    await png(join(priv, 'secret.png'), 120, 90, 2);
    writeFileSync(join(priv, 'diary.txt'), 'dear diary');
    await share(alice, h, hubId, 'Public', pub, 2);
    await alice.addShare('Private', priv); // "only me" on every hub (the default)
    await until(
      () => alice.store.counts().hashed === 4 && alice.store.mediaCounts().pending === 0,
      30_000,
      'private media',
    );
    const hashOf = (s: string, r: string) => alice.store.file(s, r)!.hash!;
    const open = hashOf('Public', 'open.png');
    const secret = hashOf('Private', 'secret.png');

    const bob = await core('bob');
    const bobHub = (await bob.addHub(h.url, acct('bob'))).hub.id;
    // A preview session brokered for a file bob may see, then asking for ones he may not.
    const r = await bob.fetchThumbnails(
      bobHub,
      alice.deviceId,
      [open, secret, 'ee'.repeat(32)],
      320,
    );
    expect(r).toEqual({ [open]: true, [secret]: false, ['ee'.repeat(32)]: false });
    expect(await bob.thumbnail(secret, 320)).toBeNull();

    const ch = await bob.broker.session(bobHub, alice.deviceId, open, { purpose: 'preview' });
    await ch.send({ t: 'peek', hash: hashOf('Private', 'diary.txt') });
    expect((await ch.next((x) => x.t === 'peek.data' || x.t === 'peek.none')).header.t).toBe(
      'peek.none',
    );
    await ch.send({ t: 'peek', hash: hashOf('Public', 'readme.txt') });
    const got = await ch.next((x) => x.t === 'peek.data' || x.t === 'peek.none');
    expect(got.header).toMatchObject({ t: 'peek.data', truncated: true });
    expect(got.payload.length).toBe(64 * 1024);
    ch.close();

    // The 1600 px preview is made on demand and fits in 1600.
    expect(await bob.fetchThumbnails(bobHub, alice.deviceId, [open], 1600)).toEqual({
      [open]: true,
    });
    const sharp = (await import('sharp')).default;
    const m = await sharp((await bob.thumbnail(open, 1600))!).metadata();
    expect(m.format).toBe('webp');
    expect(m.width).toBe(120); // never enlarged
  }, 120_000);

  it('streams a file in order over the local API, with HTTP ranges, without downloading it', async () => {
    const h = await hub();
    const alice = await core('alice');
    const hubId = (await alice.addHub(h.url, acct('alice'))).hub.id;
    const root = tmp('communal-m6-stream-');
    const data = randomBytes(3 * 1024 * 1024 + 4321);
    writeFileSync(join(root, 'film.bin'), data);
    await share(alice, h, hubId, 'Films', root, 1);
    const hash = alice.store.file('Films', 'film.bin')!.hash!;

    const bob = await core('bob');
    await bob.addHub(h.url, acct('bob'));
    const { sock } = await api(bob);
    const part = await raw(sock, `/v1/stream/${hash}?type=video/mp4`, {
      range: 'bytes=1000000-2100000',
    });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 1000000-2100000/${data.length}`);
    expect(part.headers['content-type']).toBe('video/mp4');
    expect(part.body.equals(data.subarray(1000000, 2100001))).toBe(true);
    const tail = await raw(sock, `/v1/stream/${hash}`, { range: 'bytes=-100' });
    expect(tail.body.equals(data.subarray(data.length - 100))).toBe(true);
    const all = await raw(sock, `/v1/stream/${hash}`);
    expect(all.status).toBe(200);
    expect(all.body.equals(data)).toBe(true);
    expect(
      (await raw(sock, `/v1/stream/${hash}`, { range: `bytes=${data.length + 5}-` })).status,
    ).toBe(416);
    expect(bob.store.transfers()).toEqual([]);
  }, 120_000);
});

describe('viewer thumbnail cache', () => {
  it('evicts the least recently used thumbnails above its size cap', async () => {
    const dir = tmp('communal-m6-cache-');
    const store = new IndexStore(join(dir, 'index.db'));
    cleanups.push(() => store.close());
    const sharp = (await import('sharp')).default;
    const webp = (i: number) =>
      sharp({ create: { width: 32, height: 32, channels: 3, background: { r: i, g: 0, b: 0 } } })
        .webp()
        .toBuffer();
    const one = (await webp(0)).length;
    const cache = new ThumbCache(join(dir, 'cache'), store, one * 3 + 10);
    const h = (i: number) => String(i).padStart(2, '0').repeat(32);
    for (let i = 0; i < 3; i++) expect(await cache.put(h(i), 320, await webp(0))).toBe(true);
    await sleep(5);
    await cache.get(h(0), 320); // used recently: survives
    await sleep(5);
    await cache.put(h(3), 320, await webp(0));
    expect(cache.has(h(0), 320)).toBe(true);
    expect(cache.has(h(1), 320)).toBe(false);
    expect(cache.has(h(3), 320)).toBe(true);
    expect(store.cacheTotal()).toBeLessThanOrEqual(one * 3 + 10);
    // Anything that isn't a WebP from a peer is refused.
    expect(await cache.put(h(4), 320, Buffer.from('<svg onload=alert(1)>'))).toBe(false);
  });
});
