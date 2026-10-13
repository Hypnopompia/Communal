import type { ClientBody, HubBody, Seen } from '@communal/protocol';
import { rowToEntry, type Entry, type EntryRow, type HubDb } from './db.js';

/**
 * Search, browse and sources over the hub's index. Every query goes through `visible()`, the
 * one place that decides which entries a requester may see (HANDOFF §6, rules per hub per
 * ADR 0007). An entry is visible to viewer V when:
 *
 * - it's on one of V's own (non-revoked) devices — own devices see everything; or
 * - its governing rule (`entries.rule_path`: its own rule, else the nearest ancestor folder's,
 *   else none = "only me") allows V:
 *   - `hub`: everyone signed in to this hub;
 *   - a list: V is listed by user id, or is a member of a listed group *owned by the file's
 *     owner* — and in both cases V and the owner are connected right now, so removing a
 *     connection revokes access immediately.
 *
 * Entries on revoked devices or owned by banned users are never visible to others. Files you
 * can't access never show up, not even as counts.
 */
export class Catalog {
  private readonly isOnline: (deviceId: string) => boolean;
  private readonly onlineDevices: () => string[];

  constructor(
    private readonly db: HubDb,
    presence: { isOnline: (deviceId: string) => boolean; onlineDevices: () => string[] },
    private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.isOnline = presence.isOnline;
    this.onlineDevices = presence.onlineDevices;
  }

  /** SQL condition over `e` (entries) for what @viewer may see. */
  private visible(): string {
    const connected = `SELECT user_b FROM connections WHERE user_a = @viewer AND state = 'accepted'
      UNION SELECT user_a FROM connections WHERE user_b = @viewer AND state = 'accepted'`;
    // Rules owned by live devices of unbanned users.
    const live = `d.revoked_at IS NULL AND d.user_id NOT IN (SELECT id FROM users WHERE banned_at IS NOT NULL)`;
    return `(
      e.device_id IN (SELECT id FROM devices WHERE user_id = @viewer AND revoked_at IS NULL)
      OR (e.rule_path IS NOT NULL AND (e.device_id, e.rule_path) IN (
        SELECT r.device_id, r.path FROM access_rules r JOIN devices d ON d.id = r.device_id
        WHERE r.kind = 'hub' AND ${live}
        UNION
        SELECT ru.device_id, ru.path FROM rule_users ru JOIN devices d ON d.id = ru.device_id
        WHERE ru.user_id = @viewer AND ${live} AND d.user_id IN (${connected})
        UNION
        SELECT rg.device_id, rg.path FROM rule_groups rg
          JOIN devices d ON d.id = rg.device_id
          JOIN groups g ON g.id = rg.group_id AND g.owner_id = d.user_id
          JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = @viewer
        WHERE ${live} AND d.user_id IN (${connected})
      ))
    )`;
  }

