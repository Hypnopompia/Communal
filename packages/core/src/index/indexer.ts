import { EventEmitter } from 'node:events';
import { lstat, opendir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { pino, type Logger } from 'pino';
import { SharePath } from '@communal/protocol';
import { detect, type Kind } from './detect.js';
import { createHashers, hashFile, type FileHash, type Hashers } from './hasher.js';
import type { FileRow, IndexStore } from './store.js';

export interface IndexerOptions {
  /** How long to batch watcher events before applying them (HANDOFF §5: "every few seconds"). */
  flushMs?: number;
  /** Concurrent type detections during a scan. */
  detectConcurrency?: number;
  /** Files hashed in parallel (helps most with many small files, where I/O latency dominates). */
  hashConcurrency?: number;
  /**
   * Full rescan interval (0 = off). Watchers miss events on network shares and some container
   * bind mounts (deletes, especially); a rescan only stats files, so it's cheap when idle.
   */
  rescanMs?: number;
  log?: Logger;
}

export interface IndexerEvents {
  /** The index changed (files added/removed/hashed); index sync should push. */
  changed: [];
  scanned: [{ share: string; files: number; ms: number }];
}

/** Junk that's never worth sharing. Dotfiles (incl. .git) are skipped too. */
const IGNORED_NAMES = new Set([
  'thumbs.db',
  'desktop.ini',
  '$recycle.bin',
  'system volume information',
]);
const IGNORED_SUFFIXES = ['.part', '.partmap', '.crdownload', '.tmp', '.partial', '.download'];

export function isIgnored(name: string): boolean {
  if (name.startsWith('.')) return true;
  const lower = name.toLowerCase();
  return IGNORED_NAMES.has(lower) || IGNORED_SUFFIXES.some((s) => lower.endsWith(s));
}

/** Local relative path → `/`-separated, or null if the hub could never accept it. */
function toRel(root: string, abs: string): string | null {
  const rel = abs
    .slice(root.length + 1)
    .split(sep)
    .join('/');
  return rel && SharePath.safeParse(`x/${rel}`).success ? rel : null;
}

/**
 * Keeps the local index in step with share folders: a full rescan on start, a watcher for
 * live changes (batched), and a background queue that hashes files (metadata first, hashes
 * later — HANDOFF §5).
 */
export class Indexer extends EventEmitter<IndexerEvents> {
  private readonly o: Required<Omit<IndexerOptions, 'log'>>;
  private readonly log: Logger;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly dirty = new Map<string, Set<string>>();
  private flushTimer?: NodeJS.Timeout;
  private rescanTimer?: NodeJS.Timeout;
  private scanning = false;
  private hashing = false;
  private stopped = false;
  private wake?: () => void;
  private kicked = false;
  /** Files that failed to hash, keyed share/rel → size:mtime, so we don't spin on them. */
  private readonly hashFailures = new Map<string, string>();
  private readonly abort = new AbortController();

  constructor(
    private readonly store: IndexStore,
    opts: IndexerOptions = {},
  ) {
    super();
    this.o = {
      flushMs: 2_000,
      detectConcurrency: 8,
      hashConcurrency: 4,
      rescanMs: 15 * 60_000,
      ...opts,
    };
    this.log = opts.log ?? pino({ name: 'indexer' });
  }

  /** Scans and watches every share, and starts the hashing queue. */
  async start() {
    for (const s of this.store.shares()) await this.addShare(s.name);
    void this.hashLoop();
    if (this.o.rescanMs > 0) {
      this.rescanTimer = setInterval(() => void this.rescanAll(), this.o.rescanMs);
    }
  }

  async stop() {
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.flushTimer);
    clearInterval(this.rescanTimer);
    this.wake?.();
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    this.watchers.clear();
  }

  /** Scans a share now and keeps watching it (the share must already be in the store). */
  async addShare(name: string) {
    await this.scan(name);
    this.watchShare(name);
    this.kick();
  }

  async removeShare(name: string) {
    await this.watchers.get(name)?.close();
    this.watchers.delete(name);
    this.dirty.delete(name);
  }

  progress() {
    return this.store.counts();
  }

  /** Rescans every share; skipped if the previous rescan is still running. */
  async rescanAll() {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    try {
      for (const s of this.store.shares()) {
        if (this.stopped) break;
        await this.scan(s.name);
      }
      this.kick();
    } finally {
      this.scanning = false;
    }
  }

  // ── full scan ─────────────────────────────────────────────────────────────

  async scan(name: string): Promise<number> {
    const share = this.store.share(name);
    if (!share) throw new Error(`no such share: ${name}`);
    const started = Date.now();
    const known = this.store.fileStats(name);
    const seen = new Set<string>();
    const pending: { rel: string; abs: string; size: number; mtime: number }[] = [];

    const walk = async (dir: string): Promise<void> => {
      let handle;
      try {
        handle = await opendir(dir);
      } catch (err) {
        // fs messages embed the full local path; log only the code (HANDOFF §14).
        this.log.warn(
          { share: name, code: (err as NodeJS.ErrnoException).code },
          'cannot read folder',
        );
        return;
      }
      for await (const d of handle) {
        if (isIgnored(d.name)) continue;
        const abs = join(dir, d.name);
        // Symlinks are never followed: they could point outside the share.
        if (d.isDirectory()) {
          await walk(abs);
        } else if (d.isFile()) {
          const rel = toRel(share.root, abs);
          if (!rel) continue;
          const st = await lstat(abs).catch(() => null);
          if (!st?.isFile()) continue;
          seen.add(rel);
          const mtime = Math.floor(st.mtimeMs);
          const prev = known.get(rel);
          if (!prev || prev.size !== st.size || prev.mtime !== mtime) {
            pending.push({ rel, abs, size: st.size, mtime });
          }
        }
      }
    };
    await walk(share.root);

    // Type detection reads a few KB per new/changed file; run a few at a time.
    const detected: { rel: string; size: number; mtime: number; mime: string; kind: Kind }[] = [];
    let i = 0;
    await Promise.all(
      Array.from({ length: this.o.detectConcurrency }, async () => {
        while (i < pending.length) {
          const p = pending[i++]!;
          const t = await detect(p.abs, p.rel.slice(p.rel.lastIndexOf('/') + 1));
          detected.push({ rel: p.rel, size: p.size, mtime: p.mtime, ...t });
        }
      }),
    );

    let removed = 0;
    const unseen = [...known.keys()].filter((rel) => !seen.has(rel));
    const moved = movedFrom(unseen.map((rel) => ({ rel, ...known.get(rel)! })));
    this.store.batch(() => {
      for (const d of detected) {
        this.store.upsertFile({ share: name, ...d });
        const from = known.has(d.rel) ? undefined : moved.get(`${d.size}:${d.mtime}`);
        if (from) this.store.adoptContent(name, d.rel, { share: name, rel: from });
      }
      for (const rel of unseen) if (this.store.removeFile(name, rel)) removed++;
    });
    const ms = Date.now() - started;
    this.log.info(
      { share: name, files: seen.size, changed: detected.length, removed, ms },
      'scan complete',
    );
    this.emit('scanned', { share: name, files: seen.size, ms });
    if (detected.length || removed) this.emit('changed');
    return seen.size;
  }

  // ── live changes ──────────────────────────────────────────────────────────

  private watchShare(name: string) {
    const share = this.store.share(name);
    if (!share || this.watchers.has(name)) return;
    const w = watch(share.root, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (p: string) => p !== share.root && isIgnored(p.slice(p.lastIndexOf(sep) + 1)),
    });
    const mark = (abs: string) => {
      const rel = abs === share.root ? '' : toRel(share.root, abs);
      if (rel !== null) this.touch(name, rel);
    };
    w.on('add', mark)
      .on('change', mark)
      .on('unlink', mark)
      .on('unlinkDir', mark)
      .on('addDir', mark);
    w.on('error', (err) => this.log.warn({ share: name, err: String(err) }, 'watcher error'));
    this.watchers.set(name, w);
  }

  /** Queues a path (file or folder, `''` for the root) for the next batch, as a watcher event does. */
  touch(share: string, rel: string) {
    let set = this.dirty.get(share);
    if (!set) this.dirty.set(share, (set = new Set()));
    set.add(rel);
    this.flushTimer ??= setTimeout(() => void this.flush(), this.o.flushMs);
  }

  /** Applies batched watcher events: re-stat each dirty path and update the index. */
  async flush() {
    this.flushTimer = undefined;
    const batch = [...this.dirty.entries()];
    this.dirty.clear();
    let changed = false;
    for (const [name, rels] of batch) {
      const share = this.store.share(name);
      if (!share) continue;
      const added: Omit<FileRow, 'hash'>[] = [];
      const gone: string[] = [];
      for (const rel of rels) {
        const abs = rel === '' ? share.root : join(share.root, ...rel.split('/'));
        const st = await lstat(abs).catch(() => null);
        if (st?.isFile()) {
          const prev = this.store.file(name, rel);
          const mtime = Math.floor(st.mtimeMs);
          if (!prev || prev.size !== st.size || prev.mtime !== mtime) {
            const t = await detect(abs, rel.slice(rel.lastIndexOf('/') + 1));
            added.push({ share: name, rel, size: st.size, mtime, ...t });
          }
        } else if (st?.isDirectory()) {
          // A folder appeared (moved in): a scan picks up everything inside it.
          await this.scan(name);
        } else {
          gone.push(rel); // or replaced by something unshareable
        }
      }
      // Additions first, so a file renamed within this batch keeps its hash (see movedFrom).
      const moved = movedFrom(
        gone.flatMap((rel) => {
          const f = this.store.file(name, rel);
          return f ? [f] : [];
        }),
      );
      this.store.batch(() => {
        for (const f of added) {
          const isNew = !this.store.file(name, f.rel);
          this.store.upsertFile(f);
          const from = isNew ? moved.get(`${f.size}:${f.mtime}`) : undefined;
          if (from) this.store.adoptContent(name, f.rel, { share: name, rel: from });
          changed = true;
        }
        // Drop the file, or everything under a folder that went away.
        for (const rel of gone) {
          if (this.store.removeFile(name, rel)) changed = true;
          if (this.store.removeUnder(name, rel) > 0) changed = true;
        }
      });
    }
    if (changed) {
      this.emit('changed');
      this.kick();
    }
  }

  // ── hashing ───────────────────────────────────────────────────────────────

  private kick() {
    this.kicked = true;
    this.wake?.();
  }

  private async hashLoop() {
    if (this.hashing) return;
    this.hashing = true;
    let lastEmit = Date.now();
    let pendingEmit = false;
    const pool = await Promise.all(Array.from({ length: this.o.hashConcurrency }, createHashers));
    // Results are written once per batch: a transaction per file is dominated by commit cost.
    // The batch must be committed before the next nextUnhashed() query or files get re-hashed.
    const done: { f: FileRow; h: FileHash }[] = [];
    const commit = () => {
      if (done.length === 0) return;
      this.store.batch(() => {
        for (const { f, h } of done) {
          const ok = this.store.setHash(f.share, f.rel, f, h.hash, h.chunkHashes);
          if (ok) pendingEmit = true;
        }
      });
      done.length = 0;
    };
    while (!this.stopped) {
      this.kicked = false;
      const batch = this.store
        .nextUnhashed(200)
        .filter((f) => this.hashFailures.get(`${f.share}/${f.rel}`) !== `${f.size}:${f.mtime}`);
      if (batch.length === 0) {
        if (pendingEmit) this.emit('changed');
        pendingEmit = false;
        // A kick between the query above and now must not be lost.
        if (this.kicked) continue;
        await new Promise<void>((r) => (this.wake = r));
        this.wake = undefined;
        continue;
      }
      let next = 0;
      await Promise.all(
        pool.map(async (hashers) => {
          while (next < batch.length && !this.stopped) {
            const f = batch[next++]!;
            await this.hashOne(f, hashers, done);
          }
        }),
      );
      if (this.stopped) break;
      commit();
      // Publish hashes in batches rather than one delta per file.
      if (pendingEmit && Date.now() - lastEmit > 1_000) {
        this.emit('changed');
        pendingEmit = false;
        lastEmit = Date.now();
      }
    }
    this.hashing = false;
  }

  private async hashOne(f: FileRow, hashers: Hashers, done: { f: FileRow; h: FileHash }[]) {
    const share = this.store.share(f.share);
    if (!share) return;
    const abs = join(share.root, ...f.rel.split('/'));
    try {
      const st = await lstat(abs);
      if (!st.isFile() || st.size !== f.size || Math.floor(st.mtimeMs) !== f.mtime) {
        // Changed since indexed; let the watcher/scan path refresh metadata first.
        this.touch(f.share, f.rel);
        this.hashFailures.set(`${f.share}/${f.rel}`, `${f.size}:${f.mtime}`);
        return;
      }
      done.push({ f, h: await hashFile(abs, this.abort.signal, hashers) });
    } catch (err) {
      if (this.stopped) return;
      this.hashFailures.set(`${f.share}/${f.rel}`, `${f.size}:${f.mtime}`);
      this.log.warn(
        { share: f.share, code: (err as NodeJS.ErrnoException).code },
        'could not hash file',
      );
    }
  }
}

/**
 * Removed files by size:mtime, for spotting renames and moves: a new file with exactly the
 * same size and modification time (to the millisecond) as one that just went away is taken to
 * be that file. Ambiguous signatures (two removed files alike) are left out.
 */
function movedFrom(removed: { rel: string; size: number; mtime: number }[]): Map<string, string> {
  const out = new Map<string, string>();
  const dup = new Set<string>();
  for (const f of removed) {
    const k = `${f.size}:${f.mtime}`;
    if (out.has(k)) dup.add(k);
    out.set(k, f.rel);
  }
  for (const k of dup) out.delete(k);
  return out;
}
