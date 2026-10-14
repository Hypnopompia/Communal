/**
 * Abuse limits (ADR 0022): per-address sign-ups and connections, the per-session message
 * budget, the probe responder, and the caps on files, devices, rules, groups, subscriptions,
 * connection requests and brokered connections.
 */
import { createSocket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPair, issueDeviceCert, toB64, type KeyPair } from '@communal/crypto';
import { addressKey, TokenBucket, WindowCounter } from './limits.js';
import { RawClient, signChallenge, signUp, sleep, startTestHub, type TestHub } from './testing.js';

const client = { name: 'test', version: '0' };
let t: TestHub | undefined;

async function hub(opts: Parameters<typeof startTestHub>[0] = {}) {
  t = await startTestHub({ silenceMs: 30_000, ...opts });
  return t;
}
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const h = (n: number) => n.toString(16).padStart(64, '0');
const entry = (path: string, n = 1) => ({
  path,
  size: 10,
  mtime: 1,
  mime: 'text/plain',
  kind: 'text' as const,
  meta: {},
  thumb: false,
  hash: h(n),
});

/** Sends `account.create` for `key` on a fresh connection, optionally joining `root`'s account. */
async function create(url: string, key: KeyPair, name: string, root?: KeyPair, userId?: string) {
  const c = await RawClient.connect(url);
  const sig = signChallenge(await c.next('challenge'), key);
  const join =
    root && userId
      ? {
          root_pubkey: toB64(root.publicKey),
          chain: [issueDeviceCert(root, userId, key.publicKey)],
        }
      : {};
  const reply = await c.request('account.create', {
    display_name: name,
    device_name: `${name}-laptop`,
    device_pubkey: toB64(key.publicKey),
    platform: 'linux',
    client,
    sig,
    ...join,
  });
  c.close();
  return reply;
}

describe('limit helpers', () => {
  it('counts IPv4 addresses one by one and IPv6 by /64', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('2001:0db8:0000:0001:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:0:1::/64');
    expect(addressKey('2001:db8:0:1::9')).toBe(addressKey('2001:db8:0:1:ffff::1'));
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
  });

  it('refills a token bucket over time and never above its size', () => {
    let now = 0;
    const b = new TokenBucket(10, 5, () => now);
    for (let i = 0; i < 5; i++) expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    expect(b.waitFor()).toBe(100);
    now = 100;
    expect(b.take()).toBe(true);
    now = 60_000;
    for (let i = 0; i < 5; i++) expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    // A cost above the bucket size needs a full bucket, not forever.
    now = 120_000;
    expect(b.take(50)).toBe(true);
  });

  it('counts events in a sliding window', () => {
    let now = 0;
    const w = new WindowCounter(1000, () => now);
    w.add('a');
    now = 500;
    w.add('a');
    expect(w.count('a')).toBe(2);
    now = 1000;
    expect(w.count('a')).toBe(1);
    now = 1500;
    expect(w.count('a')).toBe(0);
    expect(w.count('b')).toBe(0);
  });
});

describe('sign-ups per address', () => {
  it('refuses new accounts and devices past the hourly limit, and counts only successes', async () => {
    const t = await hub();
    t.db.setSetting('signups_per_hour', '2');
    const rootKey = generateKeyPair();
    const first = await create(t.url, rootKey, 'alice');
    expect(first.t).toBe('account.created');
    const uid = (first.body as { user_id: string }).user_id;
    // A bad signature doesn't use up the allowance.
    const c = await RawClient.connect(t.url);
    await c.next('challenge');
    const bad = await c.request('account.create', {
      display_name: 'x',
      device_name: 'x',
      device_pubkey: toB64(generateKeyPair().publicKey),
      platform: 'linux',
      client,
      sig: 'A'.repeat(86),
    });
    expect(bad.body).toMatchObject({ code: 'forbidden' });
    c.close();
    // Joining the same account from another device counts too.
    expect((await create(t.url, generateKeyPair(), 'alice', rootKey, uid)).t).toBe(
      'account.created',
    );
    const third = await create(t.url, generateKeyPair(), 'mallory');
    expect(third.body).toMatchObject({ code: 'rate_limited' });
    expect(t.db.listUsers()).toHaveLength(1);
    // 0 turns the limit off.
    t.db.setSetting('signups_per_hour', '0');
    expect((await create(t.url, generateKeyPair(), 'bob')).t).toBe('account.created');
  });
});