  /**
   * Full-text search, one hit per content hash. Ranked by availability first (some source
   * online, then seen within a week, then older; ADR 0015), then relevance, then newest. The
   * `available` filter keeps hits with at least one source seen that recently. Online state
   * lives in memory, so the online device ids go into the query as JSON: filtering after the
   * query would break paging.
   */
  search(viewer: string, q: ClientBody<'search'>): HubBody<'search.results'> {
    const match = ftsQuery(q.q);
    const offset = decodeCursor(q.cursor);
    const t = this.clock();
    const where = ['e.hash IS NOT NULL', this.visible()];
    const params: Record<string, unknown> = {
      viewer,
      limit: q.limit + 1,
      offset,
      online: JSON.stringify(this.onlineDevices()),
      week: t - WEEK,
    };
    if (q.kind) {
      where.push('e.kind = @kind');
      params.kind = q.kind;
    }
    if (q.min_size !== undefined) {
      where.push('e.size >= @min_size');
      params.min_size = q.min_size;
    }
    const isOnline = 'e.device_id IN (SELECT value FROM json_each(@online))';
    if (q.available) {
      if (q.available === 'now') where.push(isOnline);
      else {
        where.push(`(${isOnline} OR d.last_seen >= @since)`);
        params.since = t - SEEN_WITHIN[q.available];
      }
    }
    let from = 'entries e';
    let rank = '0';
    if (match) {
      from = 'entries_fts JOIN entries e ON e.rowid = entries_fts.rowid';
      where.push('entries_fts MATCH @match');
      rank = 'bm25(entries_fts)';
      params.match = match;
    }
    const tier = `CASE WHEN ${isOnline} THEN 0 WHEN d.last_seen >= @week THEN 1 ELSE 2 END`;
    // One hit per distinct content hash, best match first (then newest).
    const groups = this.db.raw
      .prepare(
        // bm25() can't sit inside an aggregate: rank each row in a materialized CTE (so the
        // planner can't flatten it back into the GROUP BY), then group by hash.
        `WITH ranked AS MATERIALIZED (
           SELECT e.hash AS hash, ${rank} AS r, e.mtime AS m, e.name AS name, ${tier} AS a
           FROM ${from} JOIN devices d ON d.id = e.device_id WHERE ${where.join(' AND ')}
         ),
         -- Newest copy and best availability per hash, grouped once. (A correlated subquery
         -- here rescanned the whole CTE per group: quadratic, 49 s for a prefix query over 50k
         -- files.)
         per_hash AS MATERIALIZED (SELECT hash, max(m) AS m, min(a) AS a FROM ranked GROUP BY hash)
         -- SQLite: with a single min(), bare columns (name) come from the best-ranked row, so the
         -- hit is named after the copy that actually matched the query.
         SELECT ranked.hash AS hash, min(r) AS r, name, per_hash.m AS m, per_hash.a AS a
         FROM ranked JOIN per_hash ON per_hash.hash = ranked.hash
         GROUP BY ranked.hash ORDER BY a, r, m DESC, hash LIMIT @limit OFFSET @offset`,
      )
      .all(params) as { hash: string; name: string }[];
    const more = groups.length > q.limit;
    const bestName = new Map(groups.map((g) => [g.hash, g.name]));
    const hashes = groups.slice(0, q.limit).map((g) => g.hash);
    const rows = this.rowsForHashes(viewer, hashes);
    const hits = hashes.map((hash) => {
      const rs = rows.get(hash) ?? [];
      const first = rs[0]!;
      const e = rowToEntry(first);
      return {
        hash,
        name: bestName.get(hash) ?? first.name,
        size: e.size,
        mime: e.mime,
        kind: e.kind,
        meta: e.meta,
        thumb: rs.some((r) => r.thumb === 1),
        sources: this.toSources(rs, t),
      };
    });
    return more ? { hits, cursor: encodeCursor(offset + q.limit) } : { hits };
  }

  sources(viewer: string, hash: string): HubBody<'sources.list'> {
    const rows = this.rowsForHashes(viewer, [hash]).get(hash) ?? [];
    return { hash, sources: this.toSources(rows, this.clock()) };
  }

  /** Sources for one hash, most available first. */
  private toSources(rows: (EntryRow & { owner: string; last_seen: number | null })[], t: number) {
    return rows
      .map((r) => {
        const online = this.isOnline(r.device_id);
        return {
          device_id: r.device_id,
          owner: r.owner,
          path: r.path,
          online,
          seen: online ? ('now' as const) : seenBucket(r.last_seen, t),
        };
      })
      .sort((a, b) => SEEN_ORDER.indexOf(a.seen) - SEEN_ORDER.indexOf(b.seen));
  }

  /**
   * Lists one folder of a device. Returns null when the viewer can't see the device at all,
   * which callers report exactly like a device that doesn't exist.
   */
  browse(viewer: string, deviceId: string, path: string): HubBody<'browse.listing'> | null {
    if (!this.canBrowse(viewer, deviceId)) return null;
    const dir = path === '' || path.endsWith('/') ? path : path + '/';
    const params = { viewer, device: deviceId, dir, len: dir.length };
    const files = (
      this.db.raw
        .prepare(
          `SELECT e.* FROM entries e WHERE e.device_id = @device AND e.dir = @dir AND ${this.visible()} ORDER BY e.name`,
        )
        .all(params) as EntryRow[]
    ).map(rowToEntry);
    const subdirs = this.db.raw
      .prepare(
        `SELECT DISTINCT e.dir FROM entries e
         WHERE e.device_id = @device AND substr(e.dir, 1, @len) = @dir AND e.dir != @dir AND ${this.visible()}`,
      )
      .pluck()
      .all(params) as string[];
    const names = new Set(subdirs.map((d) => d.slice(dir.length).split('/')[0]!));
    return {
      online: this.isOnline(deviceId),
      dirs: [...names].sort().map((name) => ({ name })),
      files,
    };
  }

