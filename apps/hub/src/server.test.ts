import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deviceId,
  fingerprint,
  generateKeyPair,
  issueDeviceCert,
  toB64,
  userId,
} from '@communal/crypto';
import {
  RawClient,
  signChallenge,
  signIn,
  signUp,
  sleep,
  startTestHub,
  type TestHub,
} from './testing.js';

const client = { name: 'test', version: '0' };
let t: TestHub;

beforeEach(async () => {
  t = await startTestHub();
});
afterEach(async () => {
  await t.close();
});

describe('session', () => {
  it('opens with a challenge carrying the hub key', async () => {
    const c = await RawClient.connect(t.url);
    const ch = await c.next('challenge');
    expect(ch.body).toMatchObject({ hub_id: 'test-hub', hub_pubkey: toB64(t.hubKey.publicKey) });
    c.close();
  });

  it('answers ping before and after sign-in', async () => {
    const c = await RawClient.connect(t.url);
    expect((await c.request('ping', {})).t).toBe('pong');
    c.close();
  });

  it('rejects malformed frames without dropping the session', async () => {
    const c = await RawClient.connect(t.url);
    c.ws.send('{nope');
    expect((await c.next('error')).body).toMatchObject({ code: 'bad_request' });
    expect((await c.request('ping', {})).t).toBe('pong');
    c.close();
  });

  it('closes sessions that never authenticate', async () => {
    await t.close();
    t = await startTestHub({ authTimeoutMs: 200, silenceMs: 5_000 });
    const c = await RawClient.connect(t.url);
    expect((await c.closed).code).toBe(4001);
  });

  it('drops a signed-in session after the silence window', async () => {
    await t.close();
    t = await startTestHub({ silenceMs: 300 });
    const { c } = await signUp(t.url, 'alice');
    const started = Date.now();
    await c.closed;
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });
});

describe('access control: pre-auth', () => {
  it.each([
    ['search', { q: 'x', limit: 10 }],
    ['connection.list', {}],
    ['link.code.create', {}],
    ['user.search', { q: 'bob', limit: 5 }],
  ] as const)('refuses %s before sign-in', async (type, body) => {
    const c = await RawClient.connect(t.url);
    const reply = await c.request(type, body as never);
    expect(reply).toMatchObject({ t: 'error', body: { code: 'unauthenticated' } });
    c.close();
  });
});

