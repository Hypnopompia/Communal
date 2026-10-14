/**
 * Hub admin from the client (ADR 0020): the first account manages the hub through its core's
 * local API, and nobody else can.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPair } from '@communal/crypto';
import { CommunalCore, LocalApi, LocalApiClient, type AdminGraph } from '@communal/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '@communal/mcp';
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

async function hub() {
  const dir = tmp('communal-m11-hub-');
  const db = new HubDb(join(dir, 'hub.db'));
  const t = await startTestHub({ dir, db, silenceMs: 5_000, banPollMs: 100 });
  cleanups.push(async () => {
    await t.close();
    db.close();
  });
  return t;
}

/** A core with its local API, as the desktop app and CLI see it. */
async function node(name: string) {
  const core = new CommunalCore({
    dataDir: tmp(`communal-m11-${name}-`),
    device: generateKeyPair(),
    hubClient: { pingIntervalMs: 1_000, silenceMs: 5_000, backoff: { initialMs: 50, maxMs: 300 } },
    log: quiet,
  });
  await core.start();
  const api = new LocalApi(core);
  const url = await api.listen({ host: '127.0.0.1', port: 0, token: 'sekret-token-123' });
  cleanups.push(async () => {
    await api.close();
    await core.stop();
  });
  return { core, api: new LocalApiClient({ url, token: 'sekret-token-123' }) };
}

