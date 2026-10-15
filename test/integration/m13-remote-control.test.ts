/**
 * Remote control (ADR 0023): a phone asks one of your computers to download something. Requests
 * go through the hub as sealed, signed `device.message`s between devices of one account; the
 * computer only acts while its Remote control setting is on, and only for its own account.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPair, sealTo, toB64 } from '@communal/crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CommunalCore, LocalApi, LocalApiClient, RemoteError, apiSocketPath } from '@communal/core';
import { createServer } from '@communal/mcp';
import type { RemoteTransfer } from '@communal/protocol';
import { sleep, startTestHub, type TestHub } from '@communal/hub/testing';

const quiet = pino({ level: process.env.M13_LOG ?? 'silent' });
const hubTimers = {
  pingIntervalMs: 1_000,
  silenceMs: 10_000,
  backoff: { initialMs: 50, maxMs: 300 },
};

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
  const t = await startTestHub({ silenceMs: 10_000 });
  cleanups.push(() => t.close());
  return t;
}

async function core(name: string) {
  const c = new CommunalCore({
    dataDir: tmp(`communal-m13-${name}-`),
    device: generateKeyPair(),
    hubClient: hubTimers,
    indexer: { flushMs: 100 },
    peer: { loopback: true },
    downloads: { retryMs: 300, chunkTimeoutMs: 5_000, answerTimeoutMs: 2_000 },
    log: quiet,
  });
  let stopped = false;
  const stop = async () => {
    if (!stopped) await c.stop();
    stopped = true;
  };
  cleanups.push(stop);
  await c.start();
  return Object.assign(c, { stopNow: stop });
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

/** Links a new core to `owner`'s account, approving the request on the owner. */
async function link(owner: CommunalCore, ownerHub: string, url: string, name: string) {
  const c = await core(name);
  const { code } = await owner.createLinkCode(ownerHub);
  const approve = (async () => {
    await until(() => owner.linkRequests().length > 0, 10_000, 'link request');
    await owner.approveLink(owner.linkRequests()[0]!.request_id);
  })();
  await Promise.all([c.link(url, code, name), approve]);
  await until(() => c.hubs.list().every((h) => h.ready), 10_000, `${name} signed in`);
  return c;
}

/**
 * Alice's desktop and phone on one hub, and Bob (a connection) sharing a song with her:
 * the file her phone asks the desktop to fetch.
 */
async function world() {
  const h = await hub();
  const desktop = await core('desktop');
  const hubId = (await desktop.addHub(h.url, acct('alice'))).hub.id;
  const phone = await link(desktop, hubId, h.url, 'Pixel');
  const bob = await core('bob');
  const bobHub = (await bob.addHub(h.url, acct('bob'))).hub.id;
  const alice = desktop.account!.user_id;
  await bob.people.request(bobHub, alice);
  await until(async () => (await desktop.people.connections(hubId)).length > 0, 10_000, 'request');
  await desktop.people.accept(hubId, bob.account!.user_id);
  const music = tmp('communal-m13-music-');
  await writeFile(join(music, 'song.mp3'), 'not really an mp3, but bytes all the same');
  await bob.addShare('Music', music);
  await bob.setRule(bobHub, 'Music/', 'hub');
  let hash = '';
  await until(
    async () => {
      const r = await phone.search({ q: 'song', limit: 10 });
      hash = r.hits[0]?.hash ?? '';
      return hash !== '';
    },
    15_000,
    'song indexed',
  );
  return { h, hubId, desktop, phone, bob, hash };
}

