import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { access, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { createBLAKE3 } from 'hash-wasm';
import { pino, type Logger } from 'pino';
import { toBase32 } from '@communal/crypto';
import { CHUNK_SIZE, type AnyPeerHeader, type PeerHeader } from '@communal/protocol';
import type { HubManager } from '../hub-manager.js';
import type { IndexStore, TransferRow } from '../index/store.js';
import type { PeerChannel } from '../peer/transport.js';
import { PathError, type PeerBroker } from './broker.js';
import { mostUseful, type TransferDiagnosis } from './diagnosis.js';

export interface DownloadOptions {
  store: IndexStore;
  hubs: HubManager;
  broker: PeerBroker;
  myDevice: string;
  /** Where downloads land unless told otherwise (read on each download: it's a setting). */
  downloadsDir: () => string;
  /** Peers downloaded from at once (HANDOFF §7 multi-source). */
  maxPeers?: number;
  /** Chunks requested ahead per peer (~32, HANDOFF §7). */
  window?: number;
  /** A chunk not received in this long goes back to the pool (slow/dead peer). */
  chunkTimeoutMs?: number;
  /** When no source is online, try again after this long (or when one comes online). */
  retryMs?: number;
  /** How long a source's device has to answer the hub's offer before it counts as offline. */
  answerTimeoutMs?: number;
  log?: Logger;
}

export interface DownloadEvents {
  progress: [{ id: string; bytes: number; size: number; peers: number }];
  done: [{ id: string; path: string }];
  failed: [{ id: string; error: string }];
  waiting: [{ id: string; reason: string; diagnosis?: TransferDiagnosis }];
}

type Source = { hub: string; device: string };

interface Peer {
  key: string;
  source: Source;
  channel: PeerChannel;
  inflight: Set<number>;
  strikes: number;
}

/** A source of a running download, for the Transfers screen (HANDOFF §11 per-source speeds). */
export interface LiveSource {
  hub: string;
  device_id: string;
  /** Verified bytes received from this source in the current run. */
  bytes: number;
  /** Bytes per second over roughly the last second or two. */
  rate: number;
}

interface SourceStat extends LiveSource {
  mark: { at: number; bytes: number };
}

class Retryable extends Error {
  constructor(
    message: string,
    /** Why we couldn't connect, when a hub could tell (HANDOFF §8). */
    readonly diagnosis?: TransferDiagnosis,
  ) {
    super(message);
  }
}

/** The error of a download whose file no hub offers us any more. */
export const GONE = 'no longer available (deleted, changed, or not shared with you any more)';

const NOTHING_KNOWN = { nat: 'unknown', upnp: false, ipv6: false, cgnat: false } as const;

const newTransferId = () => 't_' + toBase32(randomBytes(10));

/** File names from the network are untrusted: keep only a safe base name. */
export function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, '/'))
    .replace(/[\0<>:"|?*]/g, '_')
    .trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 240) : 'download';
}

/**
 * Downloads by content hash from every online source the hubs report (HANDOFF §7):
 * - the manifest must hash to the requested hash; each chunk must match its manifest hash,
 *   and a bad chunk is fetched again — from a different peer when there is one;
 * - progress lives in `<name>.part` plus a `<name>.partmap` bitmap, so a killed download
 *   resumes with only the missing chunks;
 * - ~32 chunks are in flight per peer; a slow or dead peer's chunks go back to the pool.
 */
export class Downloads extends EventEmitter<DownloadEvents> {
  private readonly o: Required<Omit<DownloadOptions, 'log'>>;
  private readonly log: Logger;
  private readonly running = new Map<string, AbortController>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly live = new Map<string, Map<string, SourceStat>>();
  private stopped = false;

  constructor(opts: DownloadOptions) {
    super();
    this.o = {
      maxPeers: 4,
      window: 32,
      chunkTimeoutMs: 30_000,
      retryMs: 30_000,
      answerTimeoutMs: 15_000,
      ...opts,
    };
    this.log = opts.log ?? pino({ name: 'downloads' });
    // A source coming online is a good moment to retry waiting downloads.
    opts.hubs.on('presence', ({ presence }) => {
      if (presence.online)
        for (const t of this.o.store.transfers(['waiting'])) this.schedule(t.id, 0);
    });
  }

