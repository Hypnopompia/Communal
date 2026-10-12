/**
 * Test helpers: an in-process hub on a random port and a raw protocol client that lets tests
 * send arbitrary (including malicious) frames.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import WebSocket from 'ws';
import { authPayload, fromB64, generateKeyPair, sign, toB64, type KeyPair } from '@communal/crypto';
import {
  encodeClient,
  parseHubMessage,
  type ClientBody,
  type ClientType,
  type HubMessage,
} from '@communal/protocol';
import { HubDb } from './db.js';
import { HubServer, type HubOptions } from './server.js';

export interface TestHub {
  hub: HubServer;
  db: HubDb;
  url: string;
  port: number;
  hubKey: KeyPair;
  dir: string;
  close(): Promise<void>;
}

export async function startTestHub(
  opts: Partial<HubOptions> & { port?: number; dir?: string; keepDir?: boolean } = {},
): Promise<TestHub> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'communal-hub-'));
  const db = opts.db ?? new HubDb(join(dir, 'hub.db'));
  const hubKey = opts.hubKey ?? generateKeyPair();
  const hub = new HubServer({
    hubId: 'test-hub',
    silenceMs: 2_000,
    authTimeoutMs: 2_000,
    log: pino({ level: process.env.HUB_TEST_LOG ?? 'silent' }),
    ...opts,
    db,
    hubKey,
  });
  const addr = await hub.listen(opts.port ?? 0, '127.0.0.1');
  const scheme = opts.tls ? 'wss' : 'ws';
  return {
    hub,
    db,
    hubKey,
    dir,
    port: addr.port,
    url: `${scheme}://127.0.0.1:${addr.port}/v1`,
    async close() {
      await hub.close();
      if (!opts.db) db.close();
      if (!opts.dir && !opts.keepDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Low-level client: you drive every frame yourself. */
export class RawClient {
  readonly ws: WebSocket;
  private readonly inbox: HubMessage[] = [];
  private waiters: { pred: (m: HubMessage) => boolean; resolve: (m: HubMessage) => void }[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(url: string) {
    this.ws = new WebSocket(url, { rejectUnauthorized: false });
    this.ws.on('message', (d) => {
      const r = parseHubMessage(d.toString());
      if (!r.ok) throw new Error(`hub sent invalid message: ${r.message}`);
      const i = this.waiters.findIndex((w) => w.pred(r.msg));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(r.msg);
      else this.inbox.push(r.msg);
    });
    this.closed = new Promise((resolve) =>
      this.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
  }

  static async connect(url: string): Promise<RawClient> {
    const c = new RawClient(url);
    await new Promise<void>((resolve, reject) => {
      c.ws.once('open', () => resolve());
      c.ws.once('error', reject);
    });
    return c;
  }

  /** Next message matching `pred` (or of type `t`), from the backlog or the wire. */
  next(pred: string | ((m: HubMessage) => boolean), timeoutMs = 2_000): Promise<HubMessage> {
    const p = typeof pred === 'string' ? (m: HubMessage) => m.t === pred : pred;
    const i = this.inbox.findIndex(p);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const w = { pred: p, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`timed out waiting for ${typeof pred === 'string' ? pred : 'message'}`));
      }, timeoutMs);
    });
  }

  /** Messages received but not yet consumed. */
  backlog(): HubMessage[] {
    return [...this.inbox];
  }

  send<T extends ClientType>(t: T, body: ClientBody<T>): string {
    const raw = encodeClient(t, body);
    this.ws.send(raw);
    return (JSON.parse(raw) as { id: string }).id;
  }

  async request<T extends ClientType>(t: T, body: ClientBody<T>): Promise<HubMessage> {
    const id = this.send(t, body);
    return this.next((m) => m.re === id);
  }

  /** Pings every `ms` so short test silence windows don't drop this client. */
  keepAlive(ms = 200): () => void {
    const timer = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.send('ping', {});
    }, ms);
    this.ws.once('close', () => clearInterval(timer));
    return () => clearInterval(timer);
  }

  close() {
    this.ws.terminate();
  }
}

export function signChallenge(challenge: HubMessage, key: KeyPair): string {
  if (challenge.t !== 'challenge') throw new Error('not a challenge');
  return toB64(
    sign(
      'communal/auth/v1',
      authPayload(fromB64(challenge.body.nonce), challenge.body.hub_id),
      key.secretKey,
    ),
  );
}

const client = { name: 'test', version: '0' };

/** Creates an account over a fresh connection and returns a signed-in raw client. */
export async function signUp(
  url: string,
  displayName: string,
  key: KeyPair = generateKeyPair(),
): Promise<{ c: RawClient; key: KeyPair; userId: string; deviceId: string }> {
  const c = await RawClient.connect(url);
  const ch = await c.next('challenge');
  const sig = signChallenge(ch, key);
  const created = await c.request('account.create', {
    display_name: displayName,
    device_name: `${displayName}-laptop`,
    device_pubkey: toB64(key.publicKey),
    platform: 'linux',
    client,
    sig,
  });
  if (created.t !== 'account.created')
    throw new Error(`account.create failed: ${JSON.stringify(created.body)}`);
  const welcome = await c.request('auth', { device_id: created.body.device_id, sig, client });
  if (welcome.t !== 'welcome') throw new Error(`auth failed: ${JSON.stringify(welcome.body)}`);
  return { c, key, userId: created.body.user_id, deviceId: created.body.device_id };
}

/** Signs an existing device in over a fresh connection. */
export async function signIn(
  url: string,
  key: KeyPair,
  deviceId: string,
): Promise<{ c: RawClient; reply: HubMessage }> {
  const c = await RawClient.connect(url);
  const ch = await c.next('challenge');
  const reply = await c.request('auth', {
    device_id: deviceId,
    sig: signChallenge(ch, key),
    client,
  });
  return { c, reply };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