describe('access control: account.create', () => {
  it('creates an active account whose id derives from the device key', async () => {
    const key = generateKeyPair();
    const c = await RawClient.connect(t.url);
    const sig = signChallenge(await c.next('challenge'), key);
    const reply = await c.request('account.create', {
      display_name: 'alice',
      device_name: 'laptop',
      device_pubkey: toB64(key.publicKey),
      platform: 'darwin',
      client,
      sig,
    });
    expect(reply).toMatchObject({
      t: 'account.created',
      body: {
        user_id: userId(key.publicKey),
        device_id: deviceId(key.publicKey),
        fingerprint: fingerprint(key.publicKey),
        status: 'active',
      },
    });
    expect(t.db.getUser(userId(key.publicKey))?.root_pubkey).toBe(toB64(key.publicKey));
    c.close();
  });

  it('rejects a key the client cannot sign with', async () => {
    const victim = generateKeyPair();
    const attacker = generateKeyPair();
    const c = await RawClient.connect(t.url);
    const sig = signChallenge(await c.next('challenge'), attacker);
    const reply = await c.request('account.create', {
      display_name: 'mallory',
      device_name: 'x',
      device_pubkey: toB64(victim.publicKey),
      platform: 'linux',
      client,
      sig,
    });
    expect(reply).toMatchObject({ t: 'error', body: { code: 'forbidden' } });
    expect(t.db.listUsers()).toHaveLength(0);
    c.close();
  });

  it('rejects a signature over another session’s challenge', async () => {
    const key = generateKeyPair();
    const a = await RawClient.connect(t.url);
    const b = await RawClient.connect(t.url);
    const sigForA = signChallenge(await a.next('challenge'), key);
    await b.next('challenge');
    const reply = await b.request('account.create', {
      display_name: 'replay',
      device_name: 'x',
      device_pubkey: toB64(key.publicKey),
      platform: 'linux',
      client,
      sig: sigForA,
    });
    expect(reply).toMatchObject({ t: 'error', body: { code: 'forbidden' } });
    a.close();
    b.close();
  });

  it('refuses to register the same device twice', async () => {
    const { c, key } = await signUp(t.url, 'alice');
    c.close();
    const c2 = await RawClient.connect(t.url);
    const sig = signChallenge(await c2.next('challenge'), key);
    const reply = await c2.request('account.create', {
      display_name: 'alice again',
      device_name: 'x',
      device_pubkey: toB64(key.publicKey),
      platform: 'linux',
      client,
      sig,
    });
    expect(reply).toMatchObject({ t: 'error', body: { code: 'conflict' } });
    c2.close();
  });

  it('creates pending accounts in approval mode', async () => {
    t.db.setSetting('join_mode', 'approval');
    const key = generateKeyPair();
    const c = await RawClient.connect(t.url);
    const sig = signChallenge(await c.next('challenge'), key);
    const created = await c.request('account.create', {
      display_name: 'dave',
      device_name: 'x',
      device_pubkey: toB64(key.publicKey),
      platform: 'linux',
      client,
      sig,
    });
    expect(created.body).toMatchObject({ status: 'pending_approval' });
    expect(t.db.getUser(userId(key.publicKey))?.status).toBe('pending');
    c.close();
  });
});

describe('access control: auth', () => {
  it('rejects unknown devices, wrong keys, revoked devices and pending users alike', async () => {
    const alice = await signUp(t.url, 'alice');
    alice.c.close();

    const unknown = generateKeyPair();
    expect((await signIn(t.url, unknown, deviceId(unknown.publicKey))).reply.body).toMatchObject({
      code: 'forbidden',
    });

    const wrongKey = await signIn(t.url, generateKeyPair(), alice.deviceId);
    expect(wrongKey.reply.body).toMatchObject({ code: 'forbidden' });

    const ok = await signIn(t.url, alice.key, alice.deviceId);
    expect(ok.reply.t).toBe('welcome');
    expect(ok.reply.body).toMatchObject({
      user_id: alice.userId,
      device_id: alice.deviceId,
      index_rev: 0,
    });
    expect((ok.reply.body as { observed_addr: string }).observed_addr).toMatch(
      /^127\.0\.0\.1:\d+$/,
    );
    ok.c.close();

    t.db.raw.prepare('UPDATE devices SET revoked_at = 1 WHERE id = ?').run(alice.deviceId);
    expect((await signIn(t.url, alice.key, alice.deviceId)).reply.body).toMatchObject({
      code: 'forbidden',
    });

    t.db.setSetting('join_mode', 'approval');
    const bobKey = generateKeyPair();
    const c = await RawClient.connect(t.url);
    const sig = signChallenge(await c.next('challenge'), bobKey);
    await c.request('account.create', {
      display_name: 'bob',
      device_name: 'x',
      device_pubkey: toB64(bobKey.publicKey),
      platform: 'linux',
      client,
      sig,
    });
    const pending = await c.request('auth', { device_id: deviceId(bobKey.publicKey), sig, client });
    expect(pending.body).toMatchObject({ code: 'pending_approval' });
    c.close();

    t.db.setUserStatus(userId(bobKey.publicKey), 'active');
    expect((await signIn(t.url, bobKey, deviceId(bobKey.publicKey))).reply.t).toBe('welcome');
  });

  it('refuses a second auth on a signed-in session', async () => {
    const alice = await signUp(t.url, 'alice');
    const again = await alice.c.request('auth', {
      device_id: alice.deviceId,
      sig: 'B'.repeat(86),
      client,
    });
    expect(again.body).toMatchObject({ code: 'conflict' });
    alice.c.close();
  });

  it('replaces an older session of the same device without a presence flap', async () => {
    const alice = await signUp(t.url, 'alice');
    const bob = await signUp(t.url, 'bob');
    t.db.putConnection(alice.userId, bob.userId, 'accepted');
    const first = await signIn(t.url, alice.key, alice.deviceId);
    expect((await alice.c.closed).code).toBe(4000);
    await sleep(100);
    // The device never went offline, so bob (connected) hears nothing.
    expect(
      bob.c.backlog().filter((m) => m.t === 'presence' && m.body.device_id === alice.deviceId),
    ).toHaveLength(0);
    first.c.close();
    bob.c.close();
  });
});

