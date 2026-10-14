import { pino, type Logger } from 'pino';
import type { HubBody } from '@communal/protocol';
import type { HubManager } from '../hub-manager.js';
import type { FileRow, IndexStore } from './store.js';
import { HubError } from '../hub-client.js';

/** Max entries per snapshot page / delta (HANDOFF §5: pages of ~5,000). */
export const PAGE = 5_000;

type Entry = HubBody<'browse.listing'>['files'][number];

export function toEntry(f: FileRow): Entry {
  return {
    path: `${f.share}/${f.rel}`,
    size: f.size,
    mtime: Math.floor(f.mtime / 1000),
    mime: f.mime,
    kind: f.kind,
    meta: f.meta ? (JSON.parse(f.meta) as Entry['meta']) : {},
    thumb: f.thumb === 1,
    hash: f.hash,
  };
}

/**
 * Publishes the local index to every hub a share is published to (ADR 0007/0008). Each hub
 * has its own rev and acked position in the local change log:
 *
 * - on sign-in, if the hub's rev (from `welcome`) isn't the one we last had acked, or we've
 *   never synced with it, send a full snapshot;
 * - otherwise send deltas built from the change log since the acked position;
 * - if the hub answers a delta with `index.resync`, fall back to a snapshot.
 */
export class IndexSync {
  private readonly log: Logger;
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly hubRev = new Map<string, number>();
  /** Hubs owed a full snapshot (also persisted by deleting their hub_sync row). */
  private readonly forced = new Set<string>();

  constructor(
    private readonly store: IndexStore,
    private readonly hubs: HubManager,
    log?: Logger,
  ) {
    this.log = log ?? pino({ name: 'index-sync' });
    hubs.on('ready', ({ hub, welcome }) => {
      this.hubRev.set(hub, welcome.index_rev);
      this.schedule(hub);
    });
  }

  /** Push pending changes to every connected hub. */
  pushAll() {
    for (const h of this.hubs.list()) if (h.ready) this.schedule(h.id);
  }

  /** Forces a full snapshot to `hub` next time (e.g. a share was (un)published there). */
  resync(hub: string) {
    this.forced.add(hub);
    this.store.forgetHub(hub);
    if (this.hubs.get(hub)?.ready) this.schedule(hub);
  }

  /** Resolves when no sync is in flight (tests). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running.values());
  }

  private schedule(hub: string) {
    if (this.running.has(hub)) {
      this.again.add(hub);
      return;
    }
    const run = (async () => {
      try {
        do {
          this.again.delete(hub);
          await this.sync(hub);
        } while (this.again.has(hub));
      } catch (err) {
        // Disconnects reject in-flight requests; the next `ready` starts over. A refusal (say,
        // more files than the hub takes, ADR 0022) is tried again on the next change.
        if (err instanceof HubError && err.code !== 'internal')
          this.log.warn({ hub, code: err.code, err: err.message }, 'hub refused the index');
        else this.log.debug({ hub, err: (err as Error).message }, 'index sync interrupted');
      } finally {
        this.running.delete(hub);
      }
    })();
    this.running.set(hub, run);
  }

  private publishedShares(hub: string): string[] {
    return this.store
      .shares()
      .filter((s) => s.hubs.includes(hub))
      .map((s) => s.name);
  }

  private async sync(hub: string) {
    const client = this.hubs.get(hub);
    if (!client?.ready) return;
    const st = this.store.hubSync(hub);
    const hubRev = this.hubRev.get(hub) ?? 0;
    if (!st || st.rev !== hubRev || this.forced.has(hub))
      return this.snapshot(hub, Math.max(hubRev, st?.rev ?? 0) + 1);

    let { rev, acked_seq: acked } = st;
    for (;;) {
      const changes = this.store.changesSince(acked, PAGE);
      if (changes.length === 0) return;
      const lastSeq = changes[changes.length - 1]!.seq;
      const published = new Set(this.publishedShares(hub));
      // Coalesce to the final state of each path; removals are sent even for shares that are
      // no longer published here (the hub ignores paths it doesn't have).
      const touched = new Map<string, { share: string; rel: string }>();
      for (const c of changes) touched.set(`${c.share}/${c.rel}`, c);
      const upsert: Entry[] = [];
      const remove: string[] = [];
      for (const [path, c] of touched) {
        const f = published.has(c.share) ? this.store.file(c.share, c.rel) : undefined;
        if (f) upsert.push(toEntry(f));
        else remove.push(path);
      }
      const reply = await client.request('index.delta', {
        base_rev: rev,
        rev: rev + 1,
        upsert,
        remove,
      });
      if (reply.t === 'index.resync') {
        this.log.info({ hub, reason: reply.body.reason }, 'hub asked for a resync');
        return this.snapshot(hub, Math.max(rev, this.hubRev.get(hub) ?? 0) + 1);
      }
      if (reply.t !== 'index.ack') throw new Error(`unexpected reply ${reply.t}`);
      rev = reply.body.rev;
      acked = lastSeq;
      this.hubRev.set(hub, rev);
      this.store.setHubSync(hub, rev, acked);
    }
  }

  private async snapshot(hub: string, rev: number) {
    const client = this.hubs.get(hub);
    if (!client?.ready) return;
    // A resync requested after this point must trigger another snapshot (shares may change
    // while we page through them), so clear the flag now rather than at the end.
    this.forced.delete(hub);
    const seqAtStart = this.store.maxSeq();
    const started = Date.now();
    let page = 0;
    let buf: Entry[] = [];
    let total = 0;
    const send = async (last: boolean) => {
      const reply = await client.request('index.snapshot', { rev, page, last, entries: buf });
      if (last ? reply.t !== 'index.ack' : reply.t !== 'ok')
        throw new Error(`unexpected reply ${reply.t}`);
      total += buf.length;
      buf = [];
      page++;
    };
    const shares = this.publishedShares(hub);
    let after: { share: string; rel: string } | null = null;
    for (;;) {
      const rows = this.store.filesPage(shares, after, PAGE);
      if (rows.length < PAGE) {
        buf = rows.map(toEntry);
        break;
      }
      buf = rows.map(toEntry);
      after = rows[rows.length - 1]!;
      await send(false);
    }
    await send(true);
    this.hubRev.set(hub, rev);
    if (this.forced.has(hub)) {
      // Superseded mid-flight: leave hub_sync deleted so even a restart re-snapshots.
      this.again.add(hub);
      return;
    }
    this.store.setHubSync(hub, rev, seqAtStart);
    this.log.info(
      { hub, rev, entries: total, pages: page, ms: Date.now() - started },
      'index snapshot sent',
    );
    // Anything that changed while we were sending goes out as a delta.
    if (this.store.maxSeq() > seqAtStart) this.again.add(hub);
  }
}
