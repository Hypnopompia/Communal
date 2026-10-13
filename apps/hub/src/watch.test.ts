/**
 * Subscriptions (M7, ADR 0013): `watch` / `unwatch` / `watch.event`. Watching is filtered like
 * browse, events only ever carry what the watcher may see, catch-up runs from `since_rev`, and
 * losing access never looks like a deletion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceId, generateKeyPair, issueDeviceCert, toB64 } from '@communal/crypto';
import type { HubBody, HubMessage } from '@communal/protocol';
import { RawClient, signIn, signUp, sleep, startTestHub, type TestHub } from './testing.js';

let t: TestHub;
beforeEach(async () => {
  t = await startTestHub({ silenceMs: 30_000 });
});
afterEach(async () => {
  await t.close();
});

type Client = RawClient;
type WatchEvent = HubBody<'watch.event'>;
const hashOf = (name: string) => Buffer.from(name.padEnd(32, '.')).toString('hex').slice(0, 64);
const entry = (path: string, extra: object = {}) => ({
  path,
  size: 10,
  mtime: 1_700_000_000,
  mime: 'text/plain',
  kind: 'text' as const,
  meta: {},
  thumb: false,
  hash: hashOf(path),
  ...extra,
});

/** Alice shares S/pub/ with the hub, keeps S/pub/secret.txt and S/priv/ to herself. */
async function world() {
  const alice = await signUp(t.url, 'alice');
  const bob = await signUp(t.url, 'bob');
  await alice.c.request('index.snapshot', {
    rev: 1,
    page: 0,
    last: true,
    entries: [
      entry('S/pub/a.txt'),
      entry('S/pub/sub/b.txt'),
      entry('S/pub/secret.txt'),
      entry('S/pub/unhashed.txt', { hash: null }),
      entry('S/priv/p.txt'),
    ],
  });
  expect(
    (
      await alice.c.request('acl.replace', {
        device_id: alice.deviceId,
        rules: [
          { path: 'S/pub/', audience: 'hub' },
          { path: 'S/pub/secret.txt', audience: 'me' },
        ],
      })
    ).t,
  ).toBe('ok');
  return { alice, bob, rev: 1 };
}

async function delta(
  c: Client,
  base: number,
  upsert: ReturnType<typeof entry>[],
  remove: string[] = [],
) {
  const r = await c.request('index.delta', { base_rev: base, rev: base + 1, upsert, remove });
  expect(r).toMatchObject({ t: 'index.ack' });
  return base + 1;
}

async function watch(c: Client, device: string, path: string, since = 0, recursive = true) {
  return c.request('watch', {
    device_id: device,
    path,
    recursive,
    mirror_deletes: false,
    since_rev: since,
  });
}

const nextEvent = async (c: Client) => (await c.next('watch.event')).body as WatchEvent;
const paths = (ev: WatchEvent) => ev.added.map((e) => e.path).sort();

/** Fails if a watch.event arrives (or is already waiting) within `ms`. */
async function noEvent(c: Client, ms = 150) {
  await sleep(ms);
  expect(c.backlog().filter((m: HubMessage) => m.t === 'watch.event')).toEqual([]);
}

