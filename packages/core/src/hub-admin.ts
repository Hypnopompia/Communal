import type { ClientBody, ClientType, HubBody, HubType } from '@communal/protocol';
import { CoreError } from './errors.js';
import { HubError } from './hub-client.js';
import type { HubManager } from './hub-manager.js';
import type { IndexStore } from './index/store.js';

export type AdminUser = HubBody<'admin.user.listing'>['users'][number] & {
  /** This user verified them by comparing safety codes (the fingerprint matches). */
  verified: boolean;
};
export type AdminSettings = HubBody<'admin.settings'>;
export type AdminSettingsChange = ClientBody<'admin.settings.set'>;
export type AdminLog = HubBody<'admin.log.listing'>;

export interface AdminGraph {
  people: {
    user_id: string;
    display_name: string;
    admin: boolean;
    status: 'active' | 'pending';
    banned: boolean;
  }[];
  connections: HubBody<'admin.graph.listing'>['connections'];
}

/**
 * Managing a hub this account administers (ADR 0020). Every call goes to that hub, which checks
 * again that the account is an admin; `welcome.admin` only saves a pointless round trip.
 */
export class HubAdmin {
  constructor(
    private readonly hubs: HubManager,
    private readonly store: IndexStore,
  ) {}

  /** Whether this account administers the hub, as it said at sign-in. */
  isAdmin(hub: string): boolean {
    return this.hubs.get(hub)?.session?.admin === true;
  }

  private async ask<Q extends ClientType, R extends HubType>(
    hub: string,
    t: Q,
    body: ClientBody<Q>,
    expect: R,
  ): Promise<HubBody<R>> {
    const client = this.hubs.get(hub);
    if (!client) throw new CoreError('not_found', `no such hub: ${hub}`);
    if (!client.ready) throw new CoreError('unavailable', 'hub is offline');
    if (client.session?.admin !== true)
      throw new CoreError('forbidden', "you don't administer this hub");
    let reply;
    try {
      reply = await client.request(t, body);
    } catch (err) {
      // An admin removed by the hub's shell since sign-in gets what a non-admin gets.
      if (
        err instanceof HubError &&
        err.code === 'bad_request' &&
        /^unknown type/.test(err.message)
      )
        throw new CoreError('forbidden', "you don't administer this hub any more");
      throw err;
    }
    if (reply.t !== expect) throw new CoreError('unavailable', `unexpected reply ${reply.t}`);
    return reply.body as HubBody<R>;
  }

  async users(hub: string): Promise<AdminUser[]> {
    const r = await this.ask(hub, 'admin.users', {}, 'admin.user.listing');
    return r.users.map((u) => ({
      ...u,
      verified: this.store.verifiedFingerprint(u.user_id) === u.fingerprint,
    }));
  }

  async approve(hub: string, userId: string) {
    await this.ask(hub, 'admin.approve', { user_id: userId }, 'ok');
  }

  async ban(hub: string, userId: string, reason?: string) {
    await this.ask(hub, 'admin.ban', { user_id: userId, ...(reason ? { reason } : {}) }, 'ok');
  }

  async unban(hub: string, userId: string) {
    await this.ask(hub, 'admin.unban', { user_id: userId }, 'ok');
  }

  settings(hub: string): Promise<AdminSettings> {
    return this.ask(hub, 'admin.settings.get', {}, 'admin.settings');
  }

  async updateSettings(hub: string, change: AdminSettingsChange): Promise<AdminSettings> {
    const r = await this.ask(hub, 'admin.settings.set', change, 'admin.settings');
    // Others pick a new name up when they next connect; the admin sees it at once.
    if (change.name !== undefined) await this.hubs.get(hub)?.rememberName(r.name);
    return r;
  }

  /** Accounts and the connections between them: never groups or rules (ADR 0020). */
  async graph(hub: string): Promise<AdminGraph> {
    const [users, graph] = await Promise.all([
      this.ask(hub, 'admin.users', {}, 'admin.user.listing'),
      this.ask(hub, 'admin.graph', {}, 'admin.graph.listing'),
    ]);
    return {
      people: users.users.map((u) => ({
        user_id: u.user_id,
        display_name: u.display_name,
        admin: u.admin,
        status: u.status,
        banned: u.banned_at !== null,
      })),
      connections: graph.connections,
    };
  }

  log(hub: string, opts: { limit?: number; before?: number } = {}): Promise<AdminLog> {
    return this.ask(
      hub,
      'admin.log',
      { limit: opts.limit ?? 100, ...(opts.before ? { before: opts.before } : {}) },
      'admin.log.listing',
    );
  }
}
