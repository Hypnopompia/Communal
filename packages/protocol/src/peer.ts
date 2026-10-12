import { Packr } from 'msgpackr';
import { z } from 'zod';
import { DeviceId, Hash, SessionId, Signature, UnixSeconds } from './common.js';

/*
 * Peer frames (HANDOFF §7). Wire format of one frame:
 *
 *   u32 BE frame_len | u32 BE header_len | msgpack header | raw payload bytes
 *
 * frame_len counts everything after itself. The header is `{ t, ...fields }`; the payload is
 * used by `chunk`, `thumb` and `peek.data` and is empty otherwise.
 */

export const CHUNK_SIZE = 1024 * 1024;
/** Largest frame we'll accept: one chunk plus generous header room. */
export const MAX_PEER_FRAME = CHUNK_SIZE + 64 * 1024;

/** Chunk-index range [start, end): start inclusive, end exclusive (ADR 0010). */
const Range = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
const Ranges = z.array(Range).min(1).max(1024);

export const peerHeaders = {
  hello: z.object({
    token: z.object({
      claims: z.object({
        session_id: SessionId,
        from: DeviceId,
        to: DeviceId,
        hash: Hash,
        exp: UnixSeconds,
      }),
      sig: Signature,
    }),
    /**
     * `file` (default): download the token's file. `preview`: thumbnails and peeks for any
     * files the uploader lets this peer see, each checked on its own (M6, ADR 0012).
     */
    purpose: z.enum(['file', 'preview']).optional(),
  }),
  'hello.ok': z.looseObject({}),
  'manifest.get': z.object({ hash: Hash }),
  manifest: z.object({
    hash: Hash,
    size: z.number().int().nonnegative(),
    chunk_size: z.literal(CHUNK_SIZE),
    /** Concatenated 32-byte BLAKE3 chunk hashes. */
    chunk_hashes: z.instanceof(Uint8Array),
  }),
  get: z.object({ hash: Hash, ranges: Ranges }),
  chunk: z.object({ hash: Hash, index: z.number().int().nonnegative() }),
  cancel: z.object({ hash: Hash, ranges: Ranges }),
  busy: z.object({ retry_after_s: z.number().int().nonnegative() }),
  'thumb.get': z.object({
    hashes: z.array(Hash).min(1).max(1000),
    size: z.union([z.literal(320), z.literal(1600)]),
  }),
  thumb: z.object({ hash: Hash, mime: z.literal('image/webp') }),
  'thumb.none': z.object({ hash: Hash }),
  peek: z.object({ hash: Hash }),
  'peek.data': z.object({ hash: Hash, truncated: z.boolean() }),
  /** Nothing to peek at: not a text file, gone, or not allowed (indistinguishable on purpose). */
  'peek.none': z.object({ hash: Hash }),
  denied: z.object({
    reason: z.enum([
      'bad_token',
      'expired',
      'wrong_target',
      'wrong_sender',
      'bad_cert',
      'revoked',
      'forbidden',
      'not_found',
      'lan_only',
    ]),
  }),
} as const;

export type PeerType = keyof typeof peerHeaders;
export type PeerHeader<T extends PeerType> = { t: T } & z.infer<(typeof peerHeaders)[T]>;
export type AnyPeerHeader = { [T in PeerType]: PeerHeader<T> }[PeerType];

export interface PeerFrame {
  header: AnyPeerHeader;
  payload: Uint8Array;
}

const packr = new Packr({ useRecords: false, moreTypes: false });

export function encodePeerFrame<T extends PeerType>(
  header: PeerHeader<T>,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const h = packr.pack(header);
  const out = new Uint8Array(8 + h.length + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 4 + h.length + payload.length);
  dv.setUint32(4, h.length);
  out.set(h, 8);
  out.set(payload, 8 + h.length);
  return out;
}

export class PeerFrameError extends Error {}

function decodeBody(body: Uint8Array): PeerFrame {
  if (body.length < 4) throw new PeerFrameError('short frame');
  const hlen = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
  if (4 + hlen > body.length) throw new PeerFrameError('header overruns frame');
  let raw: unknown;
  try {
    raw = packr.unpack(body.subarray(4, 4 + hlen));
  } catch {
    throw new PeerFrameError('bad msgpack header');
  }
  const t = (raw as { t?: unknown } | null)?.t;
  if (typeof t !== 'string' || !Object.hasOwn(peerHeaders, t)) {
    throw new PeerFrameError(`unknown frame type`);
  }
  const parsed = peerHeaders[t as PeerType].safeParse(raw);
  if (!parsed.success) throw new PeerFrameError(`invalid ${t} frame`);
  // msgpackr decodes bin into Buffer (a Uint8Array subclass); keep that as-is.
  return {
    header: { t, ...parsed.data } as AnyPeerHeader,
    payload: body.subarray(4 + hlen),
  };
}

/**
 * Incremental decoder for a byte stream: push() whatever arrived, get back complete frames.
 */
export class PeerFrameDecoder {
  private buf: Uint8Array = new Uint8Array(0);

  push(data: Uint8Array): PeerFrame[] {
    this.buf = this.buf.length === 0 ? data : concat(this.buf, data);
    const frames: PeerFrame[] = [];
    let off = 0;
    while (this.buf.length - off >= 4) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset + off, 4).getUint32(0);
      if (len > MAX_PEER_FRAME) throw new PeerFrameError('frame too large');
      if (this.buf.length - off - 4 < len) break;
      frames.push(decodeBody(this.buf.subarray(off + 4, off + 4 + len)));
      off += 4 + len;
    }
    this.buf = off === this.buf.length ? new Uint8Array(0) : this.buf.slice(off);
    return frames;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
