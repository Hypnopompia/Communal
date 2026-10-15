/**
 * M3 done-when: every audience type × connected/unconnected × own device, for search, browse
 * and sources; removing a connection revokes immediately.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceId, generateKeyPair, issueDeviceCert, toB64 } from '@communal/crypto';
import type { HubMessage } from '@communal/protocol';
import { signIn, signUp, startTestHub, type TestHub } from './testing.js';

let t: TestHub;
beforeEach(async () => {
  t = await startTestHub({ silenceMs: 30_000 });
});
afterEach(async () => {
  await t.close();
});

type Client = Awaited<ReturnType<typeof signUp>>['c'];
const body = <T>(m: HubMessage) => m.body as T;
const hashOf = (name: string) => Buffer.from(name.padEnd(32, '.')).toString('hex').slice(0, 64);
const entry = (path: string) => ({
  path,
  size: 10,
  mtime: 1_700_000_000,
  mime: 'text/plain',
  kind: 'text' as const,
  meta: {},
  thumb: false,
  hash: hashOf(path),
});

const FILES = [
  'S/default.txt', // no rule anywhere → only me
  'S/me.txt', // explicit "me"
  'S/hub/a.txt', // folder rule "hub"
  'S/hub/deep/b.txt', // inherits "hub" from S/hub/
  'S/hub/override.txt', // file rule "me" overrides the folder
  'S/users/a.txt', // folder rule { users: [bob, carol] }
  'S/groups/a.txt', // folder rule { groups: [friends] } (members: bob)
] as const;

async function world() {
  const alice = await signUp(t.url, 'alice');
  const people = {
    bob: await signUp(t.url, 'bob'), // connected; listed; in the group
    dave: await signUp(t.url, 'dave'), // connected; not listed, not in the group
    carol: await signUp(t.url, 'carol'), // listed by user id, but NOT connected
    erin: await signUp(t.url, 'erin'), // a stranger
  };
  // alice's second device (linking is M8; registered directly here).
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
  expect(own.reply.t).toBe('welcome');

  for (const p of [people.bob, people.dave]) {
    expect((await alice.c.request('connection.request', { user_id: p.userId })).t).toBe('ok');
    expect((await p.c.request('connection.accept', { user_id: alice.userId })).t).toBe('ok');
  }
  const g = body<{ groups: { group_id: string }[] }>(
    await alice.c.request('group.upsert', { name: 'Friends', members: [people.bob.userId] }),
  ).groups[0]!.group_id;

  await alice.c.request('index.snapshot', {
    rev: 1,
    page: 0,
    last: true,
    entries: FILES.map(entry),
  });
  const rules = await alice.c.request('acl.replace', {
    device_id: alice.deviceId,
    rules: [
      { path: 'S/me.txt', audience: 'me' },
      { path: 'S/hub/', audience: 'hub' },
      { path: 'S/hub/override.txt', audience: 'me' },
      { path: 'S/users/', audience: { users: [people.bob.userId, people.carol.userId] } },
      { path: 'S/groups/', audience: { groups: [g] } },
    ],
  });
  expect(rules.t).toBe('ok');
  return { alice, own: own.c, group: g, ...people };
}

/** Paths of alice's files the client can find by search, by sources and by browsing. */
async function seen(c: Client, aliceDevice: string) {
  const search = body<{ hits: { sources: { device_id: string; path: string }[] }[] }>(
    await c.request('search', { q: '', limit: 100 }),
  )
    .hits.flatMap((h) => h.sources)
    .filter((s) => s.device_id === aliceDevice)
    .map((s) => s.path)
    .sort();

  const sources: string[] = [];
  // Every path any test may add, so sources are checked for all of them.
  for (const f of [...FILES, 'S/hub/new.txt']) {
    const r = body<{ sources: { device_id: string; path: string }[] }>(
      await c.request('sources', { hash: hashOf(f) }),
    );
    sources.push(...r.sources.filter((s) => s.device_id === aliceDevice).map((s) => s.path));
  }

  const browsed: string[] = [];
  const walk = async (path: string) => {
    const r = await c.request('browse', { device_id: aliceDevice, path });
    if (r.t !== 'browse.listing') return;
    browsed.push(...r.body.files.map((f) => f.path));
    for (const d of r.body.dirs) await walk(`${path}${d.name}/`);
  };
  await walk('');
  return { search, sources: sources.sort(), browse: browsed.sort() };
}

