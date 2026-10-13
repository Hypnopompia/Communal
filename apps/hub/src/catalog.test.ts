import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HubMessage } from '@communal/protocol';
import { Catalog, ftsQuery, seenBucket } from './catalog.js';
import { signUp, startTestHub, type TestHub } from './testing.js';

let t: TestHub;
beforeEach(async () => {
  t = await startTestHub();
});
afterEach(async () => {
  await t.close();
});

const h = (n: number) => n.toString(16).padStart(64, '0');
const entry = (path: string, hash: string | null, extra: object = {}) => ({
  path,
  size: 1000,
  mtime: 1_700_000_000,
  mime: 'video/x-matroska',
  kind: 'video' as const,
  meta: {},
  thumb: false,
  hash,
  ...extra,
});

async function snapshot(
  c: Awaited<ReturnType<typeof signUp>>['c'],
  rev: number,
  entries: ReturnType<typeof entry>[],
) {
  const r = await c.request('index.snapshot', { rev, page: 0, last: true, entries });
  expect(r).toMatchObject({ t: 'index.ack', body: { rev } });
}

const body = <T>(m: HubMessage) => m.body as T;

describe('index sync', () => {
  it('replaces the device index on snapshot and applies deltas in order', async () => {
    const a = await signUp(t.url, 'alice');
    await snapshot(a.c, 1, [entry('Movies/Alien (1979).mkv', h(1)), entry('Movies/old.mkv', h(2))]);
    expect(t.db.entryCount(a.deviceId)).toBe(2);

    const d = await a.c.request('index.delta', {
      base_rev: 1,
      rev: 2,
      upsert: [entry('Movies/new/Aliens (1986).mkv', h(3))],
      remove: ['Movies/old.mkv', 'Movies/never-existed.mkv'],
    });
    expect(d).toMatchObject({ t: 'index.ack', body: { rev: 2 } });
    expect(t.db.indexRev(a.deviceId)).toBe(2);

    // A delta against a stale rev is refused with index.resync and changes nothing.
    const stale = await a.c.request('index.delta', {
      base_rev: 1,
      rev: 3,
      upsert: [],
      remove: ['Movies/Alien (1979).mkv'],
    });
    expect(stale).toMatchObject({ t: 'index.resync', body: { reason: 'rev_mismatch' } });
    expect(t.db.entryCount(a.deviceId)).toBe(2);

    // A fresh snapshot replaces everything.
    await snapshot(a.c, 7, [entry('Music/a.flac', h(9), { kind: 'audio', mime: 'audio/flac' })]);
    expect(t.db.entryCount(a.deviceId)).toBe(1);
    expect(t.db.indexRev(a.deviceId)).toBe(7);
  });

  it('assembles multi-page snapshots and rejects pages out of order', async () => {
    const a = await signUp(t.url, 'alice');
    expect(
      (
        await a.c.request('index.snapshot', {
          rev: 1,
          page: 0,
          last: false,
          entries: [entry('A/1', h(1))],
        })
      ).t,
    ).toBe('ok');
    // Not visible until the last page commits.
    expect(t.db.entryCount(a.deviceId)).toBe(0);
    const skipped = await a.c.request('index.snapshot', {
      rev: 1,
      page: 2,
      last: true,
      entries: [],
    });
    expect(skipped).toMatchObject({ t: 'error', body: { code: 'bad_request' } });

    await a.c.request('index.snapshot', {
      rev: 2,
      page: 0,
      last: false,
      entries: [entry('A/1', h(1))],
    });
    await a.c.request('index.snapshot', {
      rev: 2,
      page: 1,
      last: true,
      entries: [entry('A/2', h(2))],
    });
    expect(t.db.entryCount(a.deviceId)).toBe(2);
  });
});

