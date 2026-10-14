import Database from 'better-sqlite3';
import type { RevocationProof } from '@communal/crypto';
import type { Kind } from './detect.js';
import type { TransferDiagnosis } from '../transfer/diagnosis.js';

export type Audience = 'me' | 'hub' | { users?: string[]; groups?: string[] };

/**
 * The client's local index (one SQLite file per core): shares, the files in them, their
 * hashes, and a change log that per-hub index sync replays (docs/adr/0008-indexing.md).
 * Local paths live only here; hubs see `ShareName/relative/path`.
 */

export interface ShareRow {
  name: string;
  root: string;
  /** Hub ids (HubEntry.id) this share's index is published to. */
  hubs: string[];
  created_at: number;
}

export interface FileRow {
  share: string;
  rel: string;
  size: number;
  mtime: number;
  mime: string;
  kind: Kind;
  hash: string | null;
  /** EntryMeta as JSON, once the media worker has looked at the file (M6). */
  meta?: string | null;
  /** 1 when a 320 px thumbnail exists for this file's hash. */
  thumb?: number;
}

/** A file the media worker should analyse: hashed, of a previewable kind, not done yet. */
export type MediaTodo = FileRow & { hash: string; root: string };

export interface TransferRow {
  id: string;
  hash: string;
  name: string;
  dest_dir: string;
  size: number | null;
  state: 'queued' | 'active' | 'waiting' | 'done' | 'failed' | 'cancelled';
  bytes_done: number;
  error: string | null;
  final_path: string | null;
  /** The other device of this account that asked for it (remote control, ADR 0023). */
  requested_by: string | null;
  /** Why the last attempt couldn't connect, as diagnosed by the hub (M5). */
  diagnosis: TransferDiagnosis | null;
  created_at: number;
  updated_at: number;
}

export interface UploadLogRow {
  id: number;
  at: number;
  hub: string;
  requester_user: string;
  requester_dev: string;
  path: string;
  hash: string;
  bytes: number;
  status: 'completed' | 'partial' | 'cancelled' | 'denied';
  kind: 'file' | 'thumbnail';
}

/** A followed folder on another device (HANDOFF §5 "Subscriptions", ADR 0013). */
export interface SubscriptionRow {
  id: string;
  hub: string;
  device_id: string;
  /** The owner's folder, `Share/sub/` (always ends with `/`). */
  path: string;
  recursive: boolean;
  dest_dir: string;
  mirror_deletes: boolean;
  paused: boolean;
  /** The owner's index rev the last processed `watch.event` brought us to. */
  rev: number;
  /** `no_access` when the hub last refused the watch (the folder is gone or not shared). */
  status: 'ok' | 'no_access';
  /** Part of the synced folder (ADR 0019): one of your devices' `Communal` folders. */
  sync: boolean;
  created_at: number;
}

/** A local file's identity as we left it, to tell whether the user has touched it since. */
export interface LocalStamp {
  path: string;
  size: number;
  mtime: number;
}

/**
 * One file of a subscription: `pending` (download queued), `done` (at `local`), `failed`
 * (gone or no longer shared when we tried), or `removed` (deleted at the source; the local
 * copy was kept).
 */
export interface SubFileRow {
  sub_id: string;
  /** The owner's share path. */
  path: string;
  hash: string;
  state: 'pending' | 'done' | 'failed' | 'removed';
  transfer_id: string | null;
  local: LocalStamp | null;
  /** The previous version's local copy, replaced once the new one is in (ADR 0013). */
  prev: LocalStamp | null;
  /** The source's modification time (seconds), kept on synced files (ADR 0019). */
  mtime?: number | null;
}

export interface Change {
  seq: number;
  share: string;
  rel: string;
  op: 'upsert' | 'remove';
}

