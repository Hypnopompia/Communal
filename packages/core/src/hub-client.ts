import { EventEmitter } from 'node:events';
import { pino, type Logger } from 'pino';
import WebSocket from 'ws';
import {
  authPayload,
  fromB64,
  sign,
  toB64,
  deviceId as toDeviceId,
  type KeyPair,
} from '@communal/crypto';
import {
  encodeClient,
  parseHubMessage,
  type ClientBody,
  type ClientType,
  type HubBody,
  type HubMessage,
} from '@communal/protocol';

/** What the client persists about its relationship with one hub. */
export interface HubClientState {
  /** Hub key pinned on first contact; any later mismatch is fatal (HANDOFF §4). */
  hubPubkey?: string;
  registered: boolean;
  userId?: string;
  deviceId?: string;
  fingerprint?: string;
}

export interface HubClientOptions {
  url: string;
  device: KeyPair;
  state: HubClientState;
  saveState: (s: HubClientState) => void | Promise<void>;
  /** Creates an account on first connect when the device isn't registered yet. */
  createAccount?: Omit<ClientBody<'account.create'>, 'device_pubkey' | 'sig' | 'client'>;
  client?: { name: string; version: string };
  /** Dev only: accept the hub's self-signed certificate. Hub-key pinning still applies. */
  insecureTls?: boolean;
  pingIntervalMs?: number;
  silenceMs?: number;
  backoff?: { initialMs: number; maxMs: number };
  requestTimeoutMs?: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
  log?: Logger;
}

export class HubError extends Error {
  constructor(
    readonly code: HubBody<'error'>['code'],
    message: string,
  ) {
    super(message);
  }
}

/** Fatal conditions stop the client; reconnecting can't fix them. */
export class HubFatalError extends Error {
  constructor(
    readonly reason: 'hub_key_mismatch' | 'not_registered' | 'rejected',
    message: string,
  ) {
    super(message);
  }
}

export interface HubClientEvents {
  ready: [HubBody<'welcome'>];
  presence: [HubBody<'presence'>];
  /** Every unsolicited hub message (presence included). */
  event: [HubMessage];
  account_created: [HubBody<'account.created'>];
  pending_approval: [];
  disconnected: [{ code: number; reason: string }];
  reconnecting: [{ attempt: number; delayMs: number }];
  fatal: [HubFatalError];
}

interface Pending {
  resolve: (m: HubMessage) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

type Phase = 'idle' | 'connecting' | 'signing_in' | 'ready' | 'stopped';

/**
 * One device's session with one hub: challenge/auth (creating the account the first time),
 * keepalive pings, silence detection, and reconnect with jittered exponential backoff.
 */
export class HubClient extends EventEmitter<HubClientEvents> {
  private readonly o: Required<Omit<HubClientOptions, 'createAccount' | 'log'>> & HubClientOptions;
  private readonly log: Logger;
  private ws?: WebSocket;
  private phase: Phase = 'idle';
  private attempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private lastHeard = 0;
  private readonly pending = new Map<string, Pending>();
  private welcome?: HubBody<'welcome'>;

  constructor(opts: HubClientOptions) {
    super();
    this.o = {
      client: { name: 'communal-core', version: '0.0.0' },
      insecureTls: false,
      pingIntervalMs: 30_000,
      silenceMs: 90_000,
      backoff: { initialMs: 1_000, maxMs: 60_000 },
      requestTimeoutMs: 15_000,
      random: Math.random,
      ...opts,
    };
    this.log = (opts.log ?? pino({ name: 'hub-client' })).child({
      device_id: toDeviceId(opts.device.publicKey),
    });
  }

  get state(): HubClientState {
    return this.o.state;
  }

  get ready(): boolean {
    return this.phase === 'ready';
  }

  get session(): HubBody<'welcome'> | undefined {
    return this.phase === 'ready' ? this.welcome : undefined;
  }

