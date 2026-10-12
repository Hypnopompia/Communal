// Ambient typings for udx-native and secret-stream must travel with this file to packages
// that typecheck core from source (the CLI), and ambient declarations cannot be imported.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./modules.d.ts" />
import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';
import { randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import SecretStream from '@hyperswarm/secret-stream';
import UDX, { type UDXSocket, type UDXStream } from 'udx-native';
import { pino, type Logger } from 'pino';
import type { KeyPair } from '@communal/crypto';
import {
  encodePeerFrame,
  PeerFrameDecoder,
  type AnyPeerHeader,
  type HubBody,
  type PeerHeader,
  type PeerType,
} from '@communal/protocol';

export type Candidate = HubBody<'connect.offer'>['candidates'][number];

/**
 * Direct, encrypted peer connections (ADR 0001, 0010): one UDP socket per device carrying udx
 * streams, Noise XX on the device keys via secret-stream. No relay, no DHT.
 *
 * Connecting: both sides know the session id, each other's stream id and candidate addresses
 * (exchanged through the hub). Each side fires small "punch" datagrams at every candidate of
 * the other; the first address a punch (or its echo) arrives from is a working path — through
 * NATs, it's the other side's mapped address — and the udx stream connects there.
 */

const MAGIC = Buffer.from('CMNL1');
const PUNCH = 1;
const ECHO = 2;

/** Lower is preferred when several paths answer at once: LAN wins, then IPv6 (HANDOFF §8). */
const PRIORITY: Record<Candidate['kind'], number> = {
  lan: 0,
  ipv6: 1,
  advertised: 2,
  mapped: 3,
  public: 4,
};

/** What hole punching saw before giving up: reported to the hub in `connect.failed`. */
export interface PunchStats {
  /** Punch rounds sent (one datagram to every candidate per round). */
  attempts: number;
  /** At least one datagram left this socket (false: nothing routable, or sending failed). */
  udp_sent: boolean;
  /** Something from the peer arrived (a punch, or an echo of ours). */
  udp_received: boolean;
}

export class ConnectError extends Error {
  constructor(
    readonly reason: 'no_path' | 'handshake_failed' | 'peer_rejected' | 'closed',
    message: string,
    /** Set when punching ran: what the network let through (ADR 0011). */
    readonly stats?: PunchStats,
  ) {
    super(message);
  }
}

interface PunchState {
  /** Addresses we heard this session's punches/echoes from, with when. */
  heard: { host: string; port: number; at: number; kind: number }[];
  onHeard?: () => void;
}

export interface TransportOptions {
  device: KeyPair;
  /** UDP port to bind (0 = any). Fixed ports help with port forwarding (HANDOFF §8). */
  port?: number;
  host?: string;
  /** Operator-supplied reachable addresses (COMMUNAL_ADVERTISE_ADDR, HANDOFF §13). */
  advertise?: { host: string; port: number }[];
  /** Offer 127.0.0.1 as a candidate (tests, and peers on the same machine). */
  loopback?: boolean;
  /** How long hole punching (plus the handshake) may take before giving up (default 10 s). */
  connectTimeoutMs?: number;
  /** Fault injection for tests: drop every incoming punch/echo while this returns true. */
  testDropPunches?: () => boolean;
  log?: Logger;
}

const isPrivateV4 = (h: string) =>
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(h);

/** Every address of this machine's interfaces, loopback included (to spot "no NAT"). */
export function localAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) out.add(a.address);
  return out;
}

/** Same machine or the same private network: what "only upload on LAN" allows. */
export function isLanAddress(host: string): boolean {
  if (isIP(host) === 4) return isPrivateV4(host);
  const h = host.toLowerCase();
  if (h.startsWith('::ffff:')) return isPrivateV4(h.slice(7));
  return h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd');
}

export class PeerTransport {
  private readonly udx = new UDX();
  private socket?: UDXSocket;
  private readonly sessions = new Map<string, PunchState>();
  private readonly usedIds = new Set<number>();
  private readonly channels = new Set<PeerChannel>();
  /** Our address as seen from outside, learned by probing hubs (key: host:port). */
  private readonly publicAddrs = new Map<string, { host: string; port: number; at: number }>();
  /** A port mapping on the router (UPnP / NAT-PMP), if one was made. */
  private mapped?: { host: string; port: number };
  private probeWaiters: { from: string; resolve: (a: { addr: string; port: number }) => void }[] =
    [];
  private readonly log: Logger;

  constructor(private readonly o: TransportOptions) {
    this.log = o.log ?? pino({ name: 'peer' });
  }

  get port(): number {
    return this.socket?.address().port ?? 0;
  }