describe('watch: access control', () => {
  it('needs a session', async () => {
    const { alice } = await world();
    const c = await RawClient.connect(t.url);
    await c.next('challenge');
    const r = await watch(c, alice.deviceId, 'S/pub/');
    expect(r).toMatchObject({ t: 'error', body: { code: 'unauthenticated' } });
    c.close();
  });

  it('refuses folders you cannot see into exactly like ones that do not exist', async () => {
    const { alice, bob } = await world();
    const refused = [
      await watch(bob.c, alice.deviceId, 'S/priv/'),
      await watch(bob.c, alice.deviceId, 'S/nope/'),
      await watch(bob.c, deviceId(generateKeyPair().publicKey), 'S/pub/'),
    ];
    for (const r of refused) expect(r).toMatchObject({ t: 'error', body: { code: 'not_found' } });
    expect(new Set(refused.map((r) => JSON.stringify(r.body))).size).toBe(1);
    // Your own device isn't something to subscribe to.
    expect(await watch(alice.c, alice.deviceId, 'S/pub/')).toMatchObject({
      body: { code: 'bad_request' },
    });
    await noEvent(bob.c);
  });

  it('lets your other devices watch any of your folders, including private ones', async () => {
    const { alice } = await world();
    const laptop = generateKeyPair();
    t.db.addDevice({
      id: deviceId(laptop.publicKey),
      user_id: alice.userId,
      pubkey: toB64(laptop.publicKey),
      chain: [issueDeviceCert(alice.key, alice.userId, laptop.publicKey)],
      name: 'laptop',
      platform: 'darwin',
    });
    const own = await signIn(t.url, laptop, deviceId(laptop.publicKey));
    expect((await watch(own.c, alice.deviceId, 'S/')).t).toBe('ok');
    expect(paths(await nextEvent(own.c))).toEqual([
      'S/priv/p.txt',
      'S/pub/a.txt',
      'S/pub/secret.txt',
      'S/pub/sub/b.txt',
    ]);
    own.c.close();
  });

  it('never sends files or deletions the watcher may not see', async () => {
    const { alice, bob, rev } = await world();
    expect((await watch(bob.c, alice.deviceId, 'S/pub')).t).toBe('ok');
    const first = await nextEvent(bob.c);
    // Hashed, visible files only; the path is normalised to a folder.
    expect(first).toMatchObject({ device_id: alice.deviceId, path: 'S/pub/', rev, removed: [] });
    expect(paths(first)).toEqual(['S/pub/a.txt', 'S/pub/sub/b.txt']);

    // Changes to hidden files, and outside the folder, produce nothing at all.
    let r = await delta(alice.c, rev, [entry('S/pub/secret.txt', { size: 99, hash: hashOf('x') })]);
    r = await delta(alice.c, r, [entry('S/priv/new.txt')], ['S/priv/p.txt']);
    r = await delta(alice.c, r, [], ['S/pub/secret.txt']);
    await noEvent(bob.c);

    // A visible change is announced with the rev it brought the folder to.
    r = await delta(alice.c, r, [entry('S/pub/c.txt')], ['S/pub/a.txt']);
    const ev = await nextEvent(bob.c);
    expect(ev).toMatchObject({ rev: r, removed: ['S/pub/a.txt'] });
    expect(paths(ev)).toEqual(['S/pub/c.txt']);
  });

  it('stops events when the connection that granted access ends, without reporting deletions', async () => {
    const { alice, bob, rev } = await world();
    await alice.c.request('acl.set', {
      device_id: alice.deviceId,
      path: 'S/pub/',
      audience: { users: [bob.userId] },
    });
    await alice.c.request('connection.request', { user_id: bob.userId });
    await bob.c.request('connection.accept', { user_id: alice.userId });
    expect((await watch(bob.c, alice.deviceId, 'S/pub/')).t).toBe('ok');
    expect(paths(await nextEvent(bob.c))).toEqual(['S/pub/a.txt', 'S/pub/sub/b.txt']);

    await bob.c.request('connection.remove', { user_id: alice.userId });
    const r = await delta(alice.c, rev, [entry('S/pub/new.txt')], ['S/pub/a.txt']);
    await noEvent(bob.c);
    // Re-watching now fails like any folder bob can't see.
    expect(await watch(bob.c, alice.deviceId, 'S/pub/', r)).toMatchObject({
      body: { code: 'not_found' },
    });

    // Reconnecting restores access. The live watch was kept, and hears about everything now
    // visible, including what was added while bob couldn't see it.
    await alice.c.request('connection.request', { user_id: bob.userId });
    await bob.c.request('connection.accept', { user_id: alice.userId });
    const ev = await nextEvent(bob.c);
    expect(ev).toMatchObject({ rev: r, removed: ['S/pub/a.txt'] });
    expect(paths(ev)).toEqual(['S/pub/new.txt', 'S/pub/sub/b.txt']);
    await delta(alice.c, r, [entry('S/pub/later.txt')]);
    expect(paths(await nextEvent(bob.c))).toEqual(['S/pub/later.txt']);
  });

  it('hides the folder of a banned owner', async () => {
    const { alice, bob } = await world();
    t.db.ban(alice.userId);
    expect(await watch(bob.c, alice.deviceId, 'S/pub/')).toMatchObject({
      body: { code: 'not_found' },
    });
  });
});