  /** Resumes downloads left unfinished by a previous run. */
  start() {
    for (const t of this.o.store.transfers(['queued', 'active', 'waiting'])) this.schedule(t.id, 0);
  }

  async stop() {
    this.stopped = true;
    for (const t of this.retryTimers.values()) clearTimeout(t);
    for (const a of this.running.values()) a.abort();
    // Let in-flight runs unwind (close files, flush bitmaps).
    for (let i = 0; i < 50 && this.running.size > 0; i++)
      await new Promise((r) => setTimeout(r, 20));
  }

  add(req: { hash: string; name: string; destDir?: string }): TransferRow {
    const id = newTransferId();
    const dest = req.destDir ?? this.o.downloadsDir();
    mkdirSync(dest, { recursive: true });
    this.o.store.addTransfer({
      id,
      hash: req.hash,
      name: safeName(req.name),
      dest_dir: dest,
      size: null,
    });
    this.schedule(id, 0);
    return this.o.store.transfer(id)!;
  }

  cancel(id: string) {
    const t = this.o.store.transfer(id);
    if (!t || t.state === 'done') return false;
    this.running.get(id)?.abort();
    clearTimeout(this.retryTimers.get(id));
    this.o.store.updateTransfer(id, { state: 'cancelled' });
    const part = join(t.dest_dir, `${t.name}.part`);
    void rm(part, { force: true });
    void rm(`${part}map`, { force: true });
    return true;
  }

  list(): TransferRow[] {
    return this.o.store.transfers();
  }

  /** The sources a running download is fetching from right now, with their speeds. */
  liveSources(id: string): LiveSource[] {
    const now = Date.now();
    // A source that has gone quiet shows 0, not its last speed.
    return [...(this.live.get(id)?.values() ?? [])].map(({ mark, ...s }) => ({
      ...s,
      rate: now - mark.at > 3_000 ? 0 : s.rate,
    }));
  }

  private schedule(id: string, delayMs: number) {
    if (this.stopped || this.running.has(id)) return;
    clearTimeout(this.retryTimers.get(id));
    this.retryTimers.set(
      id,
      setTimeout(() => {
        this.retryTimers.delete(id);
        void this.run(id);
      }, delayMs),
    );
  }

  private async run(id: string) {
    const t = this.o.store.transfer(id);
    if (!t || !['queued', 'active', 'waiting'].includes(t.state) || this.running.has(id)) return;
    const abort = new AbortController();
    this.running.set(id, abort);
    this.o.store.updateTransfer(id, { state: 'active', error: null });
    let retry = false;
    try {
      const path = await this.download(t, abort.signal);
      const size = this.o.store.transfer(id)?.size ?? 0;
      this.o.store.updateTransfer(id, {
        state: 'done',
        final_path: path,
        bytes_done: size,
        diagnosis: null,
      });
      this.log.info({ transfer_id: id }, 'download complete');
      this.emit('done', { id, path });
    } catch (err) {
      if (abort.signal.aborted && this.o.store.transfer(id)?.state === 'cancelled') return;
      if (this.stopped) {
        this.o.store.updateTransfer(id, { state: 'queued' });
      } else if (err instanceof Retryable) {
        // A diagnosis stays until the download completes or a newer one replaces it.
        this.o.store.updateTransfer(id, {
          state: 'waiting',
          error: err.message,
          ...(err.diagnosis ? { diagnosis: err.diagnosis } : {}),
        });
        this.emit('waiting', {
          id,
          reason: err.message,
          ...(err.diagnosis ? { diagnosis: err.diagnosis } : {}),
        });
        retry = true;
      } else {
        this.o.store.updateTransfer(id, { state: 'failed', error: (err as Error).message });
        this.log.warn({ transfer_id: id, err: (err as Error).message }, 'download failed');
        this.emit('failed', { id, error: (err as Error).message });
      }
    } finally {
      this.running.delete(id);
    }
    // After `running` is cleared, or schedule() would think we're still going.
    if (retry) this.schedule(id, this.o.retryMs);
  }