describe('connections per address', () => {
  it('closes connections past the limit before saying anything', async () => {
    const t = await hub({ limits: { connectionsPerAddress: 2 } });
    const a = await RawClient.connect(t.url);
    const b = await RawClient.connect(t.url);
    await a.next('challenge');
    await b.next('challenge');
    const c = await RawClient.connect(t.url);
    expect(await c.closed).toMatchObject({ code: 4029 });
    expect(c.backlog()).toEqual([]);
    // A slot frees up when a connection ends.
    a.close();
    await a.closed;
    await sleep(50);
    const d = await RawClient.connect(t.url);
    expect((await d.next('challenge')).t).toBe('challenge');
    b.close();
    d.close();
  });
});

describe('message budget', () => {
  it('slows a session that runs out instead of refusing its messages', async () => {
    const t = await hub({ limits: { messageRate: 20, messageBurst: 5 } });
    const a = await signUp(t.url, 'alice');
    // Signing up spent two messages' worth; let the bucket fill again.
    await sleep(300);
    const start = Date.now();
    const ids = Array.from({ length: 15 }, () => a.c.send('group.list', {}));
    const replies = await Promise.all(ids.map((id) => a.c.next((m) => m.re === id, 5_000)));
    expect(replies.every((r) => r.t === 'group.listing')).toBe(true);
    // 5 at once, then 10 more at 20 a second.
    expect(Date.now() - start).toBeGreaterThanOrEqual(400);
    // Replies keep their order.
    expect(replies.map((r) => r.re)).toEqual(ids);
  });

  it('answers pings at once even while the session waits', async () => {
    const t = await hub({ limits: { messageRate: 2, messageBurst: 1 } });
    const a = await signUp(t.url, 'alice');
    for (let i = 0; i < 4; i++) a.c.send('group.list', {});
    const start = Date.now();
    expect((await a.c.request('ping', {})).t).toBe('pong');
    expect(Date.now() - start).toBeLessThan(300);
  });

  it('closes a session that keeps sending while it waits', async () => {
    const t = await hub({ limits: { messageRate: 1, messageBurst: 1, queueMessages: 5 } });
    const a = await signUp(t.url, 'alice');
    for (let i = 0; i < 10; i++) a.c.send('group.list', {});
    expect(await a.c.closed).toMatchObject({ code: 4029 });
  });
});

describe('auth timeout', () => {
  it('counts from the connection, so pinging without signing in buys no time', async () => {
    const t = await hub({ authTimeoutMs: 300 });
    const c = await RawClient.connect(t.url);
    await c.next('challenge');
    c.keepAlive(50);
    expect(await c.closed).toMatchObject({ code: 4001 });
  });
});

describe('NAT probe responder', () => {
  it('answers only client probes, a few a second per address', async () => {
    const t = await hub({ probePorts: [0, 0], limits: { probeRate: 2 } });
    const port = t.hub.probePorts[0];
    const sock = createSocket('udp4');
    const replies: string[] = [];
    sock.on('message', (m) => replies.push(m.toString()));
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
    sock.send('hello', port, '127.0.0.1');
    await sleep(100);
    expect(replies).toEqual([]);
    for (let i = 0; i < 5; i++) sock.send('communal-probe', port, '127.0.0.1');
    await sleep(200);
    expect(replies).toHaveLength(2);
    expect(JSON.parse(replies[0]!)).toMatchObject({ addr: '127.0.0.1' });
    sock.close();
  });
});