describe('access control: presence', () => {
  it('only reaches own devices and accepted connections', async () => {
    const alice = await signUp(t.url, 'alice');
    const bob = await signUp(t.url, 'bob');
    const carol = await signUp(t.url, 'carol');
    t.db.putConnection(alice.userId, bob.userId, 'accepted');
    t.db.putConnection(alice.userId, carol.userId, 'pending');

    alice.c.close();
    const fresh = await signIn(t.url, alice.key, alice.deviceId);
    // The waits below exceed the 2 s silence window; keep alice's session alive.
    fresh.c.keepAlive();
    // A reconnect inside the grace window is not news to anyone.
    await sleep(150);
    expect(bob.c.backlog().some((m) => m.t === 'presence')).toBe(false);

    // On sign-in alice gets a snapshot of visible devices: bob, not carol.
    expect((await fresh.c.next('presence')).body).toEqual({
      device_id: bob.deviceId,
      user_id: bob.userId,
      online: true,
    });
    expect(fresh.c.backlog().some((m) => m.t === 'presence')).toBe(false);

    // A brand-new device of a connected user is announced to alice; carol learns nothing.
    const dave = await signUp(t.url, 'dave');
    t.db.putConnection(alice.userId, dave.userId, 'accepted');
    dave.c.close();
    await sleep(2_100); // dave's grace period runs out
    expect((await fresh.c.next('presence')).body).toEqual({
      device_id: dave.deviceId,
      user_id: dave.userId,
      online: false,
    });
    const daveBack = await signIn(t.url, dave.key, dave.deviceId);
    expect((await fresh.c.next('presence')).body).toEqual({
      device_id: dave.deviceId,
      user_id: dave.userId,
      online: true,
    });
    expect(carol.c.backlog().some((m) => m.t === 'presence')).toBe(false);
    expect(bob.c.backlog().some((m) => m.t === 'presence')).toBe(false);

    for (const c of [fresh.c, bob.c, carol.c, daveBack.c]) c.close();
  });
});

