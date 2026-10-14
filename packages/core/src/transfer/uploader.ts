import { open, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pino, type Logger } from 'pino';
import { checkTransferToken, fromB64 } from '@communal/crypto';
import { CHUNK_SIZE, type AnyPeerHeader, type PeerHeader } from '@communal/protocol';
import type { HubManager } from '../hub-manager.js';
import type { IndexStore } from '../index/store.js';
import type { PeerChannel } from '../peer/transport.js';
import type { AccessOracle } from './access.js';
import type { InboundPeer } from './broker.js';
import type { MediaWorker } from '../media/worker.js';
import { analysable } from '../media/analyze.js';

/** First bytes of a text or code file a peer may peek at (HANDOFF §7). */
export const PEEK_BYTES = 64 * 1024;
/** Preview sessions are cheap but not free: cap them separately from downloads. */
const MAX_PREVIEW_SESSIONS = 8;
/** A preview session with no request for this long is closed. */
const PREVIEW_IDLE_MS = 60_000;

export interface UploadLimits {
  /** Simultaneous upload sessions (HANDOFF §7 default 3); extra requests get `busy`. */
  maxConcurrent: number;
  /** Total upload rate in bytes/second across sessions (0 = unlimited). */
  bytesPerSecond: number;
  /** Only serve peers on the local network. */
  lanOnly: boolean;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxConcurrent: 3,
  bytesPerSecond: 0,
  lanOnly: false,
};

/** Test-only fault injection. Never set in production code paths. */
export interface UploaderTestHooks {
  corruptChunk?: (hash: string, index: number) => boolean;
  /** Called for each `thumb.get` frame received, with how many hashes it asked for. */
  thumbRequest?: (hashes: number) => void;
}

/** Simple token bucket shared by all uploads. */
class RateLimiter {
  private tokens = 0;
  private last = Date.now();
  constructor(private readonly perSecond: () => number) {}
  async take(n: number) {
    for (;;) {
      const rate = this.perSecond();
      if (rate <= 0) return;
      const now = Date.now();
      this.tokens = Math.min(rate, this.tokens + ((now - this.last) / 1000) * rate);
      this.last = now;
      if (this.tokens >= n || this.tokens >= rate) {
        this.tokens -= n;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.min(1000, ((n - this.tokens) / rate) * 1000)));
    }
  }
}

/**
 * Serves files to authenticated peers (HANDOFF §7). Before sending any byte it checks, in
 * order: the hello token (hub signature with the pinned key of the hub that brokered the
 * connection, expiry, addressed to us, from the authenticated peer, matching the offer),
 * LAN-only, concurrency, and this device's own access rules for that hub. Every session is
 * written to the local upload log.
 */
export class Uploader {
  private active = 0;
  private previews = 0;
  private readonly limiter: RateLimiter;
  private readonly log: Logger;

  constructor(
    private readonly o: {
      store: IndexStore;
      hubs: HubManager;
      access: AccessOracle;
      media: MediaWorker;
      myDevice: string;
      limits: () => UploadLimits;
      testHooks?: UploaderTestHooks;
      log?: Logger;
    },
  ) {
    this.log = o.log ?? pino({ name: 'uploader' });
    this.limiter = new RateLimiter(() => o.limits().bytesPerSecond);
  }

  get activeUploads(): number {
    return this.active;
  }