describe('watch: catch-up and live events', () => {
  it('catches up from since_rev with what changed while the watcher was away', async () => {
    const { alice, bob, rev } = await world();
    expect((await watch(bob.c, alice.deviceId, 'S/pub/')).t).toBe('ok');
    const cursor = (await nextEvent(bob.c)).rev;
    bob.c.close();

    let r = await delta(alice.c, rev, [entry('S/pub/new.txt')], ['S/pub/sub/b.txt']);
    r = await delta(alice.c, r, [entry('S/pub/a.txt', { thumb: true })]); // metadata only
    r = await delta(alice.c, r, [entry('S/pub/later.txt')]);

    const back = await signIn(t.url, bob.key, bob.deviceId);
    expect((await watch(back.c, alice.deviceId, 'S/pub/', cursor)).t).toBe('ok');
    const ev = await nextEvent(back.c);
    expect(ev).toMatchObject({ rev: r, removed: ['S/pub/sub/b.txt'] });
    expect(paths(ev)).toEqual(['S/pub/later.txt', 'S/pub/new.txt']);

    // Nothing new: an empty event still confirms the cursor.
    expect((await watch(back.c, alice.deviceId, 'S/pub/', r)).t).toBe('ok');
    expect(await nextEvent(back.c)).toEqual({
      device_id: alice.deviceId,
      path: 'S/pub/',
      rev: r,
      added: [],
      removed: [],
    });
    back.c.close();
  });

  it('starts over when since_rev is ahead of the hub (an index rebuilt from scratch)', async () => {
    const { alice, bob } = await world();
    expect((await watch(bob.c, alice.deviceId, 'S/pub/', 500)).t).toBe('ok');
    expect(paths(await nextEvent(bob.c))).toEqual(['S/pub/a.txt', 'S/pub/sub/b.txt']);
  });

  it('turns a snapshot into the same events as a delta', async () => {
    const { alice, bob } = await world();
    await watch(bob.c, alice.deviceId, 'S/pub/');
    await nextEvent(bob.c);
    const snap = (rev: number, entries: ReturnType<typeof entry>[]) =>
      alice.c.request('index.snapshot', { rev, page: 0, last: true, entries });
    // Same content again: nothing to tell.
    await snap(2, [
      entry('S/pub/a.txt'),
      entry('S/pub/sub/b.txt'),
      entry('S/pub/secret.txt'),
      entry('S/pub/unhashed.txt', { hash: null }),
      entry('S/priv/p.txt'),
    ]);
    await noEvent(bob.c);
    // b.txt dropped, a.txt edited, unhashed.txt hashed.
    await snap(3, [
      entry('S/pub/a.txt', { size: 11, hash: hashOf('a2') }),
      entry('S/pub/unhashed.txt'),
    ]);
    const ev = await nextEvent(bob.c);
    expect(ev).toMatchObject({ rev: 3, removed: ['S/pub/sub/b.txt'] });
    expect(ev.added.map((e) => [e.path, e.hash])).toEqual([
      ['S/pub/a.txt', hashOf('a2')],
      ['S/pub/unhashed.txt', hashOf('S/pub/unhashed.txt')],
    ]);
  });

  it('only covers direct children when not recursive', async () => {
    const { alice, bob, rev } = await world();
    await watch(bob.c, alice.deviceId, 'S/pub/', 0, false);
    expect(paths(await nextEvent(bob.c))).toEqual(['S/pub/a.txt']);
    await delta(alice.c, rev, [entry('S/pub/sub/deeper.txt')], ['S/pub/sub/b.txt']);
    await noEvent(bob.c);
  });

  it('re-announces visible files when rules change, but not on an unchanged sign-in', async () => {
    const { alice, bob } = await world();
    await watch(bob.c, alice.deviceId, 'S/pub/');
    await nextEvent(bob.c);
    const rules = [
      { path: 'S/pub/', audience: 'hub' as const },
      { path: 'S/pub/secret.txt', audience: 'me' as const },
    ];
    await alice.c.request('acl.replace', { device_id: alice.deviceId, rules });
    await noEvent(bob.c);
    await alice.c.request('acl.replace', { device_id: alice.deviceId, rules: rules.slice(0, 1) });
    // Everything visible is re-sent; the client skips what it has.
    expect(paths(await nextEvent(bob.c))).toEqual([
      'S/pub/a.txt',
      'S/pub/secret.txt',
      'S/pub/sub/b.txt',
    ]);
    // Narrowing access again re-sends what is still visible, and never reports a deletion.
    await alice.c.request('acl.replace', { device_id: alice.deviceId, rules });
    const after = await nextEvent(bob.c);
    expect(after.removed).toEqual([]);
    expect(paths(after)).toEqual(['S/pub/a.txt', 'S/pub/sub/b.txt']);
  });

  it('stops after unwatch', async () => {
    const { alice, bob, rev } = await world();
    await watch(bob.c, alice.deviceId, 'S/pub/');
    await nextEvent(bob.c);
    expect((await bob.c.request('unwatch', { device_id: alice.deviceId, path: 'S/pub/' })).t).toBe(
      'ok',
    );
    expect(t.db.raw.prepare('SELECT count(*) FROM watches').pluck().get()).toBe(0);
    await delta(alice.c, rev, [entry('S/pub/new.txt')]);
    await noEvent(bob.c);
  });

  it('pages large catch-ups, and only the last page advances the cursor', async () => {
    const { alice, bob, rev } = await world();
    const many = Array.from({ length: 2_100 }, (_, i) => entry(`S/pub/many/${i}.txt`));
    const r = await delta(alice.c, rev, many);
    await watch(bob.c, alice.deviceId, 'S/pub/', rev);
    const pages = [await nextEvent(bob.c), await nextEvent(bob.c), await nextEvent(bob.c)];
    expect(pages.map((p) => p.rev)).toEqual([rev, rev, r]);
    expect(pages.reduce((n, p) => n + p.added.length, 0)).toBe(2_100);
    await noEvent(bob.c);
  });

  it('forgets deletions older than the retention window', async () => {
    const { alice, bob, rev } = await world();
    t.db.tombstoneRetentionS = -1; // everything is "old" by the next write
    const r = await delta(alice.c, rev, [], ['S/pub/a.txt']);
    await delta(alice.c, r, [entry('S/pub/z.txt')]);
    await watch(bob.c, alice.deviceId, 'S/pub/', rev);
    const ev = await nextEvent(bob.c);
    expect(ev.removed).toEqual([]);
    expect(paths(ev)).toEqual(['S/pub/z.txt']);
  });
});

