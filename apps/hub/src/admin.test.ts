import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair, toB64 } from '@communal/crypto';
import { clientBodies, type ClientBody, type HubMessage } from '@communal/protocol';
import { HubDb } from './db.js';
import { RawClient, signChallenge, signIn, signUp, startTestHub, type TestHub } from './testing.js';

const client = { name: 'test', version: '0' };
let t: TestHub;

beforeEach(async () => {
  t = await startTestHub();
});
afterEach(async () => {
  await t.close();
});

type AdminType = Extract<keyof typeof clientBodies, `admin.${string}`>;

/** A valid body for every admin message; the test fails if a new one isn't listed. */
const SAMPLES: { [T in AdminType]: (target: string) => ClientBody<T> } = {
  'admin.users': () => ({}),
  'admin.approve': (user_id) => ({ user_id }),
  'admin.ban': (user_id) => ({ user_id, reason: 'spam' }),
  'admin.unban': (user_id) => ({ user_id }),
  'admin.settings.get': () => ({}),
  'admin.settings.set': () => ({ join_mode: 'approval', name: 'Taken over' }),
  'admin.graph': () => ({}),
  'admin.log': () => ({ limit: 10 }),
};
const ADMIN_TYPES = Object.keys(clientBodies).filter((k) => k.startsWith('admin.')) as AdminType[];

function adminRequest(c: RawClient, type: AdminType, target: string): Promise<HubMessage> {
  return c.request(type, SAMPLES[type](target) as never);
}

/** An admin (the first account) plus two others: bob (connected to alice) and carol. */
async function world() {
  const alice = await signUp(t.url, 'alice');
  const bob = await signUp(t.url, 'bob');
  const carol = await signUp(t.url, 'carol');
  for (const x of [alice, bob, carol]) x.c.keepAlive();
  return { alice, bob, carol };
}

/** Consumes the hints already received, so the next one awaited is new. */
async function drainHints(c: RawClient) {
  for (const m of c.backlog()) if (m.t === 'admin.changed') await c.next('admin.changed');
}

async function pendingAccount(name: string) {
  const key = generateKeyPair();
  const c = await RawClient.connect(t.url);
  const sig = signChallenge(await c.next('challenge'), key);
  const created = await c.request('account.create', {
    display_name: name,
    device_name: `${name}-laptop`,
    device_pubkey: toB64(key.publicKey),
    platform: 'linux',
    client,
    sig,
  });
  if (created.t !== 'account.created') throw new Error('account.create failed');
  c.close();
  return { key, userId: created.body.user_id, deviceId: created.body.device_id };
}

describe('admins', () => {
  it('makes the first account the admin, and lets it in even in approval mode', async () => {
    t.db.setSetting('join_mode', 'approval');
    const key = generateKeyPair();
    const c = await RawClient.connect(t.url);
    const sig = signChallenge(await c.next('challenge'), key);
    const created = await c.request('account.create', {
      display_name: 'owner',
      device_name: 'x',
      device_pubkey: toB64(key.publicKey),
      platform: 'linux',
      client,
      sig,
    });
    expect(created.body).toMatchObject({ status: 'active' });
    const welcome = await c.request('auth', {
      device_id: (created.body as { device_id: string }).device_id,
      sig,
      client,
    });
    expect(welcome.body).toMatchObject({ admin: true });
    c.close();

    const second = await pendingAccount('second');
    expect(t.db.getUser(second.userId)?.status).toBe('pending');
    expect(t.db.listAdmins().map((u) => u.display_name)).toEqual(['owner']);
    expect(t.db.auditLog(10).entries[0]).toMatchObject({
      actor: 'hub',
      action: 'admin.add',
      details: 'first account',
    });
  });

  it('tells other accounts they are not admins', async () => {
    const { bob } = await world();
    const again = await signIn(t.url, bob.key, bob.deviceId);
    expect(again.reply.body).toMatchObject({ admin: false });
    again.c.close();
  });

  it('answers non-admins exactly as a hub without admin messages would', async () => {
    const { bob, carol } = await world();
    for (const type of ADMIN_TYPES) {
      const reply = await adminRequest(bob.c, type, carol.userId);
      expect(reply.t, type).toBe('error');
      expect(reply.body, type).toEqual({ code: 'bad_request', message: `unknown type ${type}` });
    }
    // Nothing changed on the way.
    expect(t.db.getUser(carol.userId)?.banned_at).toBeNull();
    expect(t.db.auditLog(10).entries.every((e) => e.actor === 'hub')).toBe(true);
  });

  it('refuses admin messages before sign-in', async () => {
    const c = await RawClient.connect(t.url);
    await c.next('challenge');
    for (const type of ADMIN_TYPES) {
      expect((await adminRequest(c, type, 'u_' + 'a'.repeat(26))).body, type).toMatchObject({
        code: 'unauthenticated',
      });
    }
    c.close();
  });

  it('takes effect at once when the shell removes or adds an admin', async () => {
    const { alice, bob } = await world();
    expect((await alice.c.request('admin.users', {})).t).toBe('admin.user.listing');
    t.db.setAdmin(alice.userId, false);
    expect((await alice.c.request('admin.users', {})).body).toMatchObject({ code: 'bad_request' });
    t.db.setAdmin(bob.userId, true);
    expect((await bob.c.request('admin.users', {})).t).toBe('admin.user.listing');
    expect(t.db.auditLog(2).entries.map((e) => [e.actor, e.action])).toEqual([
      ['cli', 'admin.add'],
      ['cli', 'admin.remove'],
    ]);
  });

  it("doesn't count a banned account as an admin", async () => {
    const { alice } = await world();
    t.db.ban(alice.userId);
    expect(t.db.isAdmin(alice.userId)).toBe(false);
    t.db.unban(alice.userId);
    expect(t.db.isAdmin(alice.userId)).toBe(true);
  });
});

