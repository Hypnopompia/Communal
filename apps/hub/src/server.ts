import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { pino, type Logger } from 'pino';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  authPayload,
  deviceId,
  fingerprint,
  fromB64,
  toB64,
  userId,
  verify,
  signTransferToken,
  verifyCertChain,
  verifyRevocation,
  type CertChain,
  type DeviceCert,
  type KeyPair,
  type SignedToken,
} from '@communal/crypto';
import {
  encodeHub,
  newGroupId,
  MAX_FRAME_BYTES,
  parseClientMessage,
  type ClientBody,
  type ClientMessage,
  type HubBody,
  type HubType,
} from '@communal/protocol';
import { Catalog } from './catalog.js';
import { diagnose, natView, type Observation } from './diagnosis.js';
import type { HubDb, RevocationProof, UserRow } from './db.js';

export interface HubOptions {
  db: HubDb;
  hubKey: KeyPair;
  hubId: string;
  /** PEM key + cert; plain ws when omitted (tests, or TLS terminated by a proxy). */
  tls?: { key: string; cert: string };
  probePorts?: [number, number];
  /** Drop a session after this much silence; presence goes offline this long after last contact. */
  silenceMs?: number;
  /** Close sessions that haven't authenticated within this time. */
  authTimeoutMs?: number;
  /**
   * How often to look for bans made by the admin CLI (a separate process) and disconnect the
   * banned users' live sessions.
   */
  banPollMs?: number;
  /**
   * After one side of a failed connection reports, how long to wait for the other side's
   * observations before diagnosing with what we have (ADR 0011).
   */
  diagnosisWaitMs?: number;
  /** How long a link code (and the approval it leads to) stays valid (HANDOFF §2: 10 min). */
  linkTtlMs?: number;
  log?: Logger;
}

/** Transfer tokens are valid for 5 minutes (HANDOFF §8). */
const TOKEN_TTL_S = 300;

const DEFAULTS = {
  silenceMs: 90_000,
  authTimeoutMs: 30_000,
  banPollMs: 2_000,
  diagnosisWaitMs: 3_000,
  linkTtlMs: 600_000,
};

/** Link codes one session may hold at once, and wrong codes a session may try (ADR 0014). */
const MAX_LINK_CODES = 5;
const MAX_BAD_CLAIMS = 5;
/** Crockford's base32 alphabet: no I, L, O or U, so codes survive being read aloud. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

type Platform = HubBody<'link.request'>['platform'];

/** Message types accepted before `auth` succeeds. */
const PRE_AUTH = new Set<ClientMessage['t']>([
  'auth',
  'account.create',
  'link.claim',
  'account.restore',
  'ping',
  'pong',
]);

interface Session {
  id: string;
  ws: WebSocket;
  nonce: Uint8Array;
  observedAddr: string;
  lastSeen: number;
  user?: string;
  device?: string;
  /** In-progress index snapshot from this session's device. */
  snapshot?: { rev: number; nextPage: number };
  /** The device's latest `network.profile` (memory only; resent after every sign-in). */
  profile?: ClientBody<'network.profile'>;
  /** Folders this device watches, keyed by `device_id + path` (resent after every sign-in). */
  watches: Map<string, LiveWatch>;
  /** A pending `link.claim` from this (unauthenticated) session: its request id. */
  claim?: string;
  badClaims: number;
  log: Logger;
}

/** A link code, valid while the session that created it is alive (ADR 0014). */
interface LinkCode {
  owner: Session;
  expires: number;
}

/** A claimed code waiting for the existing device to approve or deny. */
interface LinkRequest {
  owner: Session;
  claimer: Session;
  pubkey: string;
  name: string;
  platform: Platform;
  expires: number;
}

/** A live subscription: `sent` is the owner's index rev the watcher was last brought up to. */
interface LiveWatch {
  device: string;
  path: string;
  recursive: boolean;
  sent: number;
}

/** Max watches per session, and max files + removals per `watch.event` page. */
const MAX_WATCHES = 1_000;
const WATCH_PAGE = 1_000;

interface Brokered {
  downloader: Session;
  from: string;
  to: string;
  token: SignedToken;
  expires: number;
  /** The owner answered the offer (so it was reachable through the hub at that point). */
  answered: boolean;
  /** `connect.failed` observations from the downloader / the owner (ADR 0011). */
  down?: Observation;
  up?: Observation;
  /** Wakes a pending diagnosis when the owner's report arrives. */
  onReport?: () => void;
}

export class HubServer {
  readonly db: HubDb;
  private readonly catalog: Catalog;
  private readonly opts: Required<Omit<HubOptions, 'tls' | 'log' | 'probePorts'>> & HubOptions;
  private readonly log: Logger;
  private http?: Server;
  private wss?: WebSocketServer;
  private probes: UdpSocket[] = [];
  private sweeper?: NodeJS.Timeout;
  private banPoller?: NodeJS.Timeout;
  private readonly sessions = new Set<Session>();
  /** device_id → its live authenticated session. */
  private readonly online = new Map<string, Session>();
  /** Brokered connections awaiting the uploader's answer (HANDOFF §8). */
  private readonly brokered = new Map<string, Brokered>();
  /** device_id → timer that will publish "offline" once the grace period runs out. */
  private readonly goingOffline = new Map<string, NodeJS.Timeout>();
  private readonly linkCodes = new Map<string, LinkCode>();
  private readonly linkRequests = new Map<string, LinkRequest>();

  constructor(opts: HubOptions) {
    this.opts = { ...DEFAULTS, ...opts };
    this.db = opts.db;
    this.catalog = new Catalog(this.db, (d) => this.isOnline(d));
    this.log = opts.log ?? pino({ name: 'hub' });
  }

  /** The probe ports actually bound (port 0 in options means "any"), or [0, 0] for none. */
  get probePorts(): [number, number] {
    const [a, b] = this.probes.map((p) => p.address().port);
    return a && b ? [a, b] : [0, 0];
  }

  /** A signed-in device's latest `network.profile` (diagnostics; memory only). */
  profileOf(device: string): ClientBody<'network.profile'> | undefined {
    return this.online.get(device)?.profile;
  }

  get hubPubkey(): string {
    return toB64(this.opts.hubKey.publicKey);
  }