  async start() {
    const socket = this.udx.createSocket();
    socket.bind(this.o.port ?? 0, this.o.host ?? '0.0.0.0');
    try {
      socket.setRecvBufferSize(8 * 1024 * 1024);
      socket.setSendBufferSize(8 * 1024 * 1024);
    } catch {
      // capped by the OS; fine
    }
    socket.on('message', (msg: Buffer, from: { host: string; port: number }) =>
      this.onDatagram(msg, from),
    );
    this.socket = socket;
    this.log.info({ port: this.port }, 'peer transport listening');
  }

  async stop() {
    // Open streams keep the socket from closing. End them politely so peers notice at once,
    // then destroy whatever hasn't finished shortly after.
    for (const ch of this.channels) ch.close();
    if (this.channels.size > 0) await new Promise((r) => setTimeout(r, 200));
    for (const ch of this.channels) ch.destroy();
    this.channels.clear();
    await this.socket?.close();
    this.socket = undefined;
  }

  /**
   * Learns this socket's public (NAT-mapped) address from a hub's UDP probe responder and
   * offers it as a candidate (HANDOFF §8). Probing from the peer socket itself matters: the
   * mapping it reveals is the one hole punching will use. M5 adds NAT classification.
   */
  async probe(
    hubHost: string,
    probePort: number,
    timeoutMs = 2_000,
  ): Promise<{ host: string; port: number } | null> {
    if (!this.socket || !isIP(hubHost) || !probePort) return null;
    const from = `${hubHost}:${probePort}`;
    const reply = new Promise<{ addr: string; port: number } | null>((resolve) => {
      const w = { from, resolve };
      this.probeWaiters.push(w);
      setTimeout(() => {
        this.probeWaiters = this.probeWaiters.filter((x) => x !== w);
        resolve(null);
      }, timeoutMs).unref();
    });
    for (let i = 0; i < 3; i++) {
      try {
        this.socket.trySend(Buffer.from('communal-probe'), probePort, hubHost);
      } catch {
        return null;
      }
    }
    const r = await reply;
    if (!r || !isIP(r.addr)) return null;
    const addr = { host: r.addr, port: r.port, at: Date.now() };
    // Behind a symmetric NAT every probe reveals a new port: keep only recent ones.
    for (const [k, v] of this.publicAddrs) if (addr.at - v.at > 600_000) this.publicAddrs.delete(k);
    this.publicAddrs.set(`${addr.host}:${addr.port}`, addr);
    return { host: addr.host, port: addr.port };
  }

  private onProbeReply(msg: Buffer, from: { host: string; port: number }) {
    const key = `${from.host.replace(/^::ffff:/, '')}:${from.port}`;
    const i = this.probeWaiters.findIndex((w) => w.from === key);
    if (i < 0) return; // only trust replies from the address we probed
    try {
      const j = JSON.parse(msg.toString()) as { addr?: unknown; port?: unknown };
      if (typeof j.addr === 'string' && typeof j.port === 'number') {
        this.probeWaiters
          .splice(i, 1)[0]!
          .resolve({ addr: j.addr.replace(/^::ffff:/, ''), port: j.port });
      }
    } catch {
      // not a probe reply
    }
  }

  setMapped(addr: { host: string; port: number } | undefined) {
    this.mapped = addr && isIP(addr.host) ? addr : undefined;
  }

