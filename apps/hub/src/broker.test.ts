import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkTransferToken, fromB64 } from '@communal/crypto';
import type { HubMessage } from '@communal/protocol';
import { signUp, startTestHub, type TestHub } from './testing.js';

let t: TestHub;
beforeEach(async () => {
  t = await startTestHub({ silenceMs: 30_000 });
});
afterEach(async () => {
  await t.close();
});

const hash = 'ab'.repeat(32);
const sid = (n: number) => `x_01J9Z3QX7M8N4P5R6S7T8V9W${String(n).padStart(2, '0')}`;
const cand = [{ kind: 'lan' as const, host: '127.0.0.1', port: 40000 }];
const entry = {
  path: 'S/movie.mkv',
  size: 10,
  mtime: 1,
  mime: 'video/x-matroska',
  kind: 'video' as const,
  meta: {},
  thumb: false,
  hash,
};

async function world(publicFile = true) {
  const alice = await signUp(t.url, 'alice');
  const bob = await signUp(t.url, 'bob');
  await alice.c.request('index.snapshot', { rev: 1, page: 0, last: true, entries: [entry] });
  if (publicFile)
    await alice.c.request('acl.set', { device_id: alice.deviceId, path: 'S/', audience: 'hub' });
  return { alice, bob };
}

const req = (n: number, target: string, h = hash) => ({
  target,
  hash: h,
  session_id: sid(n),
  stream_id: 7,
  candidates: cand,
});

describe('access control: connect.request / connect.answer', () => {
  it('brokers a visible file: offer with a valid hub token to the owner, answer back with identity', async () => {
    const { alice, bob } = await world();
    expect((await bob.c.request('connect.request', req(1, alice.deviceId))).t).toBe('ok');
    const offer = (await alice.c.next('connect.offer')) as Extract<
      HubMessage,
      { t: 'connect.offer' }
    >;
    expect(offer.body).toMatchObject({
      session_id: sid(1),
      from: bob.deviceId,
      from_user: bob.userId,
      stream_id: 7,
      candidates: cand,
    });
    expect(
      checkTransferToken(offer.body.token, fromB64(t.hub.hubPubkey), {
        self: alice.deviceId,
        peer: bob.deviceId,
      }),
    ).toEqual({ ok: true });
    expect(offer.body.token.claims.exp - Date.now() / 1000).toBeGreaterThan(290);

    expect(
      (
        await alice.c.request('connect.answer', {
          session_id: sid(1),
          stream_id: 9,
          candidates: cand,
        })
      ).t,
    ).toBe('ok');
    const answer = (await bob.c.next('connect.answer')) as Extract<
      HubMessage,
      { t: 'connect.answer' }
    >;
    expect(answer.body).toMatchObject({ session_id: sid(1), stream_id: 9, to_user: alice.userId });
    expect(answer.body.token).toEqual(offer.body.token);
  });

  it('refuses to broker a file the requester cannot see — exactly like a missing one', async () => {
    const { alice, bob } = await world(false);
    const hidden = await bob.c.request('connect.request', req(2, alice.deviceId));
    const missing = await bob.c.request('connect.request', req(3, alice.deviceId, 'cd'.repeat(32)));
    expect(hidden).toMatchObject({ t: 'error', body: { code: 'not_found' } });
    expect(hidden.body).toEqual(missing.body);
    expect(alice.c.backlog().some((m) => m.t === 'connect.offer')).toBe(false);
  });

  it('reports an offline owner as peer_offline', async () => {
    const { alice, bob } = await world();
    alice.c.close();
    await new Promise((r) => setTimeout(r, 100));
    const r = await bob.c.request('connect.request', req(4, alice.deviceId));
    expect(r).toMatchObject({ t: 'connect.failed', body: { cause: 'peer_offline' } });
  });

  it('only lets the addressed device answer, and refuses reused session ids and self-connects', async () => {
    const { alice, bob } = await world();
    const carol = await signUp(t.url, 'carol');
    await bob.c.request('connect.request', req(5, alice.deviceId));
    const hijack = await carol.c.request('connect.answer', {
      session_id: sid(5),
      stream_id: 1,
      candidates: cand,
    });
    expect(hijack).toMatchObject({ t: 'error', body: { code: 'not_found' } });
    expect(bob.c.backlog().some((m) => m.t === 'connect.answer')).toBe(false);
    expect((await carol.c.request('connect.request', req(5, alice.deviceId))).body).toMatchObject({
      code: 'conflict',
    });
    expect((await alice.c.request('connect.request', req(6, alice.deviceId))).body).toMatchObject({
      code: 'not_found',
    });
  });
});

const obs = (patch: Record<string, unknown> = {}) => ({
  nat: 'endpoint_independent' as const,
  upnp: false,
  ipv6: false,
  cgnat: false,
  attempts: 50,
  udp_sent: true,
  udp_received: false,
  ...patch,
});
const profile = {
  nat: 'symmetric' as const,
  upnp: false,
  ipv6: false,
  cgnat: false,
  lan_addrs: ['10.0.0.5'],
};

