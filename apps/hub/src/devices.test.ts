/**
 * Devices (M8, ADR 0014): link codes with approval, restore with the root key, device listing
 * and revocation — each with its access-control cases.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deviceId,
  generateKeyPair,
  issueDeviceCert,
  issueRevocation,
  sign,
  toB64,
  userId,
  utf8,
  type CertChain,
  type KeyPair,
} from '@communal/crypto';
import type { HubMessage } from '@communal/protocol';
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

interface Dev {
  c: RawClient;
  key: KeyPair;
  userId: string;
  deviceId: string;
  chain: CertChain;
}

async function root(name: string): Promise<Dev> {
  return { ...(await signUp(t.url, name)), chain: [] };
}

/** Claims a code on a fresh connection; returns the claimer, its key and the claim reply. */
async function claim(code: string, key: KeyPair = generateKeyPair()) {
  const c = await RawClient.connect(t.url);
  const sig = signChallenge(await c.next('challenge'), key);
  const reply = await c.request('link.claim', {
    code,
    device_name: 'nas',
    device_pubkey: toB64(key.publicKey),
    platform: 'linux',
    sig,
  });
  return { c, key, sig, reply };
}

async function newCode(owner: Dev): Promise<string> {
  const r = await owner.c.request('link.code.create', {});
  if (r.t !== 'link.code') throw new Error(JSON.stringify(r.body));
  return r.body.code;
}

/** The whole link flow: `owner` approves a new device, which then signs in. */
async function link(owner: Dev): Promise<Dev> {
  const code = await newCode(owner);
  const { c, key, sig, reply } = await claim(code);
  expect(reply.t).toBe('ok');
  const req = await owner.c.next('link.request');
  if (req.t !== 'link.request') throw new Error('expected link.request');
  const cert = issueDeviceCert(owner.key, owner.userId, key.publicKey);
  expect((await owner.c.request('link.approve', { request_id: req.body.request_id, cert })).t).toBe(
    'ok',
  );
  const done = await c.next('link.done');
  if (done.t !== 'link.done') throw new Error('expected link.done');
  const welcome = await c.request('auth', { device_id: done.body.device_id, sig, client });
  expect(welcome).toMatchObject({ t: 'welcome', body: { user_id: owner.userId } });
  return { c, key, userId: owner.userId, deviceId: done.body.device_id, chain: done.body.chain };
}

const proof = (signer: Dev, target: string) => ({
  revocation: issueRevocation(signer.key, signer.userId, target),
  chain: signer.chain,
});

const errorCode = (m: HubMessage) => (m.t === 'error' ? m.body.code : m.t);

