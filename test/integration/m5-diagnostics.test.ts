/**
 * M5: diagnostics with no relay. Each client classifies its network towards every hub and
 * sends `network.profile`; when no direct path comes up, both sides report `connect.failed`
 * and the hub tells the downloader why (`cause`) and whose setup is easier to fix. Real hubs
 * and cores in one process; bad networks are simulated by dropping punch datagrams and
 * overriding the measured profile. The NAT lab (`docker/nat/test.sh`) runs the real thing.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPair } from '@communal/crypto';
import {
  CommunalCore,
  LocalApi,
  LocalApiClient,
  type Explained,
  type NetworkProfile,
  type PortMapper,
  apiSocketPath,
} from '@communal/core';
import { HubDb } from '@communal/hub';
import { sleep, startTestHub, type TestHub } from '@communal/hub/testing';

const quiet = pino({ level: process.env.M5_LOG ?? 'silent' });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function hub(probes = true): Promise<TestHub> {
  const dir = tmp('communal-m5-hub-');
  const db = new HubDb(join(dir, 'hub.db'));
  const t = await startTestHub({
    dir,
    db,
    silenceMs: 10_000,
    ...(probes ? { probePorts: [0, 0] as [number, number] } : {}),
  });
  cleanups.push(async () => {
    await t.close();
    db.close();
  });
  return t;
}

/** A simulated network: drop the peer's punches, and/or pretend the probe measured this. */
interface Net {
  dropPunches: boolean;
  profile?: Partial<NetworkProfile>;
}

async function core(name: string, net: Net = { dropPunches: false }, mapper?: PortMapper) {
  const c = new CommunalCore({
    dataDir: tmp(`communal-m5-${name}-`),
    device: generateKeyPair(),
    hubClient: { pingIntervalMs: 1_000, silenceMs: 10_000, backoff: { initialMs: 50, maxMs: 300 } },
    indexer: { flushMs: 100 },
    peer: { loopback: true, connectTimeoutMs: 800, testDropPunches: () => net.dropPunches },
    network: { override: () => net.profile, ...(mapper ? { mapper } : {}) },
    downloads: { retryMs: 300, chunkTimeoutMs: 5_000, answerTimeoutMs: 2_000 },
    log: quiet,
  });
  let stopped = false;
  cleanups.push(() => (stopped ? undefined : c.stop()));
  await c.start();
  return Object.assign(c, { markStopped: () => (stopped = true) });
}

async function until(cond: () => boolean | Promise<boolean>, ms: number, label: string) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

const acct = (n: string) => ({
  display_name: n,
  device_name: `${n}-box`,
  platform: 'linux' as const,
});

/** Joins `c` to `h` and waits until the hub has its network profile. */
async function join_(c: CommunalCore, h: TestHub, name: string) {
  const id = (await c.addHub(h.url, acct(name))).hub.id;
  await until(() => !!h.hub.profileOf(c.deviceId), 5_000, `${name}'s network profile`);
  return id;
}

/** alice shares one file publicly on `h`; bob joins. Both on the given simulated networks. */
async function pair(h: TestHub, aliceNet: Net, bobNet: Net) {
  const alice = await core('alice', aliceNet);
  const hubId = await join_(alice, h, 'alice');
  const root = tmp('communal-m5-share-');
  writeFileSync(join(root, 'film.mkv'), randomBytes(300_000));
  await alice.addShare('Share', root);
  await alice.setRule(hubId, 'Share/', 'hub');
  await until(() => alice.store.counts().hashed === 1, 10_000, 'hash');
  const hash = alice.store.file('Share', 'film.mkv')!.hash!;
  await until(
    () => !!h.db.raw.prepare('SELECT 1 FROM entries WHERE hash = ?').get(hash),
    10_000,
    'hash on hub',
  );
  const bob = await core('bob', bobNet);
  await join_(bob, h, 'bob');
  return { alice, bob, hash };
}

async function diagnosed(c: CommunalCore, id: string) {
  await until(() => c.store.transfer(id)?.diagnosis != null, 15_000, `diagnosis of ${id}`);
  return c.store.transfer(id)!;
}

