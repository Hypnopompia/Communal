import Database from 'better-sqlite3';
import type { CertChain } from '@communal/crypto';

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
];

const now = () => Math.floor(Date.now() / 1000);

export class HubDb {
  readonly raw: Database.Database;

  constructor(file: string) {
    this.raw = new Database(file);
    this.raw.pragma('journal_mode = WAL');
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

  touchDevice(id: string, at: number = now()) {
    this.raw.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(at, id);
  }

  indexRev(deviceId: string): number {
    const row = this.raw.prepare('SELECT rev FROM index_revs WHERE device_id = ?').get(deviceId) as
      { rev: number } | undefined;
    return row?.rev ?? 0;
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