describe('access control: bans', () => {
  it('refuses sign-in for a banned account, but only after the key is proven', async () => {
    const alice = await signUp(t.url, 'alice');
    alice.c.close();
    t.db.ban(alice.userId, 'spam');

    // A stranger guessing the device id learns nothing about the ban.
    expect((await signIn(t.url, generateKeyPair(), alice.deviceId)).reply.body).toMatchObject({
      code: 'forbidden',
    });
    expect((await signIn(t.url, alice.key, alice.deviceId)).reply.body).toMatchObject({
      code: 'banned',
    });

    t.db.unban(alice.userId);
    expect((await signIn(t.url, alice.key, alice.deviceId)).reply.t).toBe('welcome');
  });

  it('disconnects live sessions and publishes offline at once, without the grace period', async () => {
    await t.close();
    t = await startTestHub({ silenceMs: 10_000, banPollMs: 100 });
    const alice = await signUp(t.url, 'alice');
    const bob = await signUp(t.url, 'bob');
    t.db.putConnection(alice.userId, bob.userId, 'accepted');

    const started = Date.now();
    t.db.ban(bob.userId);
    expect((await bob.c.closed).code).toBe(4003);
    expect((await alice.c.next('presence')).body).toEqual({
      device_id: bob.deviceId,
      user_id: bob.userId,
      online: false,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    alice.c.close();
  });

  it('cuts short the grace period of a banned device that already disconnected', async () => {
    await t.close();
    t = await startTestHub({ silenceMs: 10_000, banPollMs: 100 });
    const alice = await signUp(t.url, 'alice');
    const bob = await signUp(t.url, 'bob');
    t.db.putConnection(alice.userId, bob.userId, 'accepted');
    bob.c.close();
    await sleep(100);
    t.db.ban(bob.userId);
    expect((await alice.c.next('presence', 1_000)).body).toMatchObject({ online: false });
    expect(t.hub.isOnline(bob.deviceId)).toBe(false);
    alice.c.close();
  });
});

describe('access control: account.create for an existing account (multi-hub, ADR 0007)', () => {
  async function createWith(key: ReturnType<typeof generateKeyPair>, extra: object) {
    const c = await RawClient.connect(t.url);
    const sig = signChallenge(await c.next('challenge'), key);
    const reply = await c.request('account.create', {
      display_name: 'alice',
      device_name: 'second laptop',
      device_pubkey: toB64(key.publicKey),
      platform: 'linux',
      client,
      sig,
      ...extra,
    });
    c.close();
    return reply;
  }

  it('registers the account under its root when a linked device joins a hub', async () => {
    const root = generateKeyPair();
    const laptop = generateKeyPair();
    const uid = userId(root.publicKey);
    const chain = [issueDeviceCert(root, uid, laptop.publicKey)];
    const reply = await createWith(laptop, { root_pubkey: toB64(root.publicKey), chain });
    expect(reply).toMatchObject({
      t: 'account.created',
      body: {
        user_id: uid,
        device_id: deviceId(laptop.publicKey),
        fingerprint: fingerprint(root.publicKey),
      },
    });
    expect(t.db.getUser(uid)?.root_pubkey).toBe(toB64(root.publicKey));
    expect(t.db.getDevice(deviceId(laptop.publicKey))?.chain).toEqual(chain);
  });

  it('rejects a chain that does not lead from that root to this device', async () => {
    const root = generateKeyPair();
    const laptop = generateKeyPair();
    const uid = userId(root.publicKey);
    const someoneElse = generateKeyPair();
    const forged = [issueDeviceCert(someoneElse, uid, laptop.publicKey)];
    expect(
      await createWith(laptop, { root_pubkey: toB64(root.publicKey), chain: forged }),
    ).toMatchObject({
      t: 'error',
      body: { code: 'forbidden' },
    });
    expect(await createWith(laptop, { root_pubkey: toB64(root.publicKey) })).toMatchObject({
      body: { code: 'bad_request' },
    });
    expect(t.db.listUsers()).toHaveLength(0);
  });

  it('adds a device with a valid chain to an account already on this hub (ADR 0014)', async () => {
    const alice = await signUp(t.url, 'alice');
    alice.c.close();
    const laptop = generateKeyPair();
    const chain = [issueDeviceCert(alice.key, alice.userId, laptop.publicKey)];
    expect(
      await createWith(laptop, { root_pubkey: toB64(alice.key.publicKey), chain }),
    ).toMatchObject({
      t: 'account.created',
      body: { user_id: alice.userId, device_id: deviceId(laptop.publicKey), status: 'active' },
    });
    expect(t.db.getUser(alice.userId)?.display_name).toBe('alice');
    expect(t.db.devicesOf(alice.userId)).toHaveLength(2);

    // A chain signed by someone outside the account still gets nowhere.
    const phone = generateKeyPair();
    const stranger = generateKeyPair();
    expect(
      await createWith(phone, {
        root_pubkey: toB64(alice.key.publicKey),
        chain: [issueDeviceCert(stranger, alice.userId, phone.publicKey)],
      }),
    ).toMatchObject({ body: { code: 'forbidden' } });
  });
});