describe('link codes', () => {
  it('links a device after approval, with the chain and sealed bundle passed through', async () => {
    const alice = await root('alice');
    const code = await newCode(alice);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const nas = await claim(code);
    expect(nas.reply.t).toBe('ok');
    const req = await alice.c.next('link.request');
    expect(req.body).toMatchObject({ device_name: 'nas', device_pubkey: toB64(nas.key.publicKey) });
    if (req.t !== 'link.request') throw new Error();

    const cert = issueDeviceCert(alice.key, alice.userId, nas.key.publicKey);
    await alice.c.request('link.approve', {
      request_id: req.body.request_id,
      cert,
      sealed: 'Q'.repeat(100),
    });
    const done = await nas.c.next('link.done');
    expect(done.body).toEqual({
      user_id: alice.userId,
      device_id: deviceId(nas.key.publicKey),
      chain: [cert],
      sealed: 'Q'.repeat(100),
    });
    expect(
      (
        await nas.c.request('auth', {
          device_id: deviceId(nas.key.publicKey),
          sig: nas.sig,
          client,
        })
      ).t,
    ).toBe('welcome');

    const list = await alice.c.request('device.list', {});
    expect(list.body).toMatchObject({
      devices: [
        { device_id: alice.deviceId, root: true, online: true, revoked_at: null },
        { device_id: deviceId(nas.key.publicKey), name: 'nas', root: false, online: true },
      ],
    });
  });

  it('chains through linked devices', async () => {
    const alice = await root('alice');
    const laptop = await link(alice);
    const nas = await link(laptop);
    expect(nas.chain).toHaveLength(2);
    expect(t.db.devicesOf(alice.userId)).toHaveLength(3);
  });

  it('uses a code only once and accepts read-aloud spellings', async () => {
    const alice = await root('alice');
    const code = await newCode(alice);
    const sloppy = code.replace(/0/g, 'O').replace(/1/g, 'L');
    expect((await claim(sloppy)).reply.t).toBe('ok');
    expect(errorCode((await claim(code)).reply)).toBe('not_found');
  });

  it('closes a session after too many wrong codes', async () => {
    const c = await RawClient.connect(t.url);
    const key = generateKeyPair();
    const sig = signChallenge(await c.next('challenge'), key);
    const body = {
      code: 'AAAA-AAAA',
      device_name: 'x',
      device_pubkey: toB64(key.publicKey),
      platform: 'linux' as const,
      sig,
    };
    for (let i = 0; i < 4; i++)
      expect(errorCode(await c.request('link.claim', body))).toBe('not_found');
    expect(errorCode(await c.request('link.claim', body))).toBe('rate_limited');
    expect((await c.closed).code).toBe(4029);
  });

  it('rejects a claim without proof of possession of the key', async () => {
    const alice = await root('alice');
    const code = await newCode(alice);
    const c = await RawClient.connect(t.url);
    await c.next('challenge');
    const key = generateKeyPair();
    const reply = await c.request('link.claim', {
      code,
      device_name: 'x',
      device_pubkey: toB64(key.publicKey),
      platform: 'linux',
      sig: toB64(sign('communal/auth/v1', utf8('not the challenge'), key.secretKey)),
    });
    expect(errorCode(reply)).toBe('forbidden');
  });

  it('expires codes', async () => {
    await t.close();
    t = await startTestHub({ linkTtlMs: 150 });
    const alice = await root('alice');
    const code = await newCode(alice);
    await sleep(250);
    expect(errorCode((await claim(code)).reply)).toBe('not_found');
  });

  it('tells the new device when the request is denied, or the approver goes away', async () => {
    const alice = await root('alice');
    const a = await claim(await newCode(alice));
    const req = await alice.c.next('link.request');
    if (req.t !== 'link.request') throw new Error();
    expect((await alice.c.request('link.deny', { request_id: req.body.request_id })).t).toBe('ok');
    expect((await a.c.next('link.denied')).t).toBe('link.denied');

    const b = await claim(await newCode(alice));
    await alice.c.next('link.request');
    alice.c.close();
    expect((await b.c.next('link.denied')).t).toBe('link.denied');
  });

  it('keeps a pending claim alive past the auth timeout', async () => {
    await t.close();
    t = await startTestHub({ authTimeoutMs: 200, silenceMs: 2_000 });
    const alice = await root('alice');
    alice.c.keepAlive();
    const nas = await claim(await newCode(alice));
    nas.c.keepAlive();
    await sleep(500);
    expect(nas.c.ws.readyState).toBe(nas.c.ws.OPEN);
  });

  it('only the device that made the code can approve, and only for the claimed key', async () => {
    const alice = await root('alice');
    const laptop = await link(alice);
    const bob = await root('bob');
    const nas = await claim(await newCode(alice));
    const req = await alice.c.next('link.request');
    if (req.t !== 'link.request') throw new Error();
    const id = req.body.request_id;

    // Another account, or another device of the same account: no such request for them.
    const forNas = issueDeviceCert(bob.key, alice.userId, nas.key.publicKey);
    expect(errorCode(await bob.c.request('link.approve', { request_id: id, cert: forNas }))).toBe(
      'not_found',
    );
    const byLaptop = issueDeviceCert(laptop.key, alice.userId, nas.key.publicKey);
    expect(
      errorCode(await laptop.c.request('link.approve', { request_id: id, cert: byLaptop })),
    ).toBe('not_found');
    expect(errorCode(await bob.c.request('link.deny', { request_id: id }))).toBe('not_found');

    // The approver must sign the claimed key itself, for its own account.
    const other = generateKeyPair();
    for (const cert of [
      issueDeviceCert(alice.key, alice.userId, other.publicKey),
      issueDeviceCert(laptop.key, alice.userId, nas.key.publicKey),
      issueDeviceCert(alice.key, bob.userId, nas.key.publicKey),
    ]) {
      expect(errorCode(await alice.c.request('link.approve', { request_id: id, cert }))).toBe(
        'bad_request',
      );
    }
    expect(t.db.devicesOf(alice.userId)).toHaveLength(2);
  });

  it('refuses link messages before sign-in', async () => {
    const c = await RawClient.connect(t.url);
    const cert = issueDeviceCert(
      generateKeyPair(),
      'u_' + 'a'.repeat(26),
      generateKeyPair().publicKey,
    );
    expect(errorCode(await c.request('link.approve', { request_id: 'lr_1', cert }))).toBe(
      'unauthenticated',
    );
    expect(errorCode(await c.request('device.list', {}))).toBe('unauthenticated');
    const stranger = generateKeyPair();
    const revocation = issueRevocation(stranger, userId(stranger.publicKey), 'd_' + 'a'.repeat(26));
    expect(errorCode(await c.request('device.revoke', { revocation, chain: [] }))).toBe(
      'unauthenticated',
    );
  });
});