describe('access control: index.snapshot / index.delta', () => {
  it("only ever changes the signed-in device's own index", async () => {
    const alice = await signUp(t.url, 'alice');
    const bob = await signUp(t.url, 'bob');
    await snapshot(alice.c, 1, [entry('Movies/Alien (1979).mkv', h(1))]);
    // Bob removes "the same path" and snapshots empty: only his own (empty) index changes.
    await bob.c.request('index.delta', {
      base_rev: 0,
      rev: 1,
      upsert: [],
      remove: ['Movies/Alien (1979).mkv'],
    });
    await snapshot(bob.c, 2, []);
    expect(t.db.entryCount(alice.deviceId)).toBe(1);
    expect(t.db.entryCount(bob.deviceId)).toBe(0);
  });

  it('refuses index messages before sign-in', async () => {
    const { RawClient } = await import('./testing.js');
    const c = await RawClient.connect(t.url);
    const r = await c.request('index.snapshot', { rev: 1, page: 0, last: true, entries: [] });
    expect(r).toMatchObject({ t: 'error', body: { code: 'unauthenticated' } });
    c.close();
  });
});

describe('access control: search, browse, sources (M2: owner only)', () => {
  async function world() {
    const alice = await signUp(t.url, 'alice');
    const bob = await signUp(t.url, 'bob');
    await snapshot(alice.c, 1, [
      entry('Movies/Alien (1979).mkv', h(1)),
      entry('Movies/Backup/Alien (1979).mkv', h(1)),
      entry('Movies/Unhashed Alien.mkv', null),
      entry('Movies/Aliens (1986).mkv', h(2), { size: 5000 }),
    ]);
    await snapshot(bob.c, 1, [entry('Films/alien.mkv', h(1))]);
    t.db.putConnection(alice.userId, bob.userId, 'accepted');
    return { alice, bob };
  }

  it('finds your own hashed files by word prefix, grouped by hash', async () => {
    const { alice } = await world();
    const r = body<{ hits: { hash: string; sources: { path: string; online: boolean }[] }[] }>(
      await alice.c.request('search', { q: 'ali', limit: 10 }),
    );
    expect(r.hits.map((x) => x.hash).sort()).toEqual([h(1), h(2)]);
    const h1 = r.hits.find((x) => x.hash === h(1))!;
    // Bob's copy of the same file is not alice's to see, even though they're connected.
    expect(h1.sources.map((s) => s.path).sort()).toEqual([
      'Movies/Alien (1979).mkv',
      'Movies/Backup/Alien (1979).mkv',
    ]);
    expect(h1.sources.every((s) => s.online)).toBe(true);

    const filtered = body<{ hits: { hash: string }[] }>(
      await alice.c.request('search', { q: 'alien', min_size: 2000, limit: 10 }),
    );
    expect(filtered.hits.map((x) => x.hash)).toEqual([h(2)]);
    const wrongKind = body<{ hits: unknown[] }>(
      await alice.c.request('search', { q: 'alien', kind: 'audio', limit: 10 }),
    );
    expect(wrongKind.hits).toEqual([]);
  });

  it("never shows another user's files, not even through sources or browse", async () => {
    const { alice, bob } = await world();
    const r = body<{ hits: { sources: { device_id: string }[] }[] }>(
      await bob.c.request('search', { q: 'alien', limit: 10 }),
    );
    expect(r.hits.flatMap((x) => x.sources.map((s) => s.device_id))).toEqual([bob.deviceId]);

    const src = body<{ sources: { device_id: string }[] }>(
      await bob.c.request('sources', { hash: h(1) }),
    );
    expect(src.sources.map((s) => s.device_id)).toEqual([bob.deviceId]);
    expect(
      body<{ sources: unknown[] }>(await bob.c.request('sources', { hash: h(2) })).sources,
    ).toEqual([]);

    // Someone else's device browses exactly like a device that doesn't exist.
    const other = await bob.c.request('browse', { device_id: alice.deviceId, path: '' });
    const missing = await bob.c.request('browse', { device_id: 'd_' + 'z'.repeat(26), path: '' });
    expect(other).toMatchObject({ t: 'error', body: { code: 'not_found' } });
    expect(other.body).toEqual(missing.body);
  });

  it('browses your own device folder by folder, unhashed files included', async () => {
    const { alice } = await world();
    const root = body<{ dirs: { name: string }[]; files: unknown[] }>(
      await alice.c.request('browse', { device_id: alice.deviceId, path: '' }),
    );
    expect(root).toMatchObject({ online: true, dirs: [{ name: 'Movies' }], files: [] });
    const movies = body<{ dirs: { name: string }[]; files: { path: string }[] }>(
      await alice.c.request('browse', { device_id: alice.deviceId, path: 'Movies/' }),
    );
    expect(movies.dirs).toEqual([{ name: 'Backup' }]);
    expect(movies.files.map((f) => f.path)).toEqual([
      'Movies/Alien (1979).mkv',
      'Movies/Aliens (1986).mkv',
      'Movies/Unhashed Alien.mkv',
    ]);
  });

  it('pages results with a cursor', async () => {
    const a = await signUp(t.url, 'alice');
    await snapshot(
      a.c,
      1,
      Array.from({ length: 25 }, (_, i) => entry(`X/report ${i}.pdf`, h(100 + i))),
    );
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const r = body<{ hits: { hash: string }[]; cursor?: string }>(
        await a.c.request('search', { q: 'report', limit: 10, ...(cursor ? { cursor } : {}) }),
      );
      r.hits.forEach((x) => seen.add(x.hash));
      cursor = r.cursor;
    } while (cursor);
    expect(seen.size).toBe(25);
  });
});