describe('access control: network.profile / connect.failed', () => {
  async function brokered(n: number) {
    const w = await world();
    await w.bob.c.request('connect.request', req(n, w.alice.deviceId));
    await w.alice.c.next('connect.offer');
    return w;
  }

  it('network.profile needs a signed-in session and is acknowledged', async () => {
    const { RawClient } = await import('./testing.js');
    const anon = await RawClient.connect(t.url);
    await anon.next('challenge');
    expect(await anon.request('network.profile', profile)).toMatchObject({
      t: 'error',
      body: { code: 'unauthenticated' },
    });
    anon.close();
    const { alice } = await world();
    expect((await alice.c.request('network.profile', profile)).t).toBe('ok');
  });

  it('combines both sides into one diagnosis for the downloader only', async () => {
    const { alice, bob } = await brokered(10);
    await alice.c.request('connect.answer', {
      session_id: sid(10),
      stream_id: 9,
      candidates: cand,
    });
    expect(
      (
        await alice.c.request('connect.failed', {
          session_id: sid(10),
          observations: obs({ nat: 'symmetric' }),
        })
      ).t,
    ).toBe('ok');
    const r = await bob.c.request('connect.failed', {
      session_id: sid(10),
      observations: obs(),
    });
    expect(r).toMatchObject({
      t: 'connect.failed',
      body: {
        session_id: sid(10),
        cause: 'both_restrictive_nat',
        easier_fix: 'you',
        you: { nat: 'endpoint_independent', upnp: false, ipv6: false, cgnat: false },
        them: { nat: 'symmetric', upnp: false, ipv6: false, cgnat: false },
      },
    });
    // The punching stats stay with the hub; the answer carries the four profile fields only.
    expect(Object.keys((r.body as { them: object }).them).sort()).toEqual([
      'cgnat',
      'ipv6',
      'nat',
      'upnp',
    ]);
    // The owner never receives a diagnosis, and the session is finished.
    expect(alice.c.backlog().some((m) => m.t === 'connect.failed')).toBe(false);
    expect(
      await bob.c.request('connect.failed', { session_id: sid(10), observations: obs() }),
    ).toMatchObject({ t: 'error', body: { code: 'not_found' } });
  });

  it('waits for the owner report that arrives after the downloader', async () => {
    const { alice, bob } = await brokered(11);
    await alice.c.request('connect.answer', {
      session_id: sid(11),
      stream_id: 9,
      candidates: cand,
    });
    const id = bob.c.send('connect.failed', { session_id: sid(11), observations: obs() });
    await new Promise((r) => setTimeout(r, 50));
    await alice.c.request('connect.failed', {
      session_id: sid(11),
      observations: obs({ nat: 'blocked' }),
    });
    expect(await bob.c.next((m) => m.re === id)).toMatchObject({
      body: { cause: 'udp_blocked', easier_fix: 'them' },
    });
  });

  it('falls back to the owner profile when it never reports, and to peer_offline when it never answered', async () => {
    const { alice, bob } = await brokered(12);
    await alice.c.request('network.profile', { ...profile, nat: 'blocked' });
    await alice.c.request('connect.answer', {
      session_id: sid(12),
      stream_id: 9,
      candidates: cand,
    });
    expect(
      await bob.c.request('connect.failed', { session_id: sid(12), observations: obs() }),
    ).toMatchObject({
      body: { cause: 'udp_blocked', easier_fix: 'them', them: { nat: 'blocked' } },
    });

    await bob.c.request('connect.request', req(13, alice.deviceId));
    await alice.c.next('connect.offer');
    expect(
      await bob.c.request('connect.failed', { session_id: sid(13), observations: obs() }),
    ).toMatchObject({ body: { cause: 'peer_offline', easier_fix: 'none' } });
  });

  it('refuses reports from anyone but the two parties, and for unknown sessions', async () => {
    const { alice, bob } = await brokered(14);
    const carol = await signUp(t.url, 'carol');
    for (const c of [carol.c]) {
      expect(
        await c.request('connect.failed', { session_id: sid(14), observations: obs() }),
      ).toMatchObject({ t: 'error', body: { code: 'not_found' } });
    }
    expect(
      await bob.c.request('connect.failed', { session_id: sid(15), observations: obs() }),
    ).toMatchObject({ t: 'error', body: { code: 'not_found' } });
    // Carol's attempt changed nothing: the real parties still get their diagnosis.
    await alice.c.request('connect.answer', {
      session_id: sid(14),
      stream_id: 9,
      candidates: cand,
    });
    expect(
      await bob.c.request('connect.failed', { session_id: sid(14), observations: obs() }),
    ).toMatchObject({ t: 'connect.failed' });
  });
});