  /**
   * Online sources across every hub (deduplicated by device; never ourselves). `gone` means
   * every hub answered and none lists a copy we may fetch, online or not: the file was
   * deleted or changed, or isn't shared with us any more.
   */
  private async sources(hash: string): Promise<{ online: Source[]; gone: boolean }> {
    const results = await this.o.hubs.requestAll('sources', { hash });
    const seen = new Set<string>();
    const online: Source[] = [];
    let listed = false;
    for (const r of results) {
      if (!r.ok || r.msg.t !== 'sources.list') continue;
      for (const s of r.msg.body.sources) {
        if (s.device_id === this.o.myDevice) continue;
        listed = true;
        if (!s.online || seen.has(s.device_id)) continue;
        seen.add(s.device_id);
        online.push({ hub: r.hub, device: s.device_id });
      }
    }
    const answered = results.every((r) => r.ok && r.msg.t === 'sources.list');
    return { online, gone: answered && !listed };
  }

  private connect(src: Source, hash: string): Promise<PeerChannel> {
    return this.o.broker.session(src.hub, src.device, hash, {
      answerTimeoutMs: this.o.answerTimeoutMs,
    });
  }

  private manifest(ch: PeerChannel, hash: string) {
    return fetchManifest(ch, hash);
  }

  private async download(t: TransferRow, signal: AbortSignal): Promise<string> {
    const { online: sources, gone } = await this.sources(t.hash);
    if (gone) throw new Error(GONE);
    if (sources.length === 0) {
      // The hubs list the file's sources as offline: no need to try reaching them.
      throw new Retryable('no source is online', {
        cause: 'peer_offline',
        easier_fix: 'none',
        you: NOTHING_KNOWN,
        them: NOTHING_KNOWN,
        at: Math.floor(Date.now() / 1000),
      });
    }
    const diagnoses: TransferDiagnosis[] = [];

    // Connect to several sources at once; the first manifest that checks out wins.
    const peers: Peer[] = [];
    let manifest: { size: number; chunkHashes: Uint8Array } | undefined;
    await Promise.all(
      sources.slice(0, this.o.maxPeers).map(async (source) => {
        try {
          const channel = await this.connect(source, t.hash);
          if (!manifest) manifest = await this.manifest(channel, t.hash);
          peers.push({ key: source.device, source, channel, inflight: new Set(), strikes: 0 });
        } catch (err) {
          if (err instanceof PathError) {
            const { session_id: _s, ...d } = err.diagnosis;
            diagnoses.push({
              ...d,
              device: source.device,
              hub: source.hub,
              at: Math.floor(Date.now() / 1000),
            });
          }
          this.log.info(
            {
              transfer_id: t.id,
              source: source.device,
              err: (err as Error).message,
              ...(err instanceof PathError ? { cause: err.diagnosis.cause } : {}),
            },
            'source unavailable',
          );
        }
      }),
    );
    if (!manifest || peers.length === 0) {
      for (const p of [...peers]) p.channel.close();
      const diagnosis = mostUseful(diagnoses);
      throw new Retryable(
        diagnosis ? `could not connect (${diagnosis.cause})` : 'could not connect to any source',
        diagnosis,
      );
    }
    const { size, chunkHashes } = manifest;
    if (t.size === null) this.o.store.updateTransfer(t.id, { size });

    const part = join(t.dest_dir, `${t.name}.part`);
    const mapPath = `${part}map`;
    const n = Math.ceil(size / CHUNK_SIZE);
    const bits = Buffer.alloc(Math.ceil(n / 8));
    let fh: FileHandle | undefined;
    let mapFh: FileHandle | undefined;
    try {
      const data = (fh = await openOrCreate(part));
      await data.truncate(size);
      const map = (mapFh = await openOrCreate(mapPath));
      // A short read just means the tail is zeros: size the map fully so offsets are stable.
      await map.read(bits, 0, bits.length, 0);
      await map.truncate(bits.length);
      const have = (i: number) => (bits[i >> 3]! & (1 << (i & 7))) !== 0;
      let done = 0;
      for (let i = 0; i < n; i++) if (have(i)) done++;
      this.log.info(
        { transfer_id: t.id, chunks: n, have: done, peers: peers.length },
        'downloading',
      );

      await this.fetchChunks({
        t,
        peers,
        n,
        size,
        chunkHashes,
        have,
        signal,
        onChunk: async (i, chunk) => {
          await data.write(chunk, 0, chunk.length, i * CHUNK_SIZE);
          bits[i >> 3]! |= 1 << (i & 7);
          await map.write(bits, i >> 3, 1, i >> 3);
          done++;
        },
        progress: () => done,
      });
      await data.sync();
    } finally {
      await fh?.close();
      await mapFh?.close();
      // Copy: closing fires `drop`, which removes peers from this array.
      for (const p of [...peers]) p.channel.close();
    }

    const final = await uniquePath(t.dest_dir, t.name);
    await rename(part, final);
    await rm(mapPath, { force: true });
    return final;
  }