describe('search hit naming', () => {
  it('names a hit after the copy that matched, not an arbitrary one with the same content', async () => {
    const a = await signUp(t.url, 'alice');
    await snapshot(a.c, 1, [entry('A/aaa first.png', h(5)), entry('A/Holiday photo.png', h(5))]);
    const r = body<{ hits: { name: string }[] }>(
      await a.c.request('search', { q: 'holiday', limit: 5 }),
    );
    expect(r.hits.map((x) => x.name)).toEqual(['Holiday photo.png']);
  });
});

describe('source availability (ADR 0015)', () => {
  const T = 1_800_000_000;
  const DAY = 86_400;

  /**
   * Four public copies of the same kind of file, one per user: bob online, carol seen 3 days
   * ago, dave 20 days ago, frank never. The catalog gets fake presence and a fixed clock.
   */
  async function world() {
    const names = ['bob', 'carol', 'dave', 'frank'];
    const users = await Promise.all(names.map((n) => signUp(t.url, n)));
    const viewer = await signUp(t.url, 'erin');
    for (const [i, u] of users.entries()) {
      await snapshot(u.c, 1, [entry(`S/${names[i]} alien.mkv`, h(i + 1))]);
      await u.c.request('acl.set', { device_id: u.deviceId, path: 'S/', audience: 'hub' });
    }
    const [bob, carol, dave, frank] = users as [
      (typeof users)[0],
      (typeof users)[0],
      (typeof users)[0],
      (typeof users)[0],
    ];
    t.db.touchDevice(carol.deviceId, T - 3 * DAY);
    t.db.touchDevice(dave.deviceId, T - 20 * DAY);
    t.db.raw.prepare('UPDATE devices SET last_seen = NULL WHERE id = ?').run(frank.deviceId);
    const online = new Set([bob.deviceId, viewer.deviceId]);
    const catalog = new Catalog(
      t.db,
      { isOnline: (d) => online.has(d), onlineDevices: () => [...online] },
      () => T,
    );
    return { bob, carol, dave, frank, viewer, catalog };
  }

  it('rounds last_seen into buckets', () => {
    expect(seenBucket(null, T)).toBe('older');
    expect(seenBucket(T - 60, T)).toBe('today');
    expect(seenBucket(T - DAY, T)).toBe('week');
    expect(seenBucket(T - 6 * DAY, T)).toBe('week');
    expect(seenBucket(T - 7 * DAY, T)).toBe('month');
    expect(seenBucket(T - 30 * DAY, T)).toBe('older');
  });

  it('ranks hits by availability and says when each source was seen', async () => {
    const w = await world();
    const r = w.catalog.search(w.viewer.userId, { q: 'alien', limit: 10 });
    const got = r.hits.map((x) => x.sources.map((s) => [s.owner, s.online, s.seen]));
    expect(got.slice(0, 2)).toEqual([
      [[w.bob.userId, true, 'now']],
      [[w.carol.userId, false, 'week']],
    ]);
    // dave and frank are both stale, so relevance decides between them.
    expect(got.slice(2).sort()).toEqual(
      [[[w.dave.userId, false, 'month']], [[w.frank.userId, false, 'older']]].sort(),
    );
    expect(w.catalog.sources(w.viewer.userId, h(2)).sources).toEqual([
      expect.objectContaining({ device_id: w.carol.deviceId, online: false, seen: 'week' }),
    ]);
  });

  it('filters by availability inside the query, so paging still works', async () => {
    const w = await world();
    const owners = (available?: 'now' | 'today' | 'week' | 'month') =>
      w.catalog
        .search(w.viewer.userId, { q: 'alien', limit: 10, ...(available ? { available } : {}) })
        .hits.map((x) => x.sources[0]!.owner);
    expect(owners('now')).toEqual([w.bob.userId]);
    expect(owners('today')).toEqual([w.bob.userId]);
    expect(owners('week')).toEqual([w.bob.userId, w.carol.userId]);
    expect(owners('month')).toEqual([w.bob.userId, w.carol.userId, w.dave.userId]);
    expect(owners()).toHaveLength(4);

    const page1 = w.catalog.search(w.viewer.userId, { q: 'alien', available: 'month', limit: 2 });
    expect(page1.hits.map((x) => x.sources[0]!.owner)).toEqual([w.bob.userId, w.carol.userId]);
    const page2 = w.catalog.search(w.viewer.userId, {
      q: 'alien',
      available: 'month',
      limit: 2,
      cursor: page1.cursor!,
    });
    expect(page2.hits.map((x) => x.sources[0]!.owner)).toEqual([w.dave.userId]);
    expect(page2.cursor).toBeUndefined();
  });

  it('filters only what the viewer may see, and sends seen over the wire', async () => {
    const w = await world();
    // A private file on an online device stays hidden whatever the filter.
    await snapshot(w.bob.c, 2, [entry('P/alien private.mkv', h(9))]);
    const r = body<{ hits: { hash: string; sources: { seen: string }[] }[] }>(
      await w.viewer.c.request('search', { q: 'alien', available: 'now', limit: 10 }),
    );
    expect(r.hits.map((x) => x.hash)).not.toContain(h(9));
    // Over the wire, the real hub's presence applies: everyone in world() is still connected.
    expect(r.hits.every((x) => x.sources.every((s) => s.seen === 'now'))).toBe(true);
  });
});

describe('FTS query building', () => {
  it('turns words into prefix terms and neutralises FTS syntax', () => {
    expect(ftsQuery('alien 1979')).toBe('"alien"* "1979"*');
    expect(ftsQuery('"a" OR b*')).toBe('"a"* "OR"* "b"*');
    expect(ftsQuery('Alien.(1979).mkv')).toBe('"Alien"* "1979"* "mkv"*');
    expect(ftsQuery('  ---  ')).toBeNull();
  });

  it('does not let a crafted query error out the hub', async () => {
    const a = await signUp(t.url, 'alice');
    for (const q of ['"', 'NEAR(a b)', 'a AND', '*', 'col:val', '(((']) {
      expect((await a.c.request('search', { q, limit: 5 })).t).toBe('search.results');
    }
  });
});
