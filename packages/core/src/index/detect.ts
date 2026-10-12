import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import mime from 'mime-types';

export type Kind =
  'image' | 'video' | 'audio' | 'document' | 'archive' | 'code' | 'text' | 'disk_image' | 'other';

const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/epub+zip',
  'application/msword',
  'application/rtf',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/x-mobipocket-ebook',
  'application/vnd.amazon.ebook',
]);

const ARCHIVE_MIMES = new Set([
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-bzip2',
  'application/x-xz',
  'application/zstd',
  'application/x-lzip',
  'application/x-compress',
]);

const DISK_IMAGE_EXT = new Set(['.iso', '.dmg', '.img', '.vhd', '.vhdx', '.vmdk', '.qcow2']);

const CODE_EXT = new Set(
  (
    '.c .h .cc .cpp .hpp .cs .go .rs .java .kt .kts .swift .m .mm .py .rb .php .pl .lua .r ' +
    '.js .mjs .cjs .ts .tsx .jsx .vue .svelte .sh .bash .zsh .fish .ps1 .bat .sql .scala .clj ' +
    '.hs .erl .ex .exs .dart .zig .nim .jl .css .scss .sass .less .html .htm .xml .json .yaml ' +
    '.yml .toml .ini .cfg .gradle .cmake .mk .dockerfile .tf .proto .graphql'
  ).split(/\s+/),
);

const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.rst',
  '.log',
  '.csv',
  '.tsv',
  '.srt',
  '.vtt',
  '.nfo',
  '.tex',
]);

/** Files named like this (no extension) are code too. */
const CODE_NAMES = new Set(['makefile', 'dockerfile', 'rakefile', 'gemfile', 'cmakelists.txt']);

/**
 * `sniffed`: the MIME came from magic bytes, so it's trusted over the extension. Otherwise
 * the extension decides first — e.g. mime-types maps `.ts` to MPEG-TS video, but a `.ts`
 * file without MPEG-TS magic is TypeScript.
 */
export function kindFor(mimeType: string, name: string, sniffed = false): Kind {
  const ext = extname(name).toLowerCase();
  const byMime = (): Kind | null => {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (DOCUMENT_MIMES.has(mimeType)) return 'document';
    if (ARCHIVE_MIMES.has(mimeType)) return 'archive';
    return null;
  };
  if (sniffed) {
    const k = byMime();
    if (k) return k;
  }
  if (DISK_IMAGE_EXT.has(ext)) return 'disk_image';
  if (CODE_EXT.has(ext) || CODE_NAMES.has(name.toLowerCase())) return 'code';
  if (TEXT_EXT.has(ext)) return 'text';
  const k = byMime();
  if (k) return k;
  if (mimeType.startsWith('text/')) return 'text';
  return 'other';
}

const SNIFF_BYTES = 4100;

/**
 * MIME type by magic bytes, falling back to the extension (HANDOFF §9). Text formats have no
 * magic, so the extension decides for them; unknown binaries are application/octet-stream.
 */
export async function detect(absPath: string, name: string): Promise<{ mime: string; kind: Kind }> {
  let sniffed: string | undefined;
  const fh = await open(absPath, 'r').catch(() => null);
  if (fh) {
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
      if (bytesRead > 0) sniffed = (await fileTypeFromBuffer(buf.subarray(0, bytesRead)))?.mime;
    } catch {
      // unreadable: fall back to the extension
    } finally {
      await fh.close();
    }
  }
  const byExt = mime.lookup(name) || undefined;
  // Containers (zip-based office/epub, OLE) sniff generically; the extension is more specific.
  if (sniffed && byExt && (sniffed === 'application/zip' || sniffed === 'application/x-cfb')) {
    return { mime: byExt, kind: kindFor(byExt, name) };
  }
  // A .ts file with no MPEG-TS magic is TypeScript, not video.
  const m =
    sniffed ?? (byExt === 'video/mp2t' ? 'text/typescript' : byExt) ?? 'application/octet-stream';
  return { mime: m, kind: kindFor(m, name, sniffed !== undefined) };
}