const MIGRATIONS = [
  `
  CREATE TABLE shares (
    name       TEXT PRIMARY KEY,
    root       TEXT NOT NULL,
    hubs       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE files (
    share        TEXT NOT NULL REFERENCES shares (name) ON DELETE CASCADE,
    rel          TEXT NOT NULL,
    size         INTEGER NOT NULL,
    mtime        INTEGER NOT NULL,
    mime         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    hash         TEXT,
    chunk_hashes BLOB,
    PRIMARY KEY (share, rel)
  );
  CREATE INDEX files_unhashed ON files (share, rel) WHERE hash IS NULL;
  CREATE INDEX files_hash ON files (hash);

  -- Append-only log of index changes; per-hub sync remembers the last seq each hub acked.
  CREATE TABLE changes (
    seq   INTEGER PRIMARY KEY AUTOINCREMENT,
    share TEXT NOT NULL,
    rel   TEXT NOT NULL,
    op    TEXT NOT NULL CHECK (op IN ('upsert', 'remove'))
  );

  CREATE TABLE hub_sync (
    hub       TEXT PRIMARY KEY,
    rev       INTEGER NOT NULL,
    acked_seq INTEGER NOT NULL
  );
  `,
  `
  -- Access rules, per hub (ADR 0007/0009). This device's copy is authoritative: it is pushed
  -- to each hub with acl.replace on sign-in, and the uploader enforces it (M4).
  CREATE TABLE acl (
    hub      TEXT NOT NULL,
    path     TEXT NOT NULL,
    audience TEXT NOT NULL,
    PRIMARY KEY (hub, path)
  );

  -- People this user has verified by comparing safety codes out of band.
  CREATE TABLE verified (
    user_id     TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    verified_at INTEGER NOT NULL
  );
  `,
  `
  -- Downloads, so they survive restarts and resume (HANDOFF §7).
  CREATE TABLE transfers (
    id         TEXT PRIMARY KEY,
    hash       TEXT NOT NULL,
    name       TEXT NOT NULL,
    dest_dir   TEXT NOT NULL,
    size       INTEGER,
    state      TEXT NOT NULL CHECK (state IN ('queued', 'active', 'waiting', 'done', 'failed', 'cancelled')),
    bytes_done INTEGER NOT NULL DEFAULT 0,
    error      TEXT,
    final_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Who downloaded what from this device. Local only, never sent to a hub (HANDOFF §2).
  CREATE TABLE upload_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    at             INTEGER NOT NULL,
    hub            TEXT NOT NULL,
    requester_user TEXT NOT NULL,
    requester_dev  TEXT NOT NULL,
    path           TEXT NOT NULL,
    hash           TEXT NOT NULL,
    bytes          INTEGER NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'cancelled', 'denied')),
    kind           TEXT NOT NULL CHECK (kind IN ('file', 'thumbnail'))
  );
  CREATE INDEX upload_log_at ON upload_log (at);
  `,
  `
  -- Why a download couldn't connect (HANDOFF §8 diagnosis, JSON), kept until it completes.
  ALTER TABLE transfers ADD COLUMN diagnosis TEXT;
  `,
  `
  -- M6: metadata and thumbnails, filled by the media worker after hashing (HANDOFF §9).
  ALTER TABLE files ADD COLUMN meta TEXT;
  ALTER TABLE files ADD COLUMN thumb INTEGER NOT NULL DEFAULT 0;
  -- When the media worker last analysed this content (NULL: still to do).
  ALTER TABLE files ADD COLUMN media_at INTEGER;
  CREATE INDEX files_media_todo ON files (share, rel) WHERE hash IS NOT NULL AND media_at IS NULL;

  -- Thumbnails fetched from peers, cached by hash (HANDOFF §9: LRU, size-capped).
  CREATE TABLE thumb_cache (
    hash    TEXT NOT NULL,
    size    INTEGER NOT NULL,
    bytes   INTEGER NOT NULL,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (hash, size)
  );
  CREATE INDEX thumb_cache_lru ON thumb_cache (used_at);
  `,
  `
  -- M7: subscriptions to other devices' folders (ADR 0013).
  CREATE TABLE subscriptions (
    id             TEXT PRIMARY KEY,
    hub            TEXT NOT NULL,
    device_id      TEXT NOT NULL,
    path           TEXT NOT NULL,
    recursive      INTEGER NOT NULL,
    dest_dir       TEXT NOT NULL,
    mirror_deletes INTEGER NOT NULL,
    paused         INTEGER NOT NULL DEFAULT 0,
    rev            INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'ok',
    created_at     INTEGER NOT NULL,
    UNIQUE (hub, device_id, path)
  );
  -- local / prev: JSON {path, size, mtime} of our copy (see LocalStamp).
  CREATE TABLE sub_files (
    sub_id      TEXT NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    hash        TEXT NOT NULL,
    state       TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'removed')),
    transfer_id TEXT,
    local       TEXT,
    prev        TEXT,
    PRIMARY KEY (sub_id, path)
  );
  CREATE INDEX sub_files_hash ON sub_files (hash);
  CREATE INDEX sub_files_transfer ON sub_files (transfer_id) WHERE transfer_id IS NOT NULL;
  `,
  `
  -- M8: revocation proofs we've verified, for our own account and for peers' (ADR 0014).
  CREATE TABLE revocations (
    user_id    TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    proof_json TEXT NOT NULL,
    PRIMARY KEY (user_id, device_id)
  );
  `,
  `
  -- The synced folder (ADR 0019): subscriptions between your devices' Communal folders, and
  -- the source's modification time of each file, which synced copies keep.
  ALTER TABLE subscriptions ADD COLUMN sync INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sub_files ADD COLUMN mtime INTEGER;
  `,
  `
  -- Remote control (ADR 0023): the name of the device that asked for a download, if not us.
  ALTER TABLE transfers ADD COLUMN requested_by TEXT;
  `,
];

const now = () => Math.floor(Date.now() / 1000);

