/**
 * Agent tools beyond ADR 0017 (ADR 0021): thumbnails an agent can look at, through the same
 * access checks as the app.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generateKeyPair } from '@communal/crypto';
import { CommunalCore, LocalApi, LocalApiClient, apiSocketPath } from '@communal/core';
import { png } from '@communal/core/testing';
import { createServer } from '@communal/mcp';
import { HubDb } from '@communal/hub';
import { sleep, startTestHub, type TestHub } from '@communal/hub/testing';

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

async function hub(): Promise<TestHub> {
  const dir = tmp('communal-m12-hub-');
  const db = new HubDb(join(dir, 'hub.db'));
  const t = await startTestHub({ dir, db, silenceMs: 20_000 });
  cleanups.push(async () => {
    await t.close();
    db.close();
  });
  return t;
}

async function core(name: string) {
  const c = new CommunalCore({
    dataDir: tmp(`communal-m12-${name}-`),
    device: generateKeyPair(),
    hubClient: { pingIntervalMs: 1_000, silenceMs: 20_000, backoff: { initialMs: 50, maxMs: 300 } },
    indexer: { flushMs: 100 },
    peer: { loopback: true },
    media: { concurrency: 2 },
    log: quiet,
  });
  cleanups.push(() => c.stop());
  await c.start();
  return c;
}

/** The local API client each agent's core was given, for calling routes directly. */
const agentApis = new Map<CommunalCore, LocalApiClient>();

