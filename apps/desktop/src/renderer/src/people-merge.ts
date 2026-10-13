/**
 * People across hubs (ADR 0021): the same account has the same user_id on every hub, so the
 * People screen shows each person once. Their connection on each hub stays separate (it's that
 * hub's, and so are its actions); the name comes from the first hub you joined that knows them.
 */
import type { Connection, Person, Seen } from './api';

export interface HubLink {
  hub: string;
  state: Connection['state'];
  since: number;
  online?: boolean;
  seen?: Seen;
}

export interface MergedPerson extends Person {
  /** In the order of your hubs (the first you joined first). */
  hubs: HubLink[];
  /** Online on any hub where you're connected. */
  online: boolean;
  /** The most recent `seen` across those hubs. */
  seen?: Seen;
}

const RECENCY: Seen[] = ['now', 'today', 'week', 'month', 'older'];

/** `perHub` in hub order; each hub's connections as it listed them. */
export function mergePeople(perHub: { hub: string; connections: Connection[] }[]): MergedPerson[] {
  const byId = new Map<string, MergedPerson>();
  for (const { hub, connections } of perHub) {
    for (const c of connections) {
      let p = byId.get(c.user_id);
      if (!p) {
        p = {
          user_id: c.user_id,
          display_name: c.display_name,
          fingerprint: c.fingerprint,
          verified: c.verified,
          hubs: [],
          online: false,
        };
        byId.set(c.user_id, p);
      }
      p.verified ||= c.verified;
      p.hubs.push({
        hub,
        state: c.state,
        since: c.since,
        ...(c.online !== undefined ? { online: c.online } : {}),
        ...(c.seen ? { seen: c.seen } : {}),
      });
      if (c.state === 'accepted') {
        p.online ||= !!c.online;
        if (c.seen && (!p.seen || RECENCY.indexOf(c.seen) < RECENCY.indexOf(p.seen)))
          p.seen = c.seen;
      }
    }
  }
  return [...byId.values()];
}
