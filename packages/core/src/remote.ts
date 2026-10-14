import { randomBytes } from 'node:crypto';
import { pino, type Logger } from 'pino';
import {
  concatBytes,
  deviceId,
  fromB64,
  openSealed,
  sealTo,
  sign,
  toB64,
  userId,
  verify,
  verifyCertChain,
  type CertChain,
  type KeyPair,
} from '@communal/crypto';
import {
  REMOTE_MAX_BODY,
  REMOTE_SKEW_S,
  RemoteBody,
  RemoteRequest,
  type HubBody,
  type RemoteErrorCode,
  type RemoteReply,
} from '@communal/protocol';
import type { AccountIdentity, Revocations } from './account.js';
import { CoreError } from './errors.js';
import { HubError } from './hub-client.js';
import type { HubManager } from './hub-manager.js';

/** Another device of this account that remote requests can go to (ADR 0023). */
export interface RemoteDevice {
  device_id: string;
  name: string;
  platform: string;
  online: boolean;
}

/** A remote request failed on the other device, with its reason. */
export class RemoteError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface RemoteControlOptions {
  hubs: HubManager;
  device: KeyPair;
  account: () => AccountIdentity | undefined;
  revocations: Revocations;
  /** Whether this device takes requests from the account's other devices (off by default). */
  allowed: () => boolean;
  /** Runs an allowed request. `from` is the asking device's name, for the transfer list. */
  run: (req: RemoteRequest, from: { device_id: string; name: string }) => Promise<unknown>;
  timeoutMs?: number;
  log?: Logger;
}

interface Known {
  device: RemoteDevice;
  pubkey: Uint8Array;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });
const now = () => Math.floor(Date.now() / 1000);

/**
 * Remote control between devices of one account (ADR 0023): a phone asks one of your computers
 * to download something while you're away from it. Requests and replies go through any hub
 * both devices are on, as `device.message`s sealed to the receiver's key and signed inside the
 * seal by the sender. The receiver checks the sender's cert chain against its own account root
 * and revocations, the clock, and a nonce it hasn't seen, so the hub can neither read, forge
 * nor replay one. No file data ever travels this way.
 */
export class RemoteControl {
  private readonly log: Logger;
  private readonly known = new Map<string, Known>();
  private readonly pending = new Map<
    string,
    { target: string; resolve: (r: RemoteReply) => void; reject: (e: Error) => void }
  >();
  private readonly seen = new Map<string, number>();

  constructor(private readonly o: RemoteControlOptions) {
    this.log = o.log ?? pino({ name: 'remote' });
    o.hubs.on('event', ({ hub, msg }) => {
      if (msg.t === 'device.message') void this.onMessage(hub, msg.body);
    });
  }

  private get me(): string {
    return deviceId(this.o.device.publicKey);
  }

  /** The account's other devices, from every hub, with keys whose chains check out. */
  async devices(): Promise<RemoteDevice[]> {
    const a = this.o.account();
    if (!a) return [];
    const root = fromB64(a.root_pubkey);
    const revoked = this.o.revocations.revokedFor(a.root_pubkey);
    const out = new Map<string, RemoteDevice>();
    for (const r of await this.o.hubs.requestAll('device.list', {})) {
      if (!r.ok || r.msg.t !== 'device.listing') continue;
      for (const d of r.msg.body.devices) {
        if (d.device_id === this.me || d.revoked_at !== null || revoked.has(d.device_id)) continue;
        if (!d.pubkey || !d.chain) continue; // an older hub: no key to seal to
        const pk = fromB64(d.pubkey);
        if (deviceId(pk) !== d.device_id || !verifyCertChain(root, pk, d.chain, revoked).ok) {
          this.log.warn({ hub: r.hub, device_id: d.device_id }, 'hub listed a device we refuse');
          continue;
        }
        const prev = out.get(d.device_id);
        const device = {
          device_id: d.device_id,
          name: d.name,
          platform: d.platform,
          online: (prev?.online ?? false) || d.online,
        };
        out.set(d.device_id, device);
        this.known.set(d.device_id, { device, pubkey: pk });
      }
    }
    return [...out.values()];
  }

  /** Sends a request to another device of this account and waits for its answer. */
  async request(target: string, req: RemoteRequest): Promise<unknown> {
    // The receiver drops anything malformed without a word: refuse it here instead.
    const checked = RemoteRequest.safeParse(req);
    if (!checked.success) throw new CoreError('bad_request', 'that request is malformed');
    if (!this.known.has(target)) await this.devices();
    const k = this.known.get(target);
    if (!k) throw new CoreError('not_found', 'not one of your devices');
    const nonce = this.nonce();
    const answer = new Promise<RemoteReply>((resolve, reject) => {
      this.pending.set(nonce, { target, resolve, reject });
    });
    const timer = setTimeout(
      () =>
        this.pending
          .get(nonce)
          ?.reject(new CoreError('unavailable', `${k.device.name} didn't answer`)),
      this.o.timeoutMs ?? 15_000,
    );
    try {
      await this.send(undefined, target, k.pubkey, { nonce, request: req });
      const reply = await answer;
      if (!reply.ok) throw new RemoteError(reply.code, reply.message);
      return reply.result;
    } finally {
      clearTimeout(timer);
      this.pending.delete(nonce);
    }
  }

