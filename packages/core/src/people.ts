import { fingerprint, fromB64, safetyCode, userId } from '@communal/crypto';
import type { ClientBody, ClientType, HubBody, HubType } from '@communal/protocol';
import type { HubManager } from './hub-manager.js';
import type { IndexStore } from './index/store.js';

type Summary = HubBody<'user.results'>['users'][number];

export interface Person {
  user_id: string;
  display_name: string;
  fingerprint: string;
  /** This user verified them by comparing safety codes. */
  verified: boolean;
}

export class PeopleError extends Error {
  constructor(
    readonly code: 'not_found' | 'unavailable' | 'hub_mismatch' | 'rejected',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The hub is not trusted to tell the truth about identities: a user id and fingerprint must
 * derive from the root key the hub hands over, or a malicious hub could substitute keys for
 * people you've verified (HANDOFF §2 "loud warning if a verified root key changes").
 */
export function checkSummary(u: Summary): boolean {
  try {
    const root = fromB64(u.root_pubkey);
    return userId(root) === u.user_id && fingerprint(root) === u.fingerprint;
  } catch {
    return false;
  }
}

/** Connections, user search, groups and verification on each hub (HANDOFF §2, §11 People). */
export class People {
  constructor(
    private readonly hubs: HubManager,
    private readonly store: IndexStore,
  ) {}

  private async ask<Q extends ClientType, R extends HubType>(
    hub: string,
    t: Q,
    body: ClientBody<Q>,
    expect: R,
  ): Promise<HubBody<R>> {
    const client = this.hubs.get(hub);
    if (!client) throw new PeopleError('not_found', `no such hub: ${hub}`);
    if (!client.ready) throw new PeopleError('unavailable', 'hub is offline');
    const reply = await client.request(t, body);
    if (reply.t !== expect) throw new PeopleError('rejected', `unexpected reply ${reply.t}`);
    return reply.body as HubBody<R>;
  }

  private person(u: Summary): Person {
    if (!checkSummary(u)) {
      throw new PeopleError(
        'hub_mismatch',
        `the hub sent a key that doesn't match ${u.user_id}; it may be compromised`,
      );
    }
    return {
      user_id: u.user_id,
      display_name: u.display_name,
      fingerprint: u.fingerprint,
      verified: this.store.verifiedFingerprint(u.user_id) === u.fingerprint,
    };
  }

  async search(hub: string, q: string, limit = 20): Promise<Person[]> {
    const r = await this.ask(hub, 'user.search', { q, limit }, 'user.results');
    return r.users.filter(checkSummary).map((u) => this.person(u));
  }

  /**
   * Devices this user can browse on every connected hub (the desktop Library). Entries whose
   * identity doesn't check out are dropped, like everywhere else. A hub that's offline or fails
   * is reported rather than failing the whole listing.
   */
  async library() {
    const results = await this.hubs.requestAll('library', {});
    const devices = [];
    const hubs = [];
    for (const r of results) {
      if (!r.ok || r.msg.t !== 'library.listing') {
        hubs.push({
          hub: r.hub,
          ok: false,
          error: r.ok ? `unexpected reply ${r.msg.t}` : r.error.message,
        });
        continue;
      }
      hubs.push({ hub: r.hub, ok: true });
      const body = r.msg.body as HubBody<'library.listing'>;
      for (const d of body.devices) {
        if (!checkSummary(d.user)) continue;
        const { user, ...rest } = d;
        devices.push({ hub: r.hub, ...rest, user: this.person(user) });
      }
    }
    return { devices, hubs };
  }

  async connections(hub: string) {
    const r = await this.ask(hub, 'connection.list', {}, 'connection.listing');
    return r.connections
      .filter((c) => checkSummary(c.user))
      .map((c) => ({
        ...this.person(c.user),
        state: c.state,
        since: c.since,
        ...(c.online !== undefined ? { online: c.online } : {}),
        ...(c.seen ? { seen: c.seen } : {}),
      }));
  }

  async request(hub: string, user: string) {
    await this.ask(hub, 'connection.request', { user_id: user }, 'ok');
  }

  async accept(hub: string, user: string) {
    await this.ask(hub, 'connection.accept', { user_id: user }, 'ok');
  }

  async remove(hub: string, user: string) {
    await this.ask(hub, 'connection.remove', { user_id: user }, 'ok');
  }

  async groups(hub: string) {
    return (await this.ask(hub, 'group.list', {}, 'group.listing')).groups;
  }

  async upsertGroup(hub: string, group: { group_id?: string; name: string; members: string[] }) {
    const r = await this.ask(hub, 'group.upsert', group, 'group.listing');
    return r.groups[0]!;
  }

  async deleteGroup(hub: string, groupId: string) {
    await this.ask(hub, 'group.delete', { group_id: groupId }, 'ok');
  }

  /**
   * The safety code to compare with `user` out of band: derived from both root fingerprints,
   * so it's the same on both sides and on every hub.
   */
  async safetyCode(hub: string, user: string): Promise<{ person: Person; code: string }> {
    const mine = this.hubs.find(hub)?.state.fingerprint;
    if (!mine) throw new PeopleError('unavailable', 'not signed in to that hub yet');
    const them = (await this.connections(hub)).find((c) => c.user_id === user);
    if (!them) throw new PeopleError('not_found', 'you can only verify your connections');
    return { person: them, code: safetyCode(mine, them.fingerprint) };
  }

  async verify(hub: string, user: string, verified: boolean) {
    const { person } = await this.safetyCode(hub, user);
    this.store.setVerified(user, verified ? person.fingerprint : null);
  }
}
