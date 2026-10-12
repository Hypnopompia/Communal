/**
 * Multi-hub foundation (ADR 0007): one device on several hubs at once, same identity
 * everywhere, events tagged by hub, and requests fanned out with per-hub results.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPair } from '@communal/crypto';
import { HubManager, type HubEntry } from '@communal/core';
import { HubDb } from '@communal/hub';
import { signUp, sleep, startTestHub, type TestHub } from '@communal/hub/testing';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function hub(): Promise<TestHub> {
  const dir = mkdtempSync(join(tmpdir(), 'communal-mh-'));
  const t = await startTestHub({ dir, db: new HubDb(join(dir, 'hub.db')), silenceMs: 600 });
  cleanups.push(async () => {
    await t.close();
    t.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return t;
}

function makeManager(saved: { hubs: HubEntry[] }) {
  const m = new HubManager({
    device: generateKeyPair(),
    hubs: saved.hubs,
    save: (hubs) => {
      saved.hubs = structuredClone(hubs);
    },
    backoff: { initialMs: 50, maxMs: 200 },
    // Test hubs drop clients after 600 ms of silence; ping well inside that.
    pingIntervalMs: 100,
    silenceMs: 600,
    log: pino({ level: 'silent' }),
  });
  cleanups.push(() => m.stop());
  return m;
}

const join_ = {
  kind: 'create' as const,
  display_name: 'alice',
  device_name: 'nas',
  platform: 'linux' as const,
};

describe('multi-hub client', () => {
  it('joins two hubs with one identity and fans requests out to both', async () => {
    const [a, b] = [await hub(), await hub()];
    const saved = { hubs: [] as HubEntry[] };
    const m = makeManager(saved);
    m.start();
    const ready: string[] = [];
    m.on('ready', ({ hub }) => ready.push(hub));
    const ea = await m.add(a.url, join_);
    const eb = await m.add(b.url, join_);
    await Promise.all([m.get(ea.id)!.waitReady(), m.get(eb.id)!.waitReady()]);

    // Same user on both hubs, each hub's key pinned separately, both persisted.
    expect(ea.state.userId).toBeDefined();
    expect(eb.state.userId).toBe(ea.state.userId);
    expect(a.db.getUser(ea.state.userId!)).toBeDefined();
    expect(b.db.getUser(ea.state.userId!)).toBeDefined();
    expect(ea.state.hubPubkey).toBe(a.hub.hubPubkey);
    expect(eb.state.hubPubkey).toBe(b.hub.hubPubkey);
    expect(saved.hubs.map((h) => h.url)).toEqual([a.url, b.url]);
    expect(saved.hubs.every((h) => h.state.registered)).toBe(true);
    expect(ready.sort()).toEqual([ea.id, eb.id].sort());

    const both = await m.requestAll('ping', {});
    expect(both).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hub: ea.id, ok: true }),
        expect.objectContaining({ hub: eb.id, ok: true }),
      ]),
    );

    // One hub going away doesn't stop the other from answering.
    await b.hub.close();
    await sleep(50);
    const partial = await m.requestAll('ping', {});
    expect(partial.find((r) => r.hub === ea.id)).toMatchObject({ ok: true });
    expect(partial.find((r) => r.hub === eb.id)).toMatchObject({ ok: false });
  });

  it('tags presence with the hub it came from', async () => {
    const [a, b] = [await hub(), await hub()];
    const m = makeManager({ hubs: [] });
    m.start();
    const ea = await m.add(a.url, join_);
    const eb = await m.add(b.url, join_);
    await Promise.all([m.get(ea.id)!.waitReady(), m.get(eb.id)!.waitReady()]);

    const seen: { hub: string; device: string }[] = [];
    m.on('presence', ({ hub, presence }) => seen.push({ hub, device: presence.device_id }));
    // bob exists only on hub B and is connected to alice there.
    const bob = await signUp(b.url, 'bob');
    b.db.putConnection(ea.state.userId!, bob.userId, 'accepted');
    bob.c.close();
    // Offline arrives once bob's grace period on hub B runs out.
    for (let i = 0; i < 150 && seen.length === 0; i++) await sleep(20);
    await sleep(100);
    expect(seen).toEqual([{ hub: eb.id, device: bob.deviceId }]);
  });

  it('reconnects to configured hubs on restart and can forget one', async () => {
    const [a, b] = [await hub(), await hub()];
    const saved = { hubs: [] as HubEntry[] };
    const device = generateKeyPair();
    const first = new HubManager({
      device,
      hubs: saved.hubs,
      save: (h) => void (saved.hubs = structuredClone(h)),
      log: pino({ level: 'silent' }),
    });
    first.start();
    const ea = await first.add(a.url, join_);
    const eb = await first.add(b.url, join_);
    await Promise.all([first.get(ea.id)!.waitReady(), first.get(eb.id)!.waitReady()]);
    await first.stop();

    // A later run: no createAccount needed, it signs in to both from saved state.
    const second = new HubManager({
      device,
      hubs: structuredClone(saved.hubs),
      save: (h) => void (saved.hubs = structuredClone(h)),
      log: pino({ level: 'silent' }),
    });
    cleanups.push(() => second.stop());
    second.start();
    await Promise.all([second.get(ea.id)!.waitReady(), second.get(eb.id)!.waitReady()]);
    expect(a.db.listUsers()).toHaveLength(1);
    expect(b.db.listUsers()).toHaveLength(1);

    expect(await second.remove(b.url)).toBe(true);
    expect(saved.hubs.map((h) => h.id)).toEqual([ea.id]);
    expect(second.list().map((h) => h.id)).toEqual([ea.id]);
    expect(await second.add(a.url).catch((e: Error) => e.message)).toMatch(/already configured/);
  });
});
