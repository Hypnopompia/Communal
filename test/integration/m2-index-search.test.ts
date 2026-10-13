/**
 * M2 done-when: a 100k-file fixture indexes, syncs and searches; deltas apply; resync recovers
 * from a forced rev mismatch. Plus multi-hub publishing/search (ADR 0007) and the local API.
 *
 * M2_FILES overrides the fixture size (default 100,000).
 */
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { pino } from 'pino';
import { generateKeyPair } from '@communal/crypto';
import {
  CommunalCore,
  LocalApi,
  LocalApiClient,
  type MergedSearch,
  apiSocketPath,
} from '@communal/core';
import { HubDb } from '@communal/hub';
import { sleep, startTestHub, type TestHub } from '@communal/hub/testing';

const FILES = Number(process.env.M2_FILES ?? 100_000);
const quiet = pino({ level: process.env.M2_LOG ?? 'silent' });

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
  const dir = tmp('communal-m2-hub-');
  const db = new HubDb(join(dir, 'hub.db'));
  const t = await startTestHub({ dir, db, silenceMs: 5_000 });
  cleanups.push(async () => {
    await t.close();
    db.close();
  });
  return t;
}

async function core(name: string): Promise<CommunalCore> {
  const c = new CommunalCore({
    dataDir: tmp(`communal-m2-${name}-`),
    device: generateKeyPair(),
    hubClient: { pingIntervalMs: 1_000, silenceMs: 5_000, backoff: { initialMs: 50, maxMs: 500 } },
    indexer: { flushMs: 100 },
    log: quiet,
  });
  cleanups.push(() => c.stop());
  await c.start();
  return c;
}

const account = (name: string) => ({
  display_name: name,
  device_name: `${name}-nas`,
  platform: 'linux' as const,
});

