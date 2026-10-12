import { governingRule } from '@communal/protocol';
import type { HubManager } from '../hub-manager.js';
import type { Audience, IndexStore } from '../index/store.js';

const TTL_MS = 30_000;

/**
 * The uploader's own access check (HANDOFF §2 "the uploader re-checks rules before sending any
 * byte"): this device's rules for the hub that brokered the request — never another hub's —
 * plus that hub's view of connections and of this user's groups, cached briefly and dropped
 * whenever a connection changes.
 */
export class AccessOracle {
  private readonly cache = new Map<
    string,
    { at: number; connected: Set<string>; groups: Map<string, Set<string>> }
  >();

  constructor(
    private readonly hubs: HubManager,
    private readonly store: IndexStore,
  ) {
    hubs.on('event', ({ hub, msg }) => {
      if (msg.t.startsWith('connection.')) this.cache.delete(hub);
    });
  }

  /** The audience governing `path` on `hub` ("me" when no rule applies). */
  audience(hub: string, path: string): Audience {
    const rules = this.store.rules(hub);
    const g = governingRule(new Set(rules.map((r) => r.path)), path);
    return g === null ? 'me' : rules.find((r) => r.path === g)!.audience;
  }

  async allows(hub: string, requesterUser: string, path: string): Promise<boolean> {
    const mine = this.hubs.find(hub)?.state.userId;
    if (requesterUser === mine) return true; // own devices see everything
    const a = this.audience(hub, path);
    if (a === 'me') return false;
    if (a === 'hub') return true; // the token proves the requester is on this hub
    const st = await this.state(hub);
    if (!st.connected.has(requesterUser)) return false;
    if (a.users?.includes(requesterUser)) return true;
    return (a.groups ?? []).some((g) => st.groups.get(g)?.has(requesterUser));
  }

  private async state(hub: string) {
    const hit = this.cache.get(hub);
    if (hit && Date.now() - hit.at < TTL_MS) return hit;
    const client = this.hubs.get(hub);
    if (!client?.ready) throw new Error('hub offline');
    const [conns, groups] = await Promise.all([
      client.request('connection.list', {}),
      client.request('group.list', {}),
    ]);
    const st = {
      at: Date.now(),
      connected: new Set(
        conns.t === 'connection.listing'
          ? conns.body.connections.filter((c) => c.state === 'accepted').map((c) => c.user.user_id)
          : [],
      ),
      groups: new Map(
        groups.t === 'group.listing'
          ? groups.body.groups.map((g) => [g.group_id, new Set(g.members)] as const)
          : [],
      ),
    };
    this.cache.set(hub, st);
    return st;
  }
}
