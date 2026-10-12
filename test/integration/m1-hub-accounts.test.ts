/**
 * M1 done-when: create 3 accounts, reconnect with backoff, presence events fire correctly.
 * Runs the real hub (over dev TLS) and real HubClients in one process with shortened timers.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPair, type KeyPair } from '@communal/crypto';
import { HubClient, type HubClientState } from '@communal/core';
import { devSelfSigned, HubDb } from '@communal/hub';
import { sleep, startTestHub, type TestHub } from '@communal/hub/testing';
import type { HubBody } from '@communal/protocol';

const SILENCE_MS = 600;
const BACKOFF = { initialMs: 50, maxMs: 400 };

interface Node {
  name: string;
  key: KeyPair;
  state: HubClientState;
  client: HubClient;
  presence: HubBody<'presence'>[];
  reconnects: { attempt: number; delayMs: number }[];
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function hubWithTls(opts: {
  dir: string;
  port?: number;
  hubKey?: KeyPair;
  db: HubDb;
}): Promise<TestHub> {
  const t = await startTestHub({
    ...opts,
    tls: await devSelfSigned(opts.dir),
    silenceMs: SILENCE_MS,
    probePorts: undefined,
  });
  return t;
}

function makeNode(
  name: string,
  url: string,
  extra: Partial<ConstructorParameters<typeof HubClient>[0]> = {},
): Node {
  const key = generateKeyPair();
  const state: HubClientState = { registered: false };
  const node: Node = {
    name,
    key,
    state,
    presence: [],
    reconnects: [],
    client: new HubClient({
      url,
      device: key,
      state,
      saveState: () => {},
      createAccount: { display_name: name, device_name: `${name}-box`, platform: 'linux' },
      insecureTls: true,
      pingIntervalMs: 100,
      silenceMs: SILENCE_MS,
      backoff: BACKOFF,
      log: pino({ level: 'silent' }),
      ...extra,
    }),
  };
  node.client.on('presence', (p) => node.presence.push(p));
  node.client.on('reconnecting', (r) => node.reconnects.push(r));
  cleanups.push(() => node.client.stop());
  return node;
}

/** Replaces a node's client with a fresh one using the same key and saved state. */
function restartClient(node: Node, url: string) {
  node.client = new HubClient({
    url,
    device: node.key,
    state: node.state,
    saveState: () => {},
    insecureTls: true,
    pingIntervalMs: 100,
    silenceMs: SILENCE_MS,
    backoff: BACKOFF,
    log: pino({ level: 'silent' }),
  });
  node.client.on('presence', (p) => node.presence.push(p));
  node.client.on('reconnecting', (r) => node.reconnects.push(r));
  cleanups.push(() => node.client.stop());
  node.client.start();
}

async function until(cond: () => boolean, timeoutMs = 5_000, label = 'condition') {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'communal-m1-'));
  const db = new HubDb(join(dir, 'hub.db'));
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, db };
}