  /** Seals and sends one message, through `via` or else any hub that takes it. */
  private async send(
    via: string | undefined,
    target: string,
    pubkey: Uint8Array,
    fields: Pick<RemoteBody, 'nonce' | 're' | 'request' | 'reply'>,
  ) {
    const a = this.o.account();
    if (!a) throw new CoreError('not_found', 'this device has no account yet');
    const body: RemoteBody = {
      v: 1,
      from: this.me,
      from_pubkey: toB64(this.o.device.publicKey),
      chain: a.chain,
      to: target,
      ts: now(),
      ...fields,
    };
    const bytes = utf8.encode(JSON.stringify(body));
    if (bytes.length > REMOTE_MAX_BODY) throw new CoreError('bad_request', 'message too large');
    const sig = sign('communal/remote/v1', bytes, this.o.device.secretKey);
    const sealed = sealTo(pubkey, concatBytes(sig, bytes));
    const hubs = this.o.hubs.list().filter((h) => h.ready);
    const order = via ? [...hubs.filter((h) => h.id === via), ...hubs] : hubs;
    for (const h of order) {
      try {
        await this.o.hubs.get(h.id)!.request('device.message', { to: target, sealed });
        return;
      } catch (err) {
        if (!(err instanceof HubError)) throw err;
        // Not online on that hub (or an older hub): try the next one.
      }
    }
    throw new CoreError('unavailable', 'that device is not online on any hub you share');
  }

  private async onMessage(hub: string, m: HubBody<'device.message'>) {
    const body = this.open(m);
    if (!body) return;
    if (body.reply && body.re) {
      const p = this.pending.get(body.re);
      if (p && p.target === body.from) p.resolve(body.reply);
      return;
    }
    if (!body.request) return;
    const reply = await this.answer(body);
    try {
      await this.send(hub, body.from, fromB64(body.from_pubkey), {
        nonce: this.nonce(),
        re: body.nonce,
        reply,
      });
    } catch (err) {
      this.log.info({ hub, err: (err as Error).message }, 'could not answer a remote request');
    }
  }

  private async answer(body: RemoteBody): Promise<RemoteReply> {
    const req = body.request!;
    const allowed = this.o.allowed();
    // Hello is answered even while remote control is off, so the asker can say why.
    if (req.op === 'hello')
      return { ok: true, result: await this.o.run(req, { device_id: body.from, name: '' }) };
    if (!allowed)
      return { ok: false, code: 'not_allowed', message: 'remote control is off on that device' };
    // The asking device's name, for the transfer list: refreshed when it's new to us.
    if (this.known.get(body.from)?.device.platform === '') await this.devices().catch(() => []);
    const name = this.known.get(body.from)?.device.name ?? 'another device';
    try {
      const result = await this.o.run(req, { device_id: body.from, name });
      this.log.info({ from: body.from, op: req.op }, 'remote request done');
      return { ok: true, result: result ?? null };
    } catch (err) {
      const code: RemoteErrorCode =
        err instanceof CoreError
          ? err.code === 'forbidden' || err.code === 'conflict'
            ? 'failed'
            : err.code
          : 'failed';
      return { ok: false, code, message: (err as Error).message.slice(0, 1024) };
    }
  }

  /**
   * Opens a sealed message and checks everything about it, or returns undefined. The sender
   * must be the device the hub named, hold the key it signed with, and chain to our own
   * account root with nothing in the chain revoked; the message must be for us, recent, and
   * new.
   */
  private open(m: HubBody<'device.message'>): RemoteBody | undefined {
    const a = this.o.account();
    if (!a) return undefined;
    let body: RemoteBody;
    try {
      const raw = openSealed(this.o.device, m.sealed);
      const bytes = raw.subarray(64);
      const parsed = RemoteBody.safeParse(JSON.parse(fromUtf8.decode(bytes)));
      if (!parsed.success) return this.refuse(m.from, 'malformed');
      body = parsed.data;
      const pk = fromB64(body.from_pubkey);
      if (body.from !== m.from || deviceId(pk) !== m.from) return this.refuse(m.from, 'sender');
      if (!verify('communal/remote/v1', raw.subarray(0, 64), bytes, pk))
        return this.refuse(m.from, 'signature');
      if (!this.sameAccount(a, pk, body.chain)) return this.refuse(m.from, 'account');
    } catch {
      return this.refuse(m.from, 'unreadable');
    }
    if (body.to !== this.me) return this.refuse(m.from, 'recipient');
    if (Math.abs(now() - body.ts) > REMOTE_SKEW_S) return this.refuse(m.from, 'clock');
    if (!this.fresh(body.nonce)) return this.refuse(m.from, 'replay');
    // Learn the sender's key, so replies don't need a device listing first.
    if (!this.known.has(body.from))
      this.known.set(body.from, {
        device: { device_id: body.from, name: 'another device', platform: '', online: true },
        pubkey: fromB64(body.from_pubkey),
      });
    return body;
  }

  private sameAccount(a: AccountIdentity, pk: Uint8Array, chain: CertChain): boolean {
    const root = fromB64(a.root_pubkey);
    if (userId(root) !== a.user_id) return false;
    const revoked = this.o.revocations.revokedFor(a.root_pubkey);
    return verifyCertChain(root, pk, chain, revoked).ok;
  }

  private refuse(from: string, why: string): undefined {
    this.log.warn({ from, why }, 'refused a remote message');
    return undefined;
  }

  /** True the first time a nonce is seen within the clock window. */
  private fresh(nonce: string): boolean {
    const t = Date.now();
    for (const [n, at] of this.seen) if (t - at > 2 * REMOTE_SKEW_S * 1000) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, t);
    return true;
  }

  private nonce(): string {
    return toB64(randomBytes(16));
  }
}
