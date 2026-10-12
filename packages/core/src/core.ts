import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pino, type Logger } from 'pino';
import { deviceId, type KeyPair } from '@communal/crypto';
import type { ClientBody, HubBody } from '@communal/protocol';
import { HubManager, type HubEntry, type SharedClientOptions } from './hub-manager.js';
import { Indexer, type IndexerOptions } from './index/indexer.js';
import { IndexStore, type Audience, type ShareRow } from './index/store.js';
import { People } from './people.js';
import { IndexSync } from './index/sync.js';
import { searchAll, type MergedSearch } from './search.js';
import type { HubClientOptions } from './hub-client.js';

export interface CoreOptions {
  dataDir: string;
  device: KeyPair;
  /** Hub client settings shared by every hub (client name, dev TLS, timers for tests…). */
  hubClient?: Omit<SharedClientOptions, 'device' | 'log'>;
  indexer?: Omit<IndexerOptions, 'log'>;
  log?: Logger;
}

export class CoreError extends Error {
  constructor(
    readonly code: 'bad_request' | 'not_found' | 'conflict' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

/** A share name becomes the first segment of every hub-visible path. */
const SHARE_NAME = /^(?!\.{1,2}$)[^/\\\0]{1,255}$/;

/**
 * The client engine (HANDOFF §3 "core"): hubs, shares, indexing, index sync and search.
 * Hosts never reach into the parts directly; the local API wraps these methods.
 */
export class CommunalCore {
  readonly hubs: HubManager;
  readonly store: IndexStore;
  readonly indexer: Indexer;
  readonly sync: IndexSync;
  readonly people: People;
  readonly log: Logger;
  private readonly hubsFile: string;

  constructor(private readonly o: CoreOptions) {
    this.log = o.log ?? pino({ name: 'core' });
    mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
    this.hubsFile = join(o.dataDir, 'hubs.json');
    this.store = new IndexStore(join(o.dataDir, 'index.db'));
    this.hubs = new HubManager({
      ...o.hubClient,
      device: o.device,
      hubs: this.loadHubs(),
      save: (hubs) => this.saveHubs(hubs),
      log: this.log,
    });
    this.indexer = new Indexer(this.store, { ...o.indexer, log: this.log });
    this.sync = new IndexSync(this.store, this.hubs, this.log);
    this.indexer.on('changed', () => this.sync.pushAll());
    this.people = new People(this.hubs, this.store);
    // Each hub gets this device's full rule set for that hub on every sign-in (ADR 0009).
    this.hubs.on('ready', ({ hub }) => void this.pushRules(hub));
  }

  get deviceId(): string {
    return deviceId(this.o.device.publicKey);
  }

  async start() {
    this.hubs.start();
    await this.indexer.start();
  }

  async stop() {
    await this.indexer.stop();
    await this.hubs.stop();
    this.store.close();
  }

  // ── hubs ──────────────────────────────────────────────────────────────────

  private loadHubs(): HubEntry[] {
    try {
      return (JSON.parse(readFileSync(this.hubsFile, 'utf8')) as { hubs: HubEntry[] }).hubs;
    } catch {
      return [];
    }
  }

  private saveHubs(hubs: HubEntry[]) {
    const tmp = this.hubsFile + '.tmp';
    writeFileSync(tmp, JSON.stringify({ hubs }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.hubsFile);
  }

  /**
   * Joins a hub and waits until signed in (or pending approval). Existing shares are NOT
   * published to the new hub automatically: their metadata would become visible to its admin.
   */
  async addHub(
    url: string,
    account: NonNullable<HubClientOptions['createAccount']>,
    timeoutMs = 30_000,
  ): Promise<{ hub: HubEntry; status: 'ready' | 'pending_approval' }> {
    const entry = await this.hubs.add(url, account).catch((e: Error) => {
      throw new CoreError('conflict', e.message);
    });
    const client = this.hubs.get(entry.id)!;
    const outcome = await new Promise<'ready' | 'pending_approval' | Error>((resolve) => {
      const timer = setTimeout(
        () => resolve(new Error('timed out connecting to the hub')),
        timeoutMs,
      );
      const done = (v: 'ready' | 'pending_approval' | Error) => {
        clearTimeout(timer);
        resolve(v);
      };
      client.once('ready', () => done('ready'));
      client.once('pending_approval', () => done('pending_approval'));
      client.once('fatal', (e) => done(e));
    });
    if (outcome instanceof Error) {
      if (!entry.state.registered) await this.hubs.remove(entry.id);
      throw new CoreError('unavailable', outcome.message);
    }
    return { hub: entry, status: outcome };
  }

  async removeHub(idOrUrl: string) {
    const entry = this.hubs.find(idOrUrl);
    if (!entry) throw new CoreError('not_found', `no such hub: ${idOrUrl}`);
    await this.hubs.remove(entry.id);
    this.store.forgetHub(entry.id);
    this.store.dropRules({ hub: entry.id });
    for (const s of this.store.shares()) {
      if (s.hubs.includes(entry.id))
        this.store.setShareHubs(
          s.name,
          s.hubs.filter((h) => h !== entry.id),
        );
    }
  }

  // ── shares ────────────────────────────────────────────────────────────────

  shares(): ShareRow[] {
    return this.store.shares();
  }

  /**
   * Shares a local folder under `name`. Published to `hubs` (default: every hub joined now).
   * Access defaults to "only me" on every hub until M3's rules say otherwise.
   */
  async addShare(name: string, path: string, hubs?: string[]): Promise<ShareRow> {
    if (!SHARE_NAME.test(name))
      throw new CoreError('bad_request', 'share names cannot contain / or \\');
    if (this.store.share(name))
      throw new CoreError('conflict', `a share named "${name}" already exists`);
    const root = await realpath(path).catch(() => null);
    if (!root || !(await stat(root)).isDirectory())
      throw new CoreError('bad_request', 'not a folder');
    const known = new Set(this.hubs.list().map((h) => h.id));
    const targets = hubs ?? [...known];
    const unknown = targets.filter((h) => !known.has(h));
    if (unknown.length) throw new CoreError('bad_request', `unknown hub(s): ${unknown.join(', ')}`);
    if (this.store.shares().some((s) => s.root === root)) {
      throw new CoreError('conflict', 'that folder is already shared');
    }
    this.store.addShare(name, root, targets);
    await this.indexer.addShare(name);
    this.sync.pushAll();
    return this.store.share(name)!;
  }

  async removeShare(name: string) {
    const share = this.store.share(name);
    if (!share) throw new CoreError('not_found', `no such share: ${name}`);
    await this.indexer.removeShare(name);
    this.store.removeShare(name);
    this.store.dropRules({ share: name });
    for (const h of share.hubs) void this.pushRules(h);
    this.sync.pushAll();
  }

  /** Changes which hubs a share is published to; affected hubs get a fresh snapshot. */
  setShareHubs(name: string, hubs: string[]) {
    const share = this.store.share(name);
    if (!share) throw new CoreError('not_found', `no such share: ${name}`);
    const known = new Set(this.hubs.list().map((h) => h.id));
    const unknown = hubs.filter((h) => !known.has(h));
    if (unknown.length) throw new CoreError('bad_request', `unknown hub(s): ${unknown.join(', ')}`);
    this.store.setShareHubs(name, hubs);
    for (const h of new Set([...share.hubs, ...hubs])) {
      if (share.hubs.includes(h) !== hubs.includes(h)) this.sync.resync(h);
    }
  }

  // ── access rules (per hub; HANDOFF §6, ADR 0007/0009) ─────────────────────

  /** Rules on `hub`, or on every hub keyed by hub id. */
  rules(hub?: string): Record<string, { path: string; audience: Audience }[]> {
    const ids = hub ? [hub] : this.hubs.list().map((h) => h.id);
    return Object.fromEntries(ids.map((h) => [h, this.store.rules(h)]));
  }

  /**
   * Sets who can see a file or folder **on one hub** (null clears it, so the path inherits
   * again). Folder paths end with `/`: `Photos/`, `Photos/2024/`; a file is `Photos/a.jpg`.
   */
  async setRule(hub: string, path: string, audience: Audience | null) {
    if (!this.hubs.find(hub)) throw new CoreError('not_found', `no such hub: ${hub}`);
    const share = path.split('/')[0]!;
    if (!this.store.share(share))
      throw new CoreError('bad_request', `"${share}" is not one of your shares`);
    if (
      path
        .split('/')
        .some((seg, i, all) => (seg === '' && i !== all.length - 1) || seg === '.' || seg === '..')
    ) {
      throw new CoreError('bad_request', 'invalid path');
    }
    const rulePath = path.includes('/') ? path : path + '/';
    this.store.setRule(hub, rulePath, audience);
    await this.pushRules(hub);
  }

  /** Sends this device's rules for `hub` to it (no-op while offline; repeated on sign-in). */
  private async pushRules(hub: string) {
    const client = this.hubs.get(hub);
    if (!client?.ready) return;
    try {
      await client.request('acl.replace', {
        device_id: this.deviceId,
        rules: this.store.rules(hub),
      });
    } catch (err) {
      this.log.warn(
        { hub, err: (err as Error).message },
        'could not send access rules; will retry on reconnect',
      );
    }
  }

  // ── search & browse ───────────────────────────────────────────────────────

  search(
    q: Omit<ClientBody<'search'>, 'cursor'>,
    cursors?: Record<string, string>,
  ): Promise<MergedSearch> {
    return searchAll(this.hubs, q, cursors);
  }

  async browse(hub: string, device: string, path: string): Promise<HubBody<'browse.listing'>> {
    const client = this.hubs.get(hub);
    if (!client) throw new CoreError('not_found', `no such hub: ${hub}`);
    if (!client.ready) throw new CoreError('unavailable', 'hub is offline');
    const reply = await client.request('browse', { device_id: device, path });
    if (reply.t !== 'browse.listing') throw new CoreError('not_found', 'no such device');
    return reply.body;
  }

  status() {
    return {
      device_id: this.deviceId,
      hubs: this.hubs.list().map((h) => ({
        id: h.id,
        url: h.url,
        ready: h.ready,
        registered: h.state.registered,
        user_id: h.state.userId ?? null,
      })),
      index: this.store.counts(),
      shares: this.store.shares().map((s) => ({ name: s.name, hubs: s.hubs })),
    };
  }
}