  async serve({ hub, offer, channel }: InboundPeer): Promise<void> {
    const deny = async (reason: PeerHeader<'denied'>['reason']) => {
      await channel.send({ t: 'denied', reason }).catch(() => {});
      channel.close();
    };
    let hello;
    try {
      hello = await channel.next((h) => h.t === 'hello', 10_000);
    } catch {
      return channel.close();
    }
    const token = (hello.header as PeerHeader<'hello'>).token;
    const hubKey = this.o.hubs.find(hub)?.state.hubPubkey;
    if (!hubKey) return deny('bad_token');
    const check = checkTransferToken(token, fromB64(hubKey), {
      self: this.o.myDevice,
      peer: offer.from,
    });
    if (!check.ok)
      return deny(
        check.reason === 'expired'
          ? 'expired'
          : check.reason === 'bad_signature'
            ? 'bad_token'
            : check.reason,
      );
    // The token must be the one the hub issued for this very session.
    if (token.sig !== offer.token.sig || token.claims.session_id !== offer.session_id)
      return deny('bad_token');

    const limits = this.o.limits();
    if (limits.lanOnly && !channel.isLan) return deny('lan_only');
    if ((hello.header as PeerHeader<'hello'>).purpose === 'preview')
      return this.servePreview({ hub, offer, channel });
    const hash = token.claims.hash;
    const logBase = {
      hub,
      requester_user: offer.from_user,
      requester_dev: offer.from,
      hash,
      kind: 'file' as const,
    };

    // Pick a local copy this requester may have, under this hub's rules.
    let copy;
    for (const c of this.o.store.copiesOf(hash, hub)) {
      if (
        await this.o.access.allows(hub, offer.from_user, `${c.share}/${c.rel}`).catch(() => false)
      ) {
        copy = c;
        break;
      }
    }
    if (!copy) {
      this.o.store.logUpload({ ...logBase, path: '', bytes: 0, status: 'denied' });
      // Same refusal whether the file is missing or forbidden: don't confirm it exists.
      return deny('forbidden');
    }
    const path = `${copy.share}/${copy.rel}`;
    const abs = join(copy.root, ...copy.rel.split('/'));
    const st = await stat(abs).catch(() => null);
    if (!st || st.size !== copy.size || Math.floor(st.mtimeMs) !== copy.mtime)
      return deny('not_found');

    if (this.active >= limits.maxConcurrent) {
      await channel.send({ t: 'busy', retry_after_s: 10 }).catch(() => {});
      return channel.close();
    }
    this.active++;
    const sent = new Set<number>();
    const requested = new Set<number>();
    let bytes = 0;
    let cancelled = false;
    let fh: FileHandle | undefined;
    try {
      fh = await open(abs, 'r');
      await channel.send({ t: 'hello.ok' });
      await this.loop(
        channel,
        hash,
        copy.chunkHashes,
        copy.size,
        fh,
        requested,
        (i, n) => {
          sent.add(i);
          bytes += n;
        },
        () => (cancelled = true),
      );
    } catch (err) {
      this.log.debug({ hub, err: (err as Error).message }, 'upload ended');
    } finally {
      this.active--;
      await fh?.close();
      const link = channel.linkStats();
      channel.close();
      // "Sent" means handed to the stream. Completed = every chunk the peer asked us for went out
      // and the peer then closed cleanly: a resumed or multi-source download asks each uploader
      // for only part of the file, and a crashed downloader never closes cleanly.
      const status =
        channel.endedByPeer && requested.size > 0 && [...requested].every((i) => sent.has(i))
          ? 'completed'
          : cancelled
            ? 'cancelled'
            : bytes > 0
              ? 'partial'
              : 'cancelled';
      this.o.store.logUpload({ ...logBase, path, bytes, status });
      this.log.info({ hub, peer: offer.from, bytes, status, link }, 'upload finished');
    }
  }

