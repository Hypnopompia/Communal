import { extname } from 'node:path';
import type { Kind } from '../index/detect.js';

/**
 * File icons (HANDOFF §9: "map MIME → icon via a broad icon set, with sensible defaults per
 * kind"). The core returns a stable icon id; each UI maps ids onto its own icon set (M9).
 * Most specific first: an exact MIME, then the extension, then the MIME family, then the kind.
 */
export type IconId =
  | 'image'
  | 'image-raw'
  | 'image-vector'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'ebook'
  | 'word'
  | 'spreadsheet'
  | 'presentation'
  | 'document'
  | 'archive'
  | 'disk-image'
  | 'code'
  | 'code-web'
  | 'code-data'
  | 'code-shell'
  | 'text'
  | 'markdown'
  | 'table'
  | 'subtitles'
  | 'font'
  | 'executable'
  | 'package'
  | 'database'
  | 'calendar'
  | 'contact'
  | 'torrent'
  | 'certificate'
  | 'model-3d'
  | 'file';

const BY_MIME: Record<string, IconId> = {
  'application/pdf': 'pdf',
  'application/epub+zip': 'ebook',
  'application/x-mobipocket-ebook': 'ebook',
  'application/vnd.amazon.ebook': 'ebook',
  'application/msword': 'word',
  'application/rtf': 'word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'application/vnd.oasis.opendocument.text': 'word',
  'application/vnd.ms-excel': 'spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheet',
  'application/vnd.oasis.opendocument.spreadsheet': 'spreadsheet',
  'application/vnd.ms-powerpoint': 'presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'presentation',
  'application/vnd.oasis.opendocument.presentation': 'presentation',
  'image/svg+xml': 'image-vector',
  'application/x-msdownload': 'executable',
  'application/x-msi': 'package',
  'application/vnd.debian.binary-package': 'package',
  'application/x-rpm': 'package',
  'application/vnd.android.package-archive': 'package',
  'application/x-sqlite3': 'database',
  'application/x-bittorrent': 'torrent',
  'text/calendar': 'calendar',
  'text/vcard': 'contact',
  'text/csv': 'table',
  'text/markdown': 'markdown',
};

const BY_EXT: Record<string, IconId> = {
  '.cr2': 'image-raw',
  '.cr3': 'image-raw',
  '.nef': 'image-raw',
  '.arw': 'image-raw',
  '.dng': 'image-raw',
  '.raf': 'image-raw',
  '.orf': 'image-raw',
  '.rw2': 'image-raw',
  '.svg': 'image-vector',
  '.ai': 'image-vector',
  '.eps': 'image-vector',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.csv': 'table',
  '.tsv': 'table',
  '.srt': 'subtitles',
  '.vtt': 'subtitles',
  '.ass': 'subtitles',
  '.ttf': 'font',
  '.otf': 'font',
  '.woff': 'font',
  '.woff2': 'font',
  '.exe': 'executable',
  '.app': 'executable',
  '.appimage': 'executable',
  '.msi': 'package',
  '.deb': 'package',
  '.rpm': 'package',
  '.apk': 'package',
  '.pkg': 'package',
  '.db': 'database',
  '.sqlite': 'database',
  '.sqlite3': 'database',
  '.ics': 'calendar',
  '.vcf': 'contact',
  '.torrent': 'torrent',
  '.pem': 'certificate',
  '.crt': 'certificate',
  '.cer': 'certificate',
  '.p12': 'certificate',
  '.stl': 'model-3d',
  '.obj': 'model-3d',
  '.gltf': 'model-3d',
  '.glb': 'model-3d',
  '.fbx': 'model-3d',
  '.3mf': 'model-3d',
  '.html': 'code-web',
  '.htm': 'code-web',
  '.css': 'code-web',
  '.scss': 'code-web',
  '.vue': 'code-web',
  '.svelte': 'code-web',
  '.json': 'code-data',
  '.yaml': 'code-data',
  '.yml': 'code-data',
  '.toml': 'code-data',
  '.xml': 'code-data',
  '.ini': 'code-data',
  '.sh': 'code-shell',
  '.bash': 'code-shell',
  '.zsh': 'code-shell',
  '.fish': 'code-shell',
  '.ps1': 'code-shell',
  '.bat': 'code-shell',
};

const BY_KIND: Record<Kind, IconId> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
  archive: 'archive',
  code: 'code',
  text: 'text',
  disk_image: 'disk-image',
  other: 'file',
};

export function iconFor(mime: string, name: string, kind: Kind): IconId {
  const exact = BY_MIME[mime];
  if (exact) return exact;
  const byExt = BY_EXT[extname(name).toLowerCase()];
  if (byExt) return byExt;
  if (mime.startsWith('font/')) return 'font';
  if (mime.startsWith('model/')) return 'model-3d';
  return BY_KIND[kind] ?? 'file';
}
