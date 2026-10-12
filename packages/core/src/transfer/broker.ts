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
import { ConnectError, type PeerChannel, type PeerTransport } from '../peer/transport.js';

export type Offer = HubBody<'connect.offer'>;

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
 * that device to the account root the hub named (and the root must match the user id).
 */
export class PeerBroker {
  private readonly answers = new Map<string, (a: HubBody<'connect.answer'>) => void>();
  private inbound?: (p: InboundPeer) => void;
  private readonly log: Logger;

  constructor(
    private readonly hubs: HubManager,
    private readonly transport: PeerTransport,
    private readonly device: KeyPair,
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

  /** Connects to `target` through `hub` to fetch `hash`. Resolves with the channel and token. */
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
        reject(new ConnectError('no_path', 'the other device did not answer'));
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
        throw new ConnectError('closed', `owner unavailable (${reply.body.cause})`);
      const answer = await answered;
      const channel = await this.transport.connect({
        session,
        localStreamId,
        remoteStreamId: answer.stream_id,
        candidates: answer.candidates,
        initiator: true,
        verifyPeer: (pk) =>
          deviceId(pk) === target &&
          chainOk(answer.to_root_pubkey, answer.to_user, pk, answer.to_chain),
      });
      return { channel, token: answer.token };
    } finally {
      this.answers.delete(session);
      this.transport.forget(session);
    }
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
          chainOk(offer.from_root_pubkey, offer.from_user, pk, offer.from_chain),
      });
      this.inbound?.({ hub, offer, channel });
    } catch (err) {
      this.log.info({ hub, err: (err as Error).message }, 'inbound connection failed');
      this.transport.forget(offer.session_id);
    }
  }
}

function chainOk(
  rootB64: string,
  user: string,
  devicePk: Uint8Array,
  chain: Offer['from_chain'],
): boolean {
  try {
    const root = fromB64(rootB64);
    // M8 adds the account's revocation list here.
    return userId(root) === user && verifyCertChain(root, devicePk, chain).ok;
  } catch {
    return false;
  }
}