describe('account.restore', () => {
  async function restore(rootKey: KeyPair, opts: { badRootSig?: boolean } = {}) {
    const key = generateKeyPair();
    const c = await RawClient.connect(t.url);
    const sig = signChallenge(await c.next('challenge'), key);
    const cert = issueDeviceCert(
      opts.badRootSig ? generateKeyPair() : rootKey,
      userId(rootKey.publicKey),
      key.publicKey,
    );
    const reply = await c.request('account.restore', {
      root_pubkey: toB64(rootKey.publicKey),
      device_pubkey: toB64(key.publicKey),
      device_name: 'restored',
      platform: 'linux',
      issued_at: cert.issued_at,
      root_sig: cert.sig,
      sig,
    });
    return { c, key, sig, reply };
  }

  it('registers a fresh device under the account with a root-signed cert', async () => {
    const alice = await root('alice');
    alice.c.close();
    const r = await restore(alice.key);
    expect(r.reply).toMatchObject({
      t: 'account.created',
      body: { user_id: alice.userId, device_id: deviceId(r.key.publicKey), status: 'active' },
    });
    expect(t.db.getDevice(deviceId(r.key.publicKey))?.chain).toHaveLength(1);
    const w = await r.c.request('auth', {
      device_id: deviceId(r.key.publicKey),
      sig: r.sig,
      client,
    });
    expect(w).toMatchObject({ t: 'welcome', body: { user_id: alice.userId } });
  });

  it('rejects a bad root signature and unknown accounts', async () => {
    const alice = await root('alice');
    expect(errorCode((await restore(alice.key, { badRootSig: true })).reply)).toBe('forbidden');
    expect(errorCode((await restore(generateKeyPair())).reply)).toBe('not_found');
    expect(t.db.devicesOf(alice.userId)).toHaveLength(1);
  });
});

describe('device.revoke', () => {
  it('revokes a device: session closed, sign-in refused, others told, files gone', async () => {
    const alice = await root('alice');
    alice.c.keepAlive();
    const laptop = await link(alice);
    const nas = await link(alice);
    const entry = {
      path: 'Docs/plan.txt',
      size: 3,
      mtime: 1,
      mime: 'text/plain',
      kind: 'text' as const,
      meta: {},
      thumb: false,
      hash: 'ab'.repeat(32),
    };
    await nas.c.request('index.snapshot', { rev: 1, page: 0, last: true, entries: [entry] });
    const hits = await alice.c.request('search', { q: 'plan', limit: 10 });
    expect(hits.body).toMatchObject({ hits: [{ hash: entry.hash }] });

    const p = proof(laptop, nas.deviceId);
    expect((await laptop.c.request('device.revoke', p)).t).toBe('ok');
    expect((await nas.c.closed).code).toBe(4004);
    expect((await alice.c.next('device.revoked')).body).toEqual(p);
    expect(t.hub.isOnline(nas.deviceId)).toBe(false);
    expect(await alice.c.request('search', { q: 'plan', limit: 10 })).toMatchObject({
      body: { hits: [] },
    });
    expect((await signIn(t.url, nas.key, nas.deviceId)).reply).toMatchObject({
      body: { code: 'forbidden' },
    });
    // Idempotent: gossip may bring the same proof back.
    expect((await alice.c.request('device.revoke', p)).t).toBe('ok');
    const list = await alice.c.request('device.list', {});
    expect(list.body).toMatchObject({
      devices: expect.arrayContaining([
        expect.objectContaining({
          device_id: nas.deviceId,
          online: false,
          revoked_at: expect.any(Number),
        }),
      ]),
    });

    // A device that signs in later hears about it.
    const again = await signIn(t.url, laptop.key, laptop.deviceId);
    expect(again.reply.t).toBe('welcome');
    expect((await again.c.next('device.revoked')).body).toEqual(p);
  });

  it('revokes every device certified through the revoked one', async () => {
    const alice = await root('alice');
    const laptop = await link(alice);
    const nas = await link(laptop);
    expect((await alice.c.request('device.revoke', proof(alice, laptop.deviceId))).t).toBe('ok');
    expect((await nas.c.closed).code).toBe(4004);
    expect(t.db.devicesOf(alice.userId)).toEqual([alice.deviceId]);
    // Nor can a key certified by the revoked device register itself later.
    const tablet = generateKeyPair();
    const c = await RawClient.connect(t.url);
    const sig = signChallenge(await c.next('challenge'), tablet);
    const reply = await c.request('account.create', {
      display_name: 'alice',
      device_name: 'tablet',
      device_pubkey: toB64(tablet.publicKey),
      platform: 'linux',
      client,
      sig,
      root_pubkey: toB64(alice.key.publicKey),
      chain: [...laptop.chain, issueDeviceCert(laptop.key, alice.userId, tablet.publicKey)],
    });
    expect(errorCode(reply)).toBe('forbidden');
  });

  it('refuses revocations for other accounts, by revoked signers, and of the root', async () => {
    const alice = await root('alice');
    const laptop = await link(alice);
    const nas = await link(alice);
    const bob = await root('bob');

    // Bob can neither submit alice's proof nor sign one for her account.
    expect(errorCode(await bob.c.request('device.revoke', proof(alice, nas.deviceId)))).toBe(
      'forbidden',
    );
    expect(
      errorCode(
        await alice.c.request('device.revoke', {
          revocation: issueRevocation(bob.key, alice.userId, nas.deviceId),
          chain: [],
        }),
      ),
    ).toBe('forbidden');

    expect(errorCode(await laptop.c.request('device.revoke', proof(laptop, alice.deviceId)))).toBe(
      'bad_request',
    );

    // Once the laptop is revoked, a proof it signed earlier is worthless.
    const late = proof(laptop, nas.deviceId);
    await alice.c.request('device.revoke', proof(alice, laptop.deviceId));
    expect(errorCode(await alice.c.request('device.revoke', late))).toBe('forbidden');
    expect(t.db.getDevice(nas.deviceId)?.revoked_at).toBeNull();
  });

  it('accepts a proof for a device this hub has never seen, and keeps it out', async () => {
    const alice = await root('alice');
    const phone = generateKeyPair();
    const cert = issueDeviceCert(alice.key, alice.userId, phone.publicKey);
    const p = proof(alice, deviceId(phone.publicKey));
    expect((await alice.c.request('device.revoke', p)).t).toBe('ok');
    const c = await RawClient.connect(t.url);
    const sig = signChallenge(await c.next('challenge'), phone);
    const reply = await c.request('account.create', {
      display_name: 'alice',
      device_name: 'phone',
      device_pubkey: toB64(phone.publicKey),
      platform: 'linux',
      client,
      sig,
      root_pubkey: toB64(alice.key.publicKey),
      chain: [cert],
    });
    expect(errorCode(reply)).toBe('forbidden');
  });
});

