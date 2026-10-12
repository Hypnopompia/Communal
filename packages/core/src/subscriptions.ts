import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, rename, rmdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pino, type Logger } from 'pino';
import { toBase32 } from '@communal/crypto';
import type { HubBody } from '@communal/protocol';
import { CoreError } from './errors.js';
import { HubError } from './hub-client.js';
import type { HubManager } from './hub-manager.js';
import type { IndexStore, LocalStamp, SubFileRow, SubscriptionRow } from './index/store.js';
import { safeName, uniquePath, type Downloads } from './transfer/downloader.js';

/** Moves a file to the OS trash (recoverable), never deletes it outright (HANDOFF §5). */
export type TrashFn = (path: string) => Promise<void>;

export const osTrash: TrashFn = async (path) => {
  const { default: trash } = await import('trash');
  await trash(path, { glob: false });
};

export interface SubscriptionOptions {
  store: IndexStore;
  hubs: HubManager;
  downloads: Downloads;
  /** Default parent of a subscription's destination folder. */
  downloadsDir: string;
  /** Where deleted files go (default: the OS trash). Tests pass their own. */
  trash?: TrashFn;
  /** How often to ask again about folders the hub refused (access may come back). */
  retryMs?: number;
  log?: Logger;
}

type WatchEvent = HubBody<'watch.event'>;
type Entry = WatchEvent['added'][number] & { hash: string };

const newSubId = () => 's_' + toBase32(randomBytes(10));

/** Subscriptions are to folders: `Photos` and `Photos/` are the same one. */
const folder = (p: string) => (p.endsWith('/') ? p : p + '/');

/**
 * Folder subscriptions (HANDOFF §5 "Subscriptions", ADR 0013). Each one follows a folder on
 * another device through one hub: the hub sends `watch.event`s (catch-up from our cursor on
 * every sign-in, then live), and we
 * - download files we don't have yet, or copy them when we already hold the same content;
 * - replace our copy when the file changes at the source;
 * - with `mirror_deletes`, move our copy to the OS trash when it's deleted at the source.
 *
 * A local file the user has changed or moved since we wrote it is never replaced or trashed.
 * Losing access stops new downloads (they fail as "no longer available") and leaves existing
 * files alone: the hub never reports lost access as deletions.
 *
 * Events for one subscription are applied one at a time, and its cursor only moves once an
 * event is fully applied, so a crash replays at most the last event (applying is idempotent).
 */
export class Subscriptions {
  private readonly log: Logger;
  private readonly trash: TrashFn;
  private readonly queues = new Map<string, Promise<void>>();
  private retryTimer?: NodeJS.Timeout;

  constructor(private readonly o: SubscriptionOptions) {
    this.log = o.log ?? pino({ name: 'subscriptions' });
    this.trash = o.trash ?? osTrash;
    o.hubs.on('ready', ({ hub }) => {
      for (const s of o.store.subscriptions())
        if (s.hub === hub && !s.paused) void this.watch(s).catch(() => undefined);
    });
    o.hubs.on('event', ({ hub, msg }) => {
      if (msg.t !== 'watch.event') return;
      const sub = o.store.findSubscription(hub, msg.body.device_id, msg.body.path);
      if (sub && !sub.paused) this.enqueue(sub.id, () => this.apply(sub.id, msg.body));
    });
    o.downloads.on('done', ({ id, path }) => this.onTransfer(id, path));
    o.downloads.on('failed', ({ id }) => this.onTransfer(id, null));
  }

  /**
   * Settles downloads that finished or were cancelled while we weren't looking, and starts
   * asking again, now and then, about folders the hub refused.
   */
  start() {
    for (const f of this.o.store.pendingSubFiles()) {
      const t = f.transfer_id ? this.o.store.transfer(f.transfer_id) : undefined;
      if (!t || t.state === 'failed' || t.state === 'cancelled')
        this.onTransfer(f.transfer_id, null);
      else if (t.state === 'done') this.onTransfer(t.id, t.final_path);
    }
    this.retryTimer = setInterval(
      () => {
        for (const s of this.o.store.subscriptions())
          if (s.status === 'no_access' && !s.paused) void this.watch(s).catch(() => undefined);
      },
      this.o.retryMs ?? 10 * 60_000,
    );
  }