  async listen(port: number, host = '0.0.0.0'): Promise<AddressInfo> {
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, hub_id: this.opts.hubId, hub_pubkey: this.hubPubkey }));
        return;
      }
      res.writeHead(404).end();
    };
    this.http = this.opts.tls
      ? createHttpsServer(this.opts.tls, handler)
      : createHttpServer(handler);
    this.wss = new WebSocketServer({ server: this.http, path: '/v1', maxPayload: MAX_FRAME_BYTES });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));

    for (const p of this.opts.probePorts ?? []) this.probes.push(await this.startProbe(p, host));

    const tick = Math.max(50, Math.floor(this.opts.silenceMs / 6));
    this.sweeper = setInterval(() => this.sweep(), tick);
    this.banPoller = setInterval(() => this.enforceBans(), this.opts.banPollMs);

    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(port, host, () => resolve());
    });
    const addr = this.http.address() as AddressInfo;
    this.log.info(
      {
        port: addr.port,
        tls: !!this.opts.tls,
        hub_id: this.opts.hubId,
        join_mode: this.db.joinMode,
      },
      'hub listening',
    );
    return addr;
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    clearInterval(this.banPoller);
    for (const t of this.goingOffline.values()) clearTimeout(t);
    this.goingOffline.clear();
    for (const s of this.sessions) s.ws.terminate();
    this.sessions.clear();
    this.online.clear();
    for (const p of this.probes) p.close();
    this.probes = [];
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
  }

  /** Devices currently counted as online (including those inside their offline grace period). */
  isOnline(device: string): boolean {
    return this.online.has(device) || this.goingOffline.has(device);
  }

  // ── NAT probe ─────────────────────────────────────────────────────────────

  private startProbe(port: number, host: string): Promise<UdpSocket> {
    // Reply to each datagram with the address/port we saw it from. A client sends from one
    // local socket to both ports; differing observed ports mean a symmetric NAT (HANDOFF §8).
    const sock = createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      if (msg.length > 64) return; // never amplify
      sock.send(
        JSON.stringify({ addr: rinfo.address, port: rinfo.port, probe: port }),
        rinfo.port,
        rinfo.address,
      );
    });
    return new Promise((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(port, host, () => resolve(sock));
    });
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    const id = 's_' + randomBytes(8).toString('hex');
    const remote = req.socket.remoteAddress ?? '';
    const s: Session = {
      id,
      ws,
      nonce: randomBytes(32),
      observedAddr: `${remote.replace(/^::ffff:/, '')}:${req.socket.remotePort ?? 0}`,
      lastSeen: Date.now(),
      watches: new Map(),
      badClaims: 0,
      log: this.log.child({ session_id: id }),
    };
    this.sessions.add(s);
    s.log.debug({ remote }, 'connected');
    this.send(s, 'challenge', {
      nonce: toB64(s.nonce),
      hub_id: this.opts.hubId,
      hub_pubkey: this.hubPubkey,
    });

    ws.on('message', (data, isBinary) => {
      s.lastSeen = Date.now();
      if (isBinary) return this.fail(s, 'bad_request', 'binary frames not supported');
      this.onMessage(s, data.toString());
    });
    ws.on('close', () => this.onClose(s));
    ws.on('error', (err) => s.log.debug({ err: err.message }, 'socket error'));
  }

  private sweep() {
    const now = Date.now();
    this.expireLinks();
    for (const s of this.sessions) {
      if (now - s.lastSeen > this.opts.silenceMs) {
        s.log.info('silent too long; dropping');
        s.ws.terminate();
      } else if (!s.device && !s.claim && now - s.lastSeen > this.opts.authTimeoutMs) {
        s.ws.close(4001, 'auth timeout');
      }
    }
  }

  /** Disconnects every live session of users the admin has banned since we last looked. */
  enforceBans() {
    const users = new Set<string>();
    for (const s of this.online.values()) users.add(s.user!);
    for (const [, owner] of this.devicesInGrace()) users.add(owner);
    for (const uid of this.db.bannedAmong([...users])) this.kickUser(uid);
  }

  /**
   * Ends all of a user's sessions now and publishes their devices offline immediately: a ban
   * skips the usual grace period, since the devices aren't coming back.
   */
  kickUser(uid: string) {
    for (const [device, s] of this.online) {
      if (s.user !== uid) continue;
      this.online.delete(device);
      s.device = undefined; // keep onClose from starting a grace period
      s.ws.close(4003, 'account banned');
      this.publishPresence(uid, device, false);
    }
    for (const device of this.db.devicesOf(uid)) {
      const pending = this.goingOffline.get(device);
      if (!pending) continue;
      clearTimeout(pending);
      this.goingOffline.delete(device);
      this.publishPresence(uid, device, false);
    }
    this.log.info({ user_id: uid }, 'banned user disconnected');
  }

  /** Ends a device's session now and publishes it offline without a grace period. */
  private dropDevice(owner: string, device: string, code: number, reason: string) {
    const s = this.online.get(device);
    if (s) {
      this.online.delete(device);
      s.device = undefined; // keep onClose from starting a grace period
      s.ws.close(code, reason);
      this.publishPresence(owner, device, false);
    }
    const pending = this.goingOffline.get(device);
    if (pending) {
      clearTimeout(pending);
      this.goingOffline.delete(device);
      this.publishPresence(owner, device, false);
    }
    for (const x of this.online.values()) {
      for (const [k, w] of x.watches) if (w.device === device) x.watches.delete(k);
    }
  }

  private onClose(s: Session) {
    this.sessions.delete(s);
    this.dropLinks(s);
    if (!s.device || this.online.get(s.device) !== s) return;
    this.online.delete(s.device);
    // Presence goes offline only once the device has been silent for the full window, so a
    // quick reconnect never flaps (HANDOFF §5 lifecycle step 4).
    const device = s.device;
    const user = s.user!;
    const wait = Math.max(0, s.lastSeen + this.opts.silenceMs - Date.now());
    this.goingOffline.set(
      device,
      setTimeout(() => {
        this.goingOffline.delete(device);
        this.db.touchDevice(device, Math.floor(s.lastSeen / 1000));
        this.publishPresence(user, device, false);
        s.log.info({ device_id: device }, 'device offline');
      }, wait),
    );
  }

  private send<T extends HubType>(s: Session, t: T, body: HubBody<T>, re?: string) {
    if (s.ws.readyState === s.ws.OPEN) s.ws.send(encodeHub(t, body, { re }));
  }

  private fail(s: Session, code: HubBody<'error'>['code'], message: string, re?: string) {
    this.send(s, 'error', { code, message }, re);
  }

  private onMessage(s: Session, raw: string) {
    const res = parseClientMessage(raw);
    if (!res.ok) return this.fail(s, res.code, res.message, res.re);
    const msg = res.msg;
    if (!s.device && !PRE_AUTH.has(msg.t))
      return this.fail(s, 'unauthenticated', 'sign in first', msg.id);
    try {
      switch (msg.t) {
        case 'ping':
          return this.send(s, 'pong', {}, msg.id);
        case 'pong':
          return;
        case 'account.create':
          return this.onAccountCreate(s, msg.id, msg.body);
        case 'auth':
          return this.onAuth(s, msg.id, msg.body);
        case 'index.snapshot':
          return this.onSnapshot(s, msg.id, msg.body);
        case 'index.delta':
          return this.onDelta(s, msg.id, msg.body);
        case 'search':
          return this.send(s, 'search.results', this.catalog.search(s.user!, msg.body), msg.id);
        case 'sources':
          return this.send(s, 'sources.list', this.catalog.sources(s.user!, msg.body.hash), msg.id);
        case 'browse': {
          const listing = this.catalog.browse(s.user!, msg.body.device_id, msg.body.path);
          if (!listing) return this.fail(s, 'not_found', 'no such device', msg.id);
          return this.send(s, 'browse.listing', listing, msg.id);
        }
        case 'user.search':
          return this.send(
            s,
            'user.results',
            {
              users: this.db
                .searchUsers(msg.body.q, s.user!, msg.body.limit)
                .map((u) => this.summary(u)),
            },
            msg.id,
          );
        case 'connection.request':
          return this.onConnectionRequest(s, msg.id, msg.body.user_id);
        case 'connection.accept':
          return this.onConnectionAccept(s, msg.id, msg.body.user_id);
        case 'connection.remove':
          return this.onConnectionRemove(s, msg.id, msg.body.user_id);
        case 'connection.list':
          return this.send(s, 'connection.listing', this.connectionListing(s.user!), msg.id);
        case 'group.upsert':
          return this.onGroupUpsert(s, msg.id, msg.body);
        case 'group.delete': {
          if (this.db.groupOwner(msg.body.group_id) !== s.user) {
            return this.fail(s, 'not_found', 'no such group', msg.id);
          }
          this.db.deleteGroup(msg.body.group_id);
          return this.send(s, 'ok', {}, msg.id);
        }
        case 'group.list':
          return this.send(s, 'group.listing', { groups: this.db.groupsOf(s.user!) }, msg.id);
        case 'acl.set':
          return this.onAcl(
            s,
            msg.id,
            msg.body.device_id,
            [{ path: msg.body.path, audience: msg.body.audience }],
            false,
          );
        case 'connect.request':
          return this.onConnectRequest(s, msg.id, msg.body);
        case 'connect.answer':
          return this.onConnectAnswer(s, msg.id, msg.body);
        case 'connect.failed':
          return void this.onConnectFailed(s, msg.id, msg.body);
        case 'network.profile':
          s.profile = msg.body;
          return this.send(s, 'ok', {}, msg.id);
        case 'acl.replace':
          return this.onAcl(s, msg.id, msg.body.device_id, msg.body.rules, true);
        case 'watch':
          return this.onWatch(s, msg.id, msg.body);
        case 'link.code.create':
          return this.onLinkCodeCreate(s, msg.id);
        case 'link.claim':
          return this.onLinkClaim(s, msg.id, msg.body);
        case 'link.approve':
          return this.onLinkApprove(s, msg.id, msg.body);
        case 'link.deny':
          return this.onLinkDeny(s, msg.id, msg.body.request_id);
        case 'account.restore':
          return this.onRestore(s, msg.id, msg.body);
        case 'device.list':
          return this.send(s, 'device.listing', this.deviceListing(s.user!), msg.id);
        case 'device.revoke':
          return this.onRevoke(s, msg.id, msg.body);
        case 'unwatch': {
          const path = folderPath(msg.body.path);
          s.watches.delete(watchKey(msg.body.device_id, path));
          this.db.removeWatch(s.device!, msg.body.device_id, path);
          return this.send(s, 'ok', {}, msg.id);
        }
        default:
          return this.fail(s, 'not_implemented', `${msg.t} is not implemented yet`, msg.id);
      }
    } catch (err) {
      s.log.error({ err }, 'handler failed');
      this.fail(s, 'internal', 'internal error', msg.id);
    }
  }

  private checkPossession(s: Session, pubkey: Uint8Array, sig: string): boolean {
    try {
      return verify(
        'communal/auth/v1',
        fromB64(sig),
        authPayload(s.nonce, this.opts.hubId),
        pubkey,
      );
    } catch {
      return false;
    }
  }

  // ── handlers ──────────────────────────────────────────────────────────────

  private onAccountCreate(s: Session, re: string, body: ClientBody<'account.create'>) {
    if (s.device) return this.fail(s, 'conflict', 'already signed in', re);
    const pubkey = fromB64(body.device_pubkey);
    if (!this.checkPossession(s, pubkey, body.sig))
      return this.fail(s, 'forbidden', 'bad signature', re);
    if (this.db.deviceExistsWithPubkey(body.device_pubkey))
      return this.fail(s, 'conflict', 'device already registered', re);

    // The first device's key is the account root (HANDOFF §2). A device joining this hub on
    // behalf of an existing account proves its chain to that account's root (ADR 0007).
    let root = pubkey;
    let chain: CertChain = [];
    if (body.root_pubkey !== undefined || body.chain !== undefined) {
      if (body.root_pubkey === undefined || body.chain === undefined) {
        return this.fail(s, 'bad_request', 'root_pubkey and chain go together', re);
      }
      root = fromB64(body.root_pubkey);
      chain = body.chain;
      if (!verifyCertChain(root, pubkey, chain).ok) {
        return this.fail(s, 'forbidden', 'cert chain does not verify', re);
      }
    }
    const uid = userId(root);
    const did = deviceId(pubkey);
    const existing = this.db.getUser(uid);
    if (existing) {
      // The account is already here: a chain to its root (empty for the root device itself)
      // is the same proof a link produces, so the device just joins it (ADR 0014).
      if (!verifyCertChain(root, pubkey, chain, this.db.revokedSet(uid)).ok)
        return this.fail(s, 'forbidden', 'cert chain does not verify', re);
      this.registerDevice(s, re, existing, {
        pubkey: body.device_pubkey,
        chain,
        name: body.device_name,
        platform: body.platform,
      });
      return;
    }
    const status = this.db.joinMode === 'open' ? 'active' : 'pending';
    this.db.createAccount(
      { id: uid, display_name: body.display_name, root_pubkey: toB64(root), status },
      {
        id: did,
        user_id: uid,
        pubkey: body.device_pubkey,
        chain,
        name: body.device_name,
        platform: body.platform,
      },
    );
    s.log.info({ user_id: uid, device_id: did, status }, 'account created');
    this.send(
      s,
      'account.created',
      {
        user_id: uid,
        device_id: did,
        fingerprint: fingerprint(root),
        status: status === 'active' ? 'active' : 'pending_approval',
      },
      re,
    );
  }

  /** Adds a verified device to an existing account and answers like `account.create`. */
  private registerDevice(
    s: Session,
    re: string,
    user: UserRow,
    d: { pubkey: string; chain: CertChain; name: string; platform: Platform },
  ) {
    const did = deviceId(fromB64(d.pubkey));
    this.db.addDevice({ id: did, user_id: user.id, ...d });
    s.log.info({ user_id: user.id, device_id: did }, 'device added to account');
    this.send(
      s,
      'account.created',
      {
        user_id: user.id,
        device_id: did,
        fingerprint: fingerprint(fromB64(user.root_pubkey)),
        status: user.status === 'active' ? 'active' : 'pending_approval',
      },
      re,
    );
  }

  private onAuth(s: Session, re: string, body: ClientBody<'auth'>) {
    if (s.device) return this.fail(s, 'conflict', 'already signed in', re);
    const dev = this.db.getDevice(body.device_id);
    // Unknown device, revoked device and bad signature all look the same to the caller.
    if (
      !dev ||
      dev.revoked_at !== null ||
      !this.checkPossession(s, fromB64(dev.pubkey), body.sig)
    ) {
      return this.fail(s, 'forbidden', 'sign-in rejected', re);
    }
    const user = this.db.getUser(dev.user_id);
    if (!user) return this.fail(s, 'forbidden', 'sign-in rejected', re);
    // Checked after the signature, so only the key holder learns the account is banned.
    if (user.banned_at !== null) {
      return this.fail(s, 'banned', 'this account has been banned by the hub admin', re);
    }
    if (user.status !== 'active')
      return this.fail(
        s,
        'pending_approval',
        'waiting for the hub admin to approve this account',
        re,
      );

    s.user = user.id;
    s.device = dev.id;
    s.log = s.log.child({ user_id: user.id, device_id: dev.id });

    const previous = this.online.get(dev.id);
    if (previous && previous !== s) {
      // Same device signed in again (e.g. a reconnect raced the old socket's death).
      previous.device = undefined;
      previous.ws.close(4000, 'replaced by a newer session');
    }
    this.online.set(dev.id, s);
    const pending = this.goingOffline.get(dev.id);
    const wasOnline = !!previous || !!pending;
    if (pending) {
      clearTimeout(pending);
      this.goingOffline.delete(dev.id);
    }
    this.db.touchDevice(dev.id);

    this.send(
      s,
      'welcome',
      {
        session: s.id,
        user_id: user.id,
        device_id: dev.id,
        observed_addr: s.observedAddr,
        index_rev: this.db.indexRev(dev.id),
        nat_probe_ports: this.probePorts,
      },
      re,
    );
    s.log.info({ client: body.client, resumed: wasOnline }, 'signed in');
    // Devices that were away catch up on the account's revocations (ADR 0014).
    for (const proof of this.db.revocationsOf(user.id)) this.send(s, 'device.revoked', proof);

    // Snapshot of who's online among the devices this user may see, then tell others.
    for (const [other, os] of this.online) {
      if (other !== dev.id && this.canSee(user.id, os.user!)) {
        this.send(s, 'presence', { device_id: other, user_id: os.user!, online: true });
      }
    }
    for (const [other, owner] of this.devicesInGrace()) {
      if (this.canSee(user.id, owner))
        this.send(s, 'presence', { device_id: other, user_id: owner, online: true });
    }
    if (!wasOnline) this.publishPresence(user.id, dev.id, true);
  }

  // ── index sync (HANDOFF §5) ───────────────────────────────────────────────
  // Index messages always apply to the session's own device: a client can't touch another
  // device's index because there's no device_id field to forge.

  private onSnapshot(s: Session, re: string, body: ClientBody<'index.snapshot'>) {
    const device = s.device!;
    if (body.page === 0) {
      this.db.beginSnapshot(device);
      s.snapshot = { rev: body.rev, nextPage: 0 };
    }
    if (!s.snapshot || s.snapshot.rev !== body.rev || s.snapshot.nextPage !== body.page) {
      s.snapshot = undefined;
      this.db.beginSnapshot(device);
      return this.fail(s, 'bad_request', 'snapshot pages out of order; start again at page 0', re);
    }
    this.db.stageSnapshotPage(device, body.entries);
    s.snapshot.nextPage++;
    if (!body.last) return this.send(s, 'ok', {}, re);
    this.db.commitSnapshot(device, body.rev);
    s.snapshot = undefined;
    s.log.info({ rev: body.rev, entries: this.db.entryCount(device) }, 'index snapshot applied');
    this.send(s, 'index.ack', { rev: body.rev }, re);
    this.notifyWatchers((w) => w.device === device);
  }

  private onDelta(s: Session, re: string, body: ClientBody<'index.delta'>) {
    const device = s.device!;
    const current = this.db.indexRev(device);
    if (body.base_rev !== current || body.rev <= body.base_rev) {
      s.log.info({ have: current, base: body.base_rev }, 'index rev mismatch; asking for resync');
      return this.send(s, 'index.resync', { reason: 'rev_mismatch' }, re);
    }
    this.db.applyDelta(device, body.rev, body.upsert, body.remove);
    this.send(s, 'index.ack', { rev: body.rev }, re);
    this.notifyWatchers((w) => w.device === device);
  }

  // ── subscriptions (HANDOFF §5 "Subscriptions", ADR 0013) ──────────────────

  private onWatch(s: Session, re: string, body: ClientBody<'watch'>) {
    const path = folderPath(body.path);
    if (body.device_id === s.device)
      return this.fail(s, 'bad_request', 'cannot watch a folder on this device', re);
    // Same answer whether the device or folder doesn't exist or the watcher can't see into it.
    if (!this.catalog.canWatch(s.user!, body.device_id, path))
      return this.fail(s, 'not_found', 'no such folder', re);
    const key = watchKey(body.device_id, path);
    if (!s.watches.has(key) && s.watches.size >= MAX_WATCHES)
      return this.fail(s, 'rate_limited', 'too many subscriptions', re);
    this.db.putWatch({
      user_id: s.user!,
      watcher_device: s.device!,
      device_id: body.device_id,
      path,
      recursive: body.recursive,
      mirror_deletes: body.mirror_deletes,
      since_rev: body.since_rev,
    });
    const w: LiveWatch = { device: body.device_id, path, recursive: body.recursive, sent: 0 };
    s.watches.set(key, w);
    this.send(s, 'ok', {}, re);
    // Catch up from since_rev. A since_rev beyond the device's rev means the hub's index was
    // rebuilt since (or the client is confused): start again from everything.
    const since = body.since_rev > this.db.indexRev(body.device_id) ? 0 : body.since_rev;
    this.sendWatchChanges(s, w, since, true);
  }

  /**
   * Sends what changed in a watched folder since `since`, in pages. Every page but the last
   * carries `since` as its rev, so a watcher that stores each event's rev as its cursor never
   * skips a page it didn't get.
   */
  private sendWatchChanges(s: Session, w: LiveWatch, since: number, always: boolean) {
    const rev = this.db.indexRev(w.device);
    const { added, removed } = this.catalog.watchChanges(
      s.user!,
      w.device,
      w.path,
      w.recursive,
      since,
    );
    w.sent = rev;
    if (!always && added.length === 0 && removed.length === 0) return;
    const items = [...removed.map((p) => ({ removed: p })), ...added.map((e) => ({ added: e }))];
    for (let i = 0; i === 0 || i < items.length; i += WATCH_PAGE) {
      const page = items.slice(i, i + WATCH_PAGE);
      const last = i + WATCH_PAGE >= items.length;
      this.send(s, 'watch.event', {
        device_id: w.device,
        path: w.path,
        rev: last ? rev : since,
        added: page.flatMap((x) => ('added' in x ? [x.added] : [])),
        removed: page.flatMap((x) => ('removed' in x ? [x.removed] : [])),
      });
    }
  }

  /** Brings matching live watches up to date (after index changes). */
  private notifyWatchers(match: (w: LiveWatch, watcher: Session) => boolean) {
    for (const s of this.online.values()) {
      for (const w of s.watches.values())
        if (match(w, s)) this.sendWatchChanges(s, w, w.sent, false);
    }
  }

  /**
   * After a change in who can see what (rules, connections, groups), re-sends everything the
   * matching watchers can now see. Files that just became visible would otherwise never be
   * announced, since their rev is old. Clients ignore what they already have, and a file that
   * became invisible is simply not mentioned: losing access never looks like a deletion.
   */
  private rewatch(match: (w: LiveWatch, watcher: Session) => boolean) {
    for (const s of this.online.values()) {
      for (const w of s.watches.values()) if (match(w, s)) this.sendWatchChanges(s, w, 0, false);
    }
  }

  // ── people: user search, connections, groups (HANDOFF §2, §5) ─────────────

  private summary(u: {
    id: string;
    display_name: string;
    root_pubkey: string;
  }): HubBody<'user.results'>['users'][number] {
    return {
      user_id: u.id,
      display_name: u.display_name,
      fingerprint: fingerprint(fromB64(u.root_pubkey)),
      root_pubkey: u.root_pubkey,
    };
  }

  /** An active, unbanned user other than `self`, or undefined (callers say "not found"). */
  private reachableUser(self: string, id: string) {
    const u = this.db.getUser(id);
    return u && u.id !== self && u.status === 'active' && u.banned_at === null ? u : undefined;
  }

  private sendToUser<T extends HubType>(userId: string, t: T, body: HubBody<T>) {
    for (const s of this.online.values()) if (s.user === userId) this.send(s, t, body);
  }

  private connectionListing(userId: string): HubBody<'connection.listing'> {
    const connections = [];
    for (const c of this.db.connectionsOf(userId)) {
      const u = this.db.getUser(c.other);
      if (!u || u.banned_at !== null) continue;
      const state =
        c.state === 'accepted'
          ? 'accepted'
          : c.requested_by === userId
            ? 'pending_out'
            : 'pending_in';
      connections.push({ user: this.summary(u), state, since: c.created_at } as const);
    }
    return { connections };
  }

  private onConnectionRequest(s: Session, re: string, target: string) {
    const me = s.user!;
    const other = this.reachableUser(me, target);
    if (!other) return this.fail(s, 'not_found', 'no such user', re);
    const existing = this.db.connection(me, target);
    if (existing?.state === 'accepted') return this.send(s, 'ok', {}, re);
    // They already asked us: asking back means yes.
    if (existing && existing.requested_by === target) return this.onConnectionAccept(s, re, target);
    if (!existing) this.db.putConnection(me, target, 'pending', me);
    this.sendToUser(target, 'connection.request', { user: this.summary(this.db.getUser(me)!) });
    this.send(s, 'ok', {}, re);
  }

  private onConnectionAccept(s: Session, re: string, requester: string) {
    const me = s.user!;
    const c = this.db.connection(me, requester);
    if (
      !c ||
      c.state !== 'pending' ||
      c.requested_by !== requester ||
      !this.reachableUser(me, requester)
    ) {
      return this.fail(s, 'not_found', 'no pending request from that user', re);
    }
    this.db.putConnection(me, requester, 'accepted');
    this.sendToUser(requester, 'connection.accept', { user: this.summary(this.db.getUser(me)!) });
    this.send(s, 'ok', {}, re);
    // Newly connected: each now sees the other's devices.
    this.announceDevices(me, [requester], true);
    this.announceDevices(requester, [me], true);
    // List rules naming either of them now apply.
    this.rewatch((w, x) => {
      const owner = this.db.getDevice(w.device)?.user_id;
      return (x.user === me && owner === requester) || (x.user === requester && owner === me);
    });
  }

  private onConnectionRemove(s: Session, re: string, other: string) {
    const me = s.user!;
    const c = this.db.connection(me, other);
    if (!c) return this.fail(s, 'not_found', 'not connected to that user', re);
    this.db.raw.transaction(() => {
      this.db.removeConnection(me, other);
      // Groups are built from connections (HANDOFF §2); access via rules is gated on the
      // connection in Catalog.visible(), so it ends right here too.
      this.db.dropFromGroups(me, other);
      this.db.dropFromGroups(other, me);
    })();
    this.sendToUser(other, 'connection.remove', { user_id: me });
    this.send(s, 'ok', {}, re);
    if (c.state === 'accepted') {
      if (!this.db.sharesWithHub(me)) this.announceDevices(me, [other], false);
      if (!this.db.sharesWithHub(other)) this.announceDevices(other, [me], false);
    }
  }

  private onGroupUpsert(s: Session, re: string, body: ClientBody<'group.upsert'>) {
    const me = s.user!;
    if (body.group_id && this.db.groupOwner(body.group_id) !== me) {
      return this.fail(s, 'not_found', 'no such group', re);
    }
    const connected = new Set(this.db.connectedUsers(me));
    const strangers = body.members.filter((m) => !connected.has(m));
    if (strangers.length)
      return this.fail(s, 'bad_request', 'group members must be your connections', re);
    const id = body.group_id ?? newGroupId();
    this.db.upsertGroup(me, id, body.name, [...new Set(body.members)]);
    const group = this.db.groupsOf(me).find((g) => g.group_id === id)!;
    this.send(s, 'group.listing', { groups: [group] }, re);
    // New members may now see files shared with the group.
    const members = new Set(group.members);
    this.rewatch((w, x) => members.has(x.user!) && this.db.getDevice(w.device)?.user_id === me);
  }

  // ── brokering (HANDOFF §8; no relay, ever) ─────────────────────────────────

  private onConnectRequest(s: Session, re: string, body: ClientBody<'connect.request'>) {
    const now = Date.now();
    for (const [id, b] of this.brokered) if (b.expires < now) this.brokered.delete(id);
    // Same answer whether the device doesn't exist or the requester just can't see the file.
    if (body.target === s.device || !this.catalog.canFetch(s.user!, body.target, body.hash)) {
      return this.fail(s, 'not_found', 'no such file on that device', re);
    }
    if (this.brokered.has(body.session_id))
      return this.fail(s, 'conflict', 'session id in use', re);
    const target = this.online.get(body.target);
    if (!target) {
      return this.send(
        s,
        'connect.failed',
        {
          session_id: body.session_id,
          cause: 'peer_offline',
          easier_fix: 'none',
          you: natView(s.profile),
          them: natView(undefined),
        },
        re,
      );
    }
    const me = this.db.getDevice(s.device!)!;
    const owner = this.db.getUser(s.user!)!;
    const token = signTransferToken(this.opts.hubKey, {
      session_id: body.session_id,
      from: s.device!,
      to: body.target,
      hash: body.hash,
      exp: Math.floor(now / 1000) + TOKEN_TTL_S,
    });
    this.brokered.set(body.session_id, {
      downloader: s,
      from: s.device!,
      to: body.target,
      token,
      expires: now + TOKEN_TTL_S * 1000,
      answered: false,
    });
    this.send(target, 'connect.offer', {
      session_id: body.session_id,
      from: s.device!,
      from_user: s.user!,
      from_root_pubkey: owner.root_pubkey,
      from_chain: me.chain,
      from_revocations: this.db.revocationsOf(s.user!).slice(-256),
      token,
      stream_id: body.stream_id,
      candidates: body.candidates,
    });
    s.log.info({ session: body.session_id, to: body.target }, 'brokering connection');
    this.send(s, 'ok', {}, re);
  }

  private onConnectAnswer(s: Session, re: string, body: ClientBody<'connect.answer'>) {
    const b = this.brokered.get(body.session_id);
    // Only the device the offer went to may answer it.
    if (!b || b.to !== s.device) return this.fail(s, 'not_found', 'no such session', re);
    b.answered = true;
    const me = this.db.getDevice(s.device!)!;
    const owner = this.db.getUser(s.user!)!;
    this.send(b.downloader, 'connect.answer', {
      session_id: body.session_id,
      stream_id: body.stream_id,
      candidates: body.candidates,
      to_user: s.user!,
      to_root_pubkey: owner.root_pubkey,
      to_chain: me.chain,
      to_revocations: this.db.revocationsOf(s.user!).slice(-256),
      token: b.token,
    });
    this.send(s, 'ok', {}, re);
  }

  /**
   * Either side of a brokered session reports that no direct path came up (HANDOFF §8). The
   * owner's report is just recorded. The downloader's is answered with one diagnosis built
   * from both sides' observations, after waiting briefly for the owner's if it isn't in yet.
   */
  private async onConnectFailed(s: Session, re: string, body: ClientBody<'connect.failed'>) {
    const b = this.brokered.get(body.session_id);
    const isDown = b?.from === s.device && b?.downloader === s;
    const isUp = b?.to === s.device;
    // Only the two parties of a live session may report, and nobody learns about others'.
    if (!b || (!isDown && !isUp)) return this.fail(s, 'not_found', 'no such session', re);
    if (isUp) {
      b.up = body.observations;
      b.onReport?.();
      return this.send(s, 'ok', {}, re);
    }
    b.down = body.observations;
    if (b.answered && !b.up) {
      const pending = b;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.opts.diagnosisWaitMs);
        pending.onReport = () => {
          clearTimeout(t);
          resolve();
        };
      });
      b.onReport = undefined;
    }
    // An owner that never reported (crashed, or its report was lost) is judged by its profile.
    const up = b.up ?? this.online.get(b.to)?.profile;
    const result = diagnose({ answered: b.answered, down: b.down, up });
    this.brokered.delete(body.session_id);
    s.log.info(
      { session: body.session_id, to: b.to, cause: result.cause, easier_fix: result.easier_fix },
      'direct connection failed',
    );
    this.send(
      s,
      'connect.failed',
      { session_id: body.session_id, ...result, you: natView(b.down), them: natView(up) },
      re,
    );
  }

  // ── devices: linking, restore, revocation (HANDOFF §2, §4; ADR 0014) ──────

  private onLinkCodeCreate(s: Session, re: string) {
    this.expireLinks();
    let mine = 0;
    for (const c of this.linkCodes.values()) if (c.owner === s) mine++;
    if (mine >= MAX_LINK_CODES) return this.fail(s, 'rate_limited', 'too many link codes', re);
    let code: string;
    do code = newLinkCode();
    while (this.linkCodes.has(code));
    this.linkCodes.set(code, { owner: s, expires: Date.now() + this.opts.linkTtlMs });
    s.log.info('link code created');
    this.send(
      s,
      'link.code',
      { code, expires_in: Math.max(1, Math.round(this.opts.linkTtlMs / 1000)) },
      re,
    );
  }

  private onLinkClaim(s: Session, re: string, body: ClientBody<'link.claim'>) {
    if (s.device) return this.fail(s, 'conflict', 'already signed in', re);
    if (s.claim) return this.fail(s, 'conflict', 'a link request is already pending', re);
    if (!this.checkPossession(s, fromB64(body.device_pubkey), body.sig))
      return this.fail(s, 'forbidden', 'bad signature', re);
    this.expireLinks();
    const code = normalizeLinkCode(body.code);
    const entry = this.linkCodes.get(code);
    if (!entry) {
      if (++s.badClaims >= MAX_BAD_CLAIMS) {
        s.log.info('too many wrong link codes; closing');
        this.fail(s, 'rate_limited', 'too many wrong link codes', re);
        return s.ws.close(4029, 'too many wrong link codes');
      }
      return this.fail(s, 'not_found', 'unknown or expired link code', re);
    }
    if (this.db.deviceExistsWithPubkey(body.device_pubkey))
      return this.fail(s, 'conflict', 'device already registered', re);
    this.linkCodes.delete(code); // single use
    const id = 'lr_' + randomBytes(8).toString('hex');
    this.linkRequests.set(id, {
      owner: entry.owner,
      claimer: s,
      pubkey: body.device_pubkey,
      name: body.device_name,
      platform: body.platform,
      expires: entry.expires,
    });
    s.claim = id;
    this.send(s, 'ok', {}, re);
    this.send(entry.owner, 'link.request', {
      request_id: id,
      device_name: body.device_name,
      platform: body.platform,
      device_pubkey: body.device_pubkey,
    });
    entry.owner.log.info({ request_id: id }, 'link code claimed; waiting for approval');
  }

  private onLinkApprove(s: Session, re: string, body: ClientBody<'link.approve'>) {
    const r = this.linkRequests.get(body.request_id);
    if (!r || r.owner !== s) return this.fail(s, 'not_found', 'no such link request', re);
    if (r.claimer.ws.readyState !== r.claimer.ws.OPEN) {
      this.linkRequests.delete(body.request_id);
      return this.fail(s, 'not_found', 'the new device went away', re);
    }
    const me = this.db.getDevice(s.device!)!;
    const user = this.db.getUser(s.user!)!;
    const cert = body.cert;
    const chain: CertChain = [...me.chain, cert];
    // The approving device signs for its own account, for exactly the key that claimed the code.
    if (
      cert.device_pubkey !== r.pubkey ||
      cert.signer_pubkey !== me.pubkey ||
      !verifyCertChain(
        fromB64(user.root_pubkey),
        fromB64(r.pubkey),
        chain,
        this.db.revokedSet(user.id),
      ).ok
    ) {
      return this.fail(s, 'bad_request', 'cert does not match the link request', re);
    }
    if (this.db.deviceExistsWithPubkey(r.pubkey))
      return this.fail(s, 'conflict', 'device already registered', re);
    this.linkRequests.delete(body.request_id);
    r.claimer.claim = undefined;
    const did = deviceId(fromB64(r.pubkey));
    this.db.addDevice({
      id: did,
      user_id: user.id,
      pubkey: r.pubkey,
      chain,
      name: r.name,
      platform: r.platform,
    });
    this.send(r.claimer, 'link.done', {
      user_id: user.id,
      device_id: did,
      chain,
      ...(body.sealed ? { sealed: body.sealed } : {}),
    });
    this.send(s, 'ok', {}, re);
    s.log.info({ new_device: did }, 'device linked');
  }

  private onLinkDeny(s: Session, re: string, id: string) {
    const r = this.linkRequests.get(id);
    if (!r || r.owner !== s) return this.fail(s, 'not_found', 'no such link request', re);
    this.denyLink(id, r);
    this.send(s, 'ok', {}, re);
  }

  private denyLink(id: string, r: LinkRequest) {
    this.linkRequests.delete(id);
    r.claimer.claim = undefined;
    this.send(r.claimer, 'link.denied', {});
  }

  /** Codes and requests die with the session that made them. */
  private dropLinks(s: Session) {
    for (const [code, c] of this.linkCodes) if (c.owner === s) this.linkCodes.delete(code);
    for (const [id, r] of this.linkRequests) {
      if (r.owner === s) this.denyLink(id, r);
      else if (r.claimer === s) this.linkRequests.delete(id);
    }
  }

  private expireLinks() {
    const now = Date.now();
    for (const [code, c] of this.linkCodes) if (c.expires < now) this.linkCodes.delete(code);
    for (const [id, r] of this.linkRequests) if (r.expires < now) this.denyLink(id, r);
  }

  /** A fresh device joins the account with a cert signed by the recovered root key (§4). */
  private onRestore(s: Session, re: string, body: ClientBody<'account.restore'>) {
    if (s.device) return this.fail(s, 'conflict', 'already signed in', re);
    if (s.claim) return this.fail(s, 'conflict', 'a link request is already pending', re);
    const pubkey = fromB64(body.device_pubkey);
    if (!this.checkPossession(s, pubkey, body.sig))
      return this.fail(s, 'forbidden', 'bad signature', re);
    if (this.db.deviceExistsWithPubkey(body.device_pubkey))
      return this.fail(s, 'conflict', 'device already registered', re);
    const root = fromB64(body.root_pubkey);
    const user = this.db.getUser(userId(root));
    if (!user || user.root_pubkey !== body.root_pubkey)
      return this.fail(s, 'not_found', 'no account with that recovery key on this hub', re);
    const cert: DeviceCert = {
      user_id: user.id,
      device_pubkey: body.device_pubkey,
      issued_at: body.issued_at,
      signer_pubkey: body.root_pubkey,
      sig: body.root_sig,
    };
    if (!verifyCertChain(root, pubkey, [cert], this.db.revokedSet(user.id)).ok)
      return this.fail(s, 'forbidden', 'recovery signature does not verify', re);
    this.registerDevice(s, re, user, {
      pubkey: body.device_pubkey,
      chain: [cert],
      name: body.device_name,
      platform: body.platform,
    });
  }

  private deviceListing(uid: string): HubBody<'device.listing'> {
    const user = this.db.getUser(uid)!;
    return {
      devices: this.db.listDevices(uid).map((d) => ({
        device_id: d.id,
        name: d.name,
        platform: d.platform as Platform,
        online: d.revoked_at === null && this.isOnline(d.id),
        last_seen: d.last_seen,
        revoked_at: d.revoked_at,
        root: d.pubkey === user.root_pubkey,
      })),
    };
  }

  private onRevoke(s: Session, re: string, proof: RevocationProof) {
    const rev = proof.revocation;
    const user = this.db.getUser(s.user!)!;
    if (rev.user_id !== user.id)
      return this.fail(s, 'forbidden', 'revocations are for your own devices', re);
    const root = fromB64(user.root_pubkey);
    if (rev.device_id === deviceId(root))
      return this.fail(s, 'bad_request', "the account's first device can't be revoked", re);
    const revoked = this.db.revokedSet(user.id);
    if (revoked.has(rev.device_id)) return this.send(s, 'ok', {}, re);
    if (!verifyRevocation(rev, root, proof.chain, revoked))
      return this.fail(s, 'forbidden', 'invalid revocation', re);
    this.db.addRevocation(proof);
    revoked.add(rev.device_id);
    this.send(s, 'ok', {}, re);
    s.log.info({ revoked: rev.device_id }, 'device revoked');
    // The device goes, and so does every device whose chain runs through it (ADR 0002).
    for (const d of this.db.listDevices(user.id)) {
      if (d.revoked_at !== null) continue;
      if (verifyCertChain(root, fromB64(d.pubkey), d.chain, revoked).ok) continue;
      this.db.revokeDevice(d.id);
      this.dropDevice(user.id, d.id, 4004, 'device revoked');
    }
    // The account's other devices keep the proof and pass it on to their other hubs.
    for (const x of this.online.values())
      if (x.user === user.id && x !== s) this.send(x, 'device.revoked', proof);
  }

  // ── access rules ──────────────────────────────────────────────────────────

  private onAcl(
    s: Session,
    re: string,
    deviceId: string,
    rules: { path: string; audience: ClientBody<'acl.set'>['audience'] }[],
    replace: boolean,
  ) {
    // Rules are set by the device that holds the files (ADR 0009).
    if (deviceId !== s.device)
      return this.fail(s, 'forbidden', 'rules can only be set for this device', re);
    for (const r of rules) {
      const a = r.audience;
      if (
        a &&
        typeof a === 'object' &&
        (a.groups ?? []).some((g) => this.db.groupOwner(g) !== s.user)
      ) {
        return this.fail(s, 'bad_request', 'unknown group', re);
      }
    }
    const before = this.db.sharesWithHub(s.user!);
    const rulesBefore = JSON.stringify(this.db.rules(deviceId));
    if (replace) {
      this.db.replaceRules(
        deviceId,
        rules.flatMap((r) => (r.audience ? [{ path: r.path, audience: r.audience }] : [])),
      );
    } else {
      this.db.setRule(deviceId, rules[0]!.path, rules[0]!.audience);
    }
    this.send(s, 'ok', {}, re);
    // acl.replace comes with every sign-in; only an actual change can make files visible.
    if (JSON.stringify(this.db.rules(deviceId)) !== rulesBefore)
      this.rewatch((w) => w.device === deviceId);
    // Sharing with the whole hub makes this user's devices' presence visible to everyone.
    const after = this.db.sharesWithHub(s.user!);
    if (before !== after) {
      const others = [...new Set([...this.online.values()].map((x) => x.user!))].filter(
        (u) => u !== s.user && !this.db.connectedUsers(s.user!).includes(u),
      );
      this.announceDevices(s.user!, others, after);
    }
  }

  /** Tells `viewers` about each online device of `owner` (online, or now hidden = offline). */
  private announceDevices(owner: string, viewers: string[], online: boolean) {
    const devices = [...this.online.entries()].filter(([, x]) => x.user === owner).map(([d]) => d);
    for (const [d] of this.devicesInGrace())
      if (this.db.getDevice(d)?.user_id === owner) devices.push(d);
    for (const v of viewers) {
      for (const d of devices)
        this.sendToUser(v, 'presence', { device_id: d, user_id: owner, online });
    }
  }

  private *devicesInGrace(): Iterable<[string, string]> {
    for (const device of this.goingOffline.keys()) {
      const owner = this.db.getDevice(device)?.user_id;
      if (owner) yield [device, owner];
    }
  }

  // ── presence ──────────────────────────────────────────────────────────────

  /**
   * Whether `viewer` may see presence of `owner`'s devices: their own devices, and devices of
   * accepted connections. M3 widens this to owners sharing something with the viewer.
   */
  /**
   * Presence follows visibility: your own devices, your connections, and anyone on the hub
   * if the owner shares something with the whole hub (their devices show up as sources).
   */
  private canSee(viewer: string, owner: string): boolean {
    if (viewer === owner) return true;
    return this.db.connectedUsers(owner).includes(viewer) || this.db.sharesWithHub(owner);
  }

  private publishPresence(owner: string, device: string, online: boolean) {
    const everyone = this.db.sharesWithHub(owner);
    const viewers = new Set([owner, ...this.db.connectedUsers(owner)]);
    for (const [other, s] of this.online) {
      if (other !== device && (everyone || viewers.has(s.user!))) {
        this.send(s, 'presence', { device_id: device, user_id: owner, online });
      }
    }
  }
}

function newLinkCode(): string {
  // 256 is a multiple of 32, so taking each byte mod 32 has no bias.
  const c = [...randomBytes(8)].map((b) => CODE_ALPHABET[b % 32]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** Codes read aloud or typed by hand: O means 0, I and L mean 1. */
function normalizeLinkCode(code: string): string {
  return code.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Watched paths are folders: `Photos` and `Photos/` are the same subscription. */
function folderPath(p: string): string {
  return p.endsWith('/') ? p : p + '/';
}

const watchKey = (device: string, path: string) => `${device}\0${path}`;