  private async fetchChunks(x: {
    t: TransferRow;
    peers: Peer[];
    n: number;
    size: number;
    chunkHashes: Uint8Array;
    have: (i: number) => boolean;
    signal: AbortSignal;
    onChunk: (i: number, data: Uint8Array) => Promise<void>;
    progress: () => number;
  }) {
    const { t, peers, n, size, chunkHashes, have, signal } = x;
    const hasher = await createBLAKE3();
    const pending = new Set<number>();
    for (let i = 0; i < n; i++) if (!have(i)) pending.add(i);
    if (pending.size === 0) return;
    const requestedAt = new Map<number, number>();
    /** Peers that sent bad data for a chunk; it's re-fetched elsewhere when possible. */
    const badFrom = new Map<number, Set<string>>();
    let lastProgress = 0;
    const stats = new Map<string, SourceStat>();
    this.live.set(t.id, stats);
    const stat = (p: Peer) => {
      let st = stats.get(p.key);
      if (!st) {
        st = {
          hub: p.source.hub,
          device_id: p.source.device,
          bytes: 0,
          rate: 0,
          mark: { at: Date.now(), bytes: 0 },
        };
        stats.set(p.key, st);
      }
      return st;
    };
    for (const p of peers) stat(p);

    return new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (err?: Error) => {
        if (finished) return;
        finished = true;
        this.live.delete(t.id);
        clearInterval(watchdog);
        for (const p of peers) p.channel.removeAllListeners('frame');
        if (err) reject(err);
        else resolve();
      };
      signal.addEventListener('abort', () => finish(new Error('aborted')), { once: true });

      const assign = (p: Peer) => {
        const want: number[] = [];
        for (const i of pending) {
          if (p.inflight.size + want.length >= this.o.window) break;
          if (requestedAt.has(i)) continue;
          // Avoid a peer that already sent garbage for this chunk, unless it's the only one.
          if (
            badFrom.get(i)?.has(p.key) &&
            peers.some((q) => q !== p && !badFrom.get(i)?.has(q.key))
          )
            continue;
          want.push(i);
        }
        if (want.length === 0) return;
        for (const i of want) {
          p.inflight.add(i);
          requestedAt.set(i, Date.now());
        }
        void p.channel
          .send({ t: 'get', hash: t.hash, ranges: toRanges(want) })
          .catch(() => drop(p, 'send failed'));
      };

      const release = (p: Peer, i: number) => {
        p.inflight.delete(i);
        requestedAt.delete(i);
      };

      const drop = (p: Peer, why: string) => {
        if (finished) return;
        const idx = peers.indexOf(p);
        if (idx < 0) return;
        peers.splice(idx, 1);
        for (const i of p.inflight) requestedAt.delete(i);
        p.inflight.clear();
        p.channel.close();
        stats.delete(p.key);
        this.log.info({ transfer_id: t.id, source: p.key, why }, 'dropped source');
        if (peers.length === 0) return finish(new Retryable(`all sources gone (${why})`));
        for (const q of peers) assign(q);
      };

      const onFrame =
        (p: Peer) =>
        async ({ header, payload }: { header: AnyPeerHeader; payload: Uint8Array }) => {
          if (finished) return;
          if (header.t === 'busy' || header.t === 'denied') return drop(p, header.t);
          if (header.t !== 'chunk' || header.hash !== t.hash) return;
          const i = header.index;
          if (!pending.has(i)) return release(p, i); // duplicate (endgame) or unrequested
          const expectLen = Math.min(CHUNK_SIZE, size - i * CHUNK_SIZE);
          hasher.init();
          hasher.update(payload);
          const ok =
            payload.length === expectLen &&
            Buffer.from(hasher.digest('binary')).equals(chunkHashes.subarray(i * 32, i * 32 + 32));
          release(p, i);
          if (!ok) {
            const set = badFrom.get(i) ?? new Set();
            set.add(p.key);
            badFrom.set(i, set);
            p.strikes++;
            this.log.warn(
              { transfer_id: t.id, source: p.key, chunk: i },
              'chunk failed verification; refetching',
            );
            if (p.strikes >= 3) return drop(p, 'sent corrupt data');
            for (const q of peers) assign(q);
            return;
          }
          pending.delete(i);
          const st = stat(p);
          st.bytes += payload.length;
          const at = Date.now();
          if (at - st.mark.at >= 1_000) {
            st.rate = Math.round(((st.bytes - st.mark.bytes) * 1_000) / (at - st.mark.at));
            st.mark = { at, bytes: st.bytes };
          }
          try {
            await x.onChunk(i, payload);
          } catch (err) {
            return finish(err as Error);
          }
          const now = Date.now();
          if (now - lastProgress > 250 || pending.size === 0) {
            lastProgress = now;
            const bytes = Math.min(size, x.progress() * CHUNK_SIZE);
            this.o.store.updateTransfer(t.id, { bytes_done: bytes });
            this.emit('progress', { id: t.id, bytes, size, peers: peers.length });
          }
          if (pending.size === 0) return finish();
          assign(p);
        };

      for (const p of [...peers]) {
        p.channel.subscribe((f) => void onFrame(p)(f));
        p.channel.once('close', () => drop(p, 'connection closed'));
        assign(p);
      }

      // Slow/dead peers: chunks outstanding too long go back to the pool for anyone. In the
      // endgame (nothing left unassigned) idle peers duplicate stragglers; first copy wins.
      const watchdog = setInterval(
        () => {
          const now = Date.now();
          for (const p of peers) {
            for (const i of [...p.inflight]) {
              if (now - (requestedAt.get(i) ?? now) > this.o.chunkTimeoutMs) release(p, i);
            }
          }
          for (const p of peers) assign(p);
        },
        Math.min(1_000, this.o.chunkTimeoutMs / 2),
      );
    });
  }
}