async function until(cond: () => boolean | Promise<boolean>, timeoutMs: number, label: string) {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

/** True once every local file is hashed and the hub holds exactly that hashed set. */
async function inSync(c: CommunalCore, t: TestHub) {
  await c.sync.idle();
  const local = c.store.counts();
  const remote = t.db.raw
    .prepare('SELECT count(*) AS n, count(hash) AS hashed FROM entries WHERE device_id = ?')
    .get(c.deviceId) as { n: number; hashed: number };
  return local.files === local.hashed && remote.n === local.files && remote.hashed === local.files;
}

describe('M2: indexing, sync and search', () => {
  it(
    `indexes, syncs and searches a ${FILES.toLocaleString()}-file share`,
    { timeout: 600_000 },
    async () => {
      const root = tmp('communal-m2-share-');
      const perDir = 1_000;
      let t0 = Date.now();
      for (let d = 0; d * perDir < FILES; d++) {
        const dir = join(root, `batch ${String(d).padStart(3, '0')}`);
        mkdirSync(dir);
        for (let i = d * perDir; i < Math.min(FILES, (d + 1) * perDir); i++) {
          writeFileSync(join(dir, `holiday photo ${i}.jpg`), `photo ${i}`);
        }
      }
      const created = Date.now() - t0;

      const h = await hub();
      const c = await core('alice');
      await c.addHub(h.url, account('alice'));
      t0 = Date.now();
      await c.addShare('Pictures', root);
      const scanned = Date.now() - t0;
      expect(c.store.counts().files).toBe(FILES);

      await until(() => c.store.counts().hashed === FILES, 600_000, 'hashing');
      const hashed = Date.now() - t0;
      await until(() => inSync(c, h), 600_000, 'hashing + sync');
      const synced = Date.now() - t0;

      t0 = Date.now();
      const target = Math.floor(FILES * 0.73);
      const r = await c.search({ q: `holiday photo ${target}`, limit: 10 });
      const searched = Date.now() - t0;
      expect(r.hits).toHaveLength(1);
      expect(r.hits[0]!.sources[0]).toMatchObject({
        path: `Pictures/batch ${String(Math.floor(target / perDir)).padStart(3, '0')}/holiday photo ${target}.jpg`,
        online: true,
      });
      expect(r.hits[0]!.kind).toBe('image');

      const prefix = await c.search({ q: 'holi pho', limit: 500 });
      expect(prefix.hits).toHaveLength(500);
      expect(prefix.hubs[0]!.cursor).toBeDefined();

      console.log(
        `[m2] ${FILES} files: create ${created} ms, scan ${scanned} ms, hashed at ${hashed} ms, synced at ${synced} ms, search ${searched} ms`,
      );
    },
  );

  it('applies deltas for adds, edits, deletes and removed folders', async () => {
    const root = tmp('communal-m2-share-');
    writeFileSync(join(root, 'keep.txt'), 'keep');
    writeFileSync(join(root, 'edit.txt'), 'v1');
    mkdirSync(join(root, 'old'));
    writeFileSync(join(root, 'old', 'a.txt'), 'a');
    const h = await hub();
    const c = await core('alice');
    await c.addHub(h.url, account('alice'));
    await c.addShare('Docs', root);
    await until(() => inSync(c, h), 10_000, 'initial sync');
    const rev0 = h.db.indexRev(c.deviceId);
    const hashOf = (p: string) =>
      h.db.raw
        .prepare('SELECT hash FROM entries WHERE device_id = ? AND path = ?')
        .pluck()
        .get(c.deviceId, p);
    const v1 = hashOf('Docs/edit.txt');

    writeFileSync(join(root, 'new.md'), '# new');
    writeFileSync(join(root, 'edit.txt'), 'version two');
    rmSync(join(root, 'old'), { recursive: true });
    await until(
      async () =>
        (await inSync(c, h)) &&
        hashOf('Docs/edit.txt') !== v1 &&
        hashOf('Docs/new.md') !== undefined,
      10_000,
      'deltas',
    );
    const paths = h.db.raw
      .prepare('SELECT path FROM entries WHERE device_id = ? ORDER BY path')
      .pluck()
      .all(c.deviceId);
    expect(paths).toEqual(['Docs/edit.txt', 'Docs/keep.txt', 'Docs/new.md']);
    // Deltas, not snapshots: the rev moved forward step by step.
    expect(h.db.indexRev(c.deviceId)).toBeGreaterThan(rev0);

    unlinkSync(join(root, 'keep.txt'));
    await c.removeShare('Docs');
    await until(() => h.db.entryCount(c.deviceId) === 0, 10_000, 'share removal');
  });

  it('recovers from a forced rev mismatch with a resync', async () => {
    const root = tmp('communal-m2-share-');
    for (let i = 0; i < 20; i++) writeFileSync(join(root, `f${i}.txt`), `${i}`);
    const h = await hub();
    const c = await core('alice');
    await c.addHub(h.url, account('alice'));
    await c.addShare('S', root);
    await until(() => inSync(c, h), 10_000, 'initial sync');

    // The hub's view diverges: wrong rev and a missing entry.
    h.db.setIndexRev(c.deviceId, 999);
    h.db.raw
      .prepare("DELETE FROM entries WHERE device_id = ? AND path = 'S/f3.txt'")
      .run(c.deviceId);
    writeFileSync(join(root, 'f20.txt'), '20');
    await until(
      async () => (await inSync(c, h)) && h.db.entryCount(c.deviceId) === 21,
      10_000,
      'resync',
    );
    // A full snapshot replaced the hub's view; hub and client agree on the rev again.
    expect(h.db.indexRev(c.deviceId)).not.toBe(999);
    expect(h.db.indexRev(c.deviceId)).toBe(c.store.hubSync(c.hubs.list()[0]!.id)!.rev);
    expect(
      h.db.raw
        .prepare("SELECT count(*) FROM entries WHERE device_id = ? AND path = 'S/f3.txt'")
        .pluck()
        .get(c.deviceId),
    ).toBe(1);

    // Hub restarts having lost the index entirely: welcome.index_rev disagrees, snapshot again.
    h.db.raw.prepare('DELETE FROM entries WHERE device_id = ?').run(c.deviceId);
    h.db.setIndexRev(c.deviceId, 0);
    const { port, hubKey, db } = h;
    await h.hub.close();
    const h2 = await startTestHub({
      port,
      hubKey,
      db,
      dir: tmp('communal-m2-hub2-'),
      silenceMs: 5_000,
    });
    cleanups.push(() => h2.hub.close());
    await until(() => h.db.entryCount(c.deviceId) === 21, 15_000, 'snapshot after hub restart');
  });

  it('publishes shares per hub and merges search results across hubs', async () => {
    const [a, b] = [await hub(), await hub()];
    const c = await core('alice');
    const ha = (await c.addHub(a.url, account('alice'))).hub.id;
    const hb = (await c.addHub(b.url, account('alice'))).hub.id;

    const shared = tmp('communal-m2-share-');
    writeFileSync(join(shared, 'Alien (1979).mkv'), 'movie bytes');
    const onlyA = tmp('communal-m2-share-');
    writeFileSync(join(onlyA, 'Alien (1979).mkv'), 'movie bytes'); // same content → same hash
    writeFileSync(join(onlyA, 'Secret plans.pdf'), '%PDF-1.4');

    await c.addShare('Movies', shared, [ha]);
    await c.addShare('Private', onlyA, [ha]);
    await until(
      async () => (
        await c.sync.idle(),
        a.db.entryCount(c.deviceId) === 3 && b.db.entryCount(c.deviceId) === 0
      ),
      10_000,
      'publish to A',
    );
    await until(() => c.store.counts().hashed === 3, 10_000, 'hashing');
    await until(async () => await inSync(c, a), 10_000, 'A synced');

    // Publish Movies to B as well; B gets a snapshot with only that share.
    c.setShareHubs('Movies', [ha, hb]);
    await until(() => b.db.entryCount(c.deviceId) === 1, 10_000, 'publish to B');
    expect(b.db.raw.prepare('SELECT path FROM entries').pluck().all()).toEqual([
      'Movies/Alien (1979).mkv',
    ]);

    const r: MergedSearch = await c.search({ q: 'alien', limit: 10 });
    expect(r.hits).toHaveLength(1);
    const sources = r.hits[0]!.sources.map((s) => `${s.hub}:${s.path}`).sort();
    expect(sources).toEqual(
      [
        `${ha}:Movies/Alien (1979).mkv`,
        `${ha}:Private/Alien (1979).mkv`,
        `${hb}:Movies/Alien (1979).mkv`,
      ].sort(),
    );
    expect(r.hubs.every((x) => x.ok)).toBe(true);

    // Unpublish from A entirely: A's copy of the index empties, B keeps Movies.
    c.setShareHubs('Movies', [hb]);
    c.setShareHubs('Private', []);
    await until(() => a.db.entryCount(c.deviceId) === 0, 10_000, 'unpublish from A');
    expect(b.db.entryCount(c.deviceId)).toBe(1);

    // One hub down: search still answers from the other and says which one is missing.
    await a.hub.close();
    await sleep(100);
    const partial = await c.search({ q: 'alien', limit: 10 });
    expect(partial.hits).toHaveLength(1);
    expect(partial.hubs.find((x) => x.hub === ha)).toMatchObject({ ok: false });
  });

  it('serves the local API over a 0600 Unix socket, and requires the token over TCP', async () => {
    const h = await hub();
    const c = await core('alice');
    const api = new LocalApi(c);
    const sock = apiSocketPath(tmp('communal-m2-sock-'));
    await api.listen({ socketPath: sock });
    cleanups.push(() => api.close());
    const cli = new LocalApiClient({ socketPath: sock });

    const joined = await cli.post<{ hub: { id: string }; status: string }>('/v1/hubs', {
      url: h.url,
      display_name: 'alice',
      device_name: 'nas',
    });
    expect(joined.status).toBe('ready');
    const root = tmp('communal-m2-share-');
    writeFileSync(join(root, 'report.pdf'), '%PDF-1.4 report');
    await cli.post('/v1/shares', { name: 'Work', path: root });
    await until(() => inSync(c, h), 10_000, 'sync');
    const r = await cli.get<MergedSearch>('/v1/search?q=report');
    expect(r.hits.map((x) => x.name)).toEqual(['report.pdf']);
    await expect(cli.post('/v1/shares', { name: 'Work', path: root })).rejects.toMatchObject({
      status: 409,
    });
    await expect(cli.post('/v1/shares', { name: 'a/b', path: root })).rejects.toMatchObject({
      status: 400,
    });
    const { statSync } = await import('node:fs');
    // Windows uses a named pipe (per-user access), with no file mode to check.
    if (process.platform !== 'win32') expect(statSync(sock).mode & 0o777).toBe(0o600);

    const tcp = new LocalApi(c);
    const base = await tcp.listen({ host: '127.0.0.1', port: 0, token: 'sekret-token-123' });
    cleanups.push(() => tcp.close());
    await expect(
      new LocalApiClient({ url: base, token: 'wrong-token-1234' }).get('/v1/status'),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(
      await new LocalApiClient({ url: base, token: 'sekret-token-123' }).get('/v1/status'),
    ).toMatchObject({
      device_id: c.deviceId,
    });
  });

  it('announces changes on /v1/events and filters search by availability', async () => {
    const h = await hub();
    const c = await core('alice');
    const api = new LocalApi(c);
    const base = await api.listen({ host: '127.0.0.1', port: 0, token: 'sekret-token-123' });
    cleanups.push(() => api.close());
    const cli = new LocalApiClient({ url: base, token: 'sekret-token-123' });
    const wsUrl = base.replace(/^http/, 'ws') + '/v1/events';

    // No token, no events.
    const refused = new WebSocket(wsUrl, { headers: { authorization: 'Bearer nope-nope-nope-1' } });
    await new Promise<void>((done) => {
      refused.on('error', () => done());
      refused.on('open', () => done());
    });
    expect(refused.readyState).not.toBe(WebSocket.OPEN);

    const ws = new WebSocket(wsUrl, { headers: { authorization: 'Bearer sekret-token-123' } });
    cleanups.push(() => ws.terminate());
    const topics = new Set<string>();
    ws.on('message', (m: Buffer) => {
      for (const t of (JSON.parse(m.toString()) as { topics: string[] }).topics) topics.add(t);
    });
    await new Promise((ok) => ws.once('open', ok));

    await cli.post('/v1/hubs', { url: h.url, display_name: 'alice', device_name: 'nas' });
    const root = tmp('communal-m2-share-');
    writeFileSync(join(root, 'report.pdf'), '%PDF-1.4 report');
    await cli.post('/v1/shares', { name: 'Work', path: root });
    await until(() => inSync(c, h), 10_000, 'sync');
    await until(() => topics.has('hubs') && topics.has('index'), 5_000, 'hubs and index topics');

    // Own files on this (online) device: available now, and say so.
    const now = await cli.get<MergedSearch>('/v1/search?q=report&available=now');
    expect(now.hits.map((x) => x.sources.map((s) => s.seen))).toEqual([['now']]);
    // The Library lists this device, on the one hub, as its owner's.
    const lib = await cli.get<{
      devices: { device_id: string; online: boolean; user: { display_name: string } }[];
    }>('/v1/library');
    expect(lib.devices).toEqual([
      expect.objectContaining({
        device_id: c.deviceId,
        online: true,
        user: expect.objectContaining({ display_name: 'alice' }),
      }),
    ]);
    await expect(cli.get('/v1/search?q=report&available=older')).rejects.toMatchObject({
      status: 400,
    });
  });
});
