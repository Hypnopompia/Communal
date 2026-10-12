import Database from 'better-sqlite3';
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
}

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
];

const now = () => Math.floor(Date.now() / 1000);

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
           chunk_hashes = CASE WHEN files.size = excluded.size AND files.mtime = excluded.mtime THEN files.chunk_hashes END`,
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
        'SELECT share, rel, size, mtime, mime, kind, hash FROM files WHERE share = ? AND rel = ?',
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
    const cols = 'share, rel, size, mtime, mime, kind, hash';
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
  }) {
    const ts = now();
    this.raw
      .prepare(
        `INSERT INTO transfers (id, hash, name, dest_dir, size, state, created_at, updated_at)
         VALUES (@id, @hash, @name, @dest_dir, @size, 'queued', @ts, @ts)`,
      )
      .run({ ...t, ts });
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

  verifiedFingerprint(userId: string): string | undefined {
    return this.raw
      .prepare('SELECT fingerprint FROM verified WHERE user_id = ?')
      .pluck()
      .get(userId) as string | undefined;
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
