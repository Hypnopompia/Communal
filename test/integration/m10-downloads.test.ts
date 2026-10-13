/**
 * Download destinations and folder downloads (ADR 0018): a downloads folder the person chooses
 * (kept across restarts, overridden by "Save to…"), and a whole folder downloaded once with its
 * structure, copying content this computer already has instead of fetching it again.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPair, type KeyPair } from '@communal/crypto';
import { CommunalCore, CoreError } from '@communal/core';
import { HubDb } from '@communal/hub';
import { sleep, startTestHub, type TestHub } from '@communal/hub/testing';

const quiet = pino({ level: process.env.M10_LOG ?? 'silent' });
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
  const dir = tmp('communal-m10-hub-');
  const db = new HubDb(join(dir, 'hub.db'));
  const t = await startTestHub({ dir, db, silenceMs: 10_000 });
  cleanups.push(async () => {
    await t.close();
    db.close();
  });
  return t;
}

async function core(name: string, opts: { dataDir?: string; device?: KeyPair } = {}) {
  const dataDir = opts.dataDir ?? tmp(`communal-m10-${name}-`);
  const device = opts.device ?? generateKeyPair();
  const c = new CommunalCore({
    dataDir,
    device,
    downloadsDir: join(dataDir, 'usual-downloads'),
    hubClient: { pingIntervalMs: 1_000, silenceMs: 10_000, backoff: { initialMs: 50, maxMs: 300 } },
    indexer: { flushMs: 100 },
    peer: { loopback: true },
    downloads: { retryMs: 300, chunkTimeoutMs: 5_000 },
    log: quiet,
  });
  let stopped = false;
  cleanups.push(() => (stopped ? undefined : c.stop()));
  await c.start();
  return Object.assign(c, {
    async restart() {
      stopped = true;
      await c.stop();
      return core(name, { dataDir, device });
    },
  });
}

async function until(cond: () => boolean | Promise<boolean>, ms: number, label: () => string) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label()}`);
    await sleep(25);
  }
}

const acct = (n: string) => ({
  display_name: n,
  device_name: `${n}-box`,
  platform: 'linux' as const,
});

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(join(d, e.name), 'utf8');
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

async function writeTree(root: string, files: Record<string, string>) {
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    await writeFile(join(root, rel), data);
  }
}

/** Waits until `c`'s files are hashed and the hub lists `n` hashed entries of its. */
async function settled(h: TestHub, c: CommunalCore, n: number) {
  await until(
    async () => {
      await c.sync.idle();
      const counts = c.store.counts();
      const onHub = h.db.raw
        .prepare('SELECT count(*) FROM entries WHERE device_id = ? AND hash IS NOT NULL')
        .pluck()
        .get(c.deviceId);
      return counts.files === n && counts.hashed === n && onHub === n;
    },
    15_000,
    () => `${n} hashed files on the hub`,
  );
}

const MUSIC = {
  'Albums/Blue/01 Intro.mp3': 'one',
  'Albums/Blue/02 Song.mp3': 'two',
  'Albums/Blue/Bonus/03 Live.mp3': 'three',
  'Albums/Red/01.mp3': 'red',
};

/** Alice shares Music with everyone on the hub; Bob joins the hub. */
async function aliceAndBob() {
  const h = await hub();
  const alice = await core('alice');
  const aliceHub = (await alice.addHub(h.url, acct('alice'))).hub.id;
  const music = tmp('communal-m10-music-');
  await writeTree(music, MUSIC);
  await alice.addShare('Music', music);
  await alice.setRule(aliceHub, 'Music/', 'hub');
  await settled(h, alice, Object.keys(MUSIC).length);
  const bob = await core('bob');
  const bobHub = (await bob.addHub(h.url, acct('bob'))).hub.id;
  return { h, alice, aliceHub, music, bob, bobHub };
}

const doneFiles = (c: CommunalCore) => c.store.transfers().filter((t) => t.state === 'done').length;