describe('files per device', () => {
  it('refuses a snapshot or delta that would take a device past the limit', async () => {
    const t = await hub();
    t.db.setSetting('max_files_per_device', '3');
    const a = await signUp(t.url, 'alice');
    const four = ['S/a', 'S/b', 'S/c', 'S/d'].map((p, i) => entry(p, i));
    // Over the limit on the second page: nothing is kept.
    expect(
      (
        await a.c.request('index.snapshot', {
          rev: 1,
          page: 0,
          last: false,
          entries: four.slice(0, 2),
        })
      ).t,
    ).toBe('ok');
    const over = await a.c.request('index.snapshot', {
      rev: 1,
      page: 1,
      last: true,
      entries: four.slice(2),
    });
    expect(over.body).toMatchObject({ code: 'forbidden' });
    expect(t.db.stagedCount(a.deviceId)).toBe(0);
    expect(t.db.entryCount(a.deviceId)).toBe(0);

    const ok = await a.c.request('index.snapshot', {
      rev: 1,
      page: 0,
      last: true,
      entries: four.slice(0, 3),
    });
    expect(ok.t).toBe('index.ack');
    // A new file is refused; changing a file, or swapping one for another, is fine.
    const add = await a.c.request('index.delta', {
      base_rev: 1,
      rev: 2,
      upsert: [entry('S/d')],
      remove: [],
    });
    expect(add.body).toMatchObject({ code: 'forbidden' });
    expect(
      (
        await a.c.request('index.delta', {
          base_rev: 1,
          rev: 2,
          upsert: [entry('S/a', 9)],
          remove: [],
        })
      ).t,
    ).toBe('index.ack');
    expect(
      (
        await a.c.request('index.delta', {
          base_rev: 2,
          rev: 3,
          upsert: [entry('S/d')],
          remove: ['S/b'],
        })
      ).t,
    ).toBe('index.ack');
    expect(t.db.entryCount(a.deviceId)).toBe(3);
  });
});

describe('devices per account', () => {
  it('refuses another device once the account has the most allowed', async () => {
    const t = await hub();
    t.db.setSetting('max_devices_per_account', '2');
    const a = await signUp(t.url, 'alice');
    expect((await create(t.url, generateKeyPair(), 'alice', a.key, a.userId)).t).toBe(
      'account.created',
    );
    const third = await create(t.url, generateKeyPair(), 'alice', a.key, a.userId);
    expect(third.body).toMatchObject({ code: 'forbidden' });
    expect(t.db.devicesOf(a.userId)).toHaveLength(2);
    // Linking is refused the same way, when the existing device approves.
    a.c.keepAlive();
    const code = (await a.c.request('link.code.create', {})).body as { code: string };
    const key = generateKeyPair();
    const claimer = await RawClient.connect(t.url);
    const sig = signChallenge(await claimer.next('challenge'), key);
    expect(
      (
        await claimer.request('link.claim', {
          code: code.code,
          device_name: 'nas',
          device_pubkey: toB64(key.publicKey),
          platform: 'linux',
          sig,
        })
      ).t,
    ).toBe('ok');
    const req = (await a.c.next('link.request')).body as { request_id: string };
    const approve = await a.c.request('link.approve', {
      request_id: req.request_id,
      cert: issueDeviceCert(a.key, a.userId, key.publicKey),
    });
    expect(approve.body).toMatchObject({ code: 'forbidden' });
    claimer.close();
  });

  it('adds no devices to a banned account', async () => {
    const t = await hub();
    const a = await signUp(t.url, 'alice');
    await signUp(t.url, 'bob');
    t.db.ban(a.userId);
    const reply = await create(t.url, generateKeyPair(), 'alice', a.key, a.userId);
    expect(reply.body).toMatchObject({ code: 'banned' });
    expect(t.db.devicesOf(a.userId)).toHaveLength(1);
  });
});

describe('connection requests', () => {
  it('tells the other person once, however often someone asks', async () => {
    const t = await hub();
    const a = await signUp(t.url, 'alice');
    const b = await signUp(t.url, 'bob');
    expect((await a.c.request('connection.request', { user_id: b.userId })).t).toBe('ok');
    expect((await a.c.request('connection.request', { user_id: b.userId })).t).toBe('ok');
    await b.c.next('connection.request');
    await sleep(100);
    expect(b.c.backlog().filter((m) => m.t === 'connection.request')).toHaveLength(0);
  });

  it('limits how many requests may wait for an answer', async () => {
    const t = await hub({ limits: { pendingRequestsPerUser: 1 } });
    const a = await signUp(t.url, 'alice');
    const b = await signUp(t.url, 'bob');
    const c = await signUp(t.url, 'carol');
    expect((await a.c.request('connection.request', { user_id: b.userId })).t).toBe('ok');
    const second = await a.c.request('connection.request', { user_id: c.userId });
    expect(second.body).toMatchObject({ code: 'rate_limited' });
    // Accepting someone else's request is always allowed.
    expect((await c.c.request('connection.request', { user_id: a.userId })).t).toBe('ok');
    expect((await a.c.request('connection.accept', { user_id: c.userId })).t).toBe('ok');
  });
});