describe('admin.users', () => {
  it('lists accounts and devices with counts, never file names or paths', async () => {
    const { alice, bob } = await world();
    bob.c.send('network.profile', {
      nat: 'symmetric',
      upnp: false,
      ipv6: true,
      cgnat: false,
      lan_addrs: ['192.168.1.20'],
    });
    await bob.c.request('index.snapshot', {
      rev: 1,
      page: 0,
      last: true,
      entries: [
        {
          path: 'Secret/plans.pdf',
          size: 1000,
          mtime: 1,
          mime: 'application/pdf',
          kind: 'document',
          meta: {},
          thumb: false,
          hash: null,
        },
      ],
    });
    const reply = await alice.c.request('admin.users', {});
    if (reply.t !== 'admin.user.listing') throw new Error(JSON.stringify(reply.body));
    const b = reply.body.users.find((u) => u.user_id === bob.userId)!;
    expect(b).toMatchObject({ display_name: 'bob', status: 'active', admin: false });
    expect(b.devices).toEqual([
      expect.objectContaining({
        device_id: bob.deviceId,
        online: true,
        files: 1,
        bytes: 1000,
        nat: { nat: 'symmetric', upnp: false, ipv6: true, cgnat: false },
      }),
    ]);
    expect(reply.body.users.find((u) => u.user_id === alice.userId)).toMatchObject({
      admin: true,
    });
    const raw = JSON.stringify(reply.body);
    expect(raw).not.toContain('plans.pdf');
    expect(raw).not.toContain('Secret');
    expect(raw).not.toContain('192.168.1.20');
  });
});

describe('admin.approve', () => {
  it('lets a pending account in, logs it and tells signed-in admins', async () => {
    const { alice } = await world();
    t.db.setSetting('join_mode', 'approval');
    await drainHints(alice.c);
    const dave = await pendingAccount('dave');
    await alice.c.next('admin.changed'); // the new account
    expect((await signIn(t.url, dave.key, dave.deviceId)).reply.body).toMatchObject({
      code: 'pending_approval',
    });

    await drainHints(alice.c);
    expect((await alice.c.request('admin.approve', { user_id: dave.userId })).t).toBe('ok');
    await alice.c.next('admin.changed');
    const signedIn = await signIn(t.url, dave.key, dave.deviceId);
    expect(signedIn.reply.t).toBe('welcome');
    signedIn.c.close();
    expect(t.db.auditLog(1).entries[0]).toMatchObject({
      actor: alice.userId,
      action: 'approve',
      target: dave.userId,
    });
    // Again: nothing to do, nothing logged.
    expect((await alice.c.request('admin.approve', { user_id: dave.userId })).t).toBe('ok');
    expect(t.db.auditLog(1).entries[0]!.action).toBe('approve');
  });

  it('says not_found for an unknown account', async () => {
    const { alice } = await world();
    const reply = await alice.c.request('admin.approve', { user_id: 'u_' + 'z'.repeat(26) });
    expect(reply.body).toMatchObject({ code: 'not_found' });
  });
});