/** An AI agent on `c`, through its local API and the MCP server. */
async function agentOn(c: CommunalCore) {
  const api = new LocalApi(c);
  const socketPath = apiSocketPath(tmp('communal-m12-sock-'));
  await api.listen({ socketPath });
  cleanups.push(() => api.close());
  const client = new LocalApiClient({ socketPath });
  const server = createServer(
    async () => client,
    () => 'test core',
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const agent = new Client({ name: 'test-agent', version: '0' });
  await agent.connect(b);
  cleanups.push(() => agent.close());
  agentApis.set(c, client);
  return async (name: string, args: Record<string, unknown> = {}) =>
    (await agent.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: (
        { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
      )[];
    };
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

describe('M12: agent tools', () => {
  it('shows an agent thumbnails it may see, and nothing of the rest', async () => {
    const h = await hub();
    const alice = await core('alice');
    const ha = (await alice.addHub(h.url, acct('alice'))).hub.id;
    const pub = tmp('communal-m12-pub-');
    const priv = tmp('communal-m12-priv-');
    await png(join(pub, 'beach.png'), 160, 120, 1);
    await png(join(priv, 'secret.png'), 160, 120, 2);
    await alice.addShare('Public', pub);
    await alice.setRule(ha, 'Public/', 'hub');
    await alice.addShare('Private', priv); // only alice, the default
    await until(
      () => alice.store.counts().hashed === 2 && alice.store.mediaCounts().pending === 0,
      30_000,
      'media',
    );
    const open = alice.store.file('Public', 'beach.png')!.hash!;
    const secret = alice.store.file('Private', 'secret.png')!.hash!;

    const bob = await core('bob');
    const hb = (await bob.addHub(h.url, acct('bob'))).hub.id;
    const call = await agentOn(bob);

    const tools = await call('view_thumbnails', {
      hub: hb,
      device: alice.deviceId,
      hashes: [open, secret],
    });
    expect(tools.isError).toBeFalsy();
    const images = tools.content.filter((x) => x.type === 'image');
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ mimeType: 'image/webp' });
    // A real WebP: RIFF....WEBP
    const bytes = Buffer.from((images[0] as { data: string }).data, 'base64');
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString()).toBe('WEBP');
    const text = tools.content
      .filter((x) => x.type === 'text')
      .map((x) => (x as { text: string }).text)
      .join('\n');
    expect(text).toContain(`Thumbnail of ${open}`);
    expect(text).toContain(`No thumbnail`);
    expect(text).toContain(secret);

    // The owner's agent sees its own private files.
    const own = await (
      await agentOn(alice)
    )('view_thumbnails', {
      hub: ha,
      device: alice.deviceId,
      hashes: [secret],
      size: 'large',
    });
    expect(own.content.filter((x) => x.type === 'image')).toHaveLength(1);

    // Limits: two large at a time.
    const tooMany = await call('view_thumbnails', {
      hub: hb,
      device: alice.deviceId,
      hashes: [open, secret, 'ee'.repeat(32)],
      size: 'large',
    });
    expect(tooMany.isError).toBe(true);
  }, 60_000);

  it('previews an access change with real names, and changes nothing', async () => {
    const h = await hub();
    const alice = await core('alice');
    const bob = await core('bob');
    const { id: ha, state: aliceState } = (await alice.addHub(h.url, acct('alice'))).hub;
    const { id: hb, state: bobState } = (await bob.addHub(h.url, acct('bob'))).hub;
    await alice.people.request(ha, bobState.userId!);
    await bob.people.accept(hb, aliceState.userId!);
    const folder = tmp('communal-m12-photos-');
    await png(join(folder, 'one.png'), 40, 30, 1);
    await png(join(folder, 'two.png'), 40, 30, 2);
    await alice.addShare('Photos', folder);
    await until(() => alice.store.counts().files === 2, 10_000, 'indexing');
    const call = await agentOn(alice);
    const text = async (name: string, args: Record<string, unknown>) => {
      const r = await call(name, args);
      if (r.isError) throw new Error((r.content[0] as { text: string }).text);
      return JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;
    };

    const toBob = await text('preview_access', {
      hub: ha,
      path: 'Photos/',
      audience: { users: [bobState.userId] },
    });
    expect(toBob).toMatchObject({ files: 2, widens: true, listed: true });
    expect(toBob.summary).toContain('from only you to bob (1 person)');
    expect(alice.rules(ha)[ha]).toEqual([]);

    await text('set_access', { hub: ha, path: 'Photos/', audience: { users: [bobState.userId] } });
    const toHub = await text('preview_access', { hub: ha, path: 'Photos/', audience: 'hub' });
    expect(toHub.summary).toContain('to everyone on 127.0.0.1');
    const back = await text('preview_access', { hub: ha, path: 'Photos/', audience: null });
    expect(back).toMatchObject({ files: 2, widens: false });
  }, 60_000);

  it('warns when a download would land in a shared folder, and only then', async () => {
    const h = await hub();
    const alice = await core('alice');
    const bob = await core('bob');
    const ha = (await alice.addHub(h.url, acct('alice'))).hub.id;
    const hb = (await bob.addHub(h.url, acct('bob'))).hub.id;
    // Bob shares a song with the whole hub.
    const bobs = tmp('communal-m12-bob-');
    writeFileSync(join(bobs, 'song.mp3'), 'la la la');
    await bob.addShare('Songs', bobs);
    await bob.setRule(hb, 'Songs/', 'hub');
    await until(() => bob.store.counts().hashed === 1, 10_000, 'hashing');
    const hash = bob.store.file('Songs', 'song.mp3')!.hash!;
    // Alice's Music is open to the hub; Music/Private is hers alone.
    const music = tmp('communal-m12-music-');
    mkdirSync(join(music, 'Private'));
    await alice.addShare('Music', music);
    await alice.setRule(ha, 'Music/', 'hub');
    await alice.setRule(ha, 'Music/Private/', 'me');
    const call = await agentOn(alice);
    const api = agentApis.get(alice)!;
    const exposure = (dir: string, inside?: string) =>
      api.get<{ shared: boolean; others?: boolean; path?: string; summary?: string }>(
        `/v1/exposure?${new URLSearchParams({ dir, ...(inside ? { inside } : {}) })}`,
      );

    // A folder that doesn't exist yet, under a path through a symlink (macOS /var → /private/var).
    expect(await exposure(join(music, 'Albums', 'New'), 'Blue/')).toMatchObject({
      shared: true,
      others: true,
      path: 'Music/Albums/New/Blue/',
      summary: expect.stringContaining('everyone on 127.0.0.1'),
    });
    expect(await exposure(join(music, 'Private'), 'x.mp3')).toMatchObject({
      shared: true,
      others: false,
    });
    expect(await exposure(join(music, '.hidden'))).toEqual({ shared: false });
    expect(await exposure(tmp('communal-m12-elsewhere-'))).toEqual({ shared: false });

    // The download itself says so; saving elsewhere doesn't.
    await until(
      async () => (await alice.search({ q: 'song', limit: 10 })).hits.length === 1,
      10_000,
      'search',
    );
    const into = await api.post<{ reshared?: { summary: string } }>('/v1/downloads', {
      hash,
      dest: join(music, 'From Bob'),
    });
    expect(into.reshared?.summary).toContain('your shared folder Music');
    const out = await api.post<{ reshared?: unknown }>('/v1/downloads', {
      hash,
      dest: tmp('communal-m12-out-'),
    });
    expect(out.reshared).toBeUndefined();

    // Agents can ask before choosing.
    const checked = await call('check_destination', { dir: join(music, 'From Bob') });
    expect(JSON.parse((checked.content[0] as { text: string }).text)).toMatchObject({
      others: true,
    });
  }, 60_000);
});