describe('M5: network profile', () => {
  it('classifies the network towards each hub and tells each hub', async () => {
    const withProbes = await hub();
    const noProbes = await hub(false);
    const alice = await core('alice');
    const a = await join_(alice, withProbes, 'alice');
    const b = await join_(alice, noProbes, 'alice');

    // Over loopback the hub sees our own address and port: no NAT at all.
    expect(alice.network.profile(a)).toMatchObject({ nat: 'none', upnp: false, cgnat: false });
    expect(withProbes.hub.profileOf(alice.deviceId)).toEqual(alice.network.profile(a));
    // A hub without probe responders can't tell us anything about the NAT.
    expect(alice.network.profile(b)?.nat).toBe('unknown');
    expect(noProbes.hub.profileOf(alice.deviceId)?.nat).toBe('unknown');

    const summary = await alice.network.summary();
    expect(summary.hubs[a]!.observed).toEqual([
      { host: '127.0.0.1', port: alice.transport.port },
      { host: '127.0.0.1', port: alice.transport.port },
    ]);
    expect(alice.status().hubs.find((h) => h.id === a)?.network?.nat).toBe('none');
  });

  it('offers a router port mapping as a candidate, spots CGNAT, and removes the mapping on stop', async () => {
    const h = await hub();
    let stops = 0;
    const mapper: PortMapper = {
      map: async (port) => ({
        mapping: { method: 'upnp', host: '100.72.1.9', port: port + 1 },
        routerIp: '100.72.1.9',
      }),
      stop: async () => void stops++,
    };
    const alice = await core('alice', { dropPunches: false }, mapper);
    const id = await join_(alice, h, 'alice');
    expect(alice.network.profile(id)).toMatchObject({ upnp: true, cgnat: true });
    expect(alice.transport.candidates()).toContainEqual({
      kind: 'mapped',
      host: '100.72.1.9',
      port: alice.transport.port + 1,
    });
    await alice.stop();
    alice.markStopped();
    expect(stops).toBe(1);
  });
});

describe('M5: connect.failed diagnosis', () => {
  it('both behind restrictive NATs: both_restrictive_nat, shown with tips over the API; recovers once fixed', async () => {
    const h = await hub();
    const aliceNet: Net = { dropPunches: true, profile: { nat: 'symmetric' } };
    const bobNet: Net = { dropPunches: true, profile: { nat: 'symmetric' } };
    const { bob, hash } = await pair(h, aliceNet, bobNet);
    const t = await bob.download(hash);
    const row = await diagnosed(bob, t.id);
    expect(row.state).toBe('waiting');
    expect(row.diagnosis).toMatchObject({
      cause: 'both_restrictive_nat',
      easier_fix: 'either',
      you: { nat: 'symmetric' },
      them: { nat: 'symmetric' },
      hub: expect.stringMatching(/^h_/),
    });

    const api = new LocalApi(bob);
    const sock = apiSocketPath(tmp('communal-m5-sock-'));
    await api.listen({ socketPath: sock });
    cleanups.push(() => api.close());
    const { downloads } = await new LocalApiClient({ socketPath: sock }).get<{
      downloads: { id: string; diagnosis: Explained | null }[];
    }>('/v1/downloads');
    const d = downloads.find((x) => x.id === t.id)!.diagnosis!;
    expect(d.message).toBe('Neither network accepts incoming connections.');
    expect(d.tips.join(' ')).toMatch(/UPnP/);
    expect(d.fix).toMatch(/either side/);

    // The owner sets up a port forward: the queued download finishes and the diagnosis goes.
    aliceNet.dropPunches = false;
    bobNet.dropPunches = false;
    await until(() => bob.store.transfer(t.id)!.state === 'done', 20_000, 'download');
    expect(bob.store.transfer(t.id)!.diagnosis).toBeNull();
  });

  it('our network blocks UDP: udp_blocked, and the fix is on our side', async () => {
    const h = await hub();
    const { bob, hash } = await pair(
      h,
      { dropPunches: false },
      { dropPunches: true, profile: { nat: 'blocked' } },
    );
    const row = await diagnosed(bob, (await bob.download(hash)).id);
    expect(row.diagnosis).toMatchObject({
      cause: 'udp_blocked',
      easier_fix: 'you',
      you: { nat: 'blocked' },
      them: { nat: 'none' },
    });
  });

  it("the owner's computer drops what reaches it although nothing NATs it: os_firewall on their side", async () => {
    const h = await hub();
    // Alice's punches reach bob, but nothing gets into alice's machine.
    const { bob, hash } = await pair(
      h,
      { dropPunches: true, profile: { nat: 'none' } },
      {
        dropPunches: false,
        profile: { nat: 'endpoint_independent' },
      },
    );
    const row = await diagnosed(bob, (await bob.download(hash)).id);
    expect(row.diagnosis).toMatchObject({ cause: 'os_firewall', easier_fix: 'them' });
  });

  it('the owner is offline: peer_offline, with nothing to fix', async () => {
    const h = await hub();
    const { alice, bob, hash } = await pair(h, { dropPunches: false }, { dropPunches: false });
    await alice.stop();
    alice.markStopped();
    const row = await diagnosed(bob, (await bob.download(hash)).id);
    expect(row.state).toBe('waiting');
    expect(row.diagnosis).toMatchObject({ cause: 'peer_offline', easier_fix: 'none' });
  });
});
