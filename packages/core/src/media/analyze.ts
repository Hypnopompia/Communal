import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { EntryMeta as EntryMetaSchema } from '@communal/protocol';
import type { z } from 'zod';
import type { Kind } from '../index/detect.js';
import { frame, probe } from './ffmpeg.js';

export type EntryMeta = z.infer<typeof EntryMetaSchema>;

/** Grid thumbnail and on-demand preview sizes (HANDOFF §9), longest side in pixels. */
export const THUMB_SIZE = 320;
export const PREVIEW_SIZE = 1600;
export type ThumbSize = typeof THUMB_SIZE | typeof PREVIEW_SIZE;

/** PDFs larger than this aren't opened (pdf.js reads the whole file). */
const MAX_PDF_BYTES = 200 * 1024 * 1024;

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
const posInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.round(v) : undefined;

/** Drops undefined fields so the JSON (and the hub's copy) stays small. */
function clean(m: EntryMeta): EntryMeta {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) as EntryMeta;
}

export function isPdf(mime: string) {
  return mime === 'application/pdf';
}

/** Whether we ever try metadata or a thumbnail for this kind of file. */
export function analysable(kind: Kind, mime: string): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio' || isPdf(mime);
}

/**
 * Metadata for the index (HANDOFF §9 table) and the 320 px thumbnail, in one read of the file.
 * Never throws: an unreadable or unsupported file just yields less.
 */
export async function analyze(
  abs: string,
  mime: string,
  kind: Kind,
  size: number,
): Promise<{ meta: EntryMeta; thumb: Buffer | null }> {
  if (!analysable(kind, mime)) return { meta: {}, thumb: null };
  try {
    const src = await source(abs, mime, kind, size, THUMB_SIZE * 2);
    return { meta: clean(src.meta), thumb: src.image ? await toWebp(src.image, THUMB_SIZE) : null };
  } catch {
    return { meta: {}, thumb: null };
  }
}

/** A thumbnail or preview of the given size, or null when the file isn't previewable. */
export async function render(
  abs: string,
  mime: string,
  kind: Kind,
  size: number,
  side: ThumbSize,
): Promise<Buffer | null> {
  if (!analysable(kind, mime)) return null;
  try {
    const src = await source(abs, mime, kind, size, side * 2);
    return src.image ? await toWebp(src.image, side) : null;
  } catch {
    return null;
  }
}

/**
 * WebP, longest side `side`, auto-rotated, and with **all metadata stripped** (HANDOFF §9: no
 * EXIF/GPS). sharp drops EXIF, XMP, IPTC and ICC unless asked to keep them.
 */
async function toWebp(input: Buffer | string, side: number): Promise<Buffer | null> {
  const sharp = (await import('sharp')).default;
  try {
    return await sharp(input, { failOn: 'none', limitInputPixels: 268_402_689 })
      .rotate()
      .resize(side, side, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: side > THUMB_SIZE ? 80 : 70 })
      .toBuffer();
  } catch {
    return null;
  }
}

interface Source {
  meta: EntryMeta;
  /** Something sharp can decode (a path or encoded bytes), or null for no picture. */
  image: Buffer | string | null;
}

async function source(
  abs: string,
  mime: string,
  kind: Kind,
  size: number,
  maxSide: number,
): Promise<Source> {
  if (isPdf(mime)) return pdf(abs, size, maxSide);
  switch (kind) {
    case 'image':
      return image(abs);
    case 'video':
      return video(abs, maxSide);
    case 'audio':
      return audio(abs);
    default:
      return { meta: {}, image: null };
  }
}

async function image(abs: string): Promise<Source> {
  const sharp = (await import('sharp')).default;
  const exifr = (await import('exifr')).default;
  const exif = (await exifr
    .parse(abs, { pick: ['DateTimeOriginal', 'CreateDate', 'ExifImageWidth', 'ExifImageHeight'] })
    .catch(() => undefined)) as Record<string, unknown> | undefined;
  const taken = (exif?.DateTimeOriginal ?? exif?.CreateDate) as Date | undefined;
  const taken_at =
    taken instanceof Date && !Number.isNaN(taken.getTime())
      ? Math.floor(taken.getTime() / 1000)
      : undefined;
  try {
    const m = await sharp(abs, { failOn: 'none' }).metadata();
    // Orientations 5–8 are rotated by 90°: report the size as displayed.
    const swap = (m.orientation ?? 1) >= 5;
    return {
      meta: {
        width: posInt(swap ? m.height : m.width),
        height: posInt(swap ? m.width : m.height),
        taken_at: taken_at && taken_at > 0 ? taken_at : undefined,
      },
      image: abs,
    };
  } catch {
    // Formats this sharp build can't decode (HEIC, camera RAW): use the JPEG preview most of
    // them embed, and the EXIF size.
    const thumb = (await exifr.thumbnail(abs).catch(() => undefined)) as Uint8Array | undefined;
    return {
      meta: {
        width: posInt(exif?.ExifImageWidth),
        height: posInt(exif?.ExifImageHeight),
        taken_at: taken_at && taken_at > 0 ? taken_at : undefined,
      },
      image: thumb ? Buffer.from(thumb) : null,
    };
  }
}

async function video(abs: string, maxSide: number): Promise<Source> {
  const info = await probe(abs);
  const meta: EntryMeta = {
    duration: info.duration,
    width: posInt(info.width),
    height: posInt(info.height),
    codec: str(info.codec, 64),
  };
  if (!info.video) return { meta, image: null };
  // A frame at ~10 % of the way in (HANDOFF §9); very short clips fall back to the first frame.
  const at = info.duration ? info.duration * 0.1 : 1;
  const png = (await frame(abs, at, maxSide)) ?? (at > 0 ? await frame(abs, 0, maxSide) : null);
  return { meta, image: png };
}

async function audio(abs: string): Promise<Source> {
  const { parseFile } = await import('music-metadata');
  const mm = await parseFile(abs, { duration: true, skipCovers: false });
  const pic = mm.common.picture?.[0];
  return {
    meta: {
      artist: str(mm.common.artist, 512),
      album: str(mm.common.album, 512),
      title: str(mm.common.title, 512),
      duration:
        mm.format.duration !== undefined && Number.isFinite(mm.format.duration)
          ? Math.round(mm.format.duration * 100) / 100
          : undefined,
    },
    image: pic ? Buffer.from(pic.data) : null,
  };
}

let fontsDir: string | undefined;
function standardFonts(): string {
  fontsDir ??=
    join(
      dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
      'standard_fonts',
    ) + '/';
  return fontsDir;
}

async function pdf(abs: string, size: number, maxSide: number): Promise<Source> {
  if (size > MAX_PDF_BYTES) return { meta: {}, image: null };
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(abs)),
    standardFontDataUrl: standardFonts(),
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const info = (await doc.getMetadata().catch(() => null))?.info as
      Record<string, unknown> | undefined;
    const meta: EntryMeta = { pages: posInt(doc.numPages), title: str(info?.Title, 512) };
    // Page 1, rendered so its longest side is about `maxSide` pixels.
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, maxSide / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(
      Math.max(1, Math.ceil(vp.width)),
      Math.max(1, Math.ceil(vp.height)),
    );
    const ctx = canvas.getContext('2d');
    // PDFs are drawn on white paper; a transparent background would thumbnail as black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    type Params = Parameters<typeof page.render>[0];
    await page.render({
      canvas: canvas as unknown as Params['canvas'],
      canvasContext: ctx as unknown as Params['canvasContext'],
      viewport: vp,
    }).promise;
    return { meta, image: await canvas.encode('png') };
  } finally {
    await task.destroy();
  }
}