/** Asks for the manifest and checks that its chunk hashes hash to `hash` (HANDOFF §7). */
export async function fetchManifest(
  ch: PeerChannel,
  hash: string,
): Promise<{ size: number; chunkHashes: Uint8Array }> {
  await ch.send({ t: 'manifest.get', hash });
  const { header } = await ch.next((h) => h.t === 'manifest' && h.hash === hash, 15_000);
  const m = header as PeerHeader<'manifest'>;
  const n = Math.ceil(m.size / CHUNK_SIZE);
  const root = await createBLAKE3();
  root.init();
  root.update(m.chunk_hashes);
  if (m.chunk_hashes.length !== n * 32 || root.digest('hex') !== hash) {
    throw new Error('manifest does not match the file hash');
  }
  return { size: m.size, chunkHashes: m.chunk_hashes };
}

/** [[start, end)] ranges from chunk indices. */
export function toRanges(indices: number[]): [number, number][] {
  const sorted = [...indices].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

/** Opens read/write, creating the file if needed, without truncating an existing one. */
async function openOrCreate(path: string): Promise<FileHandle> {
  try {
    return await open(path, 'r+');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return open(path, 'w+');
  }
}

/** `dir/name`, or `dir/stem (n).ext` for the first n that doesn't exist yet. */
export async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; ; n++) {
    const p = join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
    try {
      await access(p);
    } catch {
      return p;
    }
  }
}