const expectSees = async (c: Client, aliceDevice: string, paths: readonly string[]) => {
  const want = [...paths].sort();
  expect(await seen(c, aliceDevice)).toEqual({ search: want, sources: want, browse: want });
};

const PUBLIC = ['S/hub/a.txt', 'S/hub/deep/b.txt'];

describe('access matrix (HANDOFF §6)', () => {
  it('applies every audience type to own devices, connections and strangers', async () => {
    const w = await world();
    await expectSees(w.own, w.alice.deviceId, FILES); // own device sees everything
    await expectSees(w.bob.c, w.alice.deviceId, [...PUBLIC, 'S/users/a.txt', 'S/groups/a.txt']);
    await expectSees(w.dave.c, w.alice.deviceId, PUBLIC); // connected but not granted
    await expectSees(w.carol.c, w.alice.deviceId, PUBLIC); // listed but not connected
    await expectSees(w.erin.c, w.alice.deviceId, PUBLIC);
  });

  it('hides everything but your own files when nothing is shared, including the device itself', async () => {
    const w = await world();
    await w.alice.c.request('acl.replace', { device_id: w.alice.deviceId, rules: [] });
    for (const c of [w.bob.c, w.erin.c]) {
      await expectSees(c, w.alice.deviceId, []);
      const r = await c.request('browse', { device_id: w.alice.deviceId, path: '' });
      expect(r).toMatchObject({ t: 'error', body: { code: 'not_found' } });
    }
    await expectSees(w.own, w.alice.deviceId, FILES);
  });

  it('revokes access granted through a connection the moment it is removed', async () => {
    const w = await world();
    expect((await w.bob.c.request('connection.remove', { user_id: w.alice.userId })).t).toBe('ok');
    await expectSees(w.bob.c, w.alice.deviceId, PUBLIC);
    // Reconnecting restores user-listed access, but not group membership (dropped on removal).
    await w.bob.c.request('connection.request', { user_id: w.alice.userId });
    await w.alice.c.request('connection.accept', { user_id: w.bob.userId });
    await expectSees(w.bob.c, w.alice.deviceId, [...PUBLIC, 'S/users/a.txt']);
    const groups = body<{ groups: { members: string[] }[] }>(
      await w.alice.c.request('group.list', {}),
    );
    expect(groups.groups[0]!.members).toEqual([]);
  });

  it('follows rule changes and new files immediately', async () => {
    const w = await world();
    // A new file under a shared folder inherits its rule.
    await w.alice.c.request('index.delta', {
      base_rev: 1,
      rev: 2,
      upsert: [entry('S/hub/new.txt')],
      remove: [],
    });
    await expectSees(w.erin.c, w.alice.deviceId, [...PUBLIC, 'S/hub/new.txt']);
    // Making the whole share private again via acl.set on the folder.
    await w.alice.c.request('acl.set', {
      device_id: w.alice.deviceId,
      path: 'S/hub/',
      audience: null,
    });
    await expectSees(w.erin.c, w.alice.deviceId, []);
    await w.alice.c.request('acl.set', {
      device_id: w.alice.deviceId,
      path: 'S/',
      audience: 'hub',
    });
    // S/ is public now, but explicit "me" rules (and their subtrees) stay private.
    await expectSees(w.erin.c, w.alice.deviceId, [
      'S/default.txt',
      'S/hub/a.txt',
      'S/hub/deep/b.txt',
      'S/hub/new.txt',
    ]);
  });

  it('hides a banned owner’s files from everyone else', async () => {
    const w = await world();
    t.db.ban(w.alice.userId);
    await expectSees(w.erin.c, w.alice.deviceId, []);
    await expectSees(w.bob.c, w.alice.deviceId, []);
  });
});

