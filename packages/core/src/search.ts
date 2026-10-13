import { Seen, type ClientBody, type HubBody } from '@communal/protocol';
import type { HubManager } from './hub-manager.js';

type Hit = HubBody<'search.results'>['hits'][number];

export interface MergedSource extends Omit<Hit['sources'][number], never> {
  /** Local hub id; that hub brokers any transfer from this source (ADR 0007). */
  hub: string;
}

export interface MergedHit extends Omit<Hit, 'sources'> {
  sources: MergedSource[];
}

export interface MergedSearch {
  hits: MergedHit[];
  /** Per hub: whether it answered, its next-page cursor, or why it didn't. */
  hubs: { hub: string; ok: boolean; cursor?: string; error?: string }[];
}

/**
 * Runs one search on every connected hub at once and merges the results by content hash, so
 * a file held on several hubs is one hit with all its sources (ADR 0007). Hit order follows
 * each hub's ranking, interleaved round-robin so no single hub dominates the first page.
 * Cursors are per hub: pass back `cursors` to fetch each hub's next page.
 */
export async function searchAll(
  hubs: HubManager,
  q: Omit<ClientBody<'search'>, 'cursor'>,
  cursors: Record<string, string> = {},
): Promise<MergedSearch> {
  const results = await Promise.all(
    hubs.list().map(async (h) => {
      const client = hubs.get(h.id);
      if (!client?.ready) return { hub: h.id, ok: false as const, error: 'offline' };
      try {
        const body = cursors[h.id] ? { ...q, cursor: cursors[h.id] } : q;
        const reply = await client.request('search', body);
        if (reply.t !== 'search.results') throw new Error(`unexpected reply ${reply.t}`);
        return { hub: h.id, ok: true as const, res: reply.body };
      } catch (err) {
        return { hub: h.id, ok: false as const, error: (err as Error).message };
      }
    }),
  );

  const merged = new Map<string, MergedHit>();
  const order: string[] = [];
  const lists = results.flatMap((r) => (r.ok ? [{ hub: r.hub, hits: r.res.hits }] : []));
  const longest = Math.max(0, ...lists.map((l) => l.hits.length));
  for (let i = 0; i < longest; i++) {
    for (const { hub, hits } of lists) {
      const hit = hits[i];
      if (!hit) continue;
      const sources = hit.sources.map((s) => ({ ...s, hub }));
      const existing = merged.get(hit.hash);
      if (existing) {
        existing.sources.push(...sources);
        existing.thumb ||= hit.thumb;
      } else {
        merged.set(hit.hash, { ...hit, sources });
        order.push(hit.hash);
      }
    }
  }
  const rank = (s: { seen: Seen }) => Seen.options.indexOf(s.seen);
  for (const hit of merged.values()) hit.sources.sort((a, b) => rank(a) - rank(b));
  // Each hub ranks by availability first (ADR 0015); keep that across hubs. The sort is stable,
  // so hits stay in relevance order within an availability tier.
  const hits = order.map((h) => merged.get(h)!);
  const tier = (h: MergedHit) => {
    const seen = h.sources[0]?.seen;
    return seen === 'now' ? 0 : seen === 'today' || seen === 'week' ? 1 : 2;
  };
  hits.sort((a, b) => tier(a) - tier(b));

  return {
    hits,
    hubs: results.map((r) =>
      r.ok
        ? { hub: r.hub, ok: true, ...(r.res.cursor ? { cursor: r.res.cursor } : {}) }
        : { hub: r.hub, ok: false, error: r.error },
    ),
  };
}

/** How a source's availability reads in the UI and CLI (ADR 0015). */
export function seenLabel(seen: Seen): string {
  switch (seen) {
    case 'now':
      return 'online';
    case 'today':
      return 'offline · seen today';
    case 'week':
      return 'offline · seen this week';
    case 'month':
      return 'offline · seen this month';
    case 'older':
      return 'offline · not seen for over a month';
  }
}
