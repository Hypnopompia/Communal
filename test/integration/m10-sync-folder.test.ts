/**
 * The synced folder (ADR 0019): turned on once per computer, it keeps a `Communal` folder the
 * same on all of an account's computers, two-way, with deletions going to the trash and
 * conflicting edits kept side by side under the same name everywhere.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPair, type KeyPair } from '@communal/crypto';
import { CommunalCore, conflictName, hashFile, SYNC_MARKER, SYNC_STAGING } from '@communal/core';
import { HubDb } from '@communal/hub';
import { sleep, startTestHub, type TestHub } from '@communal/hub/testing';

const quiet = pino({ level: process.env.M10_LOG ?? 'silent' });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A fresh folder, by its real path (macOS: /var is /private/var), as shares record it. */
function tmp(prefix: string) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function hub(): Promise<TestHub> {
  const dir = tmp('communal-sync-hub-');
  const db = new HubDb(join(dir, 'hub.db'));
  const t = await startTestHub({ dir, db, silenceMs: 10_000 });
  cleanups.push(async () => {
    await t.close();
    db.close();
  });
  return t;
}

type Core = CommunalCore & { trashed: string[]; restart(): Promise<Core>; halt(): Promise<void> };

async function core(name: string, opts: { dataDir?: string; device?: KeyPair } = {}) {
  const dataDir = opts.dataDir ?? tmp(`communal-sync-${name}-`);
  const device = opts.device ?? generateKeyPair();
  const trashDir = tmp(`communal-sync-trash-${name}-`);
  const trashed: string[] = [];
  const c = new CommunalCore({
    dataDir,
    device,
    hubClient: { pingIntervalMs: 1_000, silenceMs: 10_000, backoff: { initialMs: 50, maxMs: 300 } },
    indexer: { flushMs: 100 },
    peer: { loopback: true },
    downloads: { retryMs: 300, chunkTimeoutMs: 5_000 },
    subscriptions: {
      retryMs: 300,
      trash: async (p) => {
        trashed.push(basename(p));
        await rename(p, join(trashDir, `${trashed.length}-${basename(p)}`));
      },
    },
    syncFolder: { refreshMs: 200 },
    log: quiet.child({ dev: name }),
  });
  let stopped = false;
  cleanups.push(() => (stopped ? undefined : c.stop()));
  await c.start();
  const halt = async () => {
    stopped = true;
    await c.stop();
  };
  return Object.assign(c, {
    trashed,
    halt,
    async restart() {
      await halt();
      return core(name, { dataDir, device });
    },
  }) as Core;
}