describe('remote control', () => {
  it('lists the account’s other devices, and asks first whether remote control is on', async () => {
    const { desktop, phone } = await world();
    const devices = await phone.remote.devices();
    expect(devices).toEqual([
      expect.objectContaining({ device_id: desktop.deviceId, name: 'alice-box', online: true }),
    ]);
    expect(await phone.remote.request(desktop.deviceId, { op: 'hello' })).toEqual({
      allowed: false,
      destinations: ['Downloads'],
    });
  });

  it('refuses everything but hello while the setting is off', async () => {
    const { desktop, phone, hash } = await world();
    await expect(
      phone.remote.request(desktop.deviceId, { op: 'download', hash }),
    ).rejects.toMatchObject({ code: 'not_allowed' });
    expect(desktop.downloads.list()).toEqual([]);
  });

  it('downloads to the computer, shows who asked, and reports progress back', async () => {
    const { desktop, phone, hash } = await world();
    await desktop.updateSettings({ remote_control: true });
    const started = (await phone.remote.request(desktop.deviceId, {
      op: 'download',
      hash,
    })) as { id: string; name: string };
    expect(started.name).toBe('song.mp3');
    await until(
      () => desktop.downloads.list().some((t) => t.state === 'done'),
      15_000,
      'download done',
    );
    const t = desktop.downloads.list()[0]!;
    expect(t.requested_by).toBe('Pixel');
    expect(await readFile(t.final_path!, 'utf8')).toContain('bytes all the same');
    // The phone never gets the file, only the progress, and no local paths.
    expect(phone.downloads.list()).toEqual([]);
    const r = (await phone.remote.request(desktop.deviceId, { op: 'transfers' })) as {
      transfers: RemoteTransfer[];
    };
    expect(r.transfers[0]).toMatchObject({ id: started.id, state: 'done', requested_by: 'Pixel' });
    expect(JSON.stringify(r)).not.toContain(desktop.downloadsDir);
  });

  it('follows a folder from the computer when asked', async () => {
    const { h, desktop, phone, bob } = await world();
    await desktop.updateSettings({ remote_control: true });
    const r = (await phone.remote.request(desktop.deviceId, {
      op: 'subscribe',
      hub: h.url,
      device_id: bob.deviceId,
      path: 'Music/',
      mirror_deletes: false,
    })) as { id: string };
    expect(desktop.subscriptions.list().map((s) => s.id)).toEqual([r.id]);
    await expect(
      phone.remote.request(desktop.deviceId, {
        op: 'subscribe',
        hub: 'wss://elsewhere.example/v1',
        device_id: bob.deviceId,
        path: 'Music/',
        mirror_deletes: false,
      }),
    ).rejects.toBeInstanceOf(RemoteError);
  });

  it('ignores messages from another account and forged or replayed ones', async () => {
    const { desktop, phone, bob, hash } = await world();
    await desktop.updateSettings({ remote_control: true });
    // Bob's devices aren't Alice's: the hub won't even forward to them.
    await expect(bob.remote.request(desktop.deviceId, { op: 'hello' })).rejects.toMatchObject({
      code: 'not_found',
    });
    // Junk sealed to the desktop's key, sent from Alice's own phone, is dropped unanswered.
    const client = phone.hubs.get(phone.hubs.list()[0]!.id)!;
    await client.request('device.message', {
      to: desktop.deviceId,
      sealed: sealTo(generateKeyPair().publicKey, new Uint8Array(100)),
    });
    await client.request('device.message', {
      to: desktop.deviceId,
      sealed: toB64(new Uint8Array(200)),
    });
    await sleep(200);
    expect(desktop.downloads.list()).toEqual([]);
    // A real request still works afterwards.
    await phone.remote.request(desktop.deviceId, { op: 'download', hash });
    expect(desktop.downloads.list()).toHaveLength(1);
  });

  it('says so when the computer is offline', async () => {
    const { desktop, phone } = await world();
    await phone.remote.devices();
    await desktop.stopNow();
    await expect(phone.remote.request(desktop.deviceId, { op: 'hello' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('links a phone that reaches the hub under another address, without joining it twice', async () => {
    const h = await hub();
    const desktop = await core('desktop');
    const hubId = (await desktop.addHub(h.url, acct('alice'))).hub.id;
    // The desktop knows the hub as 127.0.0.1; the phone reaches it as localhost.
    const phone = await link(desktop, hubId, h.url.replace('127.0.0.1', 'localhost'), 'Pixel');
    expect(phone.hubs.list()).toHaveLength(1);
  });

  it('saves into a named destination when asked, and never into a path (ADR 0018)', async () => {
    const { h, desktop, phone, bob, hash } = await world();
    await desktop.updateSettings({ remote_control: true });
    const movies = tmp('communal-m13-movies-');
    await desktop.saveDestination('Movies', movies);
    expect(await phone.remote.request(desktop.deviceId, { op: 'hello' })).toEqual({
      allowed: true,
      destinations: ['Downloads', 'Movies'],
    });
    // Any case; the file lands in the folder the name stands for.
    await phone.remote.request(desktop.deviceId, { op: 'download', hash, destination: 'movies' });
    await until(
      () => desktop.downloads.list().some((t) => t.state === 'done'),
      15_000,
      'download done',
    );
    expect(desktop.downloads.list()[0]!.final_path).toBe(join(movies, 'song.mp3'));
    // A path is just an unknown name, or too long to be one (a temp folder's path is short on
    // Linux and long on macOS, so it can be either).
    for (const destination of ['../etc', 'Music', '/tmp', movies])
      await expect(
        phone.remote.request(desktop.deviceId, { op: 'download', hash, destination }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(not_found|bad_request)$/) });
    await expect(
      phone.remote.request(desktop.deviceId, { op: 'download', hash, destination: 'x'.repeat(41) }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(desktop.downloads.list()).toHaveLength(1);
    // A followed folder goes to <destination>/<folder name>.
    const s = (await phone.remote.request(desktop.deviceId, {
      op: 'subscribe',
      hub: h.url,
      device_id: bob.deviceId,
      path: 'Music/',
      mirror_deletes: false,
      destination: 'Movies',
    })) as { id: string };
    expect(desktop.subscriptions.list().find((x) => x.id === s.id)!.dest_dir).toBe(
      join(movies, 'Music'),
    );
  });

  it('keeps destinations sane: names, the built-in Downloads, renames and removal', async () => {
    const desktop = await core('desktop');
    const a = tmp('communal-m13-a-');
    const b = tmp('communal-m13-b-');
    await desktop.saveDestination('TV', a);
    await expect(desktop.saveDestination('tv', b)).rejects.toMatchObject({ code: 'conflict' });
    await expect(desktop.saveDestination('Downloads', b)).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(desktop.saveDestination('a/b', b)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(desktop.saveDestination('Rel', 'relative/path')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await desktop.saveDestination('TV Shows', b, 'tv');
    expect(desktop.destinations().map((d) => [d.name, d.path, d.builtin])).toEqual([
      ['Downloads', desktop.downloadsDir, true],
      ['TV Shows', b, false],
    ]);
    await desktop.removeDestination('tv shows');
    expect(desktop.destinations()).toHaveLength(1);
    await expect(desktop.removeDestination('Downloads')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('can keep other devices out of the downloads folder, offering only named destinations', async () => {
    const { desktop, phone, hash } = await world();
    const movies = tmp('communal-m13-movies-');
    await desktop.saveDestination('Movies', movies);
    await desktop.updateSettings({ remote_control: true, remote_downloads: false });
    expect(await phone.remote.request(desktop.deviceId, { op: 'hello' })).toEqual({
      allowed: true,
      destinations: ['Movies'],
    });
    // No destination no longer means the downloads folder: an older app asking that way is
    // refused rather than guessed at.
    await expect(
      phone.remote.request(desktop.deviceId, { op: 'download', hash }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      phone.remote.request(desktop.deviceId, { op: 'download', hash, destination: 'downloads' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(desktop.downloads.list()).toEqual([]);
    await phone.remote.request(desktop.deviceId, { op: 'download', hash, destination: 'Movies' });
    expect(desktop.downloads.list()[0]!.dest_dir).toBe(movies);
    // Locally, the downloads folder is still there.
    expect(desktop.destinations()[0]!.name).toBe('Downloads');
  });

  it('lets an AI agent manage destinations and remote control, and use other devices (MCP)', async () => {
    const { desktop, phone, hash } = await world();
    const onDesktop = await agentOn(desktop);
    const onPhone = await agentOn(phone);
    const movies = tmp('communal-m13-movies-');
    const json = (r: Awaited<ReturnType<typeof onDesktop>>) =>
      JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;

    // Off by default; the desktop's agent turns it on, keeping the downloads folder back.
    expect(json(await onDesktop('get_remote_settings'))).toEqual({
      allowed: false,
      downloads: true,
    });
    await onDesktop('save_destination', { name: 'Movies', folder: movies });
    expect(
      json(await onDesktop('set_remote_settings', { allowed: true, downloads: false })),
    ).toEqual({ allowed: true, downloads: false });

    // The phone's agent sees the desktop and what it offers, by name only.
    const { devices } = json(await onPhone('list_remote_devices')) as {
      devices: { device_id: string; takes_requests: boolean; destinations?: string[] }[];
    };
    expect(devices).toEqual([
      expect.objectContaining({
        device_id: desktop.deviceId,
        takes_requests: true,
        destinations: ['Movies'],
      }),
    ]);
    // A path is refused before anything is sent; a destination by name works.
    expect(
      (await onPhone('download_file', { hash, dest: movies, on_device: 'alice-box' })).isError,
    ).toBe(true);
    const r = await onPhone('download_file', {
      hash,
      destination: 'Movies',
      on_device: 'alice-box',
    });
    expect(r.isError).toBeFalsy();
    await until(
      () => desktop.downloads.list().some((t) => t.state === 'done'),
      15_000,
      'download done',
    );
    expect(desktop.downloads.list()[0]!.dest_dir).toBe(movies);
    const t = json(await onPhone('list_transfers', { on_device: desktop.deviceId })) as {
      transfers: { requested_by: string }[];
    };
    expect(t.transfers[0]!.requested_by).toBe('Pixel');

    await onDesktop('remove_destination', { name: 'Movies' });
    expect(desktop.destinations().map((d) => d.name)).toEqual(['Downloads']);
  });
});

/** An AI agent on `c`, through its local API and the MCP server. */
async function agentOn(c: CommunalCore) {
  const api = new LocalApi(c);
  const socketPath = apiSocketPath(tmp('communal-m13-sock-'));
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
  return async (name: string, args: Record<string, unknown> = {}) =>
    (await agent.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: 'text'; text: string }[];
    };
}
