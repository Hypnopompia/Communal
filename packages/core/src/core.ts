import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pino, type Logger } from 'pino';
import {
  deviceId,
  exportRecoveryFile,
  fingerprint,
  fromB64,
  issueDeviceCert,
  issueRevocation,
  rootSecretToWords,
  toB64,
  type KdfParams,
  type KeyPair,
  type RecoveryFile,
  type RevocationProof,
} from '@communal/crypto';
import type {
  ClientBody,
  HubBody,
  RemoteRequest,
  RemoteSubscription,
  RemoteTransfer,
} from '@communal/protocol';
import { HubManager, type HubEntry, type SharedClientOptions } from './hub-manager.js';
import { Indexer, type IndexerOptions } from './index/indexer.js';
import { IndexStore, type Audience, type ShareRow } from './index/store.js';
import { People } from './people.js';
import { HubAdmin } from './hub-admin.js';
import {
  exposureOf,
  previewRule,
  explainAccess,
  type AccessExplanation,
  type AccessPreview,
  type Exposure,
  type PeopleOnHub,
} from './access-preview.js';
import { PeerTransport, type TransportOptions } from './peer/transport.js';
import { NetworkCheck, type NetworkProfile, type PortMapper } from './peer/netcheck.js';
import { PeerBroker } from './transfer/broker.js';
import { AccessOracle } from './transfer/access.js';
import {
  DEFAULT_UPLOAD_LIMITS,
  Uploader,
  type UploadLimits,
  type UploaderTestHooks,
} from './transfer/uploader.js';
import { Downloads, safeName, type DownloadOptions } from './transfer/downloader.js';
import { Streams } from './transfer/stream.js';
import { downloadFolder } from './transfer/folder.js';
import { Subscriptions, type TrashFn } from './subscriptions.js';
import { SyncFolder, SYNC_SHARE, type SyncFolderOptions } from './sync-folder.js';
import { MediaWorker, type MediaOptions } from './media/worker.js';
import { ThumbCache, ThumbStore } from './media/thumbs.js';
import { Previews } from './media/previews.js';
import { PEEK_BYTES } from './transfer/uploader.js';
import type { ThumbSize } from './media/analyze.js';
import { IndexSync } from './index/sync.js';
import { searchAll, type MergedSearch, type SearchFrom } from './search.js';
import type { Enrollment } from './hub-client.js';
import { CoreError } from './errors.js';
import { RemoteControl } from './remote.js';
import {
  AccountFile,
  accountFields,
  joinHub,
  linkDevice,
  restoreAccount,
  Revocations,
  sealBundle,
  selfRoot,
  type AccountContext,
  type AccountIdentity,
} from './account.js';

export interface CoreOptions {
  dataDir: string;
  device: KeyPair;
  /** Hub client settings shared by every hub (client name, dev TLS, timers for tests…). */
  hubClient?: Omit<SharedClientOptions, 'device' | 'log'>;
  indexer?: Omit<IndexerOptions, 'log'>;
  /** Peer transport: UDP port, operator-advertised addresses, loopback candidates (tests). */
  peer?: Omit<TransportOptions, 'device' | 'log'>;
  /**
   * Network diagnostics (M5). `mapper` opens our UDP port on the router (UPnP/NAT-PMP); it's
   * off unless given, so tests never touch a real router. `override` patches the measured
   * profile (tests).
   */
  network?: { mapper?: PortMapper; override?: () => Partial<NetworkProfile> | undefined };
  uploads?: Partial<UploadLimits>;
  /** Where downloads land by default (default: <dataDir>/downloads). */
  downloadsDir?: string;
  downloads?: Pick<
    DownloadOptions,
    'maxPeers' | 'window' | 'chunkTimeoutMs' | 'retryMs' | 'answerTimeoutMs'
  >;
  /** Metadata and thumbnails of our own files (M6); `thumbCacheBytes` caps the viewer cache. */
  media?: Omit<MediaOptions, 'log'> & { thumbCacheBytes?: number };
  /**
   * Folder subscriptions (M7). `trash` replaces the OS trash for deleted files (tests);
   * `retryMs` is how often refused folders are asked about again.
   */
  subscriptions?: { trash?: TrashFn; retryMs?: number };
  /** The synced folder (ADR 0019): how often to look for other computers, its default place. */
  syncFolder?: Omit<SyncFolderOptions, 'log'>;
  /**
   * The account's root secret on a device restored from a recovery key (ADR 0014), and how to
   * keep one that a restore produces. The first device's key is the root, so it needs neither.
   */
  root?: { secret?: Uint8Array; save?: (secret: Uint8Array) => void | Promise<void> };
  /** Fault injection for tests only. */
  testHooks?: UploaderTestHooks;
  log?: Logger;
}

export { CoreError };

export interface SavedSettings {
  uploads?: Partial<UploadLimits>;
  thumb_cache_bytes?: number;
  /** Where downloads land unless the person picks a folder (ADR 0018); null goes back. */
  downloads_dir?: string | null;
  /** Other devices of this account may start downloads here (ADR 0023). Off unless set. */
  remote_control?: boolean;
  /**
   * Whether other devices may save into the downloads folder, or only into named destinations
   * (a media server with Movies and TV, say). On unless set.
   */
  remote_downloads?: boolean;
  /** Named places to save (ADR 0018): what other devices can ask for, never a raw path. */
  destinations?: { name: string; path: string }[];
}

/** A named place to save into. "Downloads" is built in and follows the downloads folder. */
export interface Destination {
  name: string;
  path: string;
  builtin: boolean;
}