describe('device.message', () => {
  it('forwards a sealed message to another online device of the same account', async () => {
    const alice = await root('alice');
    const phone = await link(alice);
    const r = await phone.c.request('device.message', {
      to: alice.deviceId,
      sealed: 'S'.repeat(80),
    });
    expect(r.t).toBe('ok');
    const got = await alice.c.next('device.message');
    expect(got.body).toEqual({ from: phone.deviceId, sealed: 'S'.repeat(80) });
  });

  it('lists each device with its key and chain, so a message can be sealed to it', async () => {
    const alice = await root('alice');
    const phone = await link(alice);
    const list = await phone.c.request('device.list', {});
    expect(list.body).toMatchObject({
      devices: [
        { device_id: alice.deviceId, pubkey: toB64(alice.key.publicKey), chain: [] },
        { device_id: phone.deviceId, pubkey: toB64(phone.key.publicKey), chain: phone.chain },
      ],
    });
  });

  it("refuses other accounts' devices, offline and revoked devices, and itself alike", async () => {
    const alice = await root('alice');
    const bob = await root('bob');
    const phone = await link(alice);
    const laptop = await link(alice);
    const send = (from: Dev, to: string) =>
      from.c.request('device.message', { to, sealed: 'S'.repeat(80) }).then(errorCode);
    expect(await send(phone, bob.deviceId)).toBe('not_found');
    expect(await send(bob, alice.deviceId)).toBe('not_found');
    expect(await send(phone, phone.deviceId)).toBe('not_found');
    expect(await send(phone, deviceId(generateKeyPair().publicKey))).toBe('not_found');

    laptop.c.close();
    await laptop.c.closed;
    // The hub notices the closed socket a moment after the client does.
    let reply = await send(phone, laptop.deviceId);
    for (let i = 0; i < 40 && reply === 'ok'; i++) {
      await sleep(25);
      reply = await send(phone, laptop.deviceId);
    }
    expect(reply).toBe('not_found');

    expect((await alice.c.request('device.revoke', proof(alice, laptop.deviceId))).t).toBe('ok');
    expect(await send(phone, laptop.deviceId)).toBe('not_found');
    // Nothing reached anyone who shouldn't have it.
    await sleep(50);
    expect(bob.c.backlog().filter((m) => m.t === 'device.message')).toHaveLength(0);
    expect(alice.c.backlog().filter((m) => m.t === 'device.message')).toHaveLength(0);
  });

  it('refuses messages before sign-in', async () => {
    const alice = await root('alice');
    const c = await RawClient.connect(t.url);
    await c.next('challenge');
    const r = await c.request('device.message', { to: alice.deviceId, sealed: 'S'.repeat(80) });
    expect(errorCode(r)).toBe('unauthenticated');
  });
});