async function until(cond: () => boolean | Promise<boolean>, ms: number, label: () => string) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label()}`);
    await sleep(25);
  }
}

/** A folder tree as sorted relative paths → contents, without the staging folder and marker. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (e.name === SYNC_STAGING || e.name === SYNC_MARKER) continue;
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(join(d, e.name), 'utf8');
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

const sortKeys = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Waits until every computer's synced folder holds exactly `want`. */
async function allHold(cores: Core[], want: Record<string, string>) {
  for (const c of cores) {
    const root = c.syncFolder.state().path!;
    await until(
      async () => {
        await c.subscriptions.idle();
        return JSON.stringify(tree(root)) === JSON.stringify(sortKeys(want));
      },
      20_000,
      () =>
        `${c.deviceId.slice(0, 8)} to hold ${JSON.stringify(want)} (has ${JSON.stringify(tree(root))})`,
    );
  }
}

/** Waits until the hub lists `rel` with this content for every one of `cores`. */
async function published(h: TestHub, cores: Core[], rel: string, hash: string) {
  await until(
    () =>
      cores.every(
        (c) =>
          h.db.raw
            .prepare('SELECT hash FROM entries WHERE device_id = ? AND path = ?')
            .pluck()
            .get(c.deviceId, `Communal/${rel}`) === hash,
      ),
    20_000,
    () => `every computer to list ${rel}`,
  );
}

/** Waits until each computer follows each of the others. */
async function meshed(cores: Core[]) {
  for (const c of cores)
    await until(
      () =>
        c.syncFolder.state().devices.filter((d) => d.status === 'ok').length === cores.length - 1,
      15_000,
      () =>
        `${c.deviceId.slice(0, 8)} to follow the others (${JSON.stringify(c.syncFolder.state())})`,
    );
}

/** One account with `names.length` computers on one hub. */
async function account(h: TestHub, names: string[]) {
  const first = await core(names[0]!);
  const hubId = (
    await first.addHub(h.url, {
      display_name: 'alice',
      device_name: names[0]!,
      platform: 'linux',
    })
  ).hub.id;
  const all = [first];
  for (const n of names.slice(1)) {
    const c = await core(n);
    const { code } = await first.createLinkCode(hubId);
    await Promise.all([
      c.link(h.url, code, n),
      (async () => {
        await until(
          () => first.linkRequests().length > 0,
          10_000,
          () => 'link request',
        );
        await first.approveLink(first.linkRequests()[0]!.request_id);
      })(),
    ]);
    all.push(c);
  }
  return { hubId, cores: all };
}

describe('the synced folder', () => {
  it('keeps a folder the same on three computers: adds, edits, folders and deletions', async () => {
    const h = await hub();
    const { cores } = await account(h, ['desk', 'laptop', 'nas']);
    const [desk, laptop, nas] = cores as [Core, Core, Core];
    const roots = cores.map(() => join(tmp('communal-sync-home-'), 'Communal'));
    // Each starts with a file of its own, and one they all have.
    for (const [i, c] of cores.entries()) {
      await mkdir(roots[i]!, { recursive: true });
      await writeFile(join(roots[i]!, `from-${['desk', 'laptop', 'nas'][i]}.txt`), `hi ${i}`);
      await writeFile(join(roots[i]!, 'same.txt'), 'same everywhere');
      const st = await c.syncFolder.enable(roots[i]);
      expect(st).toMatchObject({ enabled: true, path: roots[i] });
    }
    await meshed(cores);
    let want: Record<string, string> = {
      'from-desk.txt': 'hi 0',
      'from-laptop.txt': 'hi 1',
      'from-nas.txt': 'hi 2',
      'same.txt': 'same everywhere',
    };
    await allHold(cores, want);
    // Only "only me": nobody else on the hub can see it.
    expect(desk.rules()[desk.hubs.list()[0]!.id]).toEqual([]);

    // A new file in a new folder on the laptop reaches both others. The NAS hears about it
    // from the laptop and from the desk, and downloads it once.
    await mkdir(join(roots[1]!, 'notes'));
    await writeFile(join(roots[1]!, 'notes', 'todo.txt'), 'buy milk');
    want = { ...want, 'notes/todo.txt': 'buy milk' };
    await allHold(cores, want);
    const todoHash = (await hashFile(join(roots[1]!, 'notes', 'todo.txt'))).hash;
    expect(nas.store.transfers().filter((t) => t.hash === todoHash).length).toBeLessThanOrEqual(1);

    // An edit on the NAS replaces the others' copies (the old one goes to the trash).
    await writeFile(join(roots[2]!, 'notes', 'todo.txt'), 'buy oat milk');
    want = { ...want, 'notes/todo.txt': 'buy oat milk' };
    await allHold(cores, want);
    expect(desk.trashed).toContain('todo.txt');

    // A deletion on the desk goes to the trash everywhere; the emptied folder goes too. (Once
    // every computer has told the others it has the edit: deleting sooner crosses the edit,
    // which the next test covers.)
    await published(
      h,
      cores,
      'notes/todo.txt',
      (await hashFile(join(roots[2]!, 'notes', 'todo.txt'))).hash,
    );
    await rm(join(roots[0]!, 'notes'), { recursive: true });
    delete want['notes/todo.txt'];
    await allHold(cores, want);
    expect(existsSync(join(roots[1]!, 'notes'))).toBe(false);
    expect(laptop.trashed).toContain('todo.txt');

    // Nothing half-placed ever reached the hub.
    const staged = h.db.raw
      .prepare("SELECT count(*) FROM entries WHERE path LIKE '%communal-incoming%'")
      .pluck()
      .get();
    expect(staged).toBe(0);
  }, 60_000);

  it('never fetches another computer’s marker file', async () => {
    const h = await hub();
    const { cores } = await account(h, ['desk', 'laptop']);
    const [desk, laptop] = cores as [Core, Core];
    const deskRoot = join(tmp('communal-sync-home-'), 'Communal');
    const laptopRoot = join(tmp('communal-sync-home-'), 'Communal');
    await laptop.syncFolder.enable(laptopRoot);
    // Markers can differ (another version's text, or edited): still nothing to trade.
    await writeFile(join(laptopRoot, SYNC_MARKER), 'an older marker');
    await writeFile(join(laptopRoot, 'a.txt'), 'a');
    await desk.syncFolder.enable(deskRoot);
    await meshed([desk, laptop]);
    await allHold([desk, laptop], { 'a.txt': 'a' });
    expect(desk.store.transfers().filter((t) => t.name === SYNC_MARKER)).toEqual([]);
    expect(laptop.store.transfers().filter((t) => t.name === SYNC_MARKER)).toEqual([]);
    expect(await readFile(join(laptopRoot, SYNC_MARKER), 'utf8')).toBe('an older marker');
    expect(readdirSync(deskRoot).filter((n) => n.includes('conflicted'))).toEqual([]);
  });

  it('keeps both versions of a file edited on two computers, named alike on both', async () => {
    const h = await hub();
    const { cores } = await account(h, ['desk', 'laptop']);
    const desk = cores[0]!;
    let laptop = cores[1]!;
    const deskRoot = join(tmp('communal-sync-home-'), 'Communal');
    const laptopRoot = join(tmp('communal-sync-home-'), 'Communal');
    await desk.syncFolder.enable(deskRoot);
    await writeFile(join(deskRoot, 'plan.txt'), 'v1');
    await laptop.syncFolder.enable(laptopRoot);
    await meshed([desk, laptop]);
    await allHold([desk, laptop], { 'plan.txt': 'v1' });

    // The laptop goes away; both edit the plan. The desk's edit is the newer one.
    await laptop.halt();
    await writeFile(join(laptopRoot, 'plan.txt'), 'v2 from the laptop');
    await utimes(join(laptopRoot, 'plan.txt'), new Date(), new Date('2026-03-01T10:00:00Z'));
    await writeFile(join(deskRoot, 'plan.txt'), 'v2 from the desk');
    await utimes(join(deskRoot, 'plan.txt'), new Date(), new Date('2026-03-02T10:00:00Z'));
    laptop = await laptop.restart();

    const loser = (await hashFile(join(laptopRoot, 'plan.txt'))).hash;
    const aside = conflictName('plan.txt', loser, Date.parse('2026-03-01T10:00:00Z') / 1000);
    expect(aside).toMatch(/^plan \(conflicted copy 2026-03-01 [0-9a-f]{6}\)\.txt$/);
    const want = { 'plan.txt': 'v2 from the desk', [aside]: 'v2 from the laptop' };
    await allHold([desk, laptop], want);

    // And it stays that way: no more copies appear.
    for (let i = 0; i < 3; i++) {
      await sleep(300);
      await allHold([desk, laptop], want);
    }

    // A deletion and an edit cross: the desk deletes the plan while the laptop, away, edits it.
    // The edit survives on both, either restored under its name (the desk heard of the edit
    // first) or as a conflicted copy (the laptop heard of the deletion first).
    await published(
      h,
      [desk, laptop],
      'plan.txt',
      (await hashFile(join(deskRoot, 'plan.txt'))).hash,
    );
    await laptop.halt();
    await rm(join(deskRoot, 'plan.txt'));
    await writeFile(join(laptopRoot, 'plan.txt'), 'v3 from the laptop');
    await utimes(join(laptopRoot, 'plan.txt'), new Date(), new Date('2026-03-03T10:00:00Z'));
    const edit = (await hashFile(join(laptopRoot, 'plan.txt'))).hash;
    laptop = await laptop.restart();
    const kept = conflictName('plan.txt', edit, Date.parse('2026-03-03T10:00:00Z') / 1000);
    const outcomes = [
      { [aside]: 'v2 from the laptop', 'plan.txt': 'v3 from the laptop' },
      { [aside]: 'v2 from the laptop', [kept]: 'v3 from the laptop' },
    ].map((o) => JSON.stringify(sortKeys(o)));
    await until(
      async () => {
        await desk.subscriptions.idle();
        await laptop.subscriptions.idle();
        const d = JSON.stringify(tree(deskRoot));
        return d === JSON.stringify(tree(laptopRoot)) && outcomes.includes(d);
      },
      20_000,
      () =>
        `the same outcome on both (${JSON.stringify(tree(deskRoot))} / ${JSON.stringify(tree(laptopRoot))})`,
    );
  }, 60_000);

  it('takes over hand-made subscriptions, and stops when a computer turns it off', async () => {
    const h = await hub();
    const { cores } = await account(h, ['desk', 'laptop']);
    const [desk, laptop] = cores as [Core, Core];
    const deskRoot = tmp('communal-sync-desk-');
    const laptopRoot = tmp('communal-sync-laptop-');
    await writeFile(join(deskRoot, 'a.txt'), 'aaa');
    // How it was done by hand before: a share named Communal on each, and a subscription from
    // the laptop to the desk's (without deletions).
    await laptop.addShare('Communal', laptopRoot);
    await desk.addShare('Communal', deskRoot);
    const manual = await laptop.subscriptions.add({
      hub: laptop.hubs.list()[0]!.id,
      device: desk.deviceId,
      path: 'Communal/',
      dest: laptopRoot,
      mirrorDeletes: false,
    });
    // Sharing a folder named Communal is turning it on: both now sync both ways.
    await meshed([desk, laptop]);
    expect(laptop.subscriptions.list().find((s) => s.id === manual.id)).toMatchObject({
      sync: true,
      mirror_deletes: true,
    });
    await writeFile(join(laptopRoot, 'b.txt'), 'bbb');
    await allHold([desk, laptop], { 'a.txt': 'aaa', 'b.txt': 'bbb' });

    // The desk turns it off: the laptop stops following it, and every file stays.
    await desk.syncFolder.disable();
    expect(desk.syncFolder.state()).toMatchObject({ enabled: false, devices: [] });
    await until(
      () => laptop.syncFolder.state().devices.length === 0,
      15_000,
      () => 'the laptop to stop following the desk',
    );
    expect(tree(deskRoot)).toEqual({ 'a.txt': 'aaa', 'b.txt': 'bbb' });
    expect(tree(laptopRoot)).toEqual({ 'a.txt': 'aaa', 'b.txt': 'bbb' });
    expect(desk.trashed).toEqual([]);
    expect(laptop.trashed).toEqual([]);
  }, 60_000);
});
