import { createBLAKE3 } from 'hash-wasm';
import { pino, type Logger } from 'pino';
import { CHUNK_SIZE, type AnyPeerHeader } from '@communal/protocol';
import type { HubManager } from '../hub-manager.js';
import type { PeerChannel } from '../peer/transport.js';
import type { PeerBroker } from './broker.js';
import { fetchManifest } from './downloader.js';

export interface StreamOptions {
  hubs: HubManager;
  broker: PeerBroker;
  myDevice: string;
  /** Chunks fetched ahead of the reader (HANDOFF §7: "a few chunks ahead"). */
  readahead?: number;
  /** Verified chunks kept in memory per stream (seeking back is cheap within this). */
  keep?: number;
  /** Close a stream nobody has read from for this long. */
  idleMs?: number;
  answerTimeoutMs?: number;
  log?: Logger;
}

/**
 * Plays a file while it's still on the other device (HANDOFF §7 "Streaming": in-order range
 * requests a few chunks ahead, used for video and audio previews). Every chunk is verified
 * against the manifest before a byte of it is served. Nothing is written to disk.
 */
export class Streams {
  private readonly o: Required<Omit<StreamOptions, 'log' | 'answerTimeoutMs'>> &
    Pick<StreamOptions, 'answerTimeoutMs'>;
  private readonly log: Logger;
  private readonly open = new Map<string, Promise<StreamSession>>();

  constructor(opts: StreamOptions) {
    this.o = { readahead: 4, keep: 16, idleMs: 30_000, ...opts };
    this.log = opts.log ?? pino({ name: 'streams' });
  }

  /** The stream for `hash`, from the first online source that serves it. */
  get(hash: string): Promise<StreamSession> {
    let s = this.open.get(hash);
    if (!s) {
      s = this.start(hash);
      this.open.set(hash, s);
      s.catch(() => this.open.delete(hash));
    }
    return s.then((x) => {
      if (!x.closed) return x;
      this.open.delete(hash);
      return this.get(hash);
    });
  }

  closeAll() {
    for (const s of this.open.values()) void s.then((x) => x.close()).catch(() => {});
    this.open.clear();
  }

  private async start(hash: string): Promise<StreamSession> {
    const seen = new Set<string>();
    let lastErr: Error = new Error('no source is online');
    for (const r of await this.o.hubs.requestAll('sources', { hash })) {
      if (!r.ok || r.msg.t !== 'sources.list') continue;
      for (const s of r.msg.body.sources) {
        if (!s.online || s.device_id === this.o.myDevice || seen.has(s.device_id)) continue;
        seen.add(s.device_id);
        try {
          const ch = await this.o.broker.session(r.hub, s.device_id, hash, {
            answerTimeoutMs: this.o.answerTimeoutMs,
          });
          const m = await fetchManifest(ch, hash).catch((e: Error) => {
            ch.close();
            throw e;
          });
          const session = new StreamSession(ch, hash, m.size, m.chunkHashes, this.o);
          session.onClose = () => {
            if (this.open.get(hash) && session.closed) this.open.delete(hash);
          };
          return session;
        } catch (err) {
          lastErr = err as Error;
          this.log.info({ source: s.device_id, err: lastErr.message }, 'stream source unavailable');
        }
      }
    }
    throw lastErr;
  }
}

export class StreamSession {
  closed = false;
  onClose?: () => void;
  private readonly have = new Map<number, Buffer>();
  private readonly requested = new Set<number>();
  private readonly waiters = new Map<number, ((b: Buffer | Error) => void)[]>();
  private readonly retries = new Map<number, number>();
  private idle?: NodeJS.Timeout;
  private hasher?: Awaited<ReturnType<typeof createBLAKE3>>;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly ch: PeerChannel,
    readonly hash: string,
    readonly size: number,
    private readonly chunkHashes: Uint8Array,
    private readonly o: { readahead: number; keep: number; idleMs: number },
  ) {
    this.unsubscribe = ch.subscribe((f) => void this.onFrame(f));
    ch.once('close', () => this.close());
    this.touch();
  }

  get chunks(): number {
    return Math.ceil(this.size / CHUNK_SIZE);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    this.unsubscribe();
    this.ch.close();
    for (const ws of this.waiters.values()) for (const w of ws) w(new Error('stream closed'));
    this.waiters.clear();
    this.onClose?.();
  }

  private touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), this.o.idleMs);
    this.idle.unref();
  }

  /** Bytes [start, end] (inclusive, like HTTP ranges), chunk by chunk, verified, in order. */
  async *read(start: number, end: number): AsyncGenerator<Buffer> {
    const last = Math.min(end, this.size - 1);
    for (let i = Math.floor(start / CHUNK_SIZE); i * CHUNK_SIZE <= last; i++) {
      const chunk = await this.chunk(i);
      const from = Math.max(start, i * CHUNK_SIZE) - i * CHUNK_SIZE;
      const to = Math.min(last, (i + 1) * CHUNK_SIZE - 1) - i * CHUNK_SIZE + 1;
      yield chunk.subarray(from, to);
    }
  }

  /** Chunk `i`, fetching it (and the next few) if needed. */
  private chunk(i: number): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error('stream closed'));
    this.touch();
    this.request(i);
    const got = this.have.get(i);
    if (got) {
      // Refresh its place in the LRU.
      this.have.delete(i);
      this.have.set(i, got);
      return Promise.resolve(got);
    }
    return new Promise((resolve, reject) => {
      const ws = this.waiters.get(i) ?? [];
      ws.push((b) => (b instanceof Error ? reject(b) : resolve(b)));
      this.waiters.set(i, ws);
    });
  }

  /** Asks for `i` and the readahead window after it that we don't have or haven't asked for. */
  private request(i: number) {
    const want: number[] = [];
    for (let j = i; j < Math.min(this.chunks, i + 1 + this.o.readahead); j++) {
      if (!this.have.has(j) && !this.requested.has(j)) want.push(j);
    }
    if (want.length === 0) return;
    for (const j of want) this.requested.add(j);
    const ranges: [number, number][] = [];
    for (const j of want) {
      const r = ranges[ranges.length - 1];
      if (r && r[1] === j) r[1] = j + 1;
      else ranges.push([j, j + 1]);
    }
    void this.ch.send({ t: 'get', hash: this.hash, ranges }).catch(() => this.close());
  }

  private async onFrame({ header, payload }: { header: AnyPeerHeader; payload: Uint8Array }) {
    if (header.t === 'busy' || header.t === 'denied') return this.close();
    if (header.t !== 'chunk' || header.hash !== this.hash) return;
    const i = header.index;
    if (!this.requested.delete(i)) return;
    this.hasher ??= await createBLAKE3();
    this.hasher.init();
    this.hasher.update(payload);
    const expectLen = Math.min(CHUNK_SIZE, this.size - i * CHUNK_SIZE);
    const ok =
      payload.length === expectLen &&
      Buffer.from(this.hasher.digest('binary')).equals(
        Buffer.from(this.chunkHashes.subarray(i * 32, i * 32 + 32)),
      );
    if (!ok) {
      // One more try, then give up: we never serve unverified bytes.
      const n = (this.retries.get(i) ?? 0) + 1;
      this.retries.set(i, n);
      if (n > 1) return this.close();
      this.request(i);
      return;
    }
    const data = Buffer.from(payload);
    this.have.set(i, data);
    while (this.have.size > this.o.keep) this.have.delete(this.have.keys().next().value!);
    const ws = this.waiters.get(i);
    this.waiters.delete(i);
    for (const w of ws ?? []) w(data);
  }
}