/** An AI agent driving a core through the MCP server (ADR 0017). */
async function agentFor(api: LocalApiClient) {
  const server = createServer(
    async () => api,
    () => 'test core',
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const agent = new Client({ name: 'test-agent', version: '0' });
  await agent.connect(b);
  cleanups.push(() => agent.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await agent.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const text = r.content[0]!.text;
    if (r.isError) throw new Error(text);
    return JSON.parse(text) as unknown;
  };
  return { agent, call };
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

interface HubStatus {
  id: string;
  admin: boolean;
  name: string | null;
  problem: { reason: string } | null;
}
const hubStatus = async (api: LocalApiClient) =>
  (await api.get<{ hubs: HubStatus[] }>('/v1/hubs')).hubs[0]!;

describe('M11: hub admin from the client', () => {
  it('lets the first account manage the hub, and nobody else', async () => {
    const h = await hub();
    const alice = await node('alice');
    const bob = await node('bob');
    const { id: ha, state: as } = (await alice.core.addHub(h.url, acct('alice'))).hub;
    const { id: hb, state: bs } = (await bob.core.addHub(h.url, acct('bob'))).hub;
    const [aliceId, bobId] = [as.userId!, bs.userId!];
    const admin = (path: string) => `/v1/hubs/${ha}/admin${path}`;

    expect(await hubStatus(alice.api)).toMatchObject({ admin: true });
    expect(await hubStatus(bob.api)).toMatchObject({ admin: false });
    for (const path of ['/users', '/settings', '/graph', '/log']) {
      await expect(bob.api.get(`/v1/hubs/${hb}/admin${path}`), path).rejects.toMatchObject({
        status: 403,
      });
    }
    await expect(
      bob.api.post(`/v1/hubs/${hb}/admin/users/${aliceId}/ban`, {}),
    ).rejects.toMatchObject({ status: 403 });

    // Users, with bob's computer and nothing about his files.
    const { users } = await alice.api.get<{
      users: { user_id: string; admin: boolean; verified: boolean; devices: unknown[] }[];
    }>(admin('/users'));
    expect(users.map((u) => [u.user_id, u.admin, u.devices.length])).toEqual([
      [aliceId, true, 1],
      [bobId, false, 1],
    ]);

    // Approval mode: carol waits until alice lets her in, and alice's core hears about her.
    const changed = new Promise<void>((resolve) =>
      alice.core.hubs.on('event', ({ msg }) => msg.t === 'admin.changed' && resolve()),
    );
    expect(
      await alice.api.put(admin('/settings'), {
        join_mode: 'approval',
        max_devices_per_account: 5,
      }),
    ).toEqual({
      join_mode: 'approval',
      name: null,
      signups_per_hour: 0,
      max_files_per_device: 1_000_000,
      max_devices_per_account: 5,
    });
    const carol = await node('carol');
    const joined = await carol.core.addHub(h.url, acct('carol'));
    expect(joined.status).toBe('pending_approval');
    const carolId = joined.hub.state.userId!;
    await changed;
    await alice.api.post(admin(`/users/${carolId}/approve`), {});
    await until(async () => (await hubStatus(carol.api)).problem === null, 5_000, 'carol in');

    // The graph shows the connection between alice and bob.
    await alice.core.people.request(ha, bobId);
    await bob.core.people.accept(hb, aliceId);
    const graph = await alice.api.get<AdminGraph>(admin('/graph'));
    expect(graph.people).toHaveLength(3);
    expect(graph.connections).toEqual([
      expect.objectContaining({ state: 'accepted', requested_by: aliceId }),
    ]);

    // A ban signs bob out for good.
    await alice.api.post(admin(`/users/${bobId}/ban`), { reason: 'testing' });
    await until(
      async () => (await hubStatus(bob.api)).problem?.reason === 'banned',
      5_000,
      'bob banned',
    );
    await expect(alice.api.post(admin(`/users/${aliceId}/ban`), {})).rejects.toMatchObject({
      status: 403,
    });

    // A new name shows on the admin's own computer at once.
    await alice.api.put(admin('/settings'), { name: 'Test hub' });
    expect(await hubStatus(alice.api)).toMatchObject({ name: 'Test hub' });

    const log = await alice.api.get<{ entries: { actor: string; action: string }[] }>(
      admin('/log?limit=4'),
    );
    expect(log.entries.map((e) => e.action)).toEqual(['set', 'ban', 'approve', 'set']);
    expect(log.entries.every((e) => e.actor === aliceId)).toBe(true);

    // Removed from the shell: refused at once, before the app reconnects.
    h.db.setAdmin(aliceId, false);
    await expect(alice.api.get(admin('/users'))).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('any more'),
    });
  });

  it('gives an agent the admin tools, refused by the hub for anyone else', async () => {
    const h = await hub();
    const alice = await node('alice');
    const bob = await node('bob');
    const ha = (await alice.core.addHub(h.url, acct('alice'))).hub.id;
    const hb = (await bob.core.addHub(h.url, acct('bob'))).hub.id;
    const aliceAgent = await agentFor(alice.api);
    const bobAgent = await agentFor(bob.api);

    const { tools } = await aliceAgent.agent.listTools();
    const ann = (n: string) => tools.find((t) => t.name === n)?.annotations;
    expect(ann('list_hub_users')).toMatchObject({ readOnlyHint: true });
    expect(ann('ban_hub_user')).toMatchObject({ destructiveHint: true });
    expect(ann('set_hub_settings')).toMatchObject({ destructiveHint: true });

    await expect(bobAgent.call('list_hub_users', { hub: hb })).rejects.toThrow(/forbidden/);
    await aliceAgent.call('set_hub_settings', { hub: ha, join_mode: 'approval', name: 'Ours' });
    expect(await aliceAgent.call('get_hub_settings', { hub: ha })).toMatchObject({
      join_mode: 'approval',
      name: 'Ours',
    });

    const carol = await node('carol');
    const joined = await carol.core.addHub(h.url, acct('carol'));
    expect(joined.status).toBe('pending_approval');
    const users = (await aliceAgent.call('list_hub_users', { hub: ha })) as {
      users: { user_id: string; status: string }[];
    };
    const waiting = users.users.filter((u) => u.status === 'pending').map((u) => u.user_id);
    expect(waiting).toEqual([joined.hub.state.userId]);
    await aliceAgent.call('approve_hub_user', { hub: ha, user_id: waiting[0] });
    await until(async () => (await hubStatus(carol.api)).problem === null, 5_000, 'carol in');

    const log = (await aliceAgent.call('get_hub_admin_log', { hub: ha, limit: 3 })) as {
      entries: { action: string }[];
    };
    expect(log.entries.map((e) => e.action)).toEqual(['approve', 'set', 'set']);
  });
});