export const DOWNLOADS_DESTINATION = 'Downloads';
const DESTINATION_NAME = /^[^/\\\0\p{Cc}]{1,40}$/u;

/** A link request waiting for this device's approval (ADR 0014). */
export interface PendingLink {
  request_id: string;
  hub: string;
  device_name: string;
  platform: string;
  device_id: string;
  device_pubkey: string;
  at: number;
}

type AccountCreate = Omit<Extract<Enrollment, { kind: 'create' }>, 'kind'>;

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
  /** Managing the hubs this account administers (ADR 0020). */
  readonly admin: HubAdmin;
  readonly transport: PeerTransport;
  readonly network: NetworkCheck;
  readonly broker: PeerBroker;
  readonly uploader: Uploader;
  readonly downloads: Downloads;
  readonly media: MediaWorker;
  readonly thumbCache: ThumbCache;
  readonly previews: Previews;
  readonly streams: Streams;
  readonly subscriptions: Subscriptions;
  readonly syncFolder: SyncFolder;
  readonly revocations: Revocations;
  /** Remote control between this account's devices (ADR 0023). */
  readonly remote: RemoteControl;
  uploadLimits: UploadLimits;
  /** Whether this device takes remote requests (Settings › Remote control). */
  remoteAllowed: boolean;
  /** Whether other devices may use the downloads folder, not only named destinations. */
  remoteDownloads: boolean;
  readonly log: Logger;
  private readonly hubsFile: string;
  private readonly settingsFile: string;
  private readonly accountFile: AccountFile;
  private accountId?: AccountIdentity;
  private rootSecretKept?: Uint8Array;
  private chosenDownloadsDir?: string;
  private readonly pendingLinks = new Map<string, PendingLink>();
  /** Per hub, the other device last browsed, which the hub tells us about (`browse.follow`). */
  private readonly following = new Map<string, string>();

  constructor(private readonly o: CoreOptions) {
    this.log = o.log ?? pino({ name: 'core' });
    mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
    this.hubsFile = join(o.dataDir, 'hubs.json');
    this.store = new IndexStore(join(o.dataDir, 'index.db'));
    this.revocations = new Revocations(this.store);
    this.accountFile = new AccountFile(o.dataDir);
    this.accountId = this.accountFile.loadOrMigrate(o.device, this.loadHubs());
    this.rootSecretKept = o.root?.secret;
    this.hubs = new HubManager({
      ...o.hubClient,
      device: o.device,
      hubs: this.loadHubs(),
      save: (hubs) => this.saveHubs(hubs),
      log: this.log,
    });
    this.indexer = new Indexer(this.store, { ...o.indexer, log: this.log });
    this.sync = new IndexSync(this.store, this.hubs, this.log);
    this.media = new MediaWorker(this.store, new ThumbStore(join(o.dataDir, 'thumbs')), {
      ...o.media,
      log: this.log,
    });
    this.indexer.on('changed', () => {
      this.sync.pushAll();
      this.media.kick();
    });
    this.media.on('changed', () => this.sync.pushAll());
    this.people = new People(this.hubs, this.store);
    this.admin = new HubAdmin(this.hubs, this.store);
    // Each hub gets this device's full rule set for that hub on every sign-in (ADR 0009).
    this.hubs.on('ready', ({ hub }) => void this.pushRules(hub));
    // Our account's revocations go to every hub on every sign-in, so a hub that was away when
    // a device was revoked hears about it (ADR 0014).
    this.hubs.on('ready', ({ hub }) => void this.pushRevocations(hub));
    // A follow lives in the hub session: renew it after every sign-in.
    this.hubs.on('ready', ({ hub }) => {
      const device = this.following.get(hub);
      if (device) this.follow(hub, device);
    });
    this.hubs.on('event', ({ hub, msg }) => {
      if (msg.t === 'link.request') this.onLinkRequest(hub, msg.body);
      if (msg.t === 'device.revoked') this.onRevoked(hub, msg.body);
    });

    this.transport = new PeerTransport({ ...o.peer, device: o.device, log: this.log });
    // On each sign-in: probe the hub from the peer socket (NAT type, and our public address as
    // a hole-punching candidate), then send it our network profile (HANDOFF §8).
    this.network = new NetworkCheck({
      transport: this.transport,
      hubs: this.hubs,
      mapper: o.network?.mapper ?? null,
      ...(o.network?.override ? { override: o.network.override } : {}),
      log: this.log,
    });
    this.broker = new PeerBroker(
      this.hubs,
      this.transport,
      o.device,
      this.network,
      this.revocations,
      this.log,
    );
    this.settingsFile = join(o.dataDir, 'settings.json');
    const saved = this.loadSettings();
    this.chosenDownloadsDir = saved.downloads_dir ?? undefined;
    this.uploadLimits = { ...DEFAULT_UPLOAD_LIMITS, ...o.uploads, ...saved.uploads };
    this.remoteAllowed = saved.remote_control ?? false;
    this.remoteDownloads = saved.remote_downloads ?? true;
    this.uploader = new Uploader({
      store: this.store,
      hubs: this.hubs,
      access: new AccessOracle(this.hubs, this.store),
      media: this.media,
      myDevice: this.deviceId,
      limits: () => this.uploadLimits,
      testHooks: o.testHooks,
      log: this.log,
    });
    this.broker.onInbound((p) => void this.uploader.serve(p));
    this.downloads = new Downloads({
      ...o.downloads,
      store: this.store,
      hubs: this.hubs,
      broker: this.broker,
      myDevice: this.deviceId,
      downloadsDir: () => this.downloadsDir,
      log: this.log,
    });
    this.thumbCache = new ThumbCache(
      join(o.dataDir, 'thumb-cache'),
      this.store,
      saved.thumb_cache_bytes ?? o.media?.thumbCacheBytes ?? 256 * 1024 * 1024,
    );
    this.subscriptions = new Subscriptions({
      store: this.store,
      hubs: this.hubs,
      downloads: this.downloads,
      downloadsDir: () => this.downloadsDir,
      ...o.subscriptions,
      log: this.log,
    });
    this.syncFolder = new SyncFolder(this, { ...o.syncFolder, log: this.log });
    const answerTimeoutMs = o.downloads?.answerTimeoutMs;
    this.previews = new Previews({
      broker: this.broker,
      cache: this.thumbCache,
      ...(answerTimeoutMs ? { answerTimeoutMs } : {}),
      log: this.log,
    });
    this.remote = new RemoteControl({
      hubs: this.hubs,
      device: o.device,
      account: () => this.accountId,
      revocations: this.revocations,
      allowed: () => this.remoteAllowed,
      run: (req, from) => this.runRemote(req, from.name),
      log: this.log,
    });
    this.streams = new Streams({
      hubs: this.hubs,
      broker: this.broker,
      myDevice: this.deviceId,
      ...(answerTimeoutMs ? { answerTimeoutMs } : {}),
      log: this.log,
    });
  }

  /** Where downloads land unless a folder is given: the person's choice, else the host's. */
  get downloadsDir(): string {
    return this.chosenDownloadsDir ?? this.defaultDownloadsDir;
  }

  /** The host's downloads folder (desktop: ~/Downloads/Communal), used until one is chosen. */
  get defaultDownloadsDir(): string {
    return this.o.downloadsDir ?? join(this.o.dataDir, 'downloads');
  }

  get deviceId(): string {
    return deviceId(this.o.device.publicKey);
  }

  async start() {
    // The transport first: candidates sent to hubs need its port.
    await this.transport.start();
    this.network.start();
    this.hubs.start();
    await this.indexer.start();
    this.media.start();
    this.downloads.start();
    this.subscriptions.start();
    this.syncFolder.start();
  }

  async stop() {
    await this.syncFolder.stop();
    await this.downloads.stop();
    await this.subscriptions.stop();
    this.streams.closeAll();
    this.media.stop();
    await this.indexer.stop();
    await this.hubs.stop();
    await this.network.stop();
    await this.transport.stop();
    await this.uploader.stop();
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
   * Joins a hub and waits until signed in (or pending approval). The first hub of a fresh
   * device creates a new account with this device as its root; later hubs get the device's
   * chain, so the account is the same everywhere (ADR 0007, 0014). Existing shares are NOT
   * published to the new hub automatically: their metadata would become visible to its admin.
   */
  async addHub(
    url: string,
    account: AccountCreate,
    timeoutMs = 30_000,
  ): Promise<{ hub: HubEntry; status: 'ready' | 'pending_approval' }> {
    const { hub, status } = await joinHub(
      this.hubs,
      url,
      { kind: 'create', ...account, ...accountFields(this.accountId) },
      { timeoutMs },
    );
    if (!this.accountId) this.setAccount(selfRoot(this.o.device));
    return { hub, status };
  }

  async removeHub(idOrUrl: string) {
    const entry = this.hubs.find(idOrUrl);
    if (!entry) throw new CoreError('not_found', `no such hub: ${idOrUrl}`);
    await this.subscriptions.forgetHub(entry.id);
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

  // ── account and devices (HANDOFF §2, §4; ADR 0014) ────────────────────────

  /** The account this device belongs to, if any. */
  get account(): AccountIdentity | undefined {
    return this.accountId;
  }

  private setAccount(a: AccountIdentity) {
    this.accountFile.save(a);
    this.accountId = a;
  }

  private requireAccount(): AccountIdentity {
    if (!this.accountId) throw new CoreError('not_found', 'this device has no account yet');
    return this.accountId;
  }

  private accountContext(): AccountContext {
    return {
      hubs: this.hubs,
      device: this.o.device,
      account: this.accountFile,
      saveRootSecret: async (secret) => {
        this.rootSecretKept = secret;
        await this.o.root?.save?.(secret);
      },
      log: this.log,
    };
  }

  /** The root secret, if this device holds it: the first device, or one restored from it. */
  private rootSecret(): Uint8Array | undefined {
    const a = this.accountId;
    if (!a) return undefined;
    if (a.root_pubkey === toB64(this.o.device.publicKey)) return this.o.device.secretKey;
    return this.rootSecretKept;
  }

  identity() {
    const a = this.accountId;
    return {
      device_id: this.deviceId,
      user_id: a?.user_id ?? null,
      fingerprint: a ? fingerprint(fromB64(a.root_pubkey)) : null,
      root_device: a ? a.root_pubkey === toB64(this.o.device.publicKey) : false,
      holds_root_key: this.rootSecret() !== undefined,
      /** Another device of the account removed this one (we kept the proof). */
      revoked: a ? this.revocations.revokedFor(a.root_pubkey).has(this.deviceId) : false,
    };
  }

  /**
   * Adds this fresh device to an existing account with a link code from one of its devices,
   * then joins every hub that device is on (HANDOFF §2 "Adding a device").
   */
  async link(url: string, code: string, deviceName: string, timeoutMs?: number) {
    const r = await linkDevice(this.accountContext(), {
      url,
      code,
      device_name: deviceName,
      platform: platform(),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    this.accountId = r.account;
    return r;
  }

  /** Restores the account onto this fresh device from its root secret (HANDOFF §4). */
  async restore(o: {
    rootSecret: Uint8Array;
    user_id?: string;
    hubs: { url: string; hub_pubkey?: string }[];
    deviceName: string;
  }) {
    const r = await restoreAccount(this.accountContext(), {
      rootSecret: o.rootSecret,
      ...(o.user_id ? { user_id: o.user_id } : {}),
      hubs: o.hubs,
      device_name: o.deviceName,
      platform: platform(),
    });
    this.accountId = r.account;
    return r;
  }

  /** A 10-minute, single-use code another device can claim to join this account. */
  async createLinkCode(hub?: string): Promise<{ hub: string; code: string; expires_in: number }> {
    this.requireAccount();
    const id = hub ?? this.hubs.list().find((h) => h.ready)?.id;
    const client = id ? this.hubs.get(id) : undefined;
    if (!id || !client) throw new CoreError('not_found', hub ? `no such hub: ${hub}` : 'no hub');
    if (!client.ready) throw new CoreError('unavailable', 'hub is offline');
    const r = await client.request('link.code.create', {});
    if (r.t !== 'link.code') throw new CoreError('unavailable', `unexpected ${r.t}`);
    return { hub: id, ...r.body };
  }

  /** Devices waiting for this device to approve their link. */
  linkRequests(): PendingLink[] {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, r] of this.pendingLinks) if (r.at < cutoff) this.pendingLinks.delete(id);
    return [...this.pendingLinks.values()];
  }

  private onLinkRequest(
    hub: string,
    r: { request_id: string; device_name: string; platform: string; device_pubkey: string },
  ) {
    let device_id: string;
    try {
      device_id = deviceId(fromB64(r.device_pubkey));
    } catch {
      return;
    }
    this.pendingLinks.set(r.request_id, { ...r, hub, device_id, at: Date.now() });
    this.log.info({ hub, request_id: r.request_id, device_id }, 'a device asks to link');
  }

  /**
   * Approves a link: certifies the new device's key and seals our hub list to it, so it can
   * join the account's other hubs without the hub learning them.
   */
  async approveLink(requestId: string) {
    const a = this.requireAccount();
    const r = this.pendingLinks.get(requestId);
    if (!r) throw new CoreError('not_found', 'no such link request');
    const client = this.hubs.get(r.hub);
    if (!client?.ready) throw new CoreError('unavailable', 'hub is offline');
    const pk = fromB64(r.device_pubkey);
    this.pendingLinks.delete(requestId);
    await client.request('link.approve', {
      request_id: requestId,
      cert: issueDeviceCert(this.o.device, a.user_id, pk),
      sealed: sealBundle(this.hubs, pk),
    });
    return { device_id: r.device_id };
  }

  async denyLink(requestId: string) {
    const r = this.pendingLinks.get(requestId);
    if (!r) throw new CoreError('not_found', 'no such link request');
    this.pendingLinks.delete(requestId);
    await this.hubs.get(r.hub)?.request('link.deny', { request_id: requestId });
  }

  /** The account's devices as every hub sees them, merged by device id. */
  async devices() {
    const a = this.requireAccount();
    const revoked = this.revocations.revokedFor(a.root_pubkey);
    const merged = new Map<
      string,
      {
        device_id: string;
        name: string;
        platform: string;
        root: boolean;
        this_device: boolean;
        revoked: boolean;
        hubs: { hub: string; online: boolean; last_seen: number | null }[];
      }
    >();
    for (const r of await this.hubs.requestAll('device.list', {})) {
      if (!r.ok || r.msg.t !== 'device.listing') continue;
      for (const d of r.msg.body.devices) {
        const m = merged.get(d.device_id) ?? {
          device_id: d.device_id,
          name: d.name,
          platform: d.platform,
          root: d.root,
          this_device: d.device_id === this.deviceId,
          revoked: false,
          hubs: [],
        };
        m.revoked ||= d.revoked_at !== null || revoked.has(d.device_id);
        m.hubs.push({ hub: r.hub, online: d.online, last_seen: d.last_seen });
        merged.set(d.device_id, m);
      }
    }
    return [...merged.values()];
  }

  /**
   * Revokes another device of this account on every hub (HANDOFF §2: any device can revoke
   * another). Hubs that are offline get it on their next sign-in.
   */
  async revokeDevice(target: string) {
    const a = this.requireAccount();
    if (target === this.deviceId)
      throw new CoreError('bad_request', 'revoke this device from another one');
    if (target === deviceId(fromB64(a.root_pubkey)))
      throw new CoreError('bad_request', "the account's first device can't be revoked");
    const proof: RevocationProof = {
      revocation: issueRevocation(this.o.device, a.user_id, target),
      chain: a.chain,
    };
    if (!this.revocations.accept(a.root_pubkey, proof))
      throw new CoreError('conflict', 'that device is already revoked');
    this.log.info({ revoked: target }, 'device revoked');
    const results = await this.hubs.requestAll('device.revoke', proof);
    return {
      hubs: results.map((r) => ({
        hub: r.hub,
        ok: r.ok,
        ...(r.ok ? {} : { error: r.error.message }),
      })),
    };
  }

  private async pushRevocations(hub: string) {
    const a = this.accountId;
    const client = this.hubs.get(hub);
    if (!a || !client?.ready) return;
    for (const p of this.revocations.proofs(a.user_id)) {
      await client.request('device.revoke', p).catch((err: Error) => {
        this.log.warn({ hub, err: err.message }, 'hub refused a revocation');
      });
    }
  }

  /** A hub tells us about a revocation in our account: keep it and pass it to the others. */
  private onRevoked(hub: string, proof: RevocationProof) {
    const a = this.accountId;
    if (!a || proof.revocation.user_id !== a.user_id) return;
    if (!this.revocations.accept(a.root_pubkey, proof)) return;
    if (proof.revocation.device_id === this.deviceId) {
      this.log.warn('this device has been revoked by another device of the account');
      return;
    }
    this.log.info({ hub, revoked: proof.revocation.device_id }, 'learned of a revoked device');
    for (const h of this.hubs.list()) if (h.id !== hub) void this.pushRevocations(h.id);
  }

  /**
   * The recovery key (HANDOFF §4, ADR 0003): a passphrase-encrypted file that also lists the
   * hubs to restore onto, or 24 words. Only a device holding the root key can export it.
   */
  async exportRecovery(
    o: { format: 'words' } | { format: 'file'; passphrase: string; kdf?: KdfParams },
  ): Promise<{ words: string[] } | { file: RecoveryFile }> {
    const a = this.requireAccount();
    const secret = this.rootSecret();
    if (!secret) {
      throw new CoreError(
        'forbidden',
        "this device doesn't hold the account's root key; export the recovery key from your first device",
      );
    }
    if (o.format === 'words') return { words: rootSecretToWords(secret) };
    if (o.passphrase.length < 8)
      throw new CoreError('bad_request', 'use a passphrase of at least 8 characters');
    const hubs = this.hubs
      .list()
      .filter((h) => h.state.registered && h.state.hubPubkey)
      .map((h) => ({ url: h.url, hub_pubkey: h.state.hubPubkey! }));
    return { file: await exportRecoveryFile(secret, a.user_id, o.passphrase, o.kdf, hubs) };
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
    if (name === SYNC_SHARE) this.syncFolder.kick();
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
    if (name === SYNC_SHARE) this.syncFolder.kick();
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
    this.store.setRule(hub, this.rulePath(hub, path), audience);
    await this.pushRules(hub);
  }

  /**
   * What `setRule` would change, without changing it (ADR 0021): which files would be seen by
   * whom instead. Uses only this device's rules, files, connections and groups.
   */
  async previewRule(hub: string, path: string, audience: Audience | null): Promise<AccessPreview> {
    const rulePath = this.rulePath(hub, path);
    return previewRule(this.store, hub, rulePath, audience, await this.peopleOn(hub));
  }

  /** Who can see a file or folder on one hub now, and which rule decides it. */
  async explainRule(hub: string, path: string): Promise<AccessExplanation> {
    return explainAccess(this.store, hub, this.rulePath(hub, path), await this.peopleOn(hub));
  }

  /**
   * Who would see files saved into `dir` (plus `inside`, a file or folder name to be created
   * there): nobody when it isn't in one of your shares, else that folder's audience on each hub
   * the share is listed on (ADR 0021: the re-share warning).
   */
  async exposure(dir: string, inside?: string): Promise<Exposure> {
    if (!isAbsolute(dir)) throw new CoreError('bad_request', 'use a full folder path');
    // Share roots are real paths; the folder may not exist yet, so resolve what does.
    let real = resolve(dir);
    const rest: string[] = [];
    for (;;) {
      const r = await realpath(real).catch(() => null);
      if (r) {
        real = join(r, ...rest);
        break;
      }
      const parent = dirname(real);
      if (parent === real) break;
      rest.unshift(basename(real));
      real = parent;
    }
    const share = this.store
      .shares()
      .find(
        (s) => real === s.root || real.startsWith(s.root.endsWith(sep) ? s.root : s.root + sep),
      );
    if (!share) return { shared: false };
    const segs = relative(share.root, real).split(sep).filter(Boolean);
    if (inside) segs.push(...inside.split(/[\\/]/).filter(Boolean));
    // Dot-folders are never indexed (ADR 0008), so nothing in one is shared.
    if (segs.some((x) => x.startsWith('.'))) return { shared: false };
    const path = [share.name, ...segs].join('/') + (inside && !inside.endsWith('/') ? '' : '/');
    const known = new Set(this.hubs.list().map((h) => h.id));
    const hubs = new Map<string, PeopleOnHub>();
    for (const h of share.hubs.filter((x) => known.has(x))) hubs.set(h, await this.peopleOn(h));
    return exposureOf(this.store, share.name, path, hubs);
  }

  /** Names and groups on a hub, for describing audiences; empty while it's offline. */
  private async peopleOn(hub: string): Promise<PeopleOnHub> {
    const entry = this.hubs.find(hub)!;
    const people: PeopleOnHub = {
      hubName: entry.state.name ?? new URL(entry.url).hostname,
      connections: new Map(),
      groups: new Map(),
    };
    // Offline, names and head counts are unknown; which files change is still exact.
    if (this.hubs.get(hub)?.ready) {
      const [connections, groups] = await Promise.all([
        this.people.connections(hub).catch(() => []),
        this.people.groups(hub).catch(() => []),
      ]);
      for (const c of connections)
        if (c.state === 'accepted') people.connections.set(c.user_id, c.display_name);
      for (const g of groups) people.groups.set(g.group_id, { name: g.name, members: g.members });
    }
    return people;
  }

  /** Checks a rule path for `hub` and normalises it (a bare share name means its folder). */
  private rulePath(hub: string, path: string): string {
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
    return path.includes('/') ? path : path + '/';
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

  // ── transfers ─────────────────────────────────────────────────────────────

  /** Starts downloading a file by hash. Without a name, the first source's file name is used. */
  async download(
    hash: string,
    opts: { name?: string; destDir?: string; destination?: string; requestedBy?: string } = {},
  ) {
    let name = opts.name;
    if (!name) {
      for (const r of await this.hubs.requestAll('sources', { hash })) {
        if (r.ok && r.msg.t === 'sources.list' && r.msg.body.sources[0]) {
          const p = r.msg.body.sources[0].path;
          name = p.slice(p.lastIndexOf('/') + 1);
          break;
        }
      }
    }
    if (!name) throw new CoreError('not_found', 'no visible source has that file');
    const destDir = opts.destination
      ? await usableFolder(this.destinationPath(opts.destination))
      : opts.destDir
        ? await usableFolder(opts.destDir)
        : undefined;
    return this.downloads.add({
      hash,
      name,
      ...(destDir ? { destDir } : {}),
      ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
    });
  }

  /**
   * Downloads a folder of another device (and its subfolders) once, into
   * `<destDir or the downloads folder>/<folder name>`, keeping its structure (ADR 0018).
   */
  async downloadFolder(
    hub: string,
    device: string,
    path: string,
    opts: { destDir?: string; destination?: string; requestedBy?: string } = {},
  ) {
    if (device === this.deviceId)
      throw new CoreError('bad_request', 'those files are already on this computer');
    const dir = opts.destination ? this.destinationPath(opts.destination) : opts.destDir;
    return downloadFolder(this, {
      hub,
      device,
      path,
      destDir: dir ? await usableFolder(dir) : this.downloadsDir,
      ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
    });
  }

  // ── destinations (ADR 0018) ───────────────────────────────────────────────

  /** Named places to save into: "Downloads" first, then the person's own. */
  destinations(): Destination[] {
    return [
      { name: DOWNLOADS_DESTINATION, path: this.downloadsDir, builtin: true },
      ...(this.loadSettings().destinations ?? []).map((d) => ({ ...d, builtin: false })),
    ];
  }

  /** The folder a destination name stands for (any case), or `not_found`. */
  destinationPath(name: string): string {
    const d = this.destinations().find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!d) throw new CoreError('not_found', `no destination called ${name}`);
    return d.path;
  }

  /**
   * Adds a destination, or changes one (`was` is its current name). The folder must be an
   * absolute path; it's created if missing.
   */
  async saveDestination(name: string, path: string, was?: string) {
    const n = name.trim();
    if (!DESTINATION_NAME.test(n))
      throw new CoreError('bad_request', 'give it a name of 1 to 40 characters, without slashes');
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (same(n, DOWNLOADS_DESTINATION) || (was && same(was, DOWNLOADS_DESTINATION)))
      throw new CoreError(
        'bad_request',
        `${DOWNLOADS_DESTINATION} is the downloads folder: change it there`,
      );
    const dir = await usableFolder(path);
    const saved = this.loadSettings();
    const list = saved.destinations ?? [];
    if (was && !list.some((d) => same(d.name, was)))
      throw new CoreError('not_found', `no destination called ${was}`);
    if (list.some((d) => same(d.name, n) && !(was && same(d.name, was))))
      throw new CoreError('conflict', `there's already a destination called ${n}`);
    const next = was
      ? list.map((d) => (same(d.name, was) ? { name: n, path: dir } : d))
      : [...list, { name: n, path: dir }];
    await this.updateSettings({ destinations: next });
    return this.destinations();
  }

  async removeDestination(name: string) {
    const list = this.loadSettings().destinations ?? [];
    const next = list.filter((d) => d.name.toLowerCase() !== name.toLowerCase());
    if (next.length === list.length)
      throw new CoreError('not_found', `no destination called ${name}`);
    await this.updateSettings({ destinations: next });
    return this.destinations();
  }

  /** Where a followed folder goes in a destination: `<destination>/<folder name>`. */
  destinationFolder(name: string, path: string): string {
    const leaf = path.replace(/\/$/, '').split('/').pop() ?? path;
    return join(this.destinationPath(name), safeName(leaf));
  }

  // ── remote control (ADR 0023) ─────────────────────────────────────────────

  /** The destinations other devices may ask for: all of them, or all but the downloads folder. */
  private remoteDestinations(): string[] {
    const all = this.destinations().map((d) => d.name);
    return this.remoteDownloads ? all : all.filter((n) => n !== DOWNLOADS_DESTINATION);
  }

  /**
   * Runs a request from another device of this account. Only these few things, and only into
   * this device's downloads folder or its named destinations: never devices, sharing, access
   * rules or settings.
   */
  private async runRemote(req: RemoteRequest, from: string): Promise<unknown> {
    const hubId = (url: string) => {
      const h = this.hubs.find(url);
      if (!h) throw new CoreError('not_found', `this computer isn't on ${url}`);
      return h.id;
    };
    // A request without a destination means the downloads folder, if this device offers it.
    const where = (destination?: string): string => {
      const name = destination ?? DOWNLOADS_DESTINATION;
      if (!this.remoteDestinations().some((n) => n.toLowerCase() === name.toLowerCase())) {
        if (!destination)
          throw new CoreError(
            'bad_request',
            `choose where: ${this.remoteDestinations().join(', ')}`,
          );
        throw new CoreError('not_found', `no destination called ${destination}`);
      }
      return name;
    };
    switch (req.op) {
      case 'hello':
        // Names only: the folders they stand for never leave this device.
        return { allowed: this.remoteAllowed, destinations: this.remoteDestinations() };
      case 'download': {
        const t = await this.download(req.hash, {
          ...(req.name ? { name: req.name } : {}),
          destination: where(req.destination),
          requestedBy: from,
        });
        return { id: t.id, name: t.name };
      }
      case 'download_folder': {
        const f = await this.downloadFolder(hubId(req.hub), req.device_id, req.path, {
          destination: where(req.destination),
          requestedBy: from,
        });
        const { dest, ...counts } = f;
        return { ...counts, folder: basename(dest) };
      }
      case 'subscribe': {
        const s = await this.subscriptions.add({
          hub: hubId(req.hub),
          device: req.device_id,
          path: req.path,
          mirrorDeletes: req.mirror_deletes,
          recursive: true,
          dest: this.destinationFolder(where(req.destination), req.path),
        });
        return { id: s.id };
      }
      case 'subscriptions':
        return {
          subscriptions: this.subscriptions
            .list()
            .filter((s) => !s.sync)
            .map((s): RemoteSubscription => this.remoteSubscription(s)),
        };
      case 'update_subscription': {
        this.remoteSub(req.id);
        await this.subscriptions.update(req.id, {
          ...(req.paused !== undefined ? { paused: req.paused } : {}),
          ...(req.mirror_deletes !== undefined ? { mirror_deletes: req.mirror_deletes } : {}),
        });
        return { subscription: this.remoteSubscription(this.remoteSub(req.id)) };
      }
      case 'unsubscribe':
        this.remoteSub(req.id);
        await this.subscriptions.remove(req.id);
        return { unsubscribed: req.id };
      case 'transfers':
        return {
          transfers: this.downloads
            .list()
            .slice(0, 30)
            .map((t): RemoteTransfer => ({
              id: t.id,
              name: t.name,
              size: t.size,
              bytes_done: t.bytes_done,
              state: t.state,
              error: t.error,
              requested_by: t.requested_by,
              updated_at: t.updated_at,
            })),
        };
      case 'cancel':
        if (!this.downloads.cancel(req.id)) throw new CoreError('not_found', 'no such download');
        return { cancelled: req.id };
    }
  }

  /** A subscription another device may change: any but the synced folder's (ADR 0019). */
  private remoteSub(id: string) {
    const s = this.subscriptions.list().find((x) => x.id === id && !x.sync);
    if (!s) throw new CoreError('not_found', 'no such subscription');
    return s;
  }

  /** A subscription as another device sees it: its destination's name, never a path. */
  private remoteSubscription(s: ReturnType<Subscriptions['list']>[number]): RemoteSubscription {
    const inside = (dir: string) => {
      const r = relative(dir, s.dest_dir);
      return r !== '' && !r.startsWith('..') && !isAbsolute(r);
    };
    // The innermost destination holding the folder (a named one can sit inside Downloads).
    const dest = this.destinations()
      .filter((d) => inside(d.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return {
      id: s.id,
      hub: this.hubs.find(s.hub)?.url ?? s.hub,
      device_id: s.device_id,
      path: s.path,
      destination: dest?.name ?? null,
      folder: basename(s.dest_dir),
      mirror_deletes: s.mirror_deletes,
      paused: s.paused,
      status: s.status,
      files: s.files,
      created_at: s.created_at,
    };
  }

  // ── previews (M6) ─────────────────────────────────────────────────────────

  /**
   * Thumbnails for files on `device` (e.g. a folder being browsed), fetched in one batch and
   * cached. Our own files' thumbnails come straight from our own store.
   */
  async fetchThumbnails(
    hub: string,
    device: string,
    hashes: string[],
    size: ThumbSize,
  ): Promise<Record<string, boolean>> {
    if (device === this.deviceId) {
      const out: Record<string, boolean> = {};
      for (const h of hashes)
        out[h] = (await this.media.thumbnail(h, size).catch(() => null)) !== null;
      return out;
    }
    if (!this.hubs.get(hub)?.ready) throw new CoreError('unavailable', 'hub is offline');
    return this.previews.fetch(hub, device, hashes, size);
  }

  /** A cached (or our own) thumbnail's bytes, or null. */
  async thumbnail(hash: string, size: ThumbSize): Promise<Buffer | null> {
    return (
      (await this.thumbCache.get(hash, size)) ??
      (await this.media.thumbnail(hash, size).catch(() => null))
    );
  }

  /** The start of a text or code file (64 KB), ours or on another device. */
  async peek(hub: string, device: string, hash: string) {
    if (device === this.deviceId) {
      const c = this.store.anyCopy(hash).find((x) => x.kind === 'text' || x.kind === 'code');
      if (!c) return null;
      const { open } = await import('node:fs/promises');
      const fh = await open(join(c.root, ...c.rel.split('/')), 'r').catch(() => null);
      if (!fh) return null;
      try {
        const buf = Buffer.alloc(Math.min(PEEK_BYTES, c.size));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        return { data: buf.subarray(0, bytesRead), truncated: c.size > PEEK_BYTES };
      } finally {
        await fh.close();
      }
    }
    if (!this.hubs.get(hub)?.ready) throw new CoreError('unavailable', 'hub is offline');
    return this.previews.peek(hub, device, hash);
  }

  // ── search & browse ───────────────────────────────────────────────────────

  /**
   * Searches every hub. `from` keeps only files held by your connections or by people you've
   * verified (and yourself). It's applied here, not by the hubs: who you've verified never
   * leaves this device.
   */
  async search(
    q: Omit<ClientBody<'search'>, 'cursor'>,
    cursors?: Record<string, string>,
    from: SearchFrom = 'anyone',
  ): Promise<MergedSearch> {
    const [r, people] = await Promise.all([
      searchAll(this.hubs, q, cursors),
      from === 'anyone' ? undefined : this.trusted(from),
    ]);
    if (!people) return r;
    const hits = r.hits
      .map((h) => ({ ...h, sources: h.sources.filter((s) => people.has(s.owner)) }))
      .filter((h) => h.sources.length > 0);
    return { ...r, hits };
  }

  /** You, plus your accepted connections on any hub, or the people you've verified. */
  private async trusted(from: Exclude<SearchFrom, 'anyone'>): Promise<Set<string>> {
    const people = from === 'verified' ? this.store.verifiedUsers() : new Set<string>();
    if (from === 'connections') {
      const lists = await Promise.all(
        this.hubs
          .list()
          .filter((h) => h.ready)
          .map((h) => this.people.connections(h.id).catch(() => [])),
      );
      for (const c of lists.flat()) if (c.state === 'accepted') people.add(c.user_id);
    }
    if (this.accountId) people.add(this.accountId.user_id);
    return people;
  }

  async browse(hub: string, device: string, path: string): Promise<HubBody<'browse.listing'>> {
    const client = this.hubs.get(hub);
    if (!client) throw new CoreError('not_found', `no such hub: ${hub}`);
    if (!client.ready) throw new CoreError('unavailable', 'hub is offline');
    const reply = await client.request('browse', { device_id: device, path });
    if (reply.t !== 'browse.listing') throw new CoreError('not_found', 'no such device');
    // This device's own changes come from the indexer; others' from the hub (`browse.changed`).
    if (device !== this.deviceId && this.following.get(hub) !== device) {
      this.following.set(hub, device);
      this.follow(hub, device);
    }
    return reply.body;
  }

  /** Asks the hub to say when `device` changes. Only a hint, so failures (old hubs) are fine. */
  private follow(hub: string, device: string) {
    this.hubs
      .get(hub)
      ?.request('browse.follow', { device_id: device })
      .catch((err: unknown) => this.log.debug({ hub, err }, 'browse.follow failed'));
  }

  // ── settings ──────────────────────────────────────────────────────────────

  /**
   * Settings changed through the local API (Settings screen, ADR 0016). They're kept in
   * `settings.json` and take precedence over the host's defaults (CLI environment variables).
   */
  async updateSettings(change: SavedSettings) {
    const saved = this.loadSettings();
    if (change.uploads) {
      saved.uploads = { ...saved.uploads, ...change.uploads };
      this.uploadLimits = { ...this.uploadLimits, ...change.uploads };
    }
    if (change.downloads_dir !== undefined) {
      const dir = change.downloads_dir === null ? null : await usableFolder(change.downloads_dir);
      saved.downloads_dir = dir;
      this.chosenDownloadsDir = dir ?? undefined;
    }
    if (change.destinations !== undefined) saved.destinations = change.destinations;
    if (change.remote_downloads !== undefined) {
      saved.remote_downloads = change.remote_downloads;
      this.remoteDownloads = change.remote_downloads;
    }
    if (change.remote_control !== undefined) {
      saved.remote_control = change.remote_control;
      this.remoteAllowed = change.remote_control;
    }
    if (change.thumb_cache_bytes !== undefined) {
      saved.thumb_cache_bytes = change.thumb_cache_bytes;
      await this.thumbCache.setCap(change.thumb_cache_bytes);
    }
    const tmp = this.settingsFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
    renameSync(tmp, this.settingsFile);
  }

  storage() {
    return {
      thumb_cache: { bytes: this.thumbCache.usage(), cap: this.thumbCache.capBytes },
      own_thumbs: this.store.mediaCounts().thumbs,
    };
  }

  private loadSettings(): SavedSettings {
    try {
      return JSON.parse(readFileSync(this.settingsFile, 'utf8')) as SavedSettings;
    } catch {
      return {};
    }
  }

  status() {
    return {
      device_id: this.deviceId,
      account: this.identity(),
      hubs: this.hubs.list().map((h) => ({
        id: h.id,
        url: h.url,
        name: h.state.name ?? null,
        ready: h.ready,
        /** This account administers the hub (ADR 0020): the app offers Manage. */
        admin: h.admin,
        problem: h.problem,
        registered: h.state.registered,
        user_id: h.state.userId ?? null,
        network: this.network.profile(h.id) ?? null,
      })),
      index: { ...this.store.counts(), ...this.store.mediaCounts() },
      peer_port: this.transport.port,
      uploads: { active: this.uploader.activeUploads, limits: this.uploadLimits },
      shares: this.store.shares().map((s) => ({ name: s.name, hubs: s.hubs })),
    };
  }
}

/** A folder to save into: an absolute path, created if needed. */
async function usableFolder(dir: string): Promise<string> {
  if (!isAbsolute(dir)) throw new CoreError('bad_request', 'use a full folder path');
  const abs = resolve(dir);
  try {
    await mkdir(abs, { recursive: true });
    if (!(await stat(abs)).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new CoreError('bad_request', `can't save into ${abs}`);
  }
  return abs;
}

export function platform(): 'darwin' | 'win32' | 'linux' | 'android' {
  const p = process.platform;
  return p === 'darwin' || p === 'win32' || p === 'android' ? p : 'linux';
}