  async stop() {
    clearInterval(this.retryTimer);
    await this.idle();
  }

  /** Resolves once every queued event and completion has been applied. */
  async idle(): Promise<void> {
    while (this.queues.size > 0) await Promise.all(this.queues.values());
  }

  list(): (SubscriptionRow & { files: Record<SubFileRow['state'], number> })[] {
    return this.o.store
      .subscriptions()
      .map((s) => ({ ...s, files: this.o.store.subFileCounts(s.id) }));
  }

  /**
   * Follows `path` on `device` through `hub`. The hub checks access first; a folder we can't
   * see is "not found". Files land under `dest` (default: downloads/<folder name>).
   */
  async add(o: {
    hub: string;
    device: string;
    path: string;
    dest?: string;
    mirrorDeletes: boolean;
    recursive?: boolean;
  }): Promise<SubscriptionRow> {
    const client = this.o.hubs.get(o.hub);
    if (!client) throw new CoreError('not_found', `no such hub: ${o.hub}`);
    if (!client.ready) throw new CoreError('unavailable', 'hub is offline');
    const path = folder(o.path);
    if (this.o.store.findSubscription(o.hub, o.device, path))
      throw new CoreError('conflict', 'already subscribed to that folder');
    const leaf = path.slice(0, -1).split('/').pop()!;
    const dest = resolve(o.dest ?? join(this.o.downloadsDir, safeName(leaf)));
    await mkdir(dest, { recursive: true });
    const id = newSubId();
    this.o.store.addSubscription({
      id,
      hub: o.hub,
      device_id: o.device,
      path,
      recursive: o.recursive ?? true,
      dest_dir: dest,
      mirror_deletes: o.mirrorDeletes,
    });
    try {
      await this.watch(this.o.store.subscription(id)!);
    } catch (err) {
      this.o.store.removeSubscription(id);
      if (err instanceof HubError && err.code === 'not_found')
        throw new CoreError('not_found', 'no such folder, or it is not shared with you');
      throw err;
    }
    this.log.info({ sub_id: id, hub: o.hub, device: o.device }, 'subscribed');
    return this.o.store.subscription(id)!;
  }

  /** Changes `mirror_deletes` (applies to later deletions) or pauses / resumes following. */
  async update(id: string, patch: { mirror_deletes?: boolean; paused?: boolean }) {
    const sub = this.o.store.subscription(id);
    if (!sub) throw new CoreError('not_found', 'no such subscription');
    this.o.store.updateSubscription(id, patch);
    if (patch.paused === undefined || patch.paused === sub.paused) return;
    if (patch.paused) await this.unwatch(sub);
    else await this.watch(this.o.store.subscription(id)!).catch(() => undefined);
  }

  /** Stops following. Files already here stay; queued downloads are cancelled. */
  async remove(id: string) {
    const sub = this.o.store.subscription(id);
    if (!sub) throw new CoreError('not_found', 'no such subscription');
    await this.unwatch(sub);
    await this.queues.get(id);
    for (const f of this.o.store.pendingSubFiles())
      if (f.sub_id === id && f.transfer_id) this.o.downloads.cancel(f.transfer_id);
    this.o.store.removeSubscription(id);
    this.log.info({ sub_id: id }, 'unsubscribed');
  }

  /** Drops every subscription through a hub we're leaving. */
  async forgetHub(hub: string) {
    for (const s of this.o.store.subscriptions()) if (s.hub === hub) await this.remove(s.id);
  }

  // ── talking to the hub ────────────────────────────────────────────────────

  /** (Re)starts the hub's watch from our cursor. Throws if the hub refuses. */
  private async watch(sub: SubscriptionRow) {
    const client = this.o.hubs.get(sub.hub);
    if (!client?.ready) return;
    try {
      await client.request('watch', {
        device_id: sub.device_id,
        path: sub.path,
        recursive: sub.recursive,
        mirror_deletes: sub.mirror_deletes,
        since_rev: sub.rev,
      });
      if (sub.status !== 'ok') this.o.store.updateSubscription(sub.id, { status: 'ok' });
    } catch (err) {
      if (err instanceof HubError && err.code === 'not_found') {
        // Deleted, or not shared with us any more. Kept, in case access comes back.
        this.o.store.updateSubscription(sub.id, { status: 'no_access' });
      } else {
        this.log.warn({ sub_id: sub.id, err: (err as Error).message }, 'watch failed');
      }
      throw err;
    }
  }

