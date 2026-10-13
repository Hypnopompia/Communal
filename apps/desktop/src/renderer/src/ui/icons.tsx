/** Line icons for navigation and actions, drawn on a 20px grid. */
import type { SVGProps } from 'react';

const paths = {
  library: 'M3 4h4v12H3zM8.5 4h4v12h-4zM14 5l3.2-.8 2.3 11.3-3.2.7z',
  search: 'M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM13 13l4.5 4.5',
  shares:
    'M2.5 6.5V15a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V8a1.5 1.5 0 0 0-1.5-1.5H9.5L8 4.5H4A1.5 1.5 0 0 0 2.5 6z',
  people:
    'M7 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 16.5c.6-2.8 2.6-4.5 5-4.5s4.4 1.7 5 4.5M13.5 9a2.5 2.5 0 1 0 0-5M14.5 12c1.8.4 3 1.9 3.5 4.5',
  transfers: 'M10 3v10M6 9l4 4 4-4M4 16.5h12',
  subscriptions:
    'M4 10a6 6 0 0 1 10.2-4.3L16 7.5M16 4v3.5h-3.5M16 10a6 6 0 0 1-10.2 4.3L4 12.5M4 16v-3.5h3.5',
  activity: 'M2.5 10h3l2-5 3 10 2-5h5',
  settings:
    'M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4',
  folder:
    'M2.5 6.5V15a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V8a1.5 1.5 0 0 0-1.5-1.5H9.5L8 4.5H4A1.5 1.5 0 0 0 2.5 6z',
  device: 'M3 5h14v8H3zM1.5 15.5h17',
  back: 'M12 4l-6 6 6 6',
  chevron: 'M6 8l4 4 4-4',
  close: 'M5 5l10 10M15 5L5 15',
  plus: 'M10 4v12M4 10h12',
  check: 'M4 10.5l4 4 8-9',
  lock: 'M5.5 9h9v7.5h-9zM7.5 9V6.5a2.5 2.5 0 0 1 5 0V9',
  globe:
    'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM2.5 10h15M10 2.5c2 2 3 4.5 3 7.5s-1 5.5-3 7.5c-2-2-3-4.5-3-7.5s1-5.5 3-7.5z',
  user: 'M10 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4.5 16.5c.6-2.8 2.8-4.5 5.5-4.5s4.9 1.7 5.5 4.5',
  eye: 'M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10zM10 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  shield: 'M10 2.5l6 2.5v4.5c0 4-2.6 6.8-6 8-3.4-1.2-6-4-6-8V5z',
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 18,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}

/** The app mark: three overlapping discs, people around a shared shelf. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="8" cy="9" r="6" fill="#2f5bea" />
      <circle cx="16" cy="9" r="6" fill="#18936a" fillOpacity="0.85" />
      <circle cx="12" cy="16" r="6" fill="#e0a43a" fillOpacity="0.85" />
    </svg>
  );
}

/**
 * File icons by the core's icon id (`iconFor()`): a page with a coloured band and a short,
 * readable label, so "PDF" or "ZIP" says what the file is without any guessing.
 */
const FILE_STYLE: Record<string, { label: string; color: string }> = {
  image: { label: 'IMG', color: '#2f8f83' },
  'image-raw': { label: 'RAW', color: '#2f8f83' },
  'image-vector': { label: 'SVG', color: '#2f8f83' },
  video: { label: 'VID', color: '#7a4fd6' },
  audio: { label: 'AUD', color: '#d0518a' },
  pdf: { label: 'PDF', color: '#c8432f' },
  ebook: { label: 'BOOK', color: '#a0612b' },
  word: { label: 'DOC', color: '#2f5bea' },
  spreadsheet: { label: 'XLS', color: '#1f8a4c' },
  presentation: { label: 'PPT', color: '#d36a1f' },
  document: { label: 'DOC', color: '#4f5d6b' },
  archive: { label: 'ZIP', color: '#8a6d1f' },
  'disk-image': { label: 'DISK', color: '#5a6a7a' },
  code: { label: 'CODE', color: '#3a6f9a' },
  'code-web': { label: 'WEB', color: '#3a6f9a' },
  'code-data': { label: 'DATA', color: '#3a6f9a' },
  'code-shell': { label: 'SH', color: '#3a6f9a' },
  text: { label: 'TXT', color: '#6b7682' },
  markdown: { label: 'MD', color: '#6b7682' },
  table: { label: 'CSV', color: '#1f8a4c' },
  subtitles: { label: 'SUB', color: '#7a4fd6' },
  font: { label: 'FONT', color: '#4f5d6b' },
  executable: { label: 'APP', color: '#4f5d6b' },
  package: { label: 'PKG', color: '#8a6d1f' },
  database: { label: 'DB', color: '#3a6f9a' },
  calendar: { label: 'CAL', color: '#c8432f' },
  contact: { label: 'CARD', color: '#2f5bea' },
  torrent: { label: 'TOR', color: '#4f5d6b' },
  certificate: { label: 'CERT', color: '#8a6d1f' },
  'model-3d': { label: '3D', color: '#7a4fd6' },
  file: { label: 'FILE', color: '#6b7682' },
};

export function FileIcon({ icon, size = 36 }: { icon: string; size?: number }) {
  const s = FILE_STYLE[icon] ?? FILE_STYLE.file!;
  return (
    <svg className="file-icon" width={size} height={size} viewBox="0 0 36 36" aria-hidden="true">
      <path
        d="M8 3h14l7 7v21a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
        fill="var(--surface)"
        stroke="var(--line)"
        strokeWidth="1.5"
      />
      <path d="M22 3v5a2 2 0 0 0 2 2h5" fill="none" stroke="var(--line)" strokeWidth="1.5" />
      <rect x="4" y="18" width="24" height="10" rx="2" fill={s.color} />
      <text
        x="16"
        y="25.6"
        textAnchor="middle"
        fontSize={s.label.length > 3 ? 6.2 : 7.4}
        fontWeight="700"
        fill="#fff"
        fontFamily="var(--font)"
      >
        {s.label}
      </text>
    </svg>
  );
}

export function FolderIcon({ size = 36 }: { size?: number }) {
  return (
    <svg className="file-icon" width={size} height={size} viewBox="0 0 36 36" aria-hidden="true">
      <path
        d="M4 9a2 2 0 0 1 2-2h8l3 3h13a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"
        fill="color-mix(in srgb, var(--accent) 22%, var(--surface))"
        stroke="color-mix(in srgb, var(--accent) 45%, transparent)"
        strokeWidth="1.5"
      />
    </svg>
  );
}

const BY_EXT: Record<string, string> = {
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  heic: 'image',
  mp4: 'video',
  mkv: 'video',
  mov: 'video',
  avi: 'video',
  webm: 'video',
  mp3: 'audio',
  flac: 'audio',
  wav: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  pdf: 'pdf',
  epub: 'ebook',
  doc: 'word',
  docx: 'word',
  xls: 'spreadsheet',
  xlsx: 'spreadsheet',
  ppt: 'presentation',
  pptx: 'presentation',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  iso: 'disk-image',
  dmg: 'disk-image',
  txt: 'text',
  md: 'markdown',
  csv: 'table',
};

/** An icon from a file name alone, for places that only know the name (transfers). */
export const iconForName = (name: string) =>
  BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'file';