  /**
   * Every device the viewer can browse, for the desktop Library (M9): their own devices, and
   * other people's devices with at least one entry visible to them. Candidates come from the
   * social graph (own, connected, or sharing with the whole hub), and each is checked with the
   * same `visible()` rule as browse, so the list never reveals a device holding nothing the
   * viewer may see.
   */
  library(viewer: string): {
    device_id: string;
    device_name: string;
    user: { id: string; display_name: string; root_pubkey: string };
    online: boolean;
    seen: Seen;
  }[] {
    const t = this.clock();
    const candidates = this.db.raw
      .prepare(
        `SELECT d.id, d.name, d.last_seen, u.id AS user_id, u.display_name, u.root_pubkey
         FROM devices d JOIN users u ON u.id = d.user_id
         WHERE d.revoked_at IS NULL AND u.banned_at IS NULL AND (
           u.id = @viewer
           OR u.id IN (SELECT user_b FROM connections WHERE user_a = @viewer AND state = 'accepted'
                       UNION SELECT user_a FROM connections WHERE user_b = @viewer AND state = 'accepted')
           OR u.id IN (SELECT dd.user_id FROM access_rules r JOIN devices dd ON dd.id = r.device_id
                       WHERE r.kind = 'hub' AND dd.revoked_at IS NULL)
         )
         ORDER BY u.id = @viewer DESC, u.display_name, d.name
         LIMIT 5000`,
      )
      .all({ viewer }) as {
      id: string;
      name: string;
      last_seen: number | null;
      user_id: string;
      display_name: string;
      root_pubkey: string;
    }[];
    return candidates
      .filter((d) => this.canBrowse(viewer, d.id))
      .map((d) => {
        const online = this.isOnline(d.id);
        return {
          device_id: d.id,
          device_name: d.name,
          user: { id: d.user_id, display_name: d.display_name, root_pubkey: d.root_pubkey },
          online,
          seen: online ? ('now' as const) : seenBucket(d.last_seen, t),
        };
      });
  }

  /** Whether the viewer can see a file with this hash on that device (brokering, HANDOFF §6). */
  canFetch(viewer: string, deviceId: string, hash: string): boolean {
    return (
      this.db.raw
        .prepare(
          `SELECT 1 FROM entries e WHERE e.device_id = @device AND e.hash = @hash AND ${this.visible()} LIMIT 1`,
        )
        .get({ viewer, device: deviceId, hash }) !== undefined
    );
  }

  /**
   * Whether the viewer may watch a folder (HANDOFF §6: watch is filtered like browse): it's on
   * one of their own devices, or they can see at least one entry under it.
   */
  canWatch(viewer: string, deviceId: string, dir: string): boolean {
    const d = this.db.getDevice(deviceId);
    if (!d || d.revoked_at !== null) return false;
    if (d.user_id === viewer) return true;
    return (
      this.db.raw
        .prepare(
          `SELECT 1 FROM entries e WHERE e.device_id = @device AND substr(e.dir, 1, @len) = @dir
           AND ${this.visible()} LIMIT 1`,
        )
        .get({ viewer, device: deviceId, dir, len: dir.length }) !== undefined
    );
  }

  /**
   * What changed in a watched folder after rev `since` (0: everything), as the viewer may see
   * it: files that have a hash (only those can be downloaded), and removals. Tombstones carry a
   * governing rule like entries, so deletions of files the viewer can't see stay hidden too.
   */
  watchChanges(
    viewer: string,
    deviceId: string,
    dir: string,
    recursive: boolean,
    since: number,
  ): { added: Entry[]; removed: string[] } {
    const under = recursive ? 'substr(e.dir, 1, @len) = @dir' : 'e.dir = @dir';
    const params = { viewer, device: deviceId, dir, len: dir.length, since };
    const where = `e.device_id = @device AND ${under} AND (@since = 0 OR e.rev > @since) AND ${this.visible()}`;
    const added = (
      this.db.raw
        .prepare(`SELECT e.* FROM entries e WHERE ${where} AND e.hash IS NOT NULL ORDER BY e.path`)
        .all(params) as EntryRow[]
    ).map(rowToEntry);
    const removed = this.db.raw
      .prepare(`SELECT e.path FROM tombstones e WHERE ${where} ORDER BY e.path`)
      .pluck()
      .all(params) as string[];
    return { added, removed };
  }