describe('access control: library', () => {
  type Listing = { devices: { device_id: string; user: { user_id: string }; online: boolean }[] };
  const devices = async (c: Client) =>
    body<Listing>(await c.request('library', {}))
      .devices.map((d) => d.device_id)
      .sort();

  it('lists own devices and devices holding something visible, nothing else', async () => {
    const w = await world();
    const laptop = (await w.own.request('library', {})).body as Listing;
    // Own devices, the empty one included, and with the user's summary.
    expect(laptop.devices.map((d) => d.device_id).sort()).toEqual(
      [w.alice.deviceId, ...t.db.listDevices(w.alice.userId).map((d) => d.id)]
        .filter((d, i, a) => a.indexOf(d) === i)
        .sort(),
    );
    expect(laptop.devices.every((d) => d.user.user_id === w.alice.userId)).toBe(true);
    // Everyone else sees alice's device (it shares with the hub), but not her empty laptop, and
    // not each other's devices: they share nothing.
    for (const p of [w.bob, w.dave, w.carol, w.erin])
      expect(await devices(p.c)).toEqual([p.deviceId, w.alice.deviceId].sort());
  });

  it('lists a stranger sharing with the hub, showing only the hub-public files, until connected', async () => {
    const w = await world();
    // erin isn't connected to alice: alice's device is in her library, under alice's name.
    const listing = body<Listing>(await w.erin.c.request('library', {}));
    expect(listing.devices.find((d) => d.device_id === w.alice.deviceId)?.user.user_id).toBe(
      w.alice.userId,
    );
    await expectSees(w.erin.c, w.alice.deviceId, PUBLIC);
    // A request from the Library changes nothing until alice accepts it.
    expect((await w.erin.c.request('connection.request', { user_id: w.alice.userId })).t).toBe(
      'ok',
    );
    await expectSees(w.erin.c, w.alice.deviceId, PUBLIC);
    // Accepted, she still sees only what alice granted her: nothing beyond the public files.
    expect((await w.alice.c.request('connection.accept', { user_id: w.erin.userId })).t).toBe('ok');
    await expectSees(w.erin.c, w.alice.deviceId, PUBLIC);
    // Without a hub rule, a stranger's computer isn't listed at all.
    await w.alice.c.request('acl.set', {
      device_id: w.alice.deviceId,
      path: 'S/hub/',
      audience: null,
    });
    expect(await devices(w.carol.c)).toEqual([w.carol.deviceId]);
  });

  it('drops a device once nothing on it is visible, and hides banned owners', async () => {
    const w = await world();
    // Only bob's list rule and group rule left: dave (connected, not granted) loses the device.
    await w.alice.c.request('acl.replace', {
      device_id: w.alice.deviceId,
      rules: [{ path: 'S/users/', audience: { users: [w.bob.userId] } }],
    });
    expect(await devices(w.dave.c)).toEqual([w.dave.deviceId]);
    expect(await devices(w.bob.c)).toEqual([w.bob.deviceId, w.alice.deviceId].sort());
    t.db.raw.prepare('UPDATE users SET banned_at = 1 WHERE id = ?').run(w.alice.userId);
    expect(await devices(w.bob.c)).toEqual([w.bob.deviceId]);
  });
});

describe('access control: acl.set / acl.replace', () => {
  it('only lets a device set rules for itself, with groups it owns', async () => {
    const w = await world();
    const otherDevice = await w.bob.c.request('acl.set', {
      device_id: w.alice.deviceId,
      path: 'S/',
      audience: 'hub',
    });
    expect(otherDevice).toMatchObject({ t: 'error', body: { code: 'forbidden' } });
    // Even alice's own other device can't set rules for the device holding the files (M3).
    const sibling = await w.own.request('acl.set', {
      device_id: w.alice.deviceId,
      path: 'S/',
      audience: 'hub',
    });
    expect(sibling).toMatchObject({ t: 'error', body: { code: 'forbidden' } });
    const bobGroup = body<{ groups: { group_id: string }[] }>(
      await w.bob.c.request('group.upsert', { name: 'Mine', members: [w.alice.userId] }),
    ).groups[0]!.group_id;
    const foreign = await w.alice.c.request('acl.set', {
      device_id: w.alice.deviceId,
      path: 'S/',
      audience: { groups: [bobGroup] },
    });
    expect(foreign).toMatchObject({ t: 'error', body: { code: 'bad_request' } });
    await expectSees(w.erin.c, w.alice.deviceId, PUBLIC);
  });
});

