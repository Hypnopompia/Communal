import { pino, type Logger } from 'pino';
import {
  checkTransferToken,
  deviceId,
  fromB64,
  userId,
  verifyCertChain,
  type KeyPair,
  type SignedToken,
} from '@communal/crypto';
import { newSessionId, type HubBody } from '@communal/protocol';
import type { HubManager } from '../hub-manager.js';
import type { NetworkCheck } from '../peer/netcheck.js';
import type { Revocations } from '../account.js';
import {
  ConnectError,
  type PeerChannel,
  type PeerTransport,
  type PunchStats,
} from '../peer/transport.js';

export type Offer = HubBody<'connect.offer'>;
/** The hub's verdict on a connection that couldn't be made directly (HANDOFF §8). */
export type Diagnosis = HubBody<'connect.failed'>;

/** No direct path to the peer, with the hub's diagnosis of why. */
export class PathError extends Error {
  constructor(
    readonly diagnosis: Diagnosis,
    message: string,
  ) {
    super(message);
  }
}

/** Failures worth diagnosing: nothing (or nothing usable) got through. */
const unreachable = (err: unknown): err is ConnectError =>
  err instanceof ConnectError && (err.reason === 'no_path' || err.reason === 'handshake_failed');

/** An incoming connection the uploader should serve, already authenticated. */
export interface InboundPeer {
  hub: string;
  offer: Offer;
  channel: PeerChannel;
}

/**
 * Client side of HANDOFF §8 brokering. Downloads ask a hub to broker (`open`); offers from
 * hubs become authenticated inbound channels for the uploader (`onInbound`). In both
 * directions the peer must prove the device key the hub named, and present a cert chain from
 * that device to the account root the hub named (and the root must match the user id), with
 * no device in it revoked: by the proofs the hub sent along, or by any we've seen before
 * (ADR 0014), so a hub that later leaves a revocation out can't bring the device back.
 */
export class PeerBroker {
  private readonly answers = new Map<string, (a: HubBody<'connect.answer'>) => void>();
  private inbound?: (p: InboundPeer) => void;
  private readonly log: Logger;

  constructor(
    private readonly hubs: HubManager,
    private readonly transport: PeerTransport,
    private readonly device: KeyPair,
    private readonly network: NetworkCheck,
    private readonly revocations: Revocations,
    log?: Logger,
  ) {
    this.log = log ?? pino({ name: 'broker' });
    hubs.on('event', ({ hub, msg }) => {
      if (msg.t === 'connect.answer') this.answers.get(msg.body.session_id)?.(msg.body);
      if (msg.t === 'connect.offer') void this.onOffer(hub, msg.body);
    });
  }

  get myDevice(): string {
    return deviceId(this.device.publicKey);
  }

  onInbound(cb: (p: InboundPeer) => void) {
    this.inbound = cb;
  }

  /**
   * Connects to `target` through `hub` to fetch `hash`. Resolves with the channel and token.
   * When no direct path comes up, rejects with a `PathError` carrying the hub's diagnosis.
   */
  async open(
    hub: string,
    target: string,
    hash: string,
    timeoutMs = 15_000,
  ): Promise<{ channel: PeerChannel; token: SignedToken }> {
    const client = this.hubs.get(hub);
    if (!client?.ready) throw new ConnectError('closed', 'hub is offline');
    const session = newSessionId();
    const localStreamId = this.transport.newStreamId();
    this.transport.expect(session);
    const answered = new Promise<HubBody<'connect.answer'>>((resolve, reject) => {
      const t = setTimeout(() => {
        this.answers.delete(session);
        reject(new ConnectError('no_path', 'the other device did not answer', NO_PUNCH));
      }, timeoutMs);
      this.answers.set(session, (a) => {
        clearTimeout(t);
        this.answers.delete(session);
        resolve(a);
      });
    });
    answered.catch(() => {}); // observed below; avoid an unhandled rejection if request() throws
    try {
      const reply = await client.request('connect.request', {
        target,
        hash,
        session_id: session,
        stream_id: localStreamId,
        candidates: this.transport.candidates(),
      });
      if (reply.t === 'connect.failed')
        throw new PathError(reply.body, `could not connect (${reply.body.cause})`);
      try {
        const answer = await answered;
        const channel = await this.transport.connect({
          session,
          localStreamId,
          remoteStreamId: answer.stream_id,
          candidates: answer.candidates,
          initiator: true,
          verifyPeer: (pk) =>
            deviceId(pk) === target &&
            this.chainOk(
              answer.to_root_pubkey,
              answer.to_user,
              pk,
              answer.to_chain,
              answer.to_revocations,
            ),
        });
        return { channel, token: answer.token };
      } catch (err) {
        if (!unreachable(err)) throw err;
        // Ask the hub what went wrong; it combines our view with the owner's.
        const diagnosis = await this.report(hub, session, err.stats);
        if (!diagnosis) throw err;
        throw new PathError(diagnosis, `could not connect (${diagnosis.cause})`);
      }
    } finally {
      this.answers.delete(session);
      this.transport.forget(session);
    }
  }