describe('M1: hub + accounts', () => {
  it('creates three accounts, pins the hub key and signs in over TLS', async () => {
    const { dir, db } = setup();
    const hub = await hubWithTls({ dir, db });
    cleanups.push(() => hub.close());

    const nodes = ['alice', 'bob', 'carol'].map((n) => makeNode(n, hub.url));
    for (const n of nodes) n.client.start();
    const welcomes = await Promise.all(nodes.map((n) => n.client.waitReady(5_000)));

    expect(
      db
        .listUsers()
        .map((u) => u.display_name)
        .sort(),
    ).toEqual(['alice', 'bob', 'carol']);
    expect(db.listUsers().every((u) => u.status === 'active')).toBe(true);
    nodes.forEach((n, i) => {
      expect(n.state).toMatchObject({
        registered: true,
        hubPubkey: hub.hub.hubPubkey,
        deviceId: welcomes[i]!.device_id,
      });
    });
  });

  it('delivers presence to connections only, with a grace period before offline', async () => {
    const { dir, db } = setup();
    const hub = await hubWithTls({ dir, db });
    cleanups.push(() => hub.close());
    const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((n) => makeNode(n, hub.url)) as [
      Node,
      Node,
      Node,
    ];
    alice.client.start();
    carol.client.start();
    await Promise.all([alice.client.waitReady(), carol.client.waitReady()]);
    bob.client.start();
    await bob.client.waitReady();
    // Connections arrive in M3; seed alice ↔ bob directly.
    db.putConnection(alice.state.userId!, bob.state.userId!, 'accepted');

    // Bob drops abruptly and comes back within the window: nobody sees a flap.
    const bobDevice = bob.state.deviceId!;
    const bobOnline = { device_id: bobDevice, user_id: bob.state.userId!, online: true };
    await bob.client.stop();
    restartClient(bob, hub.url);
    await bob.client.waitReady();
    await sleep(SILENCE_MS + 200);
    expect(alice.presence).toEqual([]);

    // Bob leaves for good: alice hears "offline" only once the silence window has passed since
    // bob's last ping (sent at most one ping interval before he stopped); carol never does.
    const left = Date.now();
    await bob.client.stop();
    await until(() => alice.presence.length === 1, 3_000, 'offline event');
    expect(Date.now() - left).toBeGreaterThanOrEqual(SILENCE_MS - 100 - 20);
    expect(alice.presence[0]).toEqual({ ...bobOnline, online: false });

    restartClient(bob, hub.url);
    await until(() => alice.presence.length === 2, 3_000, 'online event');
    expect(alice.presence[1]).toEqual(bobOnline);
    expect(carol.presence).toEqual([]);
    // Bob's sign-in snapshot told him alice is online.
    expect(bob.presence).toContainEqual({
      device_id: alice.state.deviceId!,
      user_id: alice.state.userId!,
      online: true,
    });
  });

  it('reconnects with jittered exponential backoff after a hub restart', async () => {
    const { dir, db } = setup();
    let hub = await hubWithTls({ dir, db });
    const { port, hubKey } = hub;
    const nodes = ['alice', 'bob', 'carol'].map((n) => makeNode(n, hub.url));
    for (const n of nodes) n.client.start();
    await Promise.all(nodes.map((n) => n.client.waitReady()));
    db.putConnection(nodes[0]!.state.userId!, nodes[1]!.state.userId!, 'accepted');

    await hub.close();
    // Leave the hub down long enough for several attempts, including some at the cap.
    await sleep(1_500);
    for (const n of nodes) {
      expect(n.client.ready).toBe(false);
      const delays = n.reconnects.map((r) => r.delayMs);
      expect(delays.length).toBeGreaterThanOrEqual(4);
      delays.forEach((d, i) => {
        const base = Math.min(BACKOFF.maxMs, BACKOFF.initialMs * 2 ** i);
        expect(d).toBeGreaterThanOrEqual(base / 2);
        expect(d).toBeLessThanOrEqual(base);
      });
    }

    hub = await hubWithTls({ dir, db, port, hubKey });
    cleanups.push(() => hub.close());
    await Promise.all(nodes.map((n) => n.client.waitReady(3_000)));
    // Backoff resets after a successful sign-in.
    await until(
      () => nodes[0]!.presence.some((p) => p.online && p.device_id === nodes[1]!.state.deviceId),
      3_000,
      'presence after restart',
    );
    expect(db.listUsers()).toHaveLength(3);
  });

  it('refuses a hub whose key changed since first contact', async () => {
    const { dir, db } = setup();
    let hub = await hubWithTls({ dir, db });
    const port = hub.port;
    const alice = makeNode('alice', hub.url);
    alice.client.start();
    await alice.client.waitReady();
    await hub.close();

    hub = await hubWithTls({ dir, db, port, hubKey: generateKeyPair() });
    cleanups.push(() => hub.close());
    const fatal = await new Promise<Error>((resolve) => alice.client.once('fatal', resolve));
    expect(fatal).toMatchObject({ reason: 'hub_key_mismatch' });
    expect(alice.client.ready).toBe(false);
  });

  it('holds new accounts until the admin approves them in approval mode', async () => {
    const { dir, db } = setup();
    db.setSetting('join_mode', 'approval');
    const hub = await hubWithTls({ dir, db });
    cleanups.push(() => hub.close());
    const dave = makeNode('dave', hub.url);
    let pendingSeen = 0;
    dave.client.on('pending_approval', () => pendingSeen++);
    dave.client.start();
    await until(() => pendingSeen >= 2, 3_000, 'pending approval retries');
    expect(dave.state.registered).toBe(true);
    expect(dave.client.ready).toBe(false);

    db.setUserStatus(dave.state.userId!, 'active');
    await dave.client.waitReady(3_000);
  });
});