  private async unwatch(sub: SubscriptionRow) {
    const client = this.o.hubs.get(sub.hub);
    if (!client?.ready) return;
    await client
      .request('unwatch', { device_id: sub.device_id, path: sub.path })
      .catch(() => undefined);
  }

  // ── applying events ───────────────────────────────────────────────────────

  private enqueue(id: string, fn: () => Promise<void>) {
    const next = (this.queues.get(id) ?? Promise.resolve())
      .then(fn)
      .catch((err: Error) =>
        this.log.warn({ sub_id: id, err: err.message }, 'subscription step failed'),
      );
    this.queues.set(id, next);
    void next.then(() => {
      if (this.queues.get(id) === next) this.queues.delete(id);
    });
  }

  private async apply(id: string, ev: WatchEvent) {
    const sub = this.o.store.subscription(id);
    if (!sub || sub.paused) return;
    // Removals are looked at after additions, so a file moved at the source can be moved
    // here too rather than trashed and fetched again.
    const leaving = new Map<string, SubFileRow>();
    for (const p of ev.removed) {
      const f = this.o.store.subFile(id, p);
      if (f) leaving.set(p, f);
    }
    for (const e of ev.added) {
      if (!e.hash || !e.path.startsWith(sub.path)) continue;
      await this.added(sub, e as Entry, leaving).catch((err: Error) => {
        this.log.warn({ sub_id: id, err: err.message }, 'could not fetch a subscribed file');
      });
    }
    for (const f of leaving.values()) await this.removed(sub, f);
    this.o.store.updateSubscription(id, { rev: ev.rev, status: 'ok' });
    if (ev.added.length || ev.removed.length)
      this.log.info(
        { sub_id: id, rev: ev.rev, added: ev.added.length, removed: ev.removed.length },
        'subscription updated',
      );
  }

  private async added(sub: SubscriptionRow, e: Entry, leaving: Map<string, SubFileRow>) {
    const cur = this.o.store.subFile(sub.id, e.path);
    if (cur?.hash === e.hash) {
      if (cur.state === 'pending' || cur.state === 'done') return;
      // Deleted at the source and back again, and our kept copy is untouched.
      if (cur.state === 'removed' && cur.local && (await intact(cur.local))) {
        this.o.store.putSubFile({ ...cur, state: 'done' });
        return;
      }
    }
    // A new version at this path: the old download is moot, and our copy gets replaced.
    if (cur?.state === 'pending' && cur.transfer_id) this.o.downloads.cancel(cur.transfer_id);
    const prev =
      cur?.state === 'done' || cur?.state === 'removed' ? cur.local : (cur?.prev ?? null);
    const row: SubFileRow = {
      sub_id: sub.id,
      path: e.path,
      hash: e.hash,
      state: 'pending',
      transfer_id: null,
      local: null,
      prev,
    };
    const { dir, name } = this.target(sub, e.path);
    await mkdir(dir, { recursive: true });

    // Content we already hold (moved at the source, a duplicate, or in our own shares).
    const have = await this.localCopy(sub, e, leaving);
    if (have) {
      const into = await uniquePath(dir, name);
      let moved = false;
      if (have.move) {
        moved = await rename(have.path, into).then(
          () => true,
          () => false, // e.g. another file system: copy instead
        );
        if (moved) {
          leaving.delete(have.move.path);
          this.o.store.deleteSubFile(sub.id, have.move.path);
        }
      }
      if (!moved) await copyFile(have.path, into);
      await this.place(sub, row, into);
      return;
    }
    const t = this.o.downloads.add({ hash: e.hash, name, destDir: dir });
    this.o.store.putSubFile({ ...row, transfer_id: t.id });
  }

