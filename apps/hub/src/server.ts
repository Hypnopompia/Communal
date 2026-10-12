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
  verifyCertChain,
  type CertChain,
  type KeyPair,
} from '@communal/crypto';
import {
  encodeHub,
  MAX_FRAME_BYTES,
  parseClientMessage,
  type ClientBody,
  type ClientMessage,
  type HubBody,
  type HubType,
} from '@communal/protocol';
import type { HubDb } from './db.js';

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
  log?: Logger;
}

const DEFAULTS = { silenceMs: 90_000, authTimeoutMs: 30_000, banPollMs: 2_000 };

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
  log: Logger;
}

export class HubServer {
  readonly db: HubDb;
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
  /** device_id → timer that will publish "offline" once the grace period runs out. */
  private readonly goingOffline = new Map<string, NodeJS.Timeout>();

  constructor(opts: HubOptions) {
    this.opts = { ...DEFAULTS, ...opts };
    this.db = opts.db;
    this.log = opts.log ?? pino({ name: 'hub' });
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
    for (const s of this.sessions) {
      if (now - s.lastSeen > this.opts.silenceMs) {
        s.log.info('silent too long; dropping');
        s.ws.terminate();
      } else if (!s.device && now - s.lastSeen > this.opts.authTimeoutMs) {
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

  private onClose(s: Session) {
    this.sessions.delete(s);
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
    if (this.db.getUser(uid)) {
      return this.fail(
        s,
        'conflict',
        'account already exists on this hub; link this device instead',
        re,
      );
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
        nat_probe_ports: this.opts.probePorts ?? [0, 0],
      },
      re,
    );
    s.log.info({ client: body.client, resumed: wasOnline }, 'signed in');

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
  private canSee(viewer: string, owner: string): boolean {
    if (viewer === owner) return true;
    return this.db.connectedUsers(owner).includes(viewer);
  }

  private publishPresence(owner: string, device: string, online: boolean) {
    const viewers = new Set([owner, ...this.db.connectedUsers(owner)]);
    for (const [other, s] of this.online) {
      if (other !== device && viewers.has(s.user!)) {
        this.send(s, 'presence', { device_id: device, user_id: owner, online });
      }
    }
  }
}