describe('M10: download destinations and folder downloads', () => {
  it('saves into the chosen downloads folder, kept across restarts; Save to… wins', async () => {
    const { alice, bob } = await aliceAndBob();
    const hash = alice.store.file('Music', 'Albums/Red/01.mp3')!.hash!;

    expect(bob.downloadsDir).toBe(bob.defaultDownloadsDir);
    const chosen = join(tmp('communal-m10-chosen-'), 'Incoming'); // created on demand
    await bob.updateSettings({ downloads_dir: chosen });
    expect(bob.downloadsDir).toBe(chosen);
    await expect(bob.updateSettings({ downloads_dir: 'relative/path' })).rejects.toThrow(CoreError);

    const bob2 = await bob.restart();
    expect(bob2.downloadsDir).toBe(chosen);
    await until(
      () => bob2.hubs.list().every((x) => x.ready),
      10_000,
      () => 'bob back on the hub',
    );
    await bob2.download(hash);
    const elsewhere = tmp('communal-m10-save-to-');
    await bob2.download(hash, { destDir: elsewhere });
    await until(
      () => doneFiles(bob2) === 2,
      15_000,
      () => 'two downloads',
    );
    expect(tree(chosen)).toEqual({ '01.mp3': 'red' });
    expect(tree(elsewhere)).toEqual({ '01.mp3': 'red' });

    await bob2.updateSettings({ downloads_dir: null });
    expect(bob2.downloadsDir).toBe(bob2.defaultDownloadsDir);
  });

  it('downloads a folder with its subfolders, copying content it already has', async () => {
    const { h, alice, bob, bobHub } = await aliceAndBob();
    // Bob already has "02 Song.mp3" under another name, in a folder he shares.
    const mine = tmp('communal-m10-bob-share-');
    await writeTree(mine, { 'song i had.mp3': 'two' });
    await bob.addShare('Mine', mine);
    await settled(h, bob, 1);

    const r = await bob.downloadFolder(bobHub, alice.deviceId, 'Music/Albums/Blue/');
    expect(r).toMatchObject({ queued: 2, copied: 1, skipped: 0, unprepared: 0, bytes: 8 });
    expect(r.dest).toBe(join(bob.downloadsDir, 'Blue'));
    await until(
      () => doneFiles(bob) === 2,
      15_000,
      () => 'the folder download',
    );
    expect(tree(r.dest)).toEqual({
      '01 Intro.mp3': 'one',
      '02 Song.mp3': 'two',
      'Bonus/03 Live.mp3': 'three',
    });
    // Only the two missing files were fetched.
    expect(bob.store.transfers()).toHaveLength(2);

    // Again: everything is already there, nothing new is queued or copied.
    const again = await bob.downloadFolder(bobHub, alice.deviceId, 'Music/Albums/Blue');
    expect(again).toMatchObject({ queued: 0, copied: 0, skipped: 3 });
    expect(bob.store.transfers()).toHaveLength(2);

    // Into a folder of Bob's choosing.
    const elsewhere = tmp('communal-m10-folder-to-');
    const there = await bob.downloadFolder(bobHub, alice.deviceId, 'Music/Albums/Red/', {
      destDir: elsewhere,
    });
    expect(there.dest).toBe(join(elsewhere, 'Red'));
    await until(
      () => doneFiles(bob) === 3,
      15_000,
      () => 'the second folder download',
    );
    expect(tree(elsewhere)).toEqual({ 'Red/01.mp3': 'red' });
  });

  it('refuses folders it cannot see, and folders on this computer', async () => {
    const { alice, aliceHub, bob, bobHub } = await aliceAndBob();
    await alice.setRule(aliceHub, 'Music/Albums/Red/', 'me');
    await expect(
      bob.downloadFolder(bobHub, alice.deviceId, 'Music/Albums/Red/'),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      bob.downloadFolder(bobHub, alice.deviceId, 'Music/Nothing here/'),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(bob.downloadFolder(bobHub, bob.deviceId, 'Mine/')).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(bob.store.transfers()).toHaveLength(0);
  });
});