  private async removed(sub: SubscriptionRow, f: SubFileRow) {
    if (f.state === 'removed') return; // already handled (hubs may repeat a deletion)
    if (f.state === 'pending' && f.transfer_id) this.o.downloads.cancel(f.transfer_id);
    const ours = [f.state === 'done' ? f.local : null, f.prev].filter((x) => x !== null);
    const keep: LocalStamp[] = [];
    for (const copy of ours) {
      if (sub.mirror_deletes && (await intact(copy))) {
        await this.trash(copy.path);
        await this.pruneDirs(sub, dirname(copy.path));
      } else if (await exists(copy.path)) keep.push(copy);
    }
    // Without mirror_deletes the copy stays, remembered in case the file comes back.
    if (keep[0])
      this.o.store.putSubFile({
        ...f,
        state: 'removed',
        transfer_id: null,
        local: keep[0],
        prev: null,
      });
    else this.o.store.deleteSubFile(sub.id, f.path);
  }

  private onTransfer(transferId: string | null, finalPath: string | null) {
    const f = transferId ? this.o.store.subFileByTransfer(transferId) : undefined;
    if (!f) return;
    this.enqueue(f.sub_id, async () => {
      const cur = this.o.store.subFile(f.sub_id, f.path);
      const sub = this.o.store.subscription(f.sub_id);
      if (!cur || !sub || cur.transfer_id !== transferId) return; // superseded
      if (!finalPath || !(await exists(finalPath))) {
        this.o.store.putSubFile({ ...cur, state: 'failed', transfer_id: null });
        return;
      }
      await this.place(sub, cur, finalPath);
    });
  }

  /**
   * Records a new file at `at` as done. When it replaces a previous version that's still as we
   * left it, the old one goes to the trash and the new one takes its name.
   */
  private async place(sub: SubscriptionRow, f: SubFileRow, at: string) {
    let final = at;
    if (f.prev && (await intact(f.prev))) {
      await this.trash(f.prev.path);
      const want = join(this.target(sub, f.path).dir, this.target(sub, f.path).name);
      if (at !== want && !(await exists(want))) {
        await rename(at, want);
        final = want;
      }
    }
    const st = await stat(final);
    this.o.store.putSubFile({
      ...f,
      state: 'done',
      transfer_id: null,
      local: { path: final, size: st.size, mtime: Math.floor(st.mtimeMs) },
      prev: null,
    });
  }

  /** Where a file of the owner's folder goes locally (each segment made safe). */
  private target(sub: SubscriptionRow, path: string): { dir: string; name: string } {
    const segs = path.slice(sub.path.length).split('/').map(safeName);
    const name = segs.pop()!;
    return { dir: join(sub.dest_dir, ...segs), name };
  }

  /** A local file with this content we can copy, or move when it's leaving this folder. */
  private async localCopy(
    sub: SubscriptionRow,
    e: Entry,
    leaving: Map<string, SubFileRow>,
  ): Promise<{ path: string; move?: SubFileRow } | null> {
    for (const f of leaving.values()) {
      if (f.hash === e.hash && f.state === 'done' && f.local && (await intact(f.local)))
        return { path: f.local.path, ...(sub.mirror_deletes ? { move: f } : {}) };
    }
    for (const f of this.o.store.subFilesWithHash(e.hash))
      if (f.local && (await intact(f.local))) return { path: f.local.path };
    for (const c of this.o.store.anyCopy(e.hash)) {
      const p = join(c.root, ...c.rel.split('/'));
      if (await intact({ path: p, size: c.size, mtime: c.mtime })) return { path: p };
    }
    return null;
  }

  /** Removes folders emptied by deletions, up to (not including) the destination root. */
  private async pruneDirs(sub: SubscriptionRow, dir: string) {
    while (relative(sub.dest_dir, dir) && !relative(sub.dest_dir, dir).startsWith('..')) {
      if (
        !(await rmdir(dir).then(
          () => true,
          () => false,
        ))
      )
        return;
      dir = dirname(dir);
    }
  }
}

/** Whether a file is still exactly as we left it (same size and modification time). */
async function intact(s: LocalStamp): Promise<boolean> {
  const st = await stat(s.path).catch(() => null);
  return !!st && st.isFile() && st.size === s.size && Math.floor(st.mtimeMs) === s.mtime;
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