describe('browse.follow: live browsing hints', () => {
  const follow = (c: Client, device: string | null) =>
    c.request('browse.follow', { device_id: device });
  const nextHint = async (c: Client) => (await c.next('browse.changed')).body;
  async function noHint(c: Client, ms = 150) {
    await sleep(ms);
    expect(c.backlog().filter((m: HubMessage) => m.t === 'browse.changed')).toEqual([]);
  }

  it('needs a session', async () => {
    const { alice } = await world();
    const c = await RawClient.connect(t.url);
    await c.next('challenge');
    const r = await follow(c, alice.deviceId);
    expect(r).toMatchObject({ t: 'error', body: { code: 'unauthenticated' } });
    c.close();
  });

  it('refuses devices you cannot see into exactly like ones that do not exist', async () => {
    const { alice, bob } = await world();
    const carol = await signUp(t.url, 'carol');
    // Carol has a private file only: bob can't browse her device.
    await carol.c.request('index.snapshot', {
      rev: 1,
      page: 0,
      last: true,
      entries: [entry('C/x.txt')],
    });
    const refused = [
      await follow(bob.c, carol.deviceId),
      await follow(bob.c, deviceId(generateKeyPair().publicKey)),
    ];
    for (const r of refused) expect(r).toMatchObject({ t: 'error', body: { code: 'not_found' } });
    expect(new Set(refused.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect((await follow(bob.c, alice.deviceId)).t).toBe('ok');
    carol.c.close();
  });

  it('hints when something the viewer can see is added or removed', async () => {
    const { alice, bob, rev } = await world();
    expect((await follow(bob.c, alice.deviceId)).t).toBe('ok');
    const r2 = await delta(alice.c, rev, [entry('S/pub/new.txt')]);
    expect(await nextHint(bob.c)).toEqual({ device_id: alice.deviceId });
    await delta(alice.c, r2, [], ['S/pub/a.txt']);
    expect(await nextHint(bob.c)).toEqual({ device_id: alice.deviceId });
  });

  it('says nothing about changes to files the viewer cannot see', async () => {
    const { alice, bob, rev } = await world();
    expect((await follow(bob.c, alice.deviceId)).t).toBe('ok');
    let r = await delta(alice.c, rev, [entry('S/priv/new.txt')]);
    r = await delta(alice.c, r, [entry('S/pub/secret.txt', { hash: hashOf('changed') })]);
    await delta(alice.c, r, [], ['S/priv/p.txt']);
    await noHint(bob.c);
  });

  it('tells your other devices about private changes too', async () => {
    const { alice, rev } = await world();
    const laptop = generateKeyPair();
    t.db.addDevice({
      id: deviceId(laptop.publicKey),
      user_id: alice.userId,
      pubkey: toB64(laptop.publicKey),
      chain: [issueDeviceCert(alice.key, alice.userId, laptop.publicKey)],
      name: 'laptop',
      platform: 'darwin',
    });
    const own = await signIn(t.url, laptop, deviceId(laptop.publicKey));
    expect((await follow(own.c, alice.deviceId)).t).toBe('ok');
    await delta(alice.c, rev, [entry('NewShare/x.txt')]);
    expect(await nextHint(own.c)).toEqual({ device_id: alice.deviceId });
    own.c.close();
  });

  it('hints when a rule change shows (or hides) files, and stops after unfollowing', async () => {
    const { alice, bob } = await world();
    expect((await follow(bob.c, alice.deviceId)).t).toBe('ok');
    const share = (rules: { path: string; audience: 'hub' }[]) =>
      alice.c.request('acl.replace', { device_id: alice.deviceId, rules });
    await share([{ path: 'S/', audience: 'hub' }]);
    expect(await nextHint(bob.c)).toEqual({ device_id: alice.deviceId });
    // The same rules again (as on every sign-in) change nothing.
    await share([{ path: 'S/', audience: 'hub' }]);
    await noHint(bob.c);
    expect((await follow(bob.c, null)).t).toBe('ok');
    await share([{ path: 'S/pub/', audience: 'hub' }]);
    await noHint(bob.c);
  });

  it('hints when a visible file only gains a thumbnail or new metadata', async () => {
    const { alice, bob, rev } = await world();
    expect((await follow(bob.c, alice.deviceId)).t).toBe('ok');
    let r = await delta(alice.c, rev, [entry('S/pub/a.txt', { thumb: true })]);
    expect(await nextHint(bob.c)).toEqual({ device_id: alice.deviceId });
    r = await delta(alice.c, r, [entry('S/pub/a.txt', { thumb: true, meta: { width: 10 } })]);
    expect(await nextHint(bob.c)).toEqual({ device_id: alice.deviceId });
    // ...but not for hidden files, and not when a snapshot changes nothing.
    await delta(alice.c, r, [entry('S/pub/secret.txt', { thumb: true })]);
    await alice.c.request('index.snapshot', {
      rev: r + 2,
      page: 0,
      last: true,
      entries: [
        entry('S/pub/a.txt', { thumb: true, meta: { width: 10 } }),
        entry('S/pub/sub/b.txt'),
        entry('S/pub/secret.txt', { thumb: true }),
        entry('S/pub/unhashed.txt', { hash: null }),
        entry('S/priv/p.txt'),
      ],
    });
    await noHint(bob.c);
    // A snapshot that adds a thumbnail is a change.
    await alice.c.request('index.snapshot', {
      rev: r + 3,
      page: 0,
      last: true,
      entries: [
        entry('S/pub/a.txt', { thumb: true, meta: { width: 10 } }),
        entry('S/pub/sub/b.txt', { thumb: true }),
        entry('S/pub/secret.txt', { thumb: true }),
        entry('S/pub/unhashed.txt', { hash: null }),
        entry('S/priv/p.txt'),
      ],
    });
    expect(await nextHint(bob.c)).toEqual({ device_id: alice.deviceId });
  });

  it('only follows one device per session', async () => {
    const { alice, bob, rev } = await world();
    const carol = await signUp(t.url, 'carol');
    await carol.c.request('index.snapshot', {
      rev: 1,
      page: 0,
      last: true,
      entries: [entry('C/x.txt')],
    });
    await carol.c.request('acl.replace', {
      device_id: carol.deviceId,
      rules: [{ path: 'C/', audience: 'hub' }],
    });
    expect((await follow(bob.c, alice.deviceId)).t).toBe('ok');
    expect((await follow(bob.c, carol.deviceId)).t).toBe('ok');
    await delta(alice.c, rev, [entry('S/pub/new.txt')]);
    await noHint(bob.c);
    await delta(carol.c, 1, [entry('C/y.txt')]);
    expect(await nextHint(bob.c)).toEqual({ device_id: carol.deviceId });
    carol.c.close();
  });
});

describe('library.changed: the device list', () => {
  const nextChange = (c: Client) => c.next('library.changed');
  async function noChange(c: Client, ms = 150) {
    await sleep(ms);
    expect(c.backlog().filter((m: HubMessage) => m.t === 'library.changed')).toEqual([]);
  }
  const listed = async (c: Client) => {
    const r = await c.request('library', {});
    return (r.body as HubBody<'library.listing'>).devices.map((d) => d.device_id);
  };

  /** Carol holds one private file, so nobody else has her computer in their library. */
  async function carolPrivate() {
    const carol = await signUp(t.url, 'carol');
    await carol.c.request('index.snapshot', {
      rev: 1,
      page: 0,
      last: true,
      entries: [entry('C/x.txt')],
    });
    return carol;
  }

  it('says when a device becomes browsable, and when it stops being browsable', async () => {
    const { bob } = await world();
    const carol = await carolPrivate();
    expect(await listed(bob.c)).not.toContain(carol.deviceId);
    await carol.c.request('acl.replace', {
      device_id: carol.deviceId,
      rules: [{ path: 'C/', audience: 'hub' }],
    });
    await nextChange(bob.c);
    expect(await listed(bob.c)).toContain(carol.deviceId);
    await delta(carol.c, 1, [], ['C/x.txt']);
    await nextChange(bob.c);
    expect(await listed(bob.c)).not.toContain(carol.deviceId);
    carol.c.close();
  });

  it('says when a new share makes a device browsable', async () => {
    const { bob } = await world();
    const carol = await carolPrivate();
    await carol.c.request('acl.replace', {
      device_id: carol.deviceId,
      rules: [{ path: 'Pub/', audience: 'hub' }],
    });
    await listed(bob.c);
    await delta(carol.c, 1, [entry('Pub/y.txt')]);
    await nextChange(bob.c);
    expect(await listed(bob.c)).toContain(carol.deviceId);
    carol.c.close();
  });

  it('stays quiet about private changes and for sessions that never asked', async () => {
    const { alice, bob, rev } = await world();
    const carol = await carolPrivate();
    expect(await listed(bob.c)).toContain(alice.deviceId);
    await delta(carol.c, 1, [entry('C/y.txt')]);
    await delta(alice.c, rev, [entry('S/priv/z.txt')]);
    await noChange(bob.c);
    // Alice never asked for her library: nothing comes, whatever changes.
    await carol.c.request('acl.replace', {
      device_id: carol.deviceId,
      rules: [{ path: 'C/', audience: 'hub' }],
    });
    await nextChange(bob.c);
    await noChange(alice.c);
    carol.c.close();
  });

  it('says when a connection ends, and a device goes with it', async () => {
    const { bob } = await world();
    const carol = await carolPrivate();
    t.db.putConnection(bob.userId, carol.userId, 'accepted');
    await carol.c.request('acl.replace', {
      device_id: carol.deviceId,
      rules: [{ path: 'C/', audience: { users: [bob.userId] } }],
    });
    expect(await listed(bob.c)).toContain(carol.deviceId);
    expect((await carol.c.request('connection.remove', { user_id: bob.userId })).t).toBe('ok');
    await nextChange(bob.c);
    expect(await listed(bob.c)).not.toContain(carol.deviceId);
    carol.c.close();
  });
});
