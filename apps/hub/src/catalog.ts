import type { ClientBody, HubBody } from '@communal/protocol';
import { rowToEntry, type EntryRow, type HubDb } from './db.js';

/**
 * Search, browse and sources over the hub's index. Every query goes through `visible()`, the
 * one place that decides which entries a requester may see (HANDOFF §6):
 *
 * - M2: a user sees entries from their own non-revoked devices only.
 * - M3 extends it with access rules (per hub, ADR 0007) — keep it the single choke point.
 *
 * Entries from banned or revoked owners are never visible. Inaccessible files never show up,
 * not even as counts.
 */
export class Catalog {
  constructor(
    private readonly db: HubDb,
    private readonly isOnline: (deviceId: string) => boolean,
  ) {}

  /** SQL condition over `e` (entries) for what @viewer may see. */
  private visible(): string {
    return `e.device_id IN (
      SELECT d.id FROM devices d JOIN users u ON u.id = d.user_id
      WHERE d.revoked_at IS NULL AND u.banned_at IS NULL AND d.user_id = @viewer
    )`;
  }

  search(viewer: string, q: ClientBody<'search'>): HubBody<'search.results'> {
    const match = ftsQuery(q.q);
    const offset = decodeCursor(q.cursor);
    const where = ['e.hash IS NOT NULL', this.visible()];
    const params: Record<string, unknown> = { viewer, limit: q.limit + 1, offset };
    if (q.kind) {
      where.push('e.kind = @kind');
      params.kind = q.kind;
    }
    if (q.min_size !== undefined) {
      where.push('e.size >= @min_size');
      params.min_size = q.min_size;
    }
    let from = 'entries e';
    let rank = '0';
    if (match) {
      from = 'entries_fts JOIN entries e ON e.rowid = entries_fts.rowid';
      where.push('entries_fts MATCH @match');
      rank = 'bm25(entries_fts)';
      params.match = match;
    }
    // One hit per distinct content hash, best match first (then newest).
    const groups = this.db.raw
      .prepare(
        // bm25() can't sit inside an aggregate: rank each row in a materialized CTE (so the
        // planner can't flatten it back into the GROUP BY), then group by hash.
        `WITH ranked AS MATERIALIZED (
           SELECT e.hash AS hash, ${rank} AS r, e.mtime AS m FROM ${from} WHERE ${where.join(' AND ')}
         )
         SELECT hash, min(r) AS r, max(m) AS m FROM ranked
         GROUP BY hash ORDER BY r, m DESC, hash LIMIT @limit OFFSET @offset`,
      )
      .all(params) as { hash: string }[];
    const more = groups.length > q.limit;
    const hashes = groups.slice(0, q.limit).map((g) => g.hash);
    const rows = this.rowsForHashes(viewer, hashes);
    const hits = hashes.map((hash) => {
      const rs = rows.get(hash) ?? [];
      const first = rs[0]!;
      const e = rowToEntry(first);
      return {
        hash,
        name: first.name,
        size: e.size,
        mime: e.mime,
        kind: e.kind,
        meta: e.meta,
        thumb: rs.some((r) => r.thumb === 1),
        sources: rs
          .map((r) => ({
            device_id: r.device_id,
            owner: r.owner,
            path: r.path,
            online: this.isOnline(r.device_id),
          }))
          .sort((a, b) => Number(b.online) - Number(a.online)),
      };
    });
    return more ? { hits, cursor: encodeCursor(offset + q.limit) } : { hits };
  }

  sources(viewer: string, hash: string): HubBody<'sources.list'> {
    const rows = this.rowsForHashes(viewer, [hash]).get(hash) ?? [];
    return {
      hash,
      sources: rows
        .map((r) => ({
          device_id: r.device_id,
          owner: r.owner,
          path: r.path,
          online: this.isOnline(r.device_id),
        }))
        .sort((a, b) => Number(b.online) - Number(a.online)),
    };
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

  /** M2: only your own devices. M3: devices with at least one entry visible to the viewer. */
  private canBrowse(viewer: string, deviceId: string): boolean {
    const d = this.db.getDevice(deviceId);
    return !!d && d.revoked_at === null && d.user_id === viewer;
  }

  private rowsForHashes(
    viewer: string,
    hashes: string[],
  ): Map<string, (EntryRow & { owner: string })[]> {
    const out = new Map<string, (EntryRow & { owner: string })[]>();
    if (hashes.length === 0) return out;
    const params: Record<string, unknown> = { viewer };
    hashes.forEach((h, i) => (params[`h${i}`] = h));
    const rows = this.db.raw
      .prepare(
        `SELECT e.*, d.user_id AS owner FROM entries e JOIN devices d ON d.id = e.device_id
         WHERE e.hash IN (${hashes.map((_, i) => `@h${i}`).join(',')}) AND ${this.visible()}
         ORDER BY e.device_id, e.path`,
      )
      .all(params) as (EntryRow & { owner: string })[];
    for (const r of rows) {
      const list = out.get(r.hash!) ?? [];
      list.push(r);
      out.set(r.hash!, list);
    }
    return out;
  }
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
