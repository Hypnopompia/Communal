/**
 * M3 with real cores: access rules are per hub (owner decision, ADR 0007/0009) — a folder can
 * be public on one hub and private on another — and the client's rule set is authoritative,
 * re-sent to a hub on every sign-in.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPair, toB64 } from '@communal/crypto';
import { CommunalCore, PeopleError } from '@communal/core';
import { HubDb } from '@communal/hub';
import { sleep, startTestHub } from '@communal/hub/testing';

const quiet = pino({ level: 'silent' });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function hub(
  opts: { port?: number; db?: HubDb; hubKey?: ReturnType<typeof generateKeyPair> } = {},
) {
  const dir = tmp('communal-m3-hub-');
  const db = opts.db ?? new HubDb(join(dir, 'hub.db'));
  const t = await startTestHub({
    dir,
    db,
    silenceMs: 5_000,
    ...(opts.port ? { port: opts.port } : {}),
    ...(opts.hubKey ? { hubKey: opts.hubKey } : {}),
  });
  cleanups.push(async () => {
    await t.close();
    if (!opts.db) db.close();
  });
  return t;
}

async function core(name: string) {
  const c = new CommunalCore({
    dataDir: tmp(`communal-m3-${name}-`),
    device: generateKeyPair(),
    hubClient: { pingIntervalMs: 1_000, silenceMs: 5_000, backoff: { initialMs: 50, maxMs: 300 } },
    indexer: { flushMs: 100 },
    log: quiet,
  });
  cleanups.push(() => c.stop());
  await c.start();
  return c;
}

async function until(cond: () => boolean | Promise<boolean>, ms: number, label: string) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

const acct = (n: string) => ({
  display_name: n,
  device_name: `${n}-box`,
  platform: 'linux' as const,
});

describe('M3: per-hub access with real clients', () => {
  it('makes a folder public on one hub while it stays private on another', async () => {
    const [a, b] = [await hub(), await hub()];
    const alice = await core('alice');
    const bob = await core('bob');
    const aliceA = (await alice.addHub(a.url, acct('alice'))).hub.id;
    const aliceB = (await alice.addHub(b.url, acct('alice'))).hub.id;
    const bobA = (await bob.addHub(a.url, acct('bob'))).hub.id;
    const bobB = (await bob.addHub(b.url, acct('bob'))).hub.id;

    const root = tmp('communal-m3-share-');
    writeFileSync(join(root, 'Alien (1979).mkv'), 'movie');
    await alice.addShare('Movies', root); // published to both hubs
    await until(() => alice.store.counts().hashed === 1, 5_000, 'hash');
    await until(
      async () => (
        await alice.sync.idle(),
        a.db.entryCount(alice.deviceId) === 1 && b.db.entryCount(alice.deviceId) === 1
      ),
      5_000,
      'index on both hubs',
    );

    const bobSees = async () =>
      (await bob.search({ q: 'alien', limit: 10 })).hits
        .flatMap((h) => h.sources.map((s) => s.hub))
        .sort();
    expect(await bobSees()).toEqual([]); // default: only me, everywhere

    await alice.setRule(aliceA, 'Movies/', 'hub');
    expect(await bobSees()).toEqual([bobA]); // public on A only

    // On B: listed by user id, but not connected there yet → still hidden.
    await alice.setRule(aliceB, 'Movies/', { users: [bob.hubs.find(bobB)!.state.userId!] });
    expect(await bobSees()).toEqual([bobA]);
    await alice.people.request(aliceB, bob.hubs.find(bobB)!.state.userId!);
    await bob.people.accept(bobB, alice.hubs.find(aliceB)!.state.userId!);
    expect(await bobSees()).toEqual([bobA, bobB].sort());
    // A connection on B grants nothing on A, and removing it on B revokes only B.
    await bob.people.remove(bobB, alice.hubs.find(aliceB)!.state.userId!);
    expect(await bobSees()).toEqual([bobA]);

    expect(alice.rules()).toEqual({
      [aliceA]: [{ path: 'Movies/', audience: 'hub' }],
      [aliceB]: [{ path: 'Movies/', audience: { users: [bob.hubs.find(bobB)!.state.userId!] } }],
    });
  });

  it('re-sends its rules when a hub has lost them', async () => {
    const a = await hub();
    const alice = await core('alice');
    const bob = await core('bob');
    const ha = (await alice.addHub(a.url, acct('alice'))).hub.id;
    await bob.addHub(a.url, acct('bob'));
    const root = tmp('communal-m3-share-');
    writeFileSync(join(root, 'report.pdf'), '%PDF');
    await alice.addShare('Docs', root);
    await alice.setRule(ha, 'Docs/', 'hub');
    const visible = async () => (await bob.search({ q: 'report', limit: 5 })).hits.length;
    await until(async () => (await visible()) === 1, 5_000, 'public file');

    // The hub forgets the rules (restore from an old backup, say) and restarts.
    a.db.replaceRules(alice.deviceId, []);
    expect(await visible()).toBe(0);
    const { port, hubKey, db } = a;
    await a.hub.close();
    await hub({ port, hubKey, db });
    await until(
      async () => alice.hubs.get(ha)!.ready && bob.hubs.list()[0]!.ready,
      5_000,
      'reconnect',
    );
    await until(async () => (await visible()) === 1, 5_000, 'rules re-sent on sign-in');
  });

  it('refuses identities a hub has tampered with, and shows the same safety code on both sides', async () => {
    const a = await hub();
    const alice = await core('alice');
    const bob = await core('bob');
    const ha = (await alice.addHub(a.url, acct('alice'))).hub.id;
    const hb = (await bob.addHub(a.url, acct('bob'))).hub.id;
    const aliceId = alice.hubs.find(ha)!.state.userId!;
    const bobId = bob.hubs.find(hb)!.state.userId!;
    await alice.people.request(ha, bobId);
    await bob.people.accept(hb, aliceId);

    const fromAlice = await alice.people.safetyCode(ha, bobId);
    const fromBob = await bob.people.safetyCode(hb, aliceId);
    expect(fromAlice.code).toMatch(/^\d{5} \d{5} \d{5} \d{5}$/);
    expect(fromAlice.code).toBe(fromBob.code);
    await alice.people.verify(ha, bobId, true);
    expect((await alice.people.connections(ha))[0]).toMatchObject({
      user_id: bobId,
      verified: true,
    });

    // A malicious hub swaps in another key for bob: alice's client won't accept it.
    a.db.raw
      .prepare('UPDATE users SET root_pubkey = ? WHERE id = ?')
      .run(toB64(generateKeyPair().publicKey), bobId);
    expect(await alice.people.connections(ha)).toEqual([]);
    await expect(alice.people.safetyCode(ha, bobId)).rejects.toBeInstanceOf(PeopleError);
    expect(await alice.people.search(ha, 'bob')).toEqual([]);
  });
});