  /** Addresses peers can try, best first. */
  candidates(): Candidate[] {
    const port = this.port;
    const out: Candidate[] = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.internal) continue;
        if (a.family === 'IPv4') out.push({ kind: 'lan', host: a.address, port });
        else if (!a.address.startsWith('fe80')) out.push({ kind: 'ipv6', host: a.address, port });
      }
    }
    if (this.o.loopback) out.unshift({ kind: 'lan', host: '127.0.0.1', port });
    for (const a of this.o.advertise ?? [])
      out.push({ kind: 'advertised', host: a.host, port: a.port });
    if (this.mapped) out.push({ kind: 'mapped', host: this.mapped.host, port: this.mapped.port });
    for (const a of this.publicAddrs.values()) {
      if (!out.some((c) => c.host === a.host && c.port === a.port)) {
        out.push({ kind: 'public', host: a.host, port: a.port });
      }
    }
    return out.slice(0, 16);
  }

  newStreamId(): number {
    let id: number;
    do id = randomInt(1, 0xffffffff);
    while (this.usedIds.has(id));
    this.usedIds.add(id);
    return id;
  }

  /** Starts listening for a session's punches before we know the peer's candidates. */
  expect(session: string) {
    if (!this.sessions.has(session)) this.sessions.set(session, { heard: [] });
  }

  forget(session: string) {
    this.sessions.delete(session);
  }

  private onDatagram(msg: Buffer, from: { host: string; port: number }) {
    if (msg[0] === 0x7b /* '{' */ && this.probeWaiters.length > 0)
      return this.onProbeReply(msg, from);
    if (
      msg.length < MAGIC.length + 2 ||
      msg.length > 128 ||
      !msg.subarray(0, MAGIC.length).equals(MAGIC)
    )
      return;
    const type = msg[MAGIC.length]!;
    const session = msg.subarray(MAGIC.length + 1).toString();
    const st = this.sessions.get(session);
    if (!st) return; // never answer for sessions we don't know (no reflection)
    if (this.o.testDropPunches?.()) return;
    if (type === PUNCH) this.sendDatagram(ECHO, session, from.host, from.port);
    if (!st.heard.some((h) => h.host === from.host && h.port === from.port)) {
      st.heard.push({ host: from.host, port: from.port, at: Date.now(), kind: type });
    }
    st.onHeard?.();
  }

  /** False when the datagram couldn't be sent (no socket, or an unroutable address). */
  private sendDatagram(type: number, session: string, host: string, port: number): boolean {
    if (!this.socket) return false;
    try {
      this.socket.trySend(
        Buffer.concat([MAGIC, Buffer.from([type]), Buffer.from(session)]),
        port,
        host,
      );
      return true;
    } catch {
      // unroutable candidate (e.g. IPv6 on an IPv4-only host): ignore
      return false;
    }
  }

  /**
   * Opens an authenticated channel to a peer. `verifyPeer` sees the remote device key after
   * the Noise handshake proved possession; it must check device id and cert chain.
   */
  async connect(opts: {
    session: string;
    localStreamId: number;
    remoteStreamId: number;
    candidates: Candidate[];
    initiator: boolean;
    verifyPeer: (remotePublicKey: Uint8Array) => boolean;
    timeoutMs?: number;
  }): Promise<PeerChannel> {
    const socket = this.socket;
    if (!socket) throw new ConnectError('closed', 'transport not started');
    this.expect(opts.session);
    const st = this.sessions.get(opts.session)!;
    const deadline = Date.now() + (opts.timeoutMs ?? this.o.connectTimeoutMs ?? 10_000);
    const targets = [...opts.candidates]
      .filter((c) => isIP(c.host))
      .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);

    // Punch until we've heard from the peer, then pick the best path heard in a short window.
    let attempts = 0;
    let sent = false;
    const punchAll = () => {
      attempts++;
      for (const c of targets)
        sent = this.sendDatagram(PUNCH, opts.session, c.host, c.port) || sent;
    };
    const stats = (): PunchStats => ({
      attempts,
      udp_sent: sent,
      udp_received: st.heard.length > 0,
    });
    punchAll();
    const timer = setInterval(punchAll, 100);
    try {
      if (st.heard.length === 0) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(
            () => reject(new ConnectError('no_path', 'no network path to the peer', stats())),
            Math.max(0, deadline - Date.now()),
          );
          st.onHeard = () => {
            clearTimeout(t);
            resolve();
          };
        });
      }
      // Give a better (e.g. LAN) path a moment to show up too.
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      clearInterval(timer);
      this.sessions.delete(opts.session);
      throw err;
    } finally {
      st.onHeard = undefined;
    }
    const path = [...st.heard].sort((a, b) => rank(targets, a) - rank(targets, b))[0]!;

    const raw: UDXStream = this.udx.createStream(opts.localStreamId);
    raw.connect(socket, opts.remoteStreamId, path.port, path.host);
    const secure = new SecretStream(opts.initiator, raw as unknown as Duplex, {
      keyPair: sodiumKeyPair(this.o.device),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new ConnectError('handshake_failed', 'secure handshake timed out', stats())),
          Math.max(1_000, deadline - Date.now()),
        );
        secure.once('connect', () => {
          clearTimeout(t);
          resolve();
        });
        secure.once('error', (e: Error) => {
          clearTimeout(t);
          reject(new ConnectError('handshake_failed', e.message, stats()));
        });
        secure.once('close', () => {
          clearTimeout(t);
          reject(new ConnectError('closed', 'peer closed during handshake'));
        });
      });
    } catch (err) {
      secure.destroy();
      throw err;
    } finally {
      clearInterval(timer);
      this.sessions.delete(opts.session);
    }
    const remote = secure.remotePublicKey;
    if (!remote || !opts.verifyPeer(new Uint8Array(remote))) {
      secure.destroy();
      throw new ConnectError('peer_rejected', 'peer identity did not check out');
    }
    // Detect a peer that vanished (crash, sleep, network change) instead of writing into the
    // void: keepalives every 5 s, and give up after 20 s without hearing anything.
    secure.setKeepAlive(5_000);
    secure.setTimeout(20_000);
    const ch = new PeerChannel(secure, new Uint8Array(remote), path.host);
    this.channels.add(ch);
    ch.once('close', () => this.channels.delete(ch));
    return ch;
  }
}

