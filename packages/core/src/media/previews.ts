import { pino, type Logger } from 'pino';
import type { AnyPeerHeader } from '@communal/protocol';
import type { PeerBroker } from '../transfer/broker.js';
import type { ThumbSize } from './analyze.js';
import type { ThumbCache } from './thumbs.js';

const HASH = /^[0-9a-f]{64}$/;
/** `thumb.get` carries at most this many hashes (protocol limit). */
const BATCH = 1000;

/**
 * The viewer's side of thumbnails and peeks (HANDOFF §7, §9). Thumbnails come from the cache
 * when we have them; the rest of a folder's worth is fetched from the owner's device over one
 * `preview` session with one `thumb.get` per 1,000 hashes, and cached by hash.
 */
export class Previews {
  private readonly log: Logger;
  /** Fetches in flight, so the same thumbnail isn't asked for twice at once. */
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly o: {
      broker: PeerBroker;
      cache: ThumbCache;
      answerTimeoutMs?: number;
      log?: Logger;
    },
  ) {
    this.log = o.log ?? pino({ name: 'previews' });
  }

  /**
   * Makes sure the cache holds `hashes`' thumbnails, fetching what's missing from `device`
   * (brokered by `hub`). Resolves with which hashes have a thumbnail.
   */
  async fetch(
    hub: string,
    device: string,
    hashes: string[],
    size: ThumbSize,
  ): Promise<Record<string, boolean>> {
    const wanted = [...new Set(hashes)].filter((h) => HASH.test(h));
    const out: Record<string, boolean> = {};
    const missing: string[] = [];
    const waits: Promise<void>[] = [];
    for (const h of wanted) {
      if (this.o.cache.has(h, size)) out[h] = true;
      else {
        const p = this.inflight.get(`${h}-${size}`);
        if (p) waits.push(p.then((ok) => void (out[h] = ok)));
        else missing.push(h);
      }
    }
    if (missing.length > 0) {
      const got = this.fromPeer(hub, device, missing, size);
      for (const h of missing) {
        const p = got.then((m) => m.get(h) === true);
        this.inflight.set(`${h}-${size}`, p);
        waits.push(p.then((ok) => void (out[h] = ok)));
        void p.finally(() => this.inflight.delete(`${h}-${size}`));
      }
    }
    await Promise.all(waits);
    return out;
  }

  /** One preview session to `device`; every hash asked in batches of 1,000. */
  private async fromPeer(
    hub: string,
    device: string,
    hashes: string[],
    size: ThumbSize,
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    let ch;
    try {
      ch = await this.o.broker.session(hub, device, hashes[0]!, {
        purpose: 'preview',
        answerTimeoutMs: this.o.answerTimeoutMs,
      });
    } catch (err) {
      this.log.info({ device, err: (err as Error).message }, 'no preview session');
      return result;
    }
    const channel = ch;
    try {
      for (let i = 0; i < hashes.length; i += BATCH) {
        const batch = hashes.slice(i, i + BATCH);
        const left = new Set(batch);
        const saves: Promise<void>[] = [];
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            unsubscribe();
            channel.off('close', done);
            resolve();
          };
          // Generous: the owner may render thumbnails it hasn't cached yet.
          const timer = setTimeout(done, 30_000 + batch.length * 50);
          const unsubscribe = channel.subscribe(
            ({ header, payload }: { header: AnyPeerHeader; payload: Uint8Array }) => {
              if (header.t !== 'thumb' && header.t !== 'thumb.none') return;
              if (!left.delete(header.hash)) return;
              if (header.t === 'thumb') {
                saves.push(
                  this.o.cache.put(header.hash, size, payload).then((ok) => {
                    result.set(header.hash, ok);
                  }),
                );
              } else result.set(header.hash, false);
              if (left.size === 0) done();
            },
          );
          channel.once('close', done);
          void channel.send({ t: 'thumb.get', hashes: batch, size }).catch(done);
        });
        await Promise.all(saves);
        if (channel.isClosed) break;
      }
    } finally {
      channel.close();
    }
    return result;
  }

  /** The first 64 KB of a text or code file on `device`, or null if there's nothing to show. */
  async peek(
    hub: string,
    device: string,
    hash: string,
  ): Promise<{ data: Buffer; truncated: boolean } | null> {
    if (!HASH.test(hash)) return null;
    const ch = await this.o.broker.session(hub, device, hash, {
      purpose: 'preview',
      answerTimeoutMs: this.o.answerTimeoutMs,
    });
    try {
      await ch.send({ t: 'peek', hash });
      const { header, payload } = await ch.next(
        (h) => (h.t === 'peek.data' || h.t === 'peek.none') && h.hash === hash,
        15_000,
      );
      return header.t === 'peek.data'
        ? { data: Buffer.from(payload), truncated: header.truncated }
        : null;
    } finally {
      ch.close();
    }
  }
}