type RawSub = Omit<SubscriptionRow, 'recursive' | 'mirror_deletes' | 'paused' | 'sync'> & {
  recursive: number;
  mirror_deletes: number;
  paused: number;
  sync: number;
};
const parseSub = (r: RawSub): SubscriptionRow => ({
  ...r,
  recursive: r.recursive === 1,
  mirror_deletes: r.mirror_deletes === 1,
  paused: r.paused === 1,
  sync: r.sync === 1,
});
type RawSubFile = Omit<SubFileRow, 'local' | 'prev'> & {
  local: string | null;
  prev: string | null;
};
const parseSubFile = (r: RawSubFile): SubFileRow => ({
  ...r,
  local: r.local ? (JSON.parse(r.local) as LocalStamp) : null,
  prev: r.prev ? (JSON.parse(r.prev) as LocalStamp) : null,
});

type RawTransfer = Omit<TransferRow, 'diagnosis'> & { diagnosis: string | null };
const parseTransfer = (r: RawTransfer): TransferRow => ({
  ...r,
  diagnosis: r.diagnosis ? (JSON.parse(r.diagnosis) as TransferDiagnosis) : null,
});

export class IndexStore {
  readonly raw: Database.Database;

  constructor(file: string) {
    this.raw = new Database(file);
    this.raw.pragma('journal_mode = WAL');
    // The index can always be rebuilt by a rescan, so trade the last few commits on power loss
    // for not fsyncing every write (still corruption-safe in WAL mode).
    this.raw.pragma('synchronous = NORMAL');
    this.raw.pragma('foreign_keys = ON');
    const v = this.raw.pragma('user_version', { simple: true }) as number;
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.raw.transaction(() => {
        this.raw.exec(MIGRATIONS[i]!);
        this.raw.pragma(`user_version = ${i + 1}`);
      })();
    }
  }

  close() {
    this.raw.close();
  }

  // ── shares ────────────────────────────────────────────────────────────────

  addShare(name: string, root: string, hubs: string[]) {
    this.raw
      .prepare('INSERT INTO shares (name, root, hubs, created_at) VALUES (?, ?, ?, ?)')
      .run(name, root, JSON.stringify(hubs), now());
  }

  setShareHubs(name: string, hubs: string[]) {
    this.raw.prepare('UPDATE shares SET hubs = ? WHERE name = ?').run(JSON.stringify(hubs), name);
  }

  /** Removes a share and logs a removal for each of its files so hubs drop them. */
  removeShare(name: string): boolean {
    return this.raw.transaction(() => {
      const rels = this.raw
        .prepare('SELECT rel FROM files WHERE share = ?')
        .pluck()
        .all(name) as string[];
      const log = this.raw.prepare("INSERT INTO changes (share, rel, op) VALUES (?, ?, 'remove')");
      for (const rel of rels) log.run(name, rel);
      return this.raw.prepare('DELETE FROM shares WHERE name = ?').run(name).changes > 0;
    })();
  }

  shares(): ShareRow[] {
    return (
      this.raw.prepare('SELECT * FROM shares ORDER BY name').all() as (Omit<ShareRow, 'hubs'> & {
        hubs: string;
      })[]
    ).map((r) => ({ ...r, hubs: JSON.parse(r.hubs) as string[] }));
  }

  share(name: string): ShareRow | undefined {
    return this.shares().find((s) => s.name === name);
  }

  // ── files ─────────────────────────────────────────────────────────────────

  /** size+mtime for every file in a share, for change detection during a scan. */
  fileStats(share: string): Map<string, { size: number; mtime: number }> {
    const m = new Map<string, { size: number; mtime: number }>();
    for (const r of this.raw
      .prepare('SELECT rel, size, mtime FROM files WHERE share = ?')
      .iterate(share) as Iterable<{
      rel: string;
      size: number;
      mtime: number;
    }>) {
      m.set(r.rel, { size: r.size, mtime: r.mtime });
    }
    return m;
  }

  /** Inserts or updates a file's metadata; a content change clears its hash. Logs the change. */
  upsertFile(f: Omit<FileRow, 'hash'>) {
    this.raw
      .prepare(
        `INSERT INTO files (share, rel, size, mtime, mime, kind) VALUES (@share, @rel, @size, @mtime, @mime, @kind)
         ON CONFLICT (share, rel) DO UPDATE SET
           size = excluded.size, mtime = excluded.mtime, mime = excluded.mime, kind = excluded.kind,
           hash = CASE WHEN files.size = excluded.size AND files.mtime = excluded.mtime THEN files.hash END,
           chunk_hashes = CASE WHEN files.size = excluded.size AND files.mtime = excluded.mtime THEN files.chunk_hashes END,
           meta = CASE WHEN files.size = excluded.size AND files.mtime = excluded.mtime THEN files.meta END,
           thumb = CASE WHEN files.size = excluded.size AND files.mtime = excluded.mtime THEN files.thumb ELSE 0 END,
           media_at = CASE WHEN files.size = excluded.size AND files.mtime = excluded.mtime THEN files.media_at END`,
      )
      .run(f);
    this.logChange(f.share, f.rel, 'upsert');
  }

  removeFile(share: string, rel: string): boolean {
    const gone =
      this.raw.prepare('DELETE FROM files WHERE share = ? AND rel = ?').run(share, rel).changes > 0;
    if (gone) this.logChange(share, rel, 'remove');
    return gone;
  }

  /** Names of the files directly in a folder (`''` for the share root), not in subfolders. */
  fileNamesIn(share: string, dirRel: string): Set<string> {
    const prefix = dirRel === '' ? '' : dirRel.endsWith('/') ? dirRel : dirRel + '/';
    const rels = this.raw
      .prepare(
        // A range on the (share, rel) key rather than a scan of the whole share.
        `SELECT rel FROM files WHERE share = ? AND rel >= ? AND rel < ?
         AND instr(substr(rel, ?), '/') = 0`,
      )
      .pluck()
      .all(share, prefix, prefix + '\u{10ffff}', prefix.length + 1) as string[];
    return new Set(rels.map((r) => r.slice(prefix.length)));
  }

  /** Removes everything under a folder (rel prefix). */
  removeUnder(share: string, dirRel: string): number {
    const prefix = dirRel.endsWith('/') ? dirRel : dirRel + '/';
    const rels = this.raw
      .prepare('SELECT rel FROM files WHERE share = ? AND substr(rel, 1, length(?)) = ?')
      .pluck()
      .all(share, prefix, prefix) as string[];
    for (const rel of rels) this.removeFile(share, rel);
    return rels.length;
  }

  /** Records a hash only if the file still has the size/mtime that was hashed. */
  setHash(
    share: string,
    rel: string,
    expect: { size: number; mtime: number },
    hash: string,
    chunkHashes: Uint8Array,
  ): boolean {
    const ok =
      this.raw
        .prepare(
          'UPDATE files SET hash = ?, chunk_hashes = ? WHERE share = ? AND rel = ? AND size = ? AND mtime = ?',
        )
        .run(hash, Buffer.from(chunkHashes), share, rel, expect.size, expect.mtime).changes > 0;
    if (ok) this.logChange(share, rel, 'upsert');
    return ok;
  }

  /**
   * A file that appeared where another (same size and modification time) just disappeared is
   * the same file moved: it keeps its hash, chunk hashes and media results instead of being
   * hashed again. Call before the old row is removed. Moves then reach hubs as one delta, so
   * subscribers can move their copy too (ADR 0013).
   */
  adoptContent(share: string, rel: string, from: { share: string; rel: string }): boolean {
    return (
      this.raw
        .prepare(
          `UPDATE files SET (hash, chunk_hashes, meta, thumb, media_at) = (
             SELECT o.hash, o.chunk_hashes, o.meta, o.thumb, o.media_at FROM files o
             WHERE o.share = @fs AND o.rel = @fr)
           WHERE share = @share AND rel = @rel AND hash IS NULL AND EXISTS (
             SELECT 1 FROM files o WHERE o.share = @fs AND o.rel = @fr AND o.hash IS NOT NULL
               AND o.size = files.size AND o.mtime = files.mtime)`,
        )
        .run({ share, rel, fs: from.share, fr: from.rel }).changes > 0
    );
  }

  nextUnhashed(limit: number): FileRow[] {
    return this.raw
      .prepare(
        'SELECT share, rel, size, mtime, mime, kind, hash FROM files WHERE hash IS NULL LIMIT ?',
      )
      .all(limit) as FileRow[];
  }

  file(share: string, rel: string): FileRow | undefined {
    return this.raw
      .prepare(
        'SELECT share, rel, size, mtime, mime, kind, hash, meta, thumb FROM files WHERE share = ? AND rel = ?',
      )
      .get(share, rel) as FileRow | undefined;
  }

  counts(): { files: number; hashed: number; bytes: number } {
    return this.raw
      .prepare(
        'SELECT count(*) AS files, count(hash) AS hashed, coalesce(sum(size), 0) AS bytes FROM files',
      )
      .get() as { files: number; hashed: number; bytes: number };
  }

  /**
   * One page of files in the given shares, ordered by (share, rel), after the given key.
   * Paged rather than iterated: better-sqlite3 can't run other statements while an iterator is
   * open, and callers await the network between pages.
   */
  filesPage(
    shares: string[],
    after: { share: string; rel: string } | null,
    limit: number,
  ): FileRow[] {
    if (shares.length === 0) return [];
    const inList = shares.map(() => '?').join(',');
    const cols = 'share, rel, size, mtime, mime, kind, hash, meta, thumb';
    if (!after) {
      return this.raw
        .prepare(`SELECT ${cols} FROM files WHERE share IN (${inList}) ORDER BY share, rel LIMIT ?`)
        .all(...shares, limit) as FileRow[];
    }
    return this.raw
      .prepare(
        `SELECT ${cols} FROM files WHERE share IN (${inList}) AND (share, rel) > (?, ?) ORDER BY share, rel LIMIT ?`,
      )
      .all(...shares, after.share, after.rel, limit) as FileRow[];
  }

  // ── media (M6) ────────────────────────────────────────────────────────────

  /** Hashed files the media worker hasn't analysed yet (any kind; it skips what it can't use). */
  nextMedia(limit: number): MediaTodo[] {
    return this.raw
      .prepare(
        `SELECT f.share, f.rel, f.size, f.mtime, f.mime, f.kind, f.hash, s.root FROM files f
         JOIN shares s ON s.name = f.share WHERE f.hash IS NOT NULL AND f.media_at IS NULL LIMIT ?`,
      )
      .all(limit) as MediaTodo[];
  }

  /**
   * Records what the media worker found, if the file is still the content it analysed. Logs a
   * change (so hubs get the metadata) only when something visible changed.
   */
  setMedia(f: MediaTodo, meta: object, thumb: boolean): boolean {
    const json = JSON.stringify(meta);
    const prev = this.raw
      .prepare('SELECT meta, thumb FROM files WHERE share = ? AND rel = ? AND hash = ?')
      .get(f.share, f.rel, f.hash) as { meta: string | null; thumb: number } | undefined;
    if (!prev) return false;
    this.raw
      .prepare(
        'UPDATE files SET meta = ?, thumb = ?, media_at = ? WHERE share = ? AND rel = ? AND hash = ?',
      )
      .run(json, thumb ? 1 : 0, now(), f.share, f.rel, f.hash);
    const visible = (prev.meta ?? '{}') !== json || prev.thumb !== (thumb ? 1 : 0);
    if (visible) this.logChange(f.share, f.rel, 'upsert');
    return visible;
  }

  /** How far the media worker has got (for `status`). */
  mediaCounts(): { analysed: number; pending: number; thumbs: number } {
    return this.raw
      .prepare(
        `SELECT count(media_at) AS analysed, count(hash) - count(media_at) AS pending,
                coalesce(sum(thumb), 0) AS thumbs FROM files`,
      )
      .get() as { analysed: number; pending: number; thumbs: number };
  }

  /** Every content hash still present in some share (thumbnail garbage collection). */
  liveHashes(): Set<string> {
    return new Set(
      this.raw
        .prepare('SELECT DISTINCT hash FROM files WHERE hash IS NOT NULL')
        .pluck()
        .all() as string[],
    );
  }

  /** Every local copy of `hash`, with the hubs its share is published to. */
  anyCopy(hash: string): (FileRow & { root: string; hubs: string[] })[] {
    return (
      this.raw
        .prepare(
          `SELECT f.share, f.rel, f.size, f.mtime, f.mime, f.kind, f.hash, f.thumb, s.root, s.hubs
           FROM files f JOIN shares s ON s.name = f.share WHERE f.hash = ?`,
        )
        .all(hash) as (FileRow & { root: string; hubs: string })[]
    ).map((r) => ({ ...r, hubs: JSON.parse(r.hubs) as string[] }));
  }

  // ── viewer thumbnail cache ────────────────────────────────────────────────

  cacheTouch(hash: string, size: number, bytes: number) {
    this.raw
      .prepare(
        `INSERT INTO thumb_cache (hash, size, bytes, used_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (hash, size) DO UPDATE SET bytes = excluded.bytes, used_at = excluded.used_at`,
      )
      .run(hash, size, bytes, Date.now());
  }

  cacheHas(hash: string, size: number): boolean {
    return !!this.raw
      .prepare('SELECT 1 FROM thumb_cache WHERE hash = ? AND size = ?')
      .get(hash, size);
  }

  cacheTotal(): number {
    return this.raw
      .prepare('SELECT coalesce(sum(bytes), 0) FROM thumb_cache')
      .pluck()
      .get() as number;
  }

  /** Least recently used entries first, for eviction. */
  cacheOldest(limit: number): { hash: string; size: number; bytes: number }[] {
    return this.raw
      .prepare('SELECT hash, size, bytes FROM thumb_cache ORDER BY used_at LIMIT ?')
      .all(limit) as { hash: string; size: number; bytes: number }[];
  }

  cacheDrop(hash: string, size: number) {
    this.raw.prepare('DELETE FROM thumb_cache WHERE hash = ? AND size = ?').run(hash, size);
  }

  // ── content by hash (serving) ─────────────────────────────────────────────

  /** Local copies of a file, in shares published to `hub`, with their chunk hashes. */
  copiesOf(hash: string, hub: string): (FileRow & { root: string; chunkHashes: Buffer })[] {
    return (
      this.raw
        .prepare(
          `SELECT f.share, f.rel, f.size, f.mtime, f.mime, f.kind, f.hash, f.chunk_hashes AS chunkHashes, s.root, s.hubs
           FROM files f JOIN shares s ON s.name = f.share WHERE f.hash = ? AND f.chunk_hashes IS NOT NULL`,
        )
        .all(hash) as (FileRow & { root: string; chunkHashes: Buffer; hubs: string })[]
    )
      .filter((r) => (JSON.parse(r.hubs) as string[]).includes(hub))
      .map(({ hubs: _h, ...r }) => r);
  }

  // ── transfers ─────────────────────────────────────────────────────────────

  addTransfer(t: {
    id: string;
    hash: string;
    name: string;
    dest_dir: string;
    size: number | null;
    requested_by?: string | null;
  }) {
    const ts = now();
    this.raw
      .prepare(
        `INSERT INTO transfers (id, hash, name, dest_dir, size, state, requested_by, created_at, updated_at)
         VALUES (@id, @hash, @name, @dest_dir, @size, 'queued', @requested_by, @ts, @ts)`,
      )
      .run({ requested_by: null, ...t, ts });
  }

  updateTransfer(
    id: string,
    patch: Partial<
      Pick<TransferRow, 'state' | 'size' | 'bytes_done' | 'error' | 'final_path' | 'diagnosis'>
    >,
  ) {
    const cols = Object.keys(patch);
    if (cols.length === 0) return;
    const values: Record<string, unknown> = { ...patch };
    if (patch.diagnosis !== undefined)
      values.diagnosis = patch.diagnosis ? JSON.stringify(patch.diagnosis) : null;
    this.raw
      .prepare(
        `UPDATE transfers SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @ts WHERE id = @id`,
      )
      .run({ ...values, id, ts: now() });
  }

  transfer(id: string): TransferRow | undefined {
    const row = this.raw.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as
      RawTransfer | undefined;
    return row && parseTransfer(row);
  }

  transfers(states?: TransferRow['state'][]): TransferRow[] {
    const rows = (
      states
        ? this.raw
            .prepare(
              `SELECT * FROM transfers WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY created_at`,
            )
            .all(...states)
        : this.raw.prepare('SELECT * FROM transfers ORDER BY created_at DESC').all()
    ) as RawTransfer[];
    return rows.map(parseTransfer);
  }

  /**
   * Forgets finished downloads (done, failed, cancelled) and returns them. A transfer a
   * subscription is still waiting on stays: it settles that file after a restart.
   */
  clearFinishedTransfers(): TransferRow[] {
    const where = `state IN ('done', 'failed', 'cancelled') AND id NOT IN (
      SELECT transfer_id FROM sub_files WHERE transfer_id IS NOT NULL)`;
    return this.raw.transaction(() => {
      const rows = this.raw
        .prepare(`SELECT * FROM transfers WHERE ${where}`)
        .all() as RawTransfer[];
      this.raw.prepare(`DELETE FROM transfers WHERE ${where}`).run();
      return rows.map(parseTransfer);
    })();
  }

  // ── subscriptions (M7) ────────────────────────────────────────────────────

  addSubscription(
    s: Omit<SubscriptionRow, 'paused' | 'rev' | 'status' | 'created_at' | 'sync'> & {
      sync?: boolean;
    },
  ) {
    this.raw
      .prepare(
        `INSERT INTO subscriptions (id, hub, device_id, path, recursive, dest_dir, mirror_deletes, sync, created_at)
         VALUES (@id, @hub, @device_id, @path, @recursive, @dest_dir, @mirror_deletes, @sync, @at)`,
      )
      .run({
        ...s,
        recursive: s.recursive ? 1 : 0,
        mirror_deletes: s.mirror_deletes ? 1 : 0,
        sync: s.sync ? 1 : 0,
        at: now(),
      });
  }

  updateSubscription(
    id: string,
    patch: Partial<Pick<SubscriptionRow, 'mirror_deletes' | 'paused' | 'rev' | 'status' | 'sync'>>,
  ) {
    const cols = Object.keys(patch);
    if (cols.length === 0) return;
    const values: Record<string, unknown> = { ...patch, id };
    for (const k of ['mirror_deletes', 'paused', 'sync'] as const)
      if (patch[k] !== undefined) values[k] = patch[k] ? 1 : 0;
    this.raw
      .prepare(
        `UPDATE subscriptions SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`,
      )
      .run(values);
  }

  removeSubscription(id: string): boolean {
    return this.raw.prepare('DELETE FROM subscriptions WHERE id = ?').run(id).changes > 0;
  }

  subscriptions(): SubscriptionRow[] {
    return (
      this.raw.prepare('SELECT * FROM subscriptions ORDER BY created_at, id').all() as RawSub[]
    ).map(parseSub);
  }

  subscription(id: string): SubscriptionRow | undefined {
    const r = this.raw.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as
      RawSub | undefined;
    return r && parseSub(r);
  }

  findSubscription(hub: string, device: string, path: string): SubscriptionRow | undefined {
    const r = this.raw
      .prepare('SELECT * FROM subscriptions WHERE hub = ? AND device_id = ? AND path = ?')
      .get(hub, device, path) as RawSub | undefined;
    return r && parseSub(r);
  }

  /** File counts per state for one subscription. */
  subFileCounts(id: string): Record<SubFileRow['state'], number> {
    const out = { pending: 0, done: 0, failed: 0, removed: 0 };
    for (const r of this.raw
      .prepare('SELECT state, count(*) AS n FROM sub_files WHERE sub_id = ? GROUP BY state')
      .all(id) as { state: SubFileRow['state']; n: number }[])
      out[r.state] = r.n;
    return out;
  }

  subFile(subId: string, path: string): SubFileRow | undefined {
    const r = this.raw
      .prepare('SELECT * FROM sub_files WHERE sub_id = ? AND path = ?')
      .get(subId, path) as RawSubFile | undefined;
    return r && parseSubFile(r);
  }

  /** The files waiting for this download: one, or several synced-folder sources sharing it. */
  subFilesByTransfer(transferId: string): SubFileRow[] {
    return (
      this.raw
        .prepare('SELECT * FROM sub_files WHERE transfer_id = ?')
        .all(transferId) as RawSubFile[]
    ).map(parseSubFile);
  }

  /** A synced-folder download already under way for this content at this path, if any. */
  syncPending(hash: string, path: string): SubFileRow | undefined {
    const r = this.raw
      .prepare(
        `SELECT f.* FROM sub_files f JOIN subscriptions s ON s.id = f.sub_id
         WHERE s.sync = 1 AND f.state = 'pending' AND f.transfer_id IS NOT NULL
           AND f.hash = ? AND f.path = ?`,
      )
      .get(hash, path) as RawSubFile | undefined;
    return r && parseSubFile(r);
  }

  /** Whether another synced-folder source already gave us this version of this file. */
  syncHad(path: string, hash: string, exceptSub: string): boolean {
    return (
      this.raw
        .prepare(
          `SELECT 1 FROM sub_files f JOIN subscriptions s ON s.id = f.sub_id
           WHERE s.sync = 1 AND f.state = 'done' AND f.path = ? AND f.hash = ? AND f.sub_id != ?`,
        )
        .get(path, hash, exceptSub) !== undefined
    );
  }

  /** What synced-folder subscriptions last wrote or saw at this local path. */
  syncStampsAt(localPath: string): LocalStamp[] {
    return (
      this.raw
        .prepare(
          `SELECT f.local FROM sub_files f JOIN subscriptions s ON s.id = f.sub_id
           WHERE s.sync = 1 AND f.local IS NOT NULL AND json_extract(f.local, '$.path') = ?`,
        )
        .pluck()
        .all(localPath) as string[]
    ).map((l) => JSON.parse(l) as LocalStamp);
  }

  /** Files of any subscription with this content that we have locally. */
  subFilesWithHash(hash: string): SubFileRow[] {
    return (
      this.raw
        .prepare("SELECT * FROM sub_files WHERE hash = ? AND state IN ('done', 'removed')")
        .all(hash) as RawSubFile[]
    ).map(parseSubFile);
  }

  /** Every file still waiting for its download (checked against the transfers on start). */
  pendingSubFiles(): SubFileRow[] {
    return (
      this.raw.prepare("SELECT * FROM sub_files WHERE state = 'pending'").all() as RawSubFile[]
    ).map(parseSubFile);
  }

  putSubFile(f: SubFileRow) {
    this.raw
      .prepare(
        `INSERT OR REPLACE INTO sub_files (sub_id, path, hash, state, transfer_id, local, prev, mtime)
         VALUES (@sub_id, @path, @hash, @state, @transfer_id, @local, @prev, @mtime)`,
      )
      .run({
        ...f,
        mtime: f.mtime ?? null,
        local: f.local ? JSON.stringify(f.local) : null,
        prev: f.prev ? JSON.stringify(f.prev) : null,
      });
  }

  deleteSubFile(subId: string, path: string) {
    this.raw.prepare('DELETE FROM sub_files WHERE sub_id = ? AND path = ?').run(subId, path);
  }

  // ── upload log ────────────────────────────────────────────────────────────

  logUpload(e: Omit<UploadLogRow, 'id' | 'at'>) {
    this.raw
      .prepare(
        `INSERT INTO upload_log (at, hub, requester_user, requester_dev, path, hash, bytes, status, kind)
         VALUES (@at, @hub, @requester_user, @requester_dev, @path, @hash, @bytes, @status, @kind)`,
      )
      .run({ ...e, at: now() });
  }

  uploadLog(filter: { user?: string; pathPrefix?: string; limit?: number } = {}): UploadLogRow[] {
    const where: string[] = [];
    if (filter.user) where.push('requester_user = @user');
    if (filter.pathPrefix) where.push('substr(path, 1, length(@prefix)) = @prefix');
    return this.raw
      .prepare(
        `SELECT * FROM upload_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT @limit`,
      )
      .all({
        user: filter.user,
        prefix: filter.pathPrefix,
        limit: filter.limit ?? 100,
      }) as UploadLogRow[];
  }

  /** Empties the upload log (Activity › Clear). Returns how many entries went. */
  clearUploadLog(): number {
    return this.raw.prepare('DELETE FROM upload_log').run().changes;
  }

  /** Configurable retention (HANDOFF §7). */
  pruneUploadLog(olderThanDays: number) {
    this.raw.prepare('DELETE FROM upload_log WHERE at < ?').run(now() - olderThanDays * 86_400);
  }

  // ── access rules (per hub) ────────────────────────────────────────────────

  rules(hub: string): { path: string; audience: Audience }[] {
    return (
      this.raw.prepare('SELECT path, audience FROM acl WHERE hub = ? ORDER BY path').all(hub) as {
        path: string;
        audience: string;
      }[]
    ).map((r) => ({ path: r.path, audience: JSON.parse(r.audience) as Audience }));
  }

  setRule(hub: string, path: string, audience: Audience | null) {
    if (audience === null)
      this.raw.prepare('DELETE FROM acl WHERE hub = ? AND path = ?').run(hub, path);
    else
      this.raw
        .prepare(
          'INSERT INTO acl (hub, path, audience) VALUES (?, ?, ?) ON CONFLICT (hub, path) DO UPDATE SET audience = excluded.audience',
        )
        .run(hub, path, JSON.stringify(audience));
  }

  /** Drops rules under a share (on every hub) or for a hub. */
  dropRules(where: { share?: string; hub?: string }) {
    if (where.share !== undefined) {
      const prefix = where.share + '/';
      this.raw.prepare('DELETE FROM acl WHERE substr(path, 1, length(?)) = ?').run(prefix, prefix);
    }
    if (where.hub !== undefined) this.raw.prepare('DELETE FROM acl WHERE hub = ?').run(where.hub);
  }

  // ── verification ──────────────────────────────────────────────────────────

  // ── revocations (ADR 0014) ────────────────────────────────────────────────

  revocations(userId: string): RevocationProof[] {
    return (
      this.raw
        .prepare('SELECT proof_json FROM revocations WHERE user_id = ? ORDER BY rowid')
        .pluck()
        .all(userId) as string[]
    ).map((j) => JSON.parse(j) as RevocationProof);
  }

  /** Stores a proof the caller has verified; false when that device was already revoked. */
  addRevocation(p: RevocationProof): boolean {
    return (
      this.raw
        .prepare(
          'INSERT OR IGNORE INTO revocations (user_id, device_id, proof_json) VALUES (?, ?, ?)',
        )
        .run(p.revocation.user_id, p.revocation.device_id, JSON.stringify(p)).changes > 0
    );
  }

  verifiedFingerprint(userId: string): string | undefined {
    return this.raw
      .prepare('SELECT fingerprint FROM verified WHERE user_id = ?')
      .pluck()
      .get(userId) as string | undefined;
  }

  /** Everyone this user has verified. */
  verifiedUsers(): Set<string> {
    return new Set(this.raw.prepare('SELECT user_id FROM verified').pluck().all() as string[]);
  }

  setVerified(userId: string, fingerprint: string | null) {
    if (fingerprint === null)
      this.raw.prepare('DELETE FROM verified WHERE user_id = ?').run(userId);
    else
      this.raw
        .prepare(
          'INSERT OR REPLACE INTO verified (user_id, fingerprint, verified_at) VALUES (?, ?, ?)',
        )
        .run(userId, fingerprint, now());
  }

  // ── change log & per-hub sync state ───────────────────────────────────────

  private logChange(share: string, rel: string, op: 'upsert' | 'remove') {
    this.raw.prepare('INSERT INTO changes (share, rel, op) VALUES (?, ?, ?)').run(share, rel, op);
  }

  maxSeq(): number {
    return (
      (this.raw.prepare('SELECT coalesce(max(seq), 0) FROM changes').pluck().get() as number) ?? 0
    );
  }

  changesSince(seq: number, limit: number): Change[] {
    return this.raw
      .prepare('SELECT * FROM changes WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(seq, limit) as Change[];
  }

  hubSync(hub: string): { rev: number; acked_seq: number } | undefined {
    return this.raw.prepare('SELECT rev, acked_seq FROM hub_sync WHERE hub = ?').get(hub) as
      { rev: number; acked_seq: number } | undefined;
  }

  setHubSync(hub: string, rev: number, ackedSeq: number) {
    this.raw
      .prepare(
        `INSERT INTO hub_sync (hub, rev, acked_seq) VALUES (?, ?, ?)
         ON CONFLICT (hub) DO UPDATE SET rev = excluded.rev, acked_seq = excluded.acked_seq`,
      )
      .run(hub, rev, ackedSeq);
  }

  forgetHub(hub: string) {
    this.raw.prepare('DELETE FROM hub_sync WHERE hub = ?').run(hub);
  }

  /** Drops log entries every hub has already acked (and all of them if no hub is synced). */
  compactChanges() {
    const min = this.raw.prepare('SELECT min(acked_seq) FROM hub_sync').pluck().get() as
      number | null;
    this.raw.prepare('DELETE FROM changes WHERE seq <= ?').run(min ?? this.maxSeq());
  }

  /** Runs `fn` in one transaction (batches of scan results are much faster this way). */
  batch<T>(fn: () => T): T {
    return this.raw.transaction(fn)();
  }
}