  /**
   * `open`, then `hello` with the token, and the uploader's verdict. `file` sessions fetch the
   * token's file; `preview` sessions ask for thumbnails and peeks (M6). Rejects when the
   * uploader is busy or refuses (with `denied (<reason>)`).
   */
  async session(
    hub: string,
    target: string,
    hash: string,
    opts: { purpose?: 'file' | 'preview'; answerTimeoutMs?: number } = {},
  ): Promise<PeerChannel> {
    const { channel, token } = await this.open(hub, target, hash, opts.answerTimeoutMs);
    await channel.send({
      t: 'hello',
      token,
      ...(opts.purpose === 'preview' ? { purpose: 'preview' as const } : {}),
    });
    const reply = await channel
      .next((h) => h.t === 'hello.ok' || h.t === 'denied' || h.t === 'busy', 10_000)
      .catch((err: Error) => {
        channel.close();
        throw err;
      });
    if (reply.header.t !== 'hello.ok') {
      channel.close();
      throw new Error(
        reply.header.t === 'busy'
          ? 'source busy'
          : `denied (${reply.header.t === 'denied' ? reply.header.reason : ''})`,
      );
    }
    return channel;
  }

  private async onOffer(hub: string, offer: Offer) {
    const hubKey = this.hubs.find(hub)?.state.hubPubkey;
    const client = this.hubs.get(hub);
    if (!hubKey || !client?.ready) return;
    // The offer must carry a valid token from this hub, for us, from the device it names.
    const check = checkTransferToken(offer.token, fromB64(hubKey), {
      self: this.myDevice,
      peer: offer.from,
    });
    if (!check.ok || offer.token.claims.session_id !== offer.session_id) {
      this.log.warn(
        { hub, reason: check.ok ? 'session mismatch' : check.reason },
        'ignoring bad connect offer',
      );
      return;
    }
    const localStreamId = this.transport.newStreamId();
    this.transport.expect(offer.session_id);
    try {
      await client.request('connect.answer', {
        session_id: offer.session_id,
        stream_id: localStreamId,
        candidates: this.transport.candidates(),
      });
      const channel = await this.transport.connect({
        session: offer.session_id,
        localStreamId,
        remoteStreamId: offer.stream_id,
        candidates: offer.candidates,
        initiator: false,
        verifyPeer: (pk) =>
          deviceId(pk) === offer.from &&
          this.chainOk(
            offer.from_root_pubkey,
            offer.from_user,
            pk,
            offer.from_chain,
            offer.from_revocations,
          ),
      });
      this.inbound?.({ hub, offer, channel });
    } catch (err) {
      this.log.info({ hub, err: (err as Error).message }, 'inbound connection failed');
      this.transport.forget(offer.session_id);
      // Our half of the picture, so the hub can tell the downloader what went wrong.
      if (unreachable(err)) await this.report(hub, offer.session_id, err.stats);
    }
  }

  private chainOk(
    rootB64: string,
    user: string,
    devicePk: Uint8Array,
    chain: Offer['from_chain'],
    proofs: Offer['from_revocations'],
  ): boolean {
    try {
      const root = fromB64(rootB64);
      if (userId(root) !== user) return false;
      const revoked = this.revocations.revokedFor(rootB64, proofs);
      const ok = verifyCertChain(root, devicePk, chain, revoked).ok;
      if (!ok) this.log.warn({ peer: deviceId(devicePk) }, 'peer cert chain refused');
      return ok;
    } catch {
      return false;
    }
  }

  /** Sends `connect.failed` with our observations; the downloader gets the diagnosis back. */
  private async report(
    hub: string,
    session: string,
    stats: PunchStats | undefined,
  ): Promise<Diagnosis | undefined> {
    const client = this.hubs.get(hub);
    if (!client?.ready) return undefined;
    try {
      const reply = await client.request('connect.failed', {
        session_id: session,
        observations: this.network.observations(hub, stats),
      });
      return reply.t === 'connect.failed' ? reply.body : undefined;
    } catch (err) {
      // Expected for the owner when the downloader's report already closed the session.
      this.log.debug({ hub, err: (err as Error).message }, 'connect.failed not accepted');
      return undefined;
    }
  }
}

const NO_PUNCH: PunchStats = { attempts: 0, udp_sent: false, udp_received: false };