  /**
   * Thumbnails and peeks (HANDOFF §7 `thumb.get`, `peek`). The token only got the peer this far;
   * every hash asked for is checked against this device's own rules for the brokering hub. A
   * refused hash looks exactly like one with no thumbnail, so nothing is confirmed to exist.
   */
  private async servePreview({ hub, offer, channel }: InboundPeer): Promise<void> {
    if (this.previews >= MAX_PREVIEW_SESSIONS) {
      await channel.send({ t: 'busy', retry_after_s: 5 }).catch(() => {});
      return channel.close();
    }
    this.previews++;
    const user = offer.from_user;
    const allowed = new Map<string, Awaited<ReturnType<typeof this.allowedCopy>>>();
    const copyFor = async (hash: string) => {
      if (!allowed.has(hash)) allowed.set(hash, await this.allowedCopy(hub, user, hash));
      return allowed.get(hash);
    };
    const base = { hub, requester_user: user, requester_dev: offer.from };
    let thumbBytes = 0;
    let served = 0;
    let refused = 0;
    let folder: string | undefined;

    const queue: AnyPeerHeader[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = channel.subscribe(({ header }) => {
      if (header.t === 'thumb.get' || header.t === 'peek') {
        queue.push(header);
        wake?.();
      }
    });
    channel.once('close', () => wake?.());
    try {
      await channel.send({ t: 'hello.ok' });
      while (!channel.isClosed) {
        const h = queue.shift();
        if (!h) {
          const idle = await new Promise<boolean>((r) => {
            const t = setTimeout(() => r(true), PREVIEW_IDLE_MS);
            wake = () => {
              clearTimeout(t);
              r(false);
            };
          });
          wake = undefined;
          if (idle) break;
          continue;
        }
        if (h.t === 'thumb.get') {
          this.o.testHooks?.thumbRequest?.(h.hashes.length);
          for (const hash of new Set(h.hashes)) {
            const c = await copyFor(hash);
            const data =
              c && analysable(c.kind, c.mime) ? await this.o.media.thumbnail(hash, h.size) : null;
            if (!data) {
              if (!c) refused++;
              await channel.send({ t: 'thumb.none', hash });
              continue;
            }
            await this.limiter.take(data.length);
            await channel.send({ t: 'thumb', hash, mime: 'image/webp' }, data);
            thumbBytes += data.length;
            served++;
            folder ??= `${c!.share}/${c!.rel}`.replace(/[^/]*$/, '');
          }
        } else if (h.t === 'peek') {
          const c = await copyFor(h.hash);
          const data = c && (c.kind === 'text' || c.kind === 'code') ? await this.head(c) : null;
          if (!data) {
            await channel.send({ t: 'peek.none', hash: h.hash });
            continue;
          }
          await this.limiter.take(data.length);
          await channel.send(
            { t: 'peek.data', hash: h.hash, truncated: c!.size > PEEK_BYTES },
            data,
          );
          this.o.store.logUpload({
            ...base,
            hash: h.hash,
            path: `${c!.share}/${c!.rel}`,
            bytes: data.length,
            status: data.length >= c!.size ? 'completed' : 'partial',
            kind: 'file',
          });
        }
      }
    } catch (err) {
      this.log.debug({ hub, err: (err as Error).message }, 'preview session ended');
    } finally {
      unsubscribe();
      this.previews--;
      channel.close();
      // One row per thumbnail batch (HANDOFF §7 upload log: "kind (file/thumbnail batch)").
      if (served > 0 || refused > 0) {
        this.o.store.logUpload({
          ...base,
          hash: '',
          path: folder ?? '',
          bytes: thumbBytes,
          status: served > 0 ? 'completed' : 'denied',
          kind: 'thumbnail',
        });
      }
    }
  }

  /** A local copy of `hash` this requester may see through `hub`, or undefined. */
  private async allowedCopy(hub: string, user: string, hash: string) {
    for (const c of this.o.store.anyCopy(hash)) {
      if (!c.hubs.includes(hub)) continue;
      if (await this.o.access.allows(hub, user, `${c.share}/${c.rel}`).catch(() => false)) return c;
    }
    return undefined;
  }

  /** The first PEEK_BYTES of an unchanged local file, or null. */
  private async head(c: { root: string; rel: string; size: number; mtime: number }) {
    const abs = join(c.root, ...c.rel.split('/'));
    const st = await stat(abs).catch(() => null);
    if (!st || st.size !== c.size || Math.floor(st.mtimeMs) !== c.mtime) return null;
    const fh = await open(abs, 'r').catch(() => null);
    if (!fh) return null;
    try {
      const buf = Buffer.alloc(Math.min(PEEK_BYTES, c.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  private async loop(
    ch: PeerChannel,
    hash: string,
    chunkHashes: Buffer,
    size: number,
    fh: FileHandle,
    requested: Set<number>,
    onSent: (index: number, bytes: number) => void,
    onCancel: () => void,
  ) {
    const chunks = Math.ceil(size / CHUNK_SIZE);
    const queue: number[] = [];
    let skip = new Set<number>();
    let wake: (() => void) | undefined;
    let closed = false;
    const onFrame = ({ header: h }: { header: AnyPeerHeader }) => {
      if (h.t === 'manifest.get' && h.hash === hash) {
        void ch
          .send({
            t: 'manifest',
            hash,
            size,
            chunk_size: CHUNK_SIZE,
            chunk_hashes: new Uint8Array(chunkHashes),
          })
          .catch(() => {});
      } else if (h.t === 'get' && h.hash === hash) {
        for (const [a, b] of h.ranges) {
          for (let i = a; i < Math.min(b, chunks); i++) {
            queue.push(i);
            requested.add(i);
          }
        }
        skip = new Set([...skip].filter((i) => !queue.includes(i)));
      } else if (h.t === 'cancel' && h.hash === hash) {
        for (const [a, b] of h.ranges) for (let i = a; i < b; i++) skip.add(i);
        onCancel();
      }
      wake?.();
    };
    const unsubscribe = ch.subscribe(onFrame);
    ch.once('close', () => {
      closed = true;
      wake?.();
    });
    const buf = Buffer.allocUnsafe(CHUNK_SIZE);
    try {
      while (!closed) {
        const i = queue.shift();
        if (i === undefined) {
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
          continue;
        }
        if (skip.has(i)) continue;
        const len = Math.min(CHUNK_SIZE, size - i * CHUNK_SIZE);
        await this.limiter.take(len);
        const { bytesRead } = await fh.read(buf, 0, len, i * CHUNK_SIZE);
        const data = Buffer.from(buf.subarray(0, bytesRead));
        if (this.o.testHooks?.corruptChunk?.(hash, i)) data[0] = (data[0] ?? 0) ^ 0xff;
        await ch.send({ t: 'chunk', hash, index: i }, data);
        onSent(i, bytesRead);
      }
    } finally {
      unsubscribe();
    }
  }
}
