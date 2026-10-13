import Database from 'better-sqlite3';
import type { CertChain, RevocationProof } from '@communal/crypto';
import { governingRule, type HubBody } from '@communal/protocol';

export { governingRule };

export type Entry = HubBody<'browse.listing'>['files'][number];

export interface EntryRow {
  device_id: string;
  path: string;
  dir: string;
  name: string;
  size: number;
  mtime: number;
  mime: string;
  kind: Entry['kind'];
  meta_json: string;
  thumb: number;
  hash: string | null;
  rule_path: string | null;
}

function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  return { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

export type Audience = 'me' | 'hub' | { users?: string[]; groups?: string[] };

export function rowToEntry(r: EntryRow): Entry {
  return {
    path: r.path,
    size: r.size,
    mtime: r.mtime,
    mime: r.mime,
    kind: r.kind,
    meta: JSON.parse(r.meta_json) as Entry['meta'],
    thumb: r.thumb === 1,
    hash: r.hash,
  };
}

export type { RevocationProof };

export type JoinMode = 'open' | 'approval';
export type UserStatus = 'active' | 'pending';

export interface UserRow {
  id: string;
  display_name: string;
  root_pubkey: string;
  status: UserStatus;
  created_at: number;
  /** Set when the hub admin bans the account; orthogonal to `status`. */
  banned_at: number | null;
  ban_reason: string | null;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  pubkey: string;
  chain: CertChain;
  name: string;
  platform: string;
  created_at: number;
  last_seen: number | null;
  revoked_at: number | null;
}

/**
 * Forward-only migrations; `user_version` records how many have run. Tables land with the
 * milestone that needs them (HANDOFF §10).
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id           TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    root_pubkey  TEXT NOT NULL UNIQUE,
    status       TEXT NOT NULL CHECK (status IN ('active', 'pending')),
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX users_display_name ON users (display_name COLLATE NOCASE);

  CREATE TABLE devices (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id),
    pubkey     TEXT NOT NULL UNIQUE,
    cert_chain TEXT NOT NULL,
    name       TEXT NOT NULL,
    platform   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX devices_user ON devices (user_id);

  -- user_a < user_b; requested_by says who sent the request.
  CREATE TABLE connections (
    user_a       TEXT NOT NULL REFERENCES users (id),
    user_b       TEXT NOT NULL REFERENCES users (id),
    state        TEXT NOT NULL CHECK (state IN ('pending', 'accepted')),
    requested_by TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
  );
  CREATE INDEX connections_b ON connections (user_b);

  CREATE TABLE index_revs (
    device_id TEXT PRIMARY KEY REFERENCES devices (id),
    rev       INTEGER NOT NULL
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE users ADD COLUMN banned_at INTEGER;
  ALTER TABLE users ADD COLUMN ban_reason TEXT;
  `,
  `
  -- dir: parent folder with trailing '/' (e.g. 'Movies/2024/'); name: the file name.
  CREATE TABLE entries (
    device_id TEXT NOT NULL REFERENCES devices (id),
    path      TEXT NOT NULL,
    dir       TEXT NOT NULL,
    name      TEXT NOT NULL,
    size      INTEGER NOT NULL,
    mtime     INTEGER NOT NULL,
    mime      TEXT NOT NULL,
    kind      TEXT NOT NULL,
    meta_json TEXT NOT NULL,
    thumb     INTEGER NOT NULL,
    hash      TEXT
  );
  CREATE UNIQUE INDEX entries_path ON entries (device_id, path);
  CREATE INDEX entries_dir ON entries (device_id, dir);
  CREATE INDEX entries_hash ON entries (hash) WHERE hash IS NOT NULL;

  CREATE VIRTUAL TABLE entries_fts USING fts5 (
    name, content = 'entries', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts (rowid, name) VALUES (new.rowid, new.name);
  END;
  CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts (entries_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
  END;
  CREATE TRIGGER entries_au AFTER UPDATE OF name ON entries BEGIN
    INSERT INTO entries_fts (entries_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
    INSERT INTO entries_fts (rowid, name) VALUES (new.rowid, new.name);
  END;

  -- Snapshot pages land here until the last page commits them (one device at a time).
  CREATE TABLE entries_staging (
    device_id TEXT NOT NULL,
    path      TEXT NOT NULL,
    dir       TEXT NOT NULL,
    name      TEXT NOT NULL,
    size      INTEGER NOT NULL,
    mtime     INTEGER NOT NULL,
    mime      TEXT NOT NULL,
    kind      TEXT NOT NULL,
    meta_json TEXT NOT NULL,
    thumb     INTEGER NOT NULL,
    hash      TEXT,
    PRIMARY KEY (device_id, path)
  );
  `,
  `
  CREATE TABLE groups (
    id       TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users (id),
    name     TEXT NOT NULL
  );
  CREATE INDEX groups_owner ON groups (owner_id);
  CREATE TABLE group_members (
    group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL REFERENCES users (id),
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX group_members_user ON group_members (user_id);

  -- One rule per (device, path). path is a file ('Share/a.jpg') or folder ('Share/sub/').
  -- kind: 'me' | 'hub' | 'list' (users and/or groups in the side tables).
  CREATE TABLE access_rules (
    device_id TEXT NOT NULL REFERENCES devices (id),
    path      TEXT NOT NULL,
    kind      TEXT NOT NULL CHECK (kind IN ('me', 'hub', 'list')),
    PRIMARY KEY (device_id, path)
  );
  CREATE INDEX access_rules_hub ON access_rules (kind) WHERE kind = 'hub';
  CREATE TABLE rule_users (
    device_id TEXT NOT NULL,
    path      TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    PRIMARY KEY (device_id, path, user_id),
    FOREIGN KEY (device_id, path) REFERENCES access_rules (device_id, path) ON DELETE CASCADE
  );
  CREATE INDEX rule_users_user ON rule_users (user_id);
  CREATE TABLE rule_groups (
    device_id TEXT NOT NULL,
    path      TEXT NOT NULL,
    group_id  TEXT NOT NULL,
    PRIMARY KEY (device_id, path, group_id),
    FOREIGN KEY (device_id, path) REFERENCES access_rules (device_id, path) ON DELETE CASCADE
  );

  -- The rule that governs each entry (its own, else nearest ancestor folder's); NULL = 'me'.
  ALTER TABLE entries ADD COLUMN rule_path TEXT;
  ALTER TABLE entries_staging ADD COLUMN rule_path TEXT;
  CREATE INDEX entries_rule ON entries (device_id, rule_path) WHERE rule_path IS NOT NULL;
  `,
  `
  -- M7 subscriptions (ADR 0013). rev: the device index rev at which the entry's content (hash)
  -- last changed, so a watcher can catch up from since_rev.
  ALTER TABLE entries ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX entries_rev ON entries (device_id, rev);

  -- Paths removed from a device's index, kept so watchers who were away still hear about
  -- deletions. rule_path is re-tagged like entries', so visibility follows the current rules.
  CREATE TABLE tombstones (
    device_id TEXT NOT NULL,
    path      TEXT NOT NULL,
    dir       TEXT NOT NULL,
    rule_path TEXT,
    rev       INTEGER NOT NULL,
    at        INTEGER NOT NULL,
    PRIMARY KEY (device_id, path)
  );
  CREATE INDEX tombstones_rev ON tombstones (device_id, rev);

  -- Folder subscriptions (HANDOFF §5, §10). The watcher re-sends its watches on every sign-in;
  -- this table records them (for the admin, and so unwatch has something to remove).
  CREATE TABLE watches (
    user_id        TEXT NOT NULL REFERENCES users (id),
    watcher_device TEXT NOT NULL REFERENCES devices (id),
    device_id      TEXT NOT NULL REFERENCES devices (id),
    path           TEXT NOT NULL,
    recursive      INTEGER NOT NULL,
    mirror_deletes INTEGER NOT NULL,
    since_rev      INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    PRIMARY KEY (watcher_device, device_id, path)
  );
  CREATE INDEX watches_device ON watches (device_id);
  `,
  `
  -- M8 (ADR 0014): every revocation proof accepted for an account, including ones for devices
  -- this hub has never seen, so they can't register here later.
  CREATE TABLE revocations (
    user_id     TEXT NOT NULL REFERENCES users (id),
    device_id   TEXT NOT NULL,
    proof_json  TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id)
  );
  `,
  `
  -- Live browsing (ADR 0004): the device index rev at which anything about the entry last
  -- changed (metadata and thumbnails too), so browse.changed can hint at those as well.
  ALTER TABLE entries ADD COLUMN mrev INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX entries_mrev ON entries (device_id, mrev);
  `,
];

const now = () => Math.floor(Date.now() / 1000);

/** An upsert keeps the entry's rev unless its content changed (ADR 0013). */
const KEEP_REV_UNLESS_CHANGED =
  'CASE WHEN entries.hash IS excluded.hash THEN entries.rev ELSE excluded.rev END';
/** The same for `mrev`, which moves when anything the listing shows changes. */
const KEEP_MREV_UNLESS_CHANGED = `CASE WHEN ${[
  'hash',
  'size',
  'mtime',
  'mime',
  'kind',
  'meta_json',
  'thumb',
]
  .map((c) => `entries.${c} IS excluded.${c}`)
  .join(' AND ')} THEN entries.mrev ELSE excluded.mrev END`;

export class HubDb {
  readonly raw: Database.Database;
  /**
   * How long removals are remembered for watchers that are away (ADR 0013). A watcher gone
   * longer than this still gets every current file on its return, but misses older deletions.
   */
  tombstoneRetentionS = 180 * 86_400;
  /** device_id → its rule paths; entries are tagged with their governing rule on write. */
  private readonly ruleCache = new Map<string, Set<string>>();

  constructor(file: string) {
    this.raw = new Database(file);
    this.raw.pragma('journal_mode = WAL');
    // WAL + NORMAL: corruption-safe; a power cut can lose the last commits, which clients
    // repair by resync (index) or retry (everything else).
    this.raw.pragma('synchronous = NORMAL');
    this.raw.pragma('foreign_keys = ON');
    this.raw.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate() {
    const version = this.raw.pragma('user_version', { simple: true }) as number;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.raw.transaction(() => {
        this.raw.exec(MIGRATIONS[v]!);
        this.raw.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  close() {
    this.raw.close();
  }

  // ── settings ──────────────────────────────────────────────────────────────

  getSetting(key: string): string | undefined {
    const row = this.raw.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string) {
    this.raw
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  get joinMode(): JoinMode {
    return this.getSetting('join_mode') === 'approval' ? 'approval' : 'open';
  }

  // ── users & devices ───────────────────────────────────────────────────────

  createAccount(
    user: Omit<UserRow, 'created_at' | 'banned_at' | 'ban_reason'>,
    device: Omit<DeviceRow, 'created_at' | 'last_seen' | 'revoked_at'>,
  ) {
    const t = now();
    this.raw.transaction(() => {
      this.raw
        .prepare(
          'INSERT INTO users (id, display_name, root_pubkey, status, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(user.id, user.display_name, user.root_pubkey, user.status, t);
      this.raw
        .prepare(
          `INSERT INTO devices (id, user_id, pubkey, cert_chain, name, platform, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          device.id,
          device.user_id,
          device.pubkey,
          JSON.stringify(device.chain),
          device.name,
          device.platform,
          t,
        );
    })();
  }

  /** Registers another device for an existing account (link, restore, or a chain; ADR 0014). */
  addDevice(device: Omit<DeviceRow, 'created_at' | 'last_seen' | 'revoked_at'>) {
    this.raw
      .prepare(
        `INSERT INTO devices (id, user_id, pubkey, cert_chain, name, platform, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        device.id,
        device.user_id,
        device.pubkey,
        JSON.stringify(device.chain),
        device.name,
        device.platform,
        now(),
      );
  }

  getUser(id: string): UserRow | undefined {
    return this.raw.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  listUsers(): (UserRow & { devices: number })[] {
    return this.raw
      .prepare(
        `SELECT u.*, (SELECT count(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS devices
         FROM users u ORDER BY u.created_at, u.id`,
      )
      .all() as (UserRow & { devices: number })[];
  }

  setUserStatus(id: string, status: UserStatus): boolean {
    return this.raw.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id).changes > 0;
  }

  ban(id: string, reason: string | null = null): boolean {
    return (
      this.raw
        .prepare('UPDATE users SET banned_at = ?, ban_reason = ? WHERE id = ?')
        .run(now(), reason, id).changes > 0
    );
  }

  unban(id: string): boolean {
    return (
      this.raw.prepare('UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE id = ?').run(id)
        .changes > 0
    );
  }

  /** Which of `ids` are banned. */
  bannedAmong(ids: string[]): string[] {
    if (ids.length === 0) return [];
    return (
      this.raw
        .prepare(
          `SELECT id FROM users WHERE banned_at IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(...ids) as { id: string }[]
    ).map((r) => r.id);
  }

  getDevice(id: string): DeviceRow | undefined {
    const row = this.raw.prepare('SELECT * FROM devices WHERE id = ?').get(id) as
      (Omit<DeviceRow, 'chain'> & { cert_chain: string }) | undefined;
    if (!row) return undefined;
    const { cert_chain, ...rest } = row;
    return { ...rest, chain: JSON.parse(cert_chain) as CertChain };
  }

  deviceExistsWithPubkey(pubkey: string): boolean {
    return this.raw.prepare('SELECT 1 FROM devices WHERE pubkey = ?').get(pubkey) !== undefined;
  }

  devicesOf(userId: string): string[] {
    return (
      this.raw
        .prepare('SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL')
        .all(userId) as {
        id: string;
      }[]
    ).map((r) => r.id);
  }

  /** Every device of the account, revoked ones included (oldest first). */
  listDevices(userId: string): DeviceRow[] {
    return (
      this.raw
        .prepare('SELECT id FROM devices WHERE user_id = ? ORDER BY created_at, rowid')
        .all(userId) as { id: string }[]
    ).map((r) => this.getDevice(r.id)!);
  }

  // ── revocations (ADR 0014) ────────────────────────────────────────────────

  revocationsOf(userId: string): RevocationProof[] {
    return (
      this.raw
        .prepare('SELECT proof_json FROM revocations WHERE user_id = ? ORDER BY received_at')
        .all(userId) as { proof_json: string }[]
    ).map((r) => JSON.parse(r.proof_json) as RevocationProof);
  }

  /** device_ids revoked in this account. */
  revokedSet(userId: string): Set<string> {
    return new Set(
      (
        this.raw.prepare('SELECT device_id FROM revocations WHERE user_id = ?').all(userId) as {
          device_id: string;
        }[]
      ).map((r) => r.device_id),
    );
  }

  /** Stores a proof the caller has verified. False when that device was already revoked. */
  addRevocation(proof: RevocationProof): boolean {
    return (
      this.raw
        .prepare(
          `INSERT OR IGNORE INTO revocations (user_id, device_id, proof_json, received_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(proof.revocation.user_id, proof.revocation.device_id, JSON.stringify(proof), now())
        .changes > 0
    );
  }

  /**
   * Marks a device revoked and forgets what it shared: entries (without tombstones, since a
   * device leaving must never look like deletions), rules, its index rev and watches either way.
   */
  revokeDevice(id: string, at: number = now()) {
    this.raw.transaction(() => {
      this.raw
        .prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(at, id);
      for (const sql of [
        'DELETE FROM entries WHERE device_id = ?',
        'DELETE FROM entries_staging WHERE device_id = ?',
        'DELETE FROM tombstones WHERE device_id = ?',
        'DELETE FROM access_rules WHERE device_id = ?',
        'DELETE FROM index_revs WHERE device_id = ?',
        'DELETE FROM watches WHERE device_id = ?',
        'DELETE FROM watches WHERE watcher_device = ?',
      ])
        this.raw.prepare(sql).run(id);
    })();
    this.ruleCache.delete(id);
  }

  touchDevice(id: string, at: number = now()) {
    this.raw.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(at, id);
  }

  indexRev(deviceId: string): number {
    const row = this.raw.prepare('SELECT rev FROM index_revs WHERE device_id = ?').get(deviceId) as
      { rev: number } | undefined;
    return row?.rev ?? 0;
  }

  // ── index ─────────────────────────────────────────────────────────────────

  setIndexRev(deviceId: string, rev: number) {
    this.raw
      .prepare(
        'INSERT INTO index_revs (device_id, rev) VALUES (?, ?) ON CONFLICT (device_id) DO UPDATE SET rev = excluded.rev',
      )
      .run(deviceId, rev);
  }

  private entryParams(deviceId: string, e: Entry) {
    return {
      device_id: deviceId,
      path: e.path,
      ...splitPath(e.path),
      size: e.size,
      mtime: e.mtime,
      mime: e.mime,
      kind: e.kind,
      meta_json: JSON.stringify(e.meta),
      thumb: e.thumb ? 1 : 0,
      hash: e.hash,
      rule_path: governingRule(this.rulePaths(deviceId), e.path),
    };
  }

  /**
   * Applies a delta and advances the device's rev, atomically. Removed paths leave tombstones,
   * and an entry's `rev` moves only when its content (hash) changes, so metadata-only updates
   * don't look like new files to watchers.
   */
  applyDelta(deviceId: string, rev: number, upsert: Entry[], remove: string[]) {
    const up = this.raw.prepare(
      `INSERT INTO entries (device_id, path, dir, name, size, mtime, mime, kind, meta_json, thumb, hash, rule_path, rev, mrev)
       VALUES (@device_id, @path, @dir, @name, @size, @mtime, @mime, @kind, @meta_json, @thumb, @hash, @rule_path, @rev, @rev)
       ON CONFLICT (device_id, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
         mime = excluded.mime, kind = excluded.kind, meta_json = excluded.meta_json,
         thumb = excluded.thumb, hash = excluded.hash, rule_path = excluded.rule_path,
         rev = ${KEEP_REV_UNLESS_CHANGED}, mrev = ${KEEP_MREV_UNLESS_CHANGED}`,
    );
    const bury = this.raw.prepare(
      `INSERT OR REPLACE INTO tombstones (device_id, path, dir, rule_path, rev, at)
       SELECT device_id, path, dir, rule_path, @rev, @at FROM entries WHERE device_id = @device AND path = @path`,
    );
    const del = this.raw.prepare('DELETE FROM entries WHERE device_id = ? AND path = ?');
    const unbury = this.raw.prepare('DELETE FROM tombstones WHERE device_id = ? AND path = ?');
    const at = now();
    this.raw.transaction(() => {
      for (const p of remove) {
        bury.run({ device: deviceId, path: p, rev, at });
        del.run(deviceId, p);
      }
      for (const e of upsert) {
        up.run({ ...this.entryParams(deviceId, e), rev });
        unbury.run(deviceId, e.path);
      }
      this.setIndexRev(deviceId, rev);
      this.pruneTombstones(deviceId, at);
    })();
  }

  /** Starts a snapshot for a device (discarding any half-finished one). */
  beginSnapshot(deviceId: string) {
    this.raw.prepare('DELETE FROM entries_staging WHERE device_id = ?').run(deviceId);
  }

  stageSnapshotPage(deviceId: string, entries: Entry[]) {
    const ins = this.raw.prepare(
      `INSERT OR REPLACE INTO entries_staging (device_id, path, dir, name, size, mtime, mime, kind, meta_json, thumb, hash, rule_path)
       VALUES (@device_id, @path, @dir, @name, @size, @mtime, @mime, @kind, @meta_json, @thumb, @hash, @rule_path)`,
    );
    this.raw.transaction(() => {
      for (const e of entries) ins.run(this.entryParams(deviceId, e));
    })();
  }

  /**
   * Replaces the device's whole index with the staged snapshot and sets its rev. Like a delta:
   * entries that disappear leave tombstones, and unchanged entries keep their rev.
   */
  commitSnapshot(deviceId: string, rev: number) {
    const p = { device: deviceId, rev, at: now() };
    const gone = `device_id = @device AND NOT EXISTS (
      SELECT 1 FROM entries_staging s WHERE s.device_id = @device AND s.path = entries.path)`;
    this.raw.transaction(() => {
      this.raw
        .prepare(
          `INSERT OR REPLACE INTO tombstones (device_id, path, dir, rule_path, rev, at)
           SELECT device_id, path, dir, rule_path, @rev, @at FROM entries WHERE ${gone}`,
        )
        .run(p);
      this.raw.prepare(`DELETE FROM entries WHERE ${gone}`).run({ device: deviceId });
      this.raw
        .prepare(
          // "WHERE true" lets SQLite parse an upsert whose source is a SELECT.
          `INSERT INTO entries (device_id, path, dir, name, size, mtime, mime, kind, meta_json, thumb, hash, rule_path, rev, mrev)
           SELECT device_id, path, dir, name, size, mtime, mime, kind, meta_json, thumb, hash, rule_path, @rev, @rev
           FROM entries_staging WHERE device_id = @device AND true
           ON CONFLICT (device_id, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
             mime = excluded.mime, kind = excluded.kind, meta_json = excluded.meta_json,
             thumb = excluded.thumb, hash = excluded.hash, rule_path = excluded.rule_path,
             rev = ${KEEP_REV_UNLESS_CHANGED}, mrev = ${KEEP_MREV_UNLESS_CHANGED}`,
        )
        .run({ device: deviceId, rev });
      this.raw
        .prepare(
          `DELETE FROM tombstones WHERE device_id = @device
           AND path IN (SELECT path FROM entries_staging WHERE device_id = @device)`,
        )
        .run({ device: deviceId });
      this.raw.prepare('DELETE FROM entries_staging WHERE device_id = ?').run(deviceId);
      this.setIndexRev(deviceId, rev);
      this.pruneTombstones(deviceId, p.at);
    })();
  }

  /** Tombstones older than the retention window are forgotten (ADR 0013). */
  private pruneTombstones(deviceId: string, at: number) {
    this.raw
      .prepare('DELETE FROM tombstones WHERE device_id = ? AND at < ?')
      .run(deviceId, at - this.tombstoneRetentionS);
  }

  entryCount(deviceId: string): number {
    return this.raw
      .prepare('SELECT count(*) FROM entries WHERE device_id = ?')
      .pluck()
      .get(deviceId) as number;
  }

  // ── access rules (HANDOFF §6, per hub per ADR 0007) ───────────────────────

  rulePaths(deviceId: string): Set<string> {
    let set = this.ruleCache.get(deviceId);
    if (!set) {
      set = new Set(
        this.raw
          .prepare('SELECT path FROM access_rules WHERE device_id = ?')
          .pluck()
          .all(deviceId) as string[],
      );
      this.ruleCache.set(deviceId, set);
    }
    return set;
  }

  rules(deviceId: string): { path: string; audience: Audience }[] {
    const rows = this.raw
      .prepare('SELECT path, kind FROM access_rules WHERE device_id = ? ORDER BY path')
      .all(deviceId) as { path: string; kind: 'me' | 'hub' | 'list' }[];
    const users = this.raw
      .prepare('SELECT user_id FROM rule_users WHERE device_id = ? AND path = ? ORDER BY user_id')
      .pluck();
    const groups = this.raw
      .prepare(
        'SELECT group_id FROM rule_groups WHERE device_id = ? AND path = ? ORDER BY group_id',
      )
      .pluck();
    return rows.map((r) => {
      if (r.kind !== 'list') return { path: r.path, audience: r.kind };
      const u = users.all(deviceId, r.path) as string[];
      const g = groups.all(deviceId, r.path) as string[];
      return {
        path: r.path,
        audience: { ...(u.length ? { users: u } : {}), ...(g.length ? { groups: g } : {}) },
      };
    });
  }

  private writeRule(deviceId: string, path: string, audience: Audience | null) {
    this.raw
      .prepare('DELETE FROM access_rules WHERE device_id = ? AND path = ?')
      .run(deviceId, path);
    if (audience === null) return;
    const kind = typeof audience === 'string' ? audience : 'list';
    this.raw
      .prepare('INSERT INTO access_rules (device_id, path, kind) VALUES (?, ?, ?)')
      .run(deviceId, path, kind);
    if (typeof audience === 'object') {
      const u = this.raw.prepare(
        'INSERT OR IGNORE INTO rule_users (device_id, path, user_id) VALUES (?, ?, ?)',
      );
      const g = this.raw.prepare(
        'INSERT OR IGNORE INTO rule_groups (device_id, path, group_id) VALUES (?, ?, ?)',
      );
      for (const id of audience.users ?? []) u.run(deviceId, path, id);
      for (const id of audience.groups ?? []) g.run(deviceId, path, id);
    }
  }

  /** Sets (or with null, clears) one rule, then re-tags the device's entries. */
  setRule(deviceId: string, path: string, audience: Audience | null) {
    this.raw.transaction(() => {
      this.writeRule(deviceId, path, audience);
      this.retag(deviceId);
    })();
  }

  /** Replaces every rule for the device atomically. */
  replaceRules(deviceId: string, rules: { path: string; audience: Audience }[]) {
    this.raw.transaction(() => {
      this.raw.prepare('DELETE FROM access_rules WHERE device_id = ?').run(deviceId);
      for (const r of rules) this.writeRule(deviceId, r.path, r.audience);
      this.retag(deviceId);
    })();
  }

  /** Recomputes which rule governs each of the device's entries. */
  private retag(deviceId: string) {
    this.ruleCache.delete(deviceId);
    const paths = this.rulePaths(deviceId);
    const upd = this.raw.prepare(
      'UPDATE entries SET rule_path = ? WHERE device_id = ? AND path = ?',
    );
    const rows = this.raw
      .prepare('SELECT path, rule_path FROM entries WHERE device_id = ?')
      .all(deviceId) as {
      path: string;
      rule_path: string | null;
    }[];
    for (const r of rows) {
      const g = governingRule(paths, r.path);
      if (g !== r.rule_path) upd.run(g, deviceId, r.path);
    }
    // Tombstones too: who hears about a deletion follows the current rules, like the files.
    const updT = this.raw.prepare(
      'UPDATE tombstones SET rule_path = ? WHERE device_id = ? AND path = ?',
    );
    const dead = this.raw
      .prepare('SELECT path, rule_path FROM tombstones WHERE device_id = ?')
      .all(deviceId) as { path: string; rule_path: string | null }[];
    for (const r of dead) {
      const g = governingRule(paths, r.path);
      if (g !== r.rule_path) updT.run(g, deviceId, r.path);
    }
  }

  /** Whether any device of the user has an "everyone on the hub" rule (affects presence). */
  sharesWithHub(userId: string): boolean {
    return (
      this.raw
        .prepare(
          `SELECT 1 FROM access_rules r JOIN devices d ON d.id = r.device_id
           WHERE d.user_id = ? AND d.revoked_at IS NULL AND r.kind = 'hub' LIMIT 1`,
        )
        .get(userId) !== undefined
    );
  }

  // ── watches (subscriptions, M7) ───────────────────────────────────────────

  putWatch(w: {
    user_id: string;
    watcher_device: string;
    device_id: string;
    path: string;
    recursive: boolean;
    mirror_deletes: boolean;
    since_rev: number;
  }) {
    this.raw
      .prepare(
        `INSERT INTO watches (user_id, watcher_device, device_id, path, recursive, mirror_deletes, since_rev, created_at)
         VALUES (@user_id, @watcher_device, @device_id, @path, @recursive, @mirror_deletes, @since_rev, @at)
         ON CONFLICT (watcher_device, device_id, path) DO UPDATE SET recursive = excluded.recursive,
           mirror_deletes = excluded.mirror_deletes, since_rev = excluded.since_rev`,
      )
      .run({
        ...w,
        recursive: w.recursive ? 1 : 0,
        mirror_deletes: w.mirror_deletes ? 1 : 0,
        at: now(),
      });
  }

  removeWatch(watcherDevice: string, deviceId: string, path: string): boolean {
    return (
      this.raw
        .prepare('DELETE FROM watches WHERE watcher_device = ? AND device_id = ? AND path = ?')
        .run(watcherDevice, deviceId, path).changes > 0
    );
  }

  // ── groups (owner-only) ───────────────────────────────────────────────────

  groupsOf(ownerId: string): { group_id: string; name: string; members: string[] }[] {
    const groups = this.raw
      .prepare('SELECT id, name FROM groups WHERE owner_id = ? ORDER BY name, id')
      .all(ownerId) as {
      id: string;
      name: string;
    }[];
    const members = this.raw
      .prepare('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY user_id')
      .pluck();
    return groups.map((g) => ({
      group_id: g.id,
      name: g.name,
      members: members.all(g.id) as string[],
    }));
  }

  groupOwner(groupId: string): string | undefined {
    return this.raw.prepare('SELECT owner_id FROM groups WHERE id = ?').pluck().get(groupId) as
      string | undefined;
  }

  upsertGroup(ownerId: string, groupId: string, name: string, members: string[]) {
    this.raw.transaction(() => {
      this.raw
        .prepare(
          'INSERT INTO groups (id, owner_id, name) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name',
        )
        .run(groupId, ownerId, name);
      this.raw.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
      const ins = this.raw.prepare(
        'INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)',
      );
      for (const m of members) ins.run(groupId, m);
    })();
  }

  deleteGroup(groupId: string) {
    this.raw.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
  }

  /** Removes `member` from every group `owner` owns (used when a connection ends). */
  dropFromGroups(ownerId: string, memberId: string) {
    this.raw
      .prepare(
        'DELETE FROM group_members WHERE user_id = ? AND group_id IN (SELECT id FROM groups WHERE owner_id = ?)',
      )
      .run(memberId, ownerId);
  }

  // ── users ─────────────────────────────────────────────────────────────────

  /** Active, unbanned users whose display name starts with (or contains a word starting with) q. */
  searchUsers(q: string, excludeId: string, limit: number): UserRow[] {
    const like = q.replace(/[\\%_]/g, (c) => '\\' + c);
    return this.raw
      .prepare(
        `SELECT * FROM users
         WHERE status = 'active' AND banned_at IS NULL AND id != @exclude
           AND (display_name LIKE @prefix ESCAPE '\\' OR display_name LIKE @word ESCAPE '\\')
         ORDER BY display_name COLLATE NOCASE, id LIMIT @limit`,
      )
      .all({ exclude: excludeId, prefix: `${like}%`, word: `% ${like}%`, limit }) as UserRow[];
  }

  // ── connections ───────────────────────────────────────────────────────────

  /** Inserts or updates a connection row; used by M3 handlers and by tests. */
  putConnection(a: string, b: string, state: 'pending' | 'accepted', requestedBy: string = a) {
    const [x, y] = a < b ? [a, b] : [b, a];
    this.raw
      .prepare(
        `INSERT INTO connections (user_a, user_b, state, requested_by, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_a, user_b) DO UPDATE SET state = excluded.state`,
      )
      .run(x, y, state, requestedBy, now());
  }

  connection(
    a: string,
    b: string,
  ): { state: 'pending' | 'accepted'; requested_by: string; created_at: number } | undefined {
    const [x, y] = a < b ? [a, b] : [b, a];
    return this.raw
      .prepare(
        'SELECT state, requested_by, created_at FROM connections WHERE user_a = ? AND user_b = ?',
      )
      .get(x, y) as
      { state: 'pending' | 'accepted'; requested_by: string; created_at: number } | undefined;
  }

  removeConnection(a: string, b: string): boolean {
    const [x, y] = a < b ? [a, b] : [b, a];
    return (
      this.raw.prepare('DELETE FROM connections WHERE user_a = ? AND user_b = ?').run(x, y)
        .changes > 0
    );
  }

  connectionsOf(
    userId: string,
  ): { other: string; state: 'pending' | 'accepted'; requested_by: string; created_at: number }[] {
    return this.raw
      .prepare(
        `SELECT CASE WHEN user_a = @u THEN user_b ELSE user_a END AS other, state, requested_by, created_at
         FROM connections WHERE user_a = @u OR user_b = @u ORDER BY created_at`,
      )
      .all({ u: userId }) as {
      other: string;
      state: 'pending' | 'accepted';
      requested_by: string;
      created_at: number;
    }[];
  }

  connectedUsers(userId: string): string[] {
    return (
      this.raw
        .prepare(
          `SELECT user_b AS id FROM connections WHERE user_a = ? AND state = 'accepted'
           UNION SELECT user_a FROM connections WHERE user_b = ? AND state = 'accepted'`,
        )
        .all(userId, userId) as { id: string }[]
    ).map((r) => r.id);
  }
}
