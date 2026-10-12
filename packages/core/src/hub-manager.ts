import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { toBase32 } from '@communal/crypto';
import type { ClientBody, ClientType, HubBody, HubMessage } from '@communal/protocol';
import {
  HubClient,
  HubError,
  type HubClientOptions,
  type Enrolled,
  type Enrollment,
  type HubClientState,
  type HubFatalError,
} from './hub-client.js';

/**
 * One configured hub. `id` is a local handle that stays stable even if the hub's URL changes.
 * The hub's own identity is its pinned key (`state.hubPubkey`).
 */
export interface HubEntry {
  id: string;
  url: string;
  state: HubClientState;
}

export interface HubManagerEvents {
  ready: [{ hub: string; welcome: HubBody<'welcome'> }];
  presence: [{ hub: string; presence: HubBody<'presence'> }];
  event: [{ hub: string; msg: HubMessage }];
  account_created: [{ hub: string; created: HubBody<'account.created'> }];
  enrolled: [{ hub: string; enrolled: Enrolled }];
  pending_approval: [{ hub: string }];
  disconnected: [{ hub: string; code: number; reason: string }];
  fatal: [{ hub: string; error: HubFatalError }];
}

/** Options shared by every hub's client (timers, TLS, logging, the device key...). */
export type SharedClientOptions = Omit<HubClientOptions, 'url' | 'state' | 'saveState' | 'enroll'>;

export interface HubManagerOptions extends SharedClientOptions {
  hubs: HubEntry[];
  save: (hubs: HubEntry[]) => void | Promise<void>;
}

export type FanOutResult =
  { hub: string; ok: true; msg: HubMessage } | { hub: string; ok: false; error: Error };

export const newHubId = (): string => 'h_' + toBase32(randomBytes(6));

/**
 * Runs one HubClient per configured hub with the same device identity, so the app can be on
 * several hubs at once and fan a request (e.g. a search) out to all of them (ADR 0007).
 */
export class HubManager extends EventEmitter<HubManagerEvents> {
  private readonly hubs = new Map<string, { entry: HubEntry; client: HubClient }>();
  private started = false;

  constructor(private readonly opts: HubManagerOptions) {
    super();
    for (const entry of opts.hubs) this.attach(entry);
  }

  /** Configured hubs with their connection status. */
  list(): (HubEntry & { ready: boolean })[] {
    return [...this.hubs.values()].map(({ entry, client }) => ({ ...entry, ready: client.ready }));
  }

  get(id: string): HubClient | undefined {
    return this.hubs.get(id)?.client;
  }

  /** Finds a hub by local id or URL. */
  find(idOrUrl: string): HubEntry | undefined {
    return (
      this.hubs.get(idOrUrl)?.entry ??
      [...this.hubs.values()].find((h) => h.entry.url === idOrUrl)?.entry
    );
  }

  start() {
    this.started = true;
    for (const { client } of this.hubs.values()) client.start();
  }

  async stop() {
    this.started = false;
    await Promise.all([...this.hubs.values()].map(({ client }) => client.stop()));
  }

  /**
   * Adds a hub and connects to it (if the manager is running). With `enroll`, the device
   * registers on that hub; the account keeps the same user_id on every hub because it derives
   * from the root key. `hubPubkey` pins a key learned elsewhere (a link bundle, a recovery file).
   */
  async add(url: string, enroll?: Enrollment, hubPubkey?: string): Promise<HubEntry> {
    if (this.find(url)) throw new Error(`already configured: ${url}`);
    const entry: HubEntry = {
      id: newHubId(),
      url,
      state: { registered: false, ...(hubPubkey ? { hubPubkey } : {}) },
    };
    this.attach(entry, enroll);
    await this.persist();
    if (this.started) this.hubs.get(entry.id)!.client.start();
    return entry;
  }

  /** Disconnects and forgets a hub locally. The account stays on that hub. */
  async remove(idOrUrl: string): Promise<boolean> {
    const entry = this.find(idOrUrl);
    if (!entry) return false;
    const { client } = this.hubs.get(entry.id)!;
    this.hubs.delete(entry.id);
    await client.stop();
    client.removeAllListeners();
    await this.persist();
    return true;
  }

  /**
   * Sends the same request to every signed-in hub in parallel and settles per hub; a slow or
   * failing hub never blocks the others. Hubs that aren't connected report an error.
   */
  async requestAll<T extends ClientType>(t: T, body: ClientBody<T>): Promise<FanOutResult[]> {
    return Promise.all(
      [...this.hubs.values()].map(async ({ entry, client }): Promise<FanOutResult> => {
        try {
          return { hub: entry.id, ok: true, msg: await client.request(t, body) };
        } catch (error) {
          return {
            hub: entry.id,
            ok: false,
            error: error instanceof Error ? error : new HubError('internal', String(error)),
          };
        }
      }),
    );
  }

  private attach(entry: HubEntry, enroll?: HubClientOptions['enroll']) {
    const { hubs: _hubs, save: _save, ...shared } = this.opts;
    const client = new HubClient({
      ...shared,
      url: entry.url,
      state: entry.state,
      saveState: () => this.persist(),
      enroll,
    });
    const hub = entry.id;
    client.on('ready', (welcome) => this.emit('ready', { hub, welcome }));
    client.on('presence', (presence) => this.emit('presence', { hub, presence }));
    client.on('event', (msg) => this.emit('event', { hub, msg }));
    client.on('account_created', (created) => this.emit('account_created', { hub, created }));
    client.on('enrolled', (enrolled) => this.emit('enrolled', { hub, enrolled }));
    client.on('pending_approval', () => this.emit('pending_approval', { hub }));
    client.on('disconnected', (d) => this.emit('disconnected', { hub, ...d }));
    client.on('fatal', (error) => this.emit('fatal', { hub, error }));
    this.hubs.set(entry.id, { entry, client });
  }

  private async persist() {
    await this.opts.save([...this.hubs.values()].map((h) => h.entry));
  }
}
