/**
 * Agent tools beyond ADR 0017 (ADR 0021): thumbnails an agent can look at, through the same
 * access checks as the app; reading part of a file, waiting for a download, explaining access.
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

  it('reads part of a file, waits for its download and explains who can see it', async () => {
    const h = await hub();
    const alice = await core('alice');
    const bob = await core('bob');
    await alice.addHub(h.url, acct('alice'));
    const hb = (await bob.addHub(h.url, acct('bob'))).hub.id;
    // Bob shares a log with the hub, and keeps a diary to himself.
    const shared = tmp('communal-m12-logs-');
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n') + '\nTHE END\n';
    writeFileSync(join(shared, 'server.log'), lines);
    await png(join(shared, 'pic.png'), 40, 30, 3);
    mkdirSync(join(shared, 'Private'));
    writeFileSync(join(shared, 'Private', 'diary.txt'), 'dear diary');
    await bob.addShare('Logs', shared);
    await bob.setRule(hb, 'Logs/', 'hub');
    await bob.setRule(hb, 'Logs/Private/', 'me');
    await until(() => bob.store.counts().hashed === 3, 10_000, 'hashing');
    const log = bob.store.file('Logs', 'server.log')!.hash!;
    const pic = bob.store.file('Logs', 'pic.png')!.hash!;
    const diary = bob.store.file('Logs', 'Private/diary.txt')!.hash!;
    await until(
      async () => (await alice.search({ q: 'server', limit: 10 })).hits.length === 1,
      10_000,
      'search',
    );

    const call = await agentOn(alice);
    const json = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await call(name, args);
      const text = (r.content[0] as { text: string }).text;
      if (r.isError) throw new Error(text);
      return JSON.parse(text) as Record<string, unknown>;
    };

    const start = await json('read_file_part', { hash: log, offset: 7, length: 6 });
    expect(start).toEqual({ start: 7, end: 12, size: lines.length, text: 'line 1' });
    const tail = await json('read_file_part', { hash: log, length: 8, from_end: true });
    expect(tail).toMatchObject({ text: 'THE END\n', end: lines.length - 1 });
    expect(await json('read_file_part', { hash: pic, length: 8 })).toMatchObject({
      binary: true,
      base64: Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').toString('base64'),
    });
    await expect(json('read_file_part', { hash: log, offset: lines.length + 10 })).rejects.toThrow(
      /past the end/,
    );
    // Bob's computer refuses what alice may not see.
    await expect(json('read_file_part', { hash: diary })).rejects.toThrow();
    await expect(json('read_file_part', { hash: log, length: 64 * 1024 + 1 })).rejects.toThrow();

    // A download, waited for.
    const dest = tmp('communal-m12-dl-');
    const { download } = (await json('download_file', { hash: log, dest })) as {
      download: { id: string };
    };
    expect(await json('wait_for_transfer', { id: download.id, timeout_seconds: 30 })).toMatchObject(
      { id: download.id, state: 'done' },
    );
    expect(await json('clear_finished_transfers')).toMatchObject({ cleared: 1 });
    await expect(json('wait_for_transfer', { id: download.id })).rejects.toThrow(/no download/);

    // Bob's agent sees who took it, then clears his log.
    const bobCall = await agentOn(bob);
    const bobJson = async (name: string, args: Record<string, unknown> = {}) =>
      JSON.parse(((await bobCall(name, args)).content[0] as { text: string }).text) as {
        log?: { path: string }[];
        cleared?: number;
      } & Record<string, unknown>;
    await until(
      async () => ((await bobJson('get_activity', { path: 'Logs/' })).log ?? []).length > 0,
      10_000,
      'upload log',
    );
    expect((await bobJson('get_activity', { path: 'Nope/' })).log).toEqual([]);
    expect((await bobJson('clear_activity')).cleared).toBeGreaterThan(0);
    expect((await bobJson('get_activity')).log).toEqual([]);

    // Why can people see it?
    expect(
      await bobJson('explain_access', { hub: hb, path: 'Logs/Private/diary.txt' }),
    ).toMatchObject({
      rule_path: 'Logs/Private/',
      inherited: true,
      audience: { audience: 'me', label: 'only you' },
    });
    const open = await bobJson('explain_access', { hub: hb, path: 'Logs/server.log' });
    expect(open).toMatchObject({ rule_path: 'Logs/', listed: true });
    expect(open.summary).toContain('everyone on 127.0.0.1');
    expect((await bobCall('explain_access', { hub: hb, path: 'Nope/x' })).isError).toBe(true);

    // The thumbnail cache.
    expect(
      await json('set_thumbnail_cache', { max_bytes: 32 * 1024 * 1024, clear: true }),
    ).toMatchObject({ thumb_cache: { bytes: 0, cap: 32 * 1024 * 1024 } });
  }, 60_000);
});