describe('groups, rules, subscriptions and brokered connections', () => {
  it('caps groups per account', async () => {
    const t = await hub({ limits: { groupsPerUser: 1 } });
    const a = await signUp(t.url, 'alice');
    const g = await a.c.request('group.upsert', { name: 'one', members: [] });
    expect(g.t).toBe('group.listing');
    const id = (g.body as { groups: { group_id: string }[] }).groups[0]!.group_id;
    expect((await a.c.request('group.upsert', { name: 'two', members: [] })).body).toMatchObject({
      code: 'rate_limited',
    });
    // Renaming the one it has is fine.
    expect((await a.c.request('group.upsert', { group_id: id, name: 'uno', members: [] })).t).toBe(
      'group.listing',
    );
  });

  it('caps rules per device', async () => {
    const t = await hub({ limits: { rulesPerDevice: 1 } });
    const a = await signUp(t.url, 'alice');
    const set = (path: string, audience: 'hub' | 'me' | null) =>
      a.c.request('acl.set', { device_id: a.deviceId, path, audience });
    expect((await set('A/', 'hub')).t).toBe('ok');
    expect((await set('B/', 'hub')).body).toMatchObject({ code: 'rate_limited' });
    expect((await set('A/', 'me')).t).toBe('ok');
    expect((await set('A/', null)).t).toBe('ok');
    expect((await set('B/', 'hub')).t).toBe('ok');
    const many = await a.c.request('acl.replace', {
      device_id: a.deviceId,
      rules: [
        { path: 'A/', audience: 'hub' },
        { path: 'B/', audience: 'hub' },
      ],
    });
    expect(many.body).toMatchObject({ code: 'rate_limited' });
  });

  it('caps stored subscriptions per watching device', async () => {
    const t = await hub({ limits: { watchesPerDevice: 1 } });
    const a = await signUp(t.url, 'alice');
    const b = await signUp(t.url, 'bob');
    await a.c.request('index.snapshot', {
      rev: 1,
      page: 0,
      last: true,
      entries: [entry('A/x'), entry('B/y', 2)],
    });
    await a.c.request('acl.set', { device_id: a.deviceId, path: 'A/', audience: 'hub' });
    await a.c.request('acl.set', { device_id: a.deviceId, path: 'B/', audience: 'hub' });
    const watch = (path: string) =>
      b.c.request('watch', {
        device_id: a.deviceId,
        path,
        recursive: true,
        mirror_deletes: false,
        since_rev: 0,
      });
    expect((await watch('A/')).t).toBe('ok');
    expect((await watch('B/')).body).toMatchObject({ code: 'rate_limited' });
    // Watching the same folder again (as after every sign-in) is fine.
    expect((await watch('A/')).t).toBe('ok');
  });

  it('caps brokered connections waiting per session', async () => {
    const t = await hub({ limits: { brokeredPerSession: 1 } });
    const a = await signUp(t.url, 'alice');
    const b = await signUp(t.url, 'bob');
    await a.c.request('index.snapshot', { rev: 1, page: 0, last: true, entries: [entry('S/f')] });
    await a.c.request('acl.set', { device_id: a.deviceId, path: 'S/', audience: 'hub' });
    const req = (n: number) =>
      b.c.request('connect.request', {
        target: a.deviceId,
        hash: h(1),
        session_id: `x_01J9Z3QX7M8N4P5R6S7T8V9W${String(n).padStart(2, '0')}`,
        stream_id: 7,
        candidates: [{ kind: 'lan', host: '127.0.0.1', port: 40000 }],
      });
    expect((await req(1)).t).toBe('ok');
    expect((await req(2)).body).toMatchObject({ code: 'rate_limited' });
  });
});

describe('names', () => {
  it('refuses names with control or direction characters', async () => {
    const t = await hub();
    const reply = await create(t.url, generateKeyPair(), 'Bob‮exe.jpg');
    expect(reply.body).toMatchObject({ code: 'bad_request' });
    // Emoji sequences (with zero-width joiners) are fine.
    expect((await create(t.url, generateKeyPair(), 'Ana 👩‍👩‍👧')).t).toBe('account.created');
  });
});