function rank(targets: Candidate[], h: { host: string; port: number }): number {
  const c = targets.find((t) => t.host === h.host && t.port === h.port);
  // Paths we heard from but didn't list (a NAT's mapped address) rank after listed LAN ones.
  return c ? PRIORITY[c.kind] : isLanAddress(h.host) ? 0.5 : 3.5;
}

function sodiumKeyPair(kp: KeyPair) {
  const secretKey = Buffer.alloc(64);
  secretKey.set(kp.secretKey, 0);
  secretKey.set(kp.publicKey, 32);
  return { publicKey: Buffer.from(kp.publicKey), secretKey };
}

export interface PeerChannelEvents {
  frame: [{ header: AnyPeerHeader; payload: Uint8Array }];
  close: [];
}

/** A framed, authenticated connection to one peer device (HANDOFF §7 frames). */
export class PeerChannel extends EventEmitter<PeerChannelEvents> {
  private readonly decoder = new PeerFrameDecoder();
  private closed = false;
  /** Frames that arrived while nobody was listening (e.g. `hello` racing the uploader's setup). */
  private backlog: { header: AnyPeerHeader; payload: Uint8Array }[] = [];
  /** True when the peer closed cleanly (vs. timeout, error or our own close). */
  endedByPeer = false;

  constructor(
    private readonly stream: SecretStream,
    readonly remotePublicKey: Uint8Array,
    readonly remoteHost: string,
  ) {
    super();
    stream.on('data', (d: Buffer) => {
      try {
        for (const f of this.decoder.push(d)) {
          if (this.listenerCount('frame') > 0) this.emit('frame', f);
          else if (this.backlog.push(f) > 64) this.close(); // a peer flooding us before we're ready
        }
      } catch {
        this.close(); // malformed frames end the connection
      }
    });
    // The peer ending its side means the conversation is over: end ours too.
    stream.on('end', () => {
      this.endedByPeer = true;
      this.close();
    });
    stream.on('close', () => this.onClosed());
    stream.on('error', () => this.onClosed());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isLan(): boolean {
    return isLanAddress(this.remoteHost);
  }

  /** Sends one frame; resolves once the stream can take more (backpressure). */
  async send<T extends PeerType>(header: PeerHeader<T>, payload?: Uint8Array): Promise<void> {
    if (this.closed) throw new ConnectError('closed', 'channel closed');
    if (!this.stream.write(encodePeerFrame(header, payload))) {
      await new Promise<void>((resolve) => {
        const done = () => {
          this.stream.off('drain', done);
          this.off('close', done);
          resolve();
        };
        this.stream.once('drain', done);
        this.once('close', done);
      });
    }
  }

  /** Delivers every frame (backlog first) to `handler` until the returned function is called. */
  subscribe(handler: (f: { header: AnyPeerHeader; payload: Uint8Array }) => void): () => void {
    this.on('frame', handler);
    const pending = this.backlog;
    this.backlog = [];
    for (const f of pending) handler(f);
    return () => this.off('frame', handler);
  }

  /** Next frame matching `pred`, from the backlog or the wire (rejects on close or timeout). */
  next(
    pred: (h: AnyPeerHeader) => boolean,
    timeoutMs = 15_000,
  ): Promise<{ header: AnyPeerHeader; payload: Uint8Array }> {
    const i = this.backlog.findIndex((f) => pred(f.header));
    if (i >= 0) return Promise.resolve(this.backlog.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const onFrame = (f: { header: AnyPeerHeader; payload: Uint8Array }) => {
        if (!pred(f.header)) return;
        cleanup();
        resolve(f);
      };
      const onClose = () => {
        cleanup();
        reject(new ConnectError('closed', 'peer closed the connection'));
      };
      const t = setTimeout(() => {
        cleanup();
        reject(new ConnectError('closed', 'timed out waiting for the peer'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(t);
        this.off('frame', onFrame);
        this.off('close', onClose);
      };
      this.on('frame', onFrame);
      this.on('close', onClose);
      if (this.closed) onClose();
    });
  }

  /** Tears the connection down immediately (shutdown). */
  destroy() {
    this.stream.destroy();
    this.onClosed();
  }

  close() {
    if (this.closed) return;
    this.stream.end();
    setTimeout(() => this.stream.destroy(), 200).unref();
    this.onClosed();
  }

  private onClosed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}
