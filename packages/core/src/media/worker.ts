import { EventEmitter } from 'node:events';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { pino, type Logger } from 'pino';
import type { IndexStore, MediaTodo } from '../index/store.js';
import { analysable, analyze, render, THUMB_SIZE, type ThumbSize } from './analyze.js';
import type { ThumbStore } from './thumbs.js';

export interface MediaOptions {
  /** Files analysed at once (ffmpeg and pdf.js are CPU-heavy). */
  concurrency?: number;
  /** How often to delete thumbnails of content no share holds any more. */
  gcMs?: number;
  log?: Logger;
}

export interface MediaEvents {
  /** Metadata or thumbnails changed; index sync should push. */
  changed: [];
}

/**
 * Metadata and thumbnails, after hashing (HANDOFF §9: "generated in the background after
 * hashing"). Waits while hashing is still going, so a big first index isn't slowed down, and
 * logs an index change only when something visible changed.
 */
export class MediaWorker extends EventEmitter<MediaEvents> {
  private readonly log: Logger;
  private readonly o: Required<Omit<MediaOptions, 'log'>>;
  private stopped = false;
  private wake?: () => void;
  private kicked = false;
  private gcTimer?: NodeJS.Timeout;
  /** Previews being rendered on demand, so concurrent requests share one render. */
  private readonly rendering = new Map<string, Promise<Buffer | null>>();

  constructor(
    private readonly store: IndexStore,
    private readonly thumbs: ThumbStore,
    opts: MediaOptions = {},
  ) {
    super();
    this.o = { concurrency: 2, gcMs: 6 * 3600_000, ...opts };
    this.log = opts.log ?? pino({ name: 'media' });
  }

  start() {
    void this.loop();
    const gc = () =>
      void this.thumbs
        .gc(this.store.liveHashes())
        .then((n) => n && this.log.info({ removed: n }, 'old thumbnails removed'))
        .catch(() => {});
    gc();
    this.gcTimer = setInterval(gc, this.o.gcMs);
    this.gcTimer.unref();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.gcTimer);
    this.wake?.();
  }

  /** New hashes arrived (the indexer changed something). */
  kick() {
    this.kicked = true;
    this.wake?.();
  }

  private hashingPending(): boolean {
    return !!this.store.raw.prepare('SELECT 1 FROM files WHERE hash IS NULL LIMIT 1').get();
  }

  private async loop() {
    let visible = false;
    let lastEmit = 0;
    while (!this.stopped) {
      this.kicked = false;
      const batch = this.hashingPending() ? [] : this.store.nextMedia(100);
      if (batch.length === 0) {
        if (visible) this.emit('changed');
        visible = false;
        if (this.kicked) continue;
        // Re-check now and then: hashing finishing doesn't kick us.
        await new Promise<void>((r) => {
          this.wake = r;
          setTimeout(r, 1_000).unref();
        });
        this.wake = undefined;
        continue;
      }
      let next = 0;
      await Promise.all(
        Array.from({ length: this.o.concurrency }, async () => {
          while (next < batch.length && !this.stopped) {
            if (await this.one(batch[next++]!)) visible = true;
          }
        }),
      );
      if (visible && Date.now() - lastEmit > 1_000) {
        this.emit('changed');
        visible = false;
        lastEmit = Date.now();
      }
    }
  }

  private async one(f: MediaTodo): Promise<boolean> {
    if (!analysable(f.kind, f.mime)) return this.store.setMedia(f, {}, false);
    const abs = join(f.root, ...f.rel.split('/'));
    const same = async () => {
      const st = await lstat(abs).catch(() => null);
      return !!st?.isFile() && st.size === f.size && Math.floor(st.mtimeMs) === f.mtime;
    };
    if (!(await same())) return this.store.setMedia(f, {}, false);
    const { meta, thumb } = await analyze(abs, f.mime, f.kind, f.size);
    // The file changed while we read it: the indexer will re-hash it and we'll come back.
    if (this.stopped || !(await same())) return false;
    if (thumb) await this.thumbs.put(f.hash, THUMB_SIZE, thumb).catch(() => {});
    return this.store.setMedia(f, meta, thumb !== null);
  }

  /**
   * A thumbnail or preview of `hash` from a local copy: the stored one, or rendered now (the
   * 1600 px preview is made on demand, HANDOFF §9). null when no copy is previewable.
   */
  async thumbnail(hash: string, size: ThumbSize): Promise<Buffer | null> {
    const stored = await this.thumbs.get(hash, size);
    if (stored) return stored;
    const key = `${hash}-${size}`;
    let p = this.rendering.get(key);
    if (!p) {
      p = this.renderNow(hash, size).finally(() => this.rendering.delete(key));
      this.rendering.set(key, p);
    }
    return p;
  }

  private async renderNow(hash: string, size: ThumbSize): Promise<Buffer | null> {
    for (const c of this.store.anyCopy(hash)) {
      // A 320 px thumbnail exists only if the media worker made one; don't retry failures.
      if (size === THUMB_SIZE && c.thumb !== 1) continue;
      const abs = join(c.root, ...c.rel.split('/'));
      const st = await lstat(abs).catch(() => null);
      if (!st?.isFile() || st.size !== c.size || Math.floor(st.mtimeMs) !== c.mtime) continue;
      const out = await render(abs, c.mime, c.kind, c.size, size);
      if (out) {
        await this.thumbs.put(hash, size, out).catch(() => {});
        return out;
      }
    }
    return null;
  }
}