describe('connections', () => {
  it('runs request → accept → remove with notifications to the other side', async () => {
    const alice = await signUp(t.url, 'alice');
    const bob = await signUp(t.url, 'bob');
    expect((await alice.c.request('connection.request', { user_id: bob.userId })).t).toBe('ok');
    expect((await bob.c.next('connection.request')).body).toMatchObject({
      user: { user_id: alice.userId, display_name: 'alice' },
    });

    const listA = body<{ connections: { state: string }[] }>(
      await alice.c.request('connection.list', {}),
    );
    const listB = body<{ connections: { state: string }[] }>(
      await bob.c.request('connection.list', {}),
    );
    expect(listA.connections.map((c) => c.state)).toEqual(['pending_out']);
    expect(listB.connections.map((c) => c.state)).toEqual(['pending_in']);

    // Only the recipient can accept.
    expect(
      (await alice.c.request('connection.accept', { user_id: bob.userId })).body,
    ).toMatchObject({ code: 'not_found' });
    expect((await bob.c.request('connection.accept', { user_id: alice.userId })).t).toBe('ok');
    expect((await alice.c.next('connection.accept')).body).toMatchObject({
      user: { user_id: bob.userId },
    });
    // Now connected, each is told the other is online.
    expect((await alice.c.next('presence')).body).toMatchObject({
      device_id: bob.deviceId,
      online: true,
    });

    expect((await bob.c.request('connection.remove', { user_id: alice.userId })).t).toBe('ok');
    expect((await alice.c.next('connection.remove')).body).toEqual({ user_id: bob.userId });
    expect(
      (await alice.c.next((m) => m.t === 'presence' && m.body.online === false)).body,
    ).toMatchObject({
      device_id: bob.deviceId,
    });
    expect(
      body<{ connections: unknown[] }>(await alice.c.request('connection.list', {})).connections,
    ).toEqual([]);
  });

  it('says whether accepted connections are online, and nothing about pending ones', async () => {
    // A short silence window, so Bob counts as offline soon after he leaves.
    const h = await startTestHub({ silenceMs: 300 });
    const alice = await signUp(h.url, 'alice');
    alice.c.keepAlive();
    const bob = await signUp(h.url, 'bob');
    const carol = await signUp(h.url, 'carol');
    carol.c.keepAlive();
    h.db.putConnection(alice.userId, bob.userId, 'accepted', alice.userId);
    await carol.c.request('connection.request', { user_id: alice.userId });
    type Listing = {
      connections: { user: { user_id: string }; online?: boolean; seen?: string }[];
    };
    const list = async () =>
      new Map(
        body<Listing>(await alice.c.request('connection.list', {})).connections.map((c) => [
          c.user.user_id,
          c,
        ]),
      );
    let l = await list();
    expect(l.get(bob.userId)).toMatchObject({ online: true, seen: 'now' });
    // A pending request reveals nothing about presence, either way.
    expect(l.get(carol.userId)).not.toHaveProperty('online');
    expect(l.get(carol.userId)).not.toHaveProperty('seen');
    expect(
      body<Listing>(await carol.c.request('connection.list', {})).connections[0],
    ).not.toHaveProperty('online');

    // Bob goes away: offline once his grace period ends, seen within the day.
    bob.c.close();
    for (let i = 0; i < 100 && (l = await list()).get(bob.userId)?.online; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(l.get(bob.userId)).toMatchObject({ online: false, seen: 'today' });
    await h.close();
  });

  it('treats crossing requests as acceptance', async () => {
    const alice = await signUp(t.url, 'alice');
    const bob = await signUp(t.url, 'bob');
    await alice.c.request('connection.request', { user_id: bob.userId });
    await bob.c.request('connection.request', { user_id: alice.userId });
    expect(t.db.connection(alice.userId, bob.userId)?.state).toBe('accepted');
  });

  it('cannot reach yourself, unknown, pending or banned users', async () => {
    const alice = await signUp(t.url, 'alice');
    const banned = await signUp(t.url, 'mallory');
    t.db.ban(banned.userId);
    t.db.setSetting('join_mode', 'approval');
    const pendingKey = generateKeyPair();
    t.db.createAccount(
      {
        id: 'u_' + 'p'.repeat(26),
        display_name: 'pending',
        root_pubkey: toB64(pendingKey.publicKey),
        status: 'pending',
      },
      {
        id: 'd_' + 'p'.repeat(26),
        user_id: 'u_' + 'p'.repeat(26),
        pubkey: toB64(pendingKey.publicKey),
        chain: [],
        name: 'x',
        platform: 'linux',
      },
    );
    for (const id of [alice.userId, 'u_' + 'z'.repeat(26), 'u_' + 'p'.repeat(26), banned.userId]) {
      expect((await alice.c.request('connection.request', { user_id: id })).body).toMatchObject({
        code: 'not_found',
      });
    }
  });
});

describe('user search', () => {
  it('finds active users by name or word prefix, never yourself, banned or pending users', async () => {
    const alice = await signUp(t.url, 'alice');
    await signUp(t.url, 'Bob Smith');
    await signUp(t.url, 'bobby');
    const banned = await signUp(t.url, 'bob banned');
    t.db.ban(banned.userId);
    await signUp(t.url, '100%_real');
    const names = async (q: string) =>
      body<{ users: { display_name: string }[] }>(
        await alice.c.request('user.search', { q, limit: 20 }),
      ).users.map((u) => u.display_name);
    expect(await names('bob')).toEqual(['Bob Smith', 'bobby']);
    expect(await names('smi')).toEqual(['Bob Smith']);
    expect(await names('alice')).toEqual([]);
    // LIKE wildcards in the query are literal.
    expect(await names('%')).toEqual([]);
    expect(await names('100%_')).toEqual(['100%_real']);
  });
});

describe('groups', () => {
  it('are private to their owner and built only from connections', async () => {
    const alice = await signUp(t.url, 'alice');
    const bob = await signUp(t.url, 'bob');
    const stranger = await signUp(t.url, 'stranger');
    expect(
      (await alice.c.request('group.upsert', { name: 'X', members: [stranger.userId] })).body,
    ).toMatchObject({
      code: 'bad_request',
    });
    await alice.c.request('connection.request', { user_id: bob.userId });
    await bob.c.request('connection.accept', { user_id: alice.userId });
    const g = body<{ groups: { group_id: string; members: string[] }[] }>(
      await alice.c.request('group.upsert', { name: 'Family', members: [bob.userId] }),
    ).groups[0]!;
    expect(g.members).toEqual([bob.userId]);
    // Members can't see, edit or delete it.
    expect(body<{ groups: unknown[] }>(await bob.c.request('group.list', {})).groups).toEqual([]);
    expect(
      (await bob.c.request('group.upsert', { group_id: g.group_id, name: 'Mine', members: [] }))
        .body,
    ).toMatchObject({
      code: 'not_found',
    });
    expect((await bob.c.request('group.delete', { group_id: g.group_id })).body).toMatchObject({
      code: 'not_found',
    });
    // Owner renames and deletes.
    await alice.c.request('group.upsert', {
      group_id: g.group_id,
      name: 'Fam',
      members: [bob.userId],
    });
    expect(
      body<{ groups: { name: string }[] }>(await alice.c.request('group.list', {})).groups[0]!.name,
    ).toBe('Fam');
    expect((await alice.c.request('group.delete', { group_id: g.group_id })).t).toBe('ok');
  });
});

describe('presence follows visibility', () => {
  it('shows a hub-wide sharer to everyone, and withdraws it when they stop', async () => {
    const alice = await signUp(t.url, 'alice');
    const erin = await signUp(t.url, 'erin');
    await alice.c.request('index.snapshot', {
      rev: 1,
      page: 0,
      last: true,
      entries: [entry('S/a.txt')],
    });
    await alice.c.request('acl.set', { device_id: alice.deviceId, path: 'S/', audience: 'hub' });
    expect((await erin.c.next('presence')).body).toMatchObject({
      device_id: alice.deviceId,
      online: true,
    });
    await alice.c.request('acl.set', { device_id: alice.deviceId, path: 'S/', audience: null });
    expect((await erin.c.next('presence')).body).toMatchObject({
      device_id: alice.deviceId,
      online: false,
    });
  });
});