  /**
   * Whether anything on the device the viewer can see was added, changed (metadata and
   * thumbnails included: `mrev`) or removed after rev `since`: the test for a `browse.changed`
   * hint, so changes to hidden files never cause one.
   */
  changedSince(viewer: string, deviceId: string, since: number): boolean {
    const params = { viewer, device: deviceId, since };
    const any = (table: string, rev: string) =>
      this.db.raw
        .prepare(
          `SELECT 1 FROM ${table} e WHERE e.device_id = @device AND e.${rev} > @since
           AND ${this.visible()} LIMIT 1`,
        )
        .get(params) !== undefined;
    return any('entries', 'mrev') || any('tombstones', 'rev');
  }

  /** Whether `library(viewer)` lists the device, checked for that one device alone. */
  inLibrary(viewer: string, deviceId: string): boolean {
    const d = this.db.getDevice(deviceId);
    // visible() already hides banned owners' entries from everyone else.
    return !!d && d.revoked_at === null && this.canBrowse(viewer, deviceId);
  }

  /** A device is browsable when the viewer can see at least one entry on it. */
  private canBrowse(viewer: string, deviceId: string): boolean {
    return (
      this.db.raw
        .prepare(
          `SELECT 1 FROM entries e WHERE e.device_id = @device AND ${this.visible()} LIMIT 1`,
        )
        .get({ viewer, device: deviceId }) !== undefined ||
      // Your own (non-revoked) devices are browsable even while empty.
      ((d) => !!d && d.revoked_at === null && d.user_id === viewer)(this.db.getDevice(deviceId))
    );
  }

  private rowsForHashes(
    viewer: string,
    hashes: string[],
  ): Map<string, (EntryRow & { owner: string; last_seen: number | null })[]> {
    const out = new Map<string, (EntryRow & { owner: string; last_seen: number | null })[]>();
    if (hashes.length === 0) return out;
    const params: Record<string, unknown> = { viewer };
    hashes.forEach((h, i) => (params[`h${i}`] = h));
    const rows = this.db.raw
      .prepare(
        `SELECT e.*, d.user_id AS owner, d.last_seen AS last_seen FROM entries e JOIN devices d ON d.id = e.device_id
         WHERE e.hash IN (${hashes.map((_, i) => `@h${i}`).join(',')}) AND ${this.visible()}
         ORDER BY e.device_id, e.path`,
      )
      .all(params) as (EntryRow & { owner: string; last_seen: number | null })[];
    for (const r of rows) {
      const list = out.get(r.hash!) ?? [];
      list.push(r);
      out.set(r.hash!, list);
    }
    return out;
  }
}

const DAY = 86_400;
const WEEK = 7 * DAY;
const SEEN_WITHIN = { today: DAY, week: WEEK, month: 30 * DAY } as const;
const SEEN_ORDER: Seen[] = ['now', 'today', 'week', 'month', 'older'];

/**
 * An offline device's last sign-in, rounded (ADR 0015). "today" is the last 24 hours, not the
 * calendar day, so it doesn't depend on anyone's time zone.
 */
export function seenBucket(lastSeen: number | null, t: number): Seen {
  if (lastSeen === null) return 'older';
  const ago = t - lastSeen;
  if (ago < SEEN_WITHIN.today) return 'today';
  if (ago < SEEN_WITHIN.week) return 'week';
  if (ago < SEEN_WITHIN.month) return 'month';
  return 'older';
}

/**
 * User text → FTS5 query: every word must match as a prefix ("ali 79" finds
 * "Alien (1979).mkv"). Quotes are escaped so user input can't inject FTS syntax.
 */
export function ftsQuery(q: string): string | null {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim())
    .filter((t) => t.length > 0)
    .flatMap((t) => t.split(' '));
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`).toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const m = /^o:(\d{1,9})$/.exec(Buffer.from(cursor, 'base64url').toString());
  return m ? Number(m[1]) : 0;
}