describe('admin.ban / admin.unban', () => {
  it('signs the account out at once, logs the reason, and unbans', async () => {
    const { alice, bob } = await world();
    const reply = await alice.c.request('admin.ban', { user_id: bob.userId, reason: 'spam' });
    expect(reply.t).toBe('ok');
    expect((await bob.c.closed).code).toBe(4003);
    expect((await signIn(t.url, bob.key, bob.deviceId)).reply.body).toMatchObject({
      code: 'banned',
    });
    expect(t.db.auditLog(1).entries[0]).toMatchObject({
      actor: alice.userId,
      action: 'ban',
      target: bob.userId,
      details: 'spam',
    });

    expect((await alice.c.request('admin.unban', { user_id: bob.userId })).t).toBe('ok');
    const back = await signIn(t.url, bob.key, bob.deviceId);
    expect(back.reply.t).toBe('welcome');
    back.c.close();
    expect(t.db.auditLog(1).entries[0]).toMatchObject({ action: 'unban', target: bob.userId });
  });

  it("won't ban yourself or another admin from a client", async () => {
    const { alice, bob } = await world();
    t.db.setAdmin(bob.userId, true);
    for (const target of [alice.userId, bob.userId]) {
      const reply = await alice.c.request('admin.ban', { user_id: target });
      expect(reply.body).toMatchObject({ code: 'forbidden' });
      expect(t.db.getUser(target)?.banned_at).toBeNull();
    }
  });
});

describe('admin.settings', () => {
  it('reads and changes the join mode and name, logging each change', async () => {
    const { alice } = await world();
    expect((await alice.c.request('admin.settings.get', {})).body).toEqual({
      join_mode: 'open',
      name: null,
    });
    const set = await alice.c.request('admin.settings.set', {
      join_mode: 'approval',
      name: 'Hunter family',
    });
    expect(set.body).toEqual({ join_mode: 'approval', name: 'Hunter family' });
    const c = await RawClient.connect(t.url);
    expect((await c.next('challenge')).body).toMatchObject({ name: 'Hunter family' });
    c.close();

    expect((await alice.c.request('admin.settings.set', { name: null })).body).toEqual({
      join_mode: 'approval',
      name: null,
    });
    expect(
      t.db
        .auditLog(3)
        .entries.map((e) => [e.action, e.target, e.details])
        .reverse(),
    ).toEqual([
      ['set', 'join_mode', 'approval'],
      ['set', 'name', 'Hunter family'],
      ['set', 'name', null],
    ]);
  });
});

describe('admin.graph', () => {
  it('lists connections, and nothing about groups or rules', async () => {
    const { alice, bob, carol } = await world();
    t.db.putConnection(alice.userId, bob.userId, 'accepted', alice.userId);
    t.db.putConnection(bob.userId, carol.userId, 'pending', carol.userId);
    t.db.upsertGroup(bob.userId, 'g_01J9Z3QX7M8N4P5R6S7T8V9W0X', 'Close friends', [alice.userId]);
    const reply = await alice.c.request('admin.graph', {});
    if (reply.t !== 'admin.graph.listing') throw new Error(JSON.stringify(reply.body));
    expect(reply.body.connections).toHaveLength(2);
    expect(reply.body.connections).toContainEqual(
      expect.objectContaining({ state: 'pending', requested_by: carol.userId }),
    );
    expect(JSON.stringify(reply.body)).not.toContain('Close friends');
  });
});

describe('admin.log', () => {
  it('pages newest first', async () => {
    const { alice } = await world();
    for (const name of ['a', 'b', 'c', 'd']) t.db.changeSettings({ name }, 'cli');
    const first = await alice.c.request('admin.log', { limit: 2 });
    if (first.t !== 'admin.log.listing') throw new Error(JSON.stringify(first.body));
    expect(first.body.entries.map((e) => e.details)).toEqual(['d', 'c']);
    expect(first.body.more).toBe(true);
    const next = await alice.c.request('admin.log', {
      limit: 10,
      before: first.body.entries[1]!.id,
    });
    if (next.t !== 'admin.log.listing') throw new Error(JSON.stringify(next.body));
    expect(next.body.entries.map((e) => e.details)).toEqual(['b', 'a', 'first account']);
    expect(next.body.more).toBe(false);
  });
});

describe('migration', () => {
  it("makes an existing hub's oldest unbanned account its admin", async () => {
    const { alice, bob } = await world();
    t.db.ban(alice.userId);
    // Roll the database back to before admins existed, then open it again.
    t.db.raw.exec('ALTER TABLE users DROP COLUMN admin_at; DROP TABLE admin_log;');
    t.db.raw.pragma('user_version = 7');
    const again = new HubDb(join(t.dir, 'hub.db'));
    try {
      expect(again.listAdmins().map((u) => u.id)).toEqual([bob.userId]);
      expect(again.auditLog(5).entries).toEqual([
        expect.objectContaining({ actor: 'hub', action: 'admin.add', target: bob.userId }),
      ]);
    } finally {
      again.close();
    }
  });
});