  start() {
    if (this.phase !== 'idle') return;
    this.connect();
  }

  async stop(): Promise<void> {
    this.phase = 'stopped';
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close(1000, 'client stopping');
      setTimeout(() => {
        ws.terminate();
        resolve();
      }, 1000).unref();
    });
  }

  /** Resolves on the next `ready` (immediately if already signed in). */
  waitReady(timeoutMs = 30_000): Promise<HubBody<'welcome'>> {
    if (this.phase === 'ready' && this.welcome) return Promise.resolve(this.welcome);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for hub'));
      }, timeoutMs);
      const onReady = (w: HubBody<'welcome'>) => {
        cleanup();
        resolve(w);
      };
      const onFatal = (e: HubFatalError) => {
        cleanup();
        reject(e);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('ready', onReady);
        this.off('fatal', onFatal);
      };
      this.on('ready', onReady);
      this.on('fatal', onFatal);
    });
  }

  /** Sends a request on a signed-in session and resolves with the reply (rejects on `error`). */
  request<T extends ClientType>(t: T, body: ClientBody<T>): Promise<HubMessage> {
    if (this.phase !== 'ready')
      return Promise.reject(new HubError('unauthenticated', 'not connected to hub'));
    return this.rawRequest(t, body);
  }

  // ── connection lifecycle ──────────────────────────────────────────────────

  private connect() {
    this.phase = 'connecting';
    const ws = new WebSocket(this.o.url, {
      rejectUnauthorized: !this.o.insecureTls,
      maxPayload: 16 * 1024 * 1024,
      handshakeTimeout: 10_000,
    });
    this.ws = ws;
    this.lastHeard = Date.now();
    ws.on('message', (data, isBinary) => {
      if (ws !== this.ws || isBinary) return;
      this.lastHeard = Date.now();
      this.onMessage(data.toString());
    });
    ws.on('close', (code, reason) => {
      if (ws === this.ws) this.onClose(code, reason.toString());
    });
    ws.on('error', (err) => this.log.debug({ err: err.message }, 'socket error'));
  }

  private onClose(code: number, reason: string) {
    clearInterval(this.pingTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new HubError('internal', 'connection closed'));
    }
    this.pending.clear();
    const wasReady = this.phase === 'ready';
    this.welcome = undefined;
    if (wasReady) this.log.info({ code, reason }, 'disconnected from hub');
    this.emit('disconnected', { code, reason });
    if (this.phase === 'stopped') return;
    this.phase = 'idle';
    this.scheduleReconnect();
  }

  /** Delay in [base/2, base], base = min(max, initial·2^attempt): 1 s → 60 s with jitter. */
  backoffDelay(attempt: number): number {
    const { initialMs, maxMs } = this.o.backoff;
    const base = Math.min(maxMs, initialMs * 2 ** attempt);
    return Math.round(base / 2 + this.o.random() * (base / 2));
  }

  private scheduleReconnect() {
    const delayMs = this.backoffDelay(this.attempt);
    this.attempt++;
    this.emit('reconnecting', { attempt: this.attempt, delayMs });
    this.log.debug({ attempt: this.attempt, delay_ms: delayMs }, 'reconnecting');
    this.reconnectTimer = setTimeout(() => {
      if (this.phase === 'idle') this.connect();
    }, delayMs);
  }

  private fatal(err: HubFatalError) {
    this.log.error({ reason: err.reason }, err.message);
    this.phase = 'stopped';
    this.ws?.close(1000, err.reason);
    this.emit('fatal', err);
  }

  private startKeepalive() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastHeard > this.o.silenceMs) {
        this.log.warn('hub silent too long; reconnecting');
        this.ws?.terminate();
        return;
      }
      this.send('ping', {});
    }, this.o.pingIntervalMs);
  }

  // ── messages ──────────────────────────────────────────────────────────────

  private send<T extends ClientType>(t: T, body: ClientBody<T>, id?: string): string {
    const raw = encodeClient(t, body, id ? { id } : {});
    this.ws?.send(raw);
    return (JSON.parse(raw) as { id: string }).id;
  }

  private rawRequest<T extends ClientType>(t: T, body: ClientBody<T>): Promise<HubMessage> {
    return new Promise((resolve, reject) => {
      const id = this.send(t, body);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HubError('internal', `${t} timed out`));
      }, this.o.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private onMessage(raw: string) {
    const res = parseHubMessage(raw);
    if (!res.ok) {
      this.log.warn({ code: res.code, message: res.message }, 'bad message from hub');
      return;
    }
    const msg = res.msg;
    if (msg.re) {
      const p = this.pending.get(msg.re);
      if (p) {
        this.pending.delete(msg.re);
        clearTimeout(p.timer);
        if (msg.t === 'error') p.reject(new HubError(msg.body.code, msg.body.message));
        else p.resolve(msg);
        return;
      }
    }
    switch (msg.t) {
      case 'challenge':
        void this.signIn(msg.body);
        return;
      case 'ping':
        this.send('pong', {});
        return;
      case 'pong':
        return;
      case 'presence':
        this.emit('presence', msg.body);
        break;
      case 'error':
        this.log.warn({ code: msg.body.code }, msg.body.message);
        return;
    }
    this.emit('event', msg);
  }

  private async signIn(ch: HubBody<'challenge'>) {
    if (this.phase !== 'connecting') return;
    this.phase = 'signing_in';
    const st = this.o.state;
    if (st.hubPubkey && st.hubPubkey !== ch.hub_pubkey) {
      return this.fatal(
        new HubFatalError(
          'hub_key_mismatch',
          'the hub presented a different key than the one pinned on first contact',
        ),
      );
    }
    if (!st.hubPubkey) await this.save({ hubPubkey: ch.hub_pubkey });

    const sig = toB64(
      sign('communal/auth/v1', authPayload(fromB64(ch.nonce), ch.hub_id), this.o.device.secretKey),
    );
    try {
      if (!st.registered) {
        if (!this.o.createAccount) {
          return this.fatal(
            new HubFatalError('not_registered', 'this device has no account on the hub'),
          );
        }
        const created = (await this.rawRequest('account.create', {
          ...this.o.createAccount,
          device_pubkey: toB64(this.o.device.publicKey),
          client: this.o.client,
          sig,
        })) as Extract<HubMessage, { t: 'account.created' }>;
        await this.save({
          registered: true,
          userId: created.body.user_id,
          deviceId: created.body.device_id,
          fingerprint: created.body.fingerprint,
        });
        this.emit('account_created', created.body);
      }
      const welcome = (await this.rawRequest('auth', {
        device_id: toDeviceId(this.o.device.publicKey),
        sig,
        client: this.o.client,
      })) as Extract<HubMessage, { t: 'welcome' }>;
      this.welcome = welcome.body;
      this.phase = 'ready';
      this.attempt = 0;
      this.startKeepalive();
      this.log.info({ session: welcome.body.session }, 'signed in to hub');
      this.emit('ready', welcome.body);
    } catch (err) {
      // stop() may have run while we awaited; TS can't see that across the await.
      if ((this.phase as Phase) === 'stopped') return;
      if (err instanceof HubError && err.code === 'pending_approval') {
        this.emit('pending_approval');
        this.ws?.close(1000, 'pending approval');
      } else if (err instanceof HubError && err.code === 'forbidden') {
        this.fatal(new HubFatalError('rejected', `hub rejected sign-in: ${err.message}`));
      } else {
        this.log.warn({ err: (err as Error).message }, 'sign-in failed');
        this.ws?.close(1000, 'sign-in failed');
      }
    }
  }

  private async save(patch: Partial<HubClientState>) {
    Object.assign(this.o.state, patch);
    await this.o.saveState(this.o.state);
  }
}
