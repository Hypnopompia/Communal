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

/**
 * The app mark: three overlapping hexagons, people's shelves with what they share in the middle
 * (left see-through). Paths from `build/mark.svg`, made by scripts/icons.mjs.
 */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fillRule="evenodd"
        fill="#4d7cff"
        d="M7.3 1.1L7.6 1L7.8 0.9L8 0.8L8.3 0.8L8.5 0.8L8.8 0.9L9 1L9.2 1.1L14.5 4.1L14.7 4.2L14.9 4.4L15.1 4.6L15.2 4.8L15.3 5L15.4 5.2L15.4 5.5L15.4 5.8L15.4 11.8L15.4 12.1L15.4 12.3L15.3 12.6L15.2 12.8L15.1 13L14.9 13.2L14.7 13.3L14.5 13.5L9.2 16.5L9 16.6L8.8 16.7L8.5 16.7L8.3 16.8L8 16.7L7.8 16.7L7.6 16.6L7.3 16.5L2.1 13.5L1.9 13.3L1.7 13.2L1.5 13L1.4 12.8L1.3 12.6L1.2 12.3L1.1 12.1L1.1 11.8L1.1 5.8L1.1 5.5L1.2 5.2L1.3 5L1.4 4.8L1.5 4.6L1.7 4.4L1.9 4.2L2.1 4.1ZM8.7 12.6L8.6 12.3L8.6 12.1L8.6 11.8L8.6 8.9L11 7.5L11.3 7.4L11.5 7.3L11.8 7.3L12 7.2L12.2 7.3L12.5 7.3L12.7 7.4L13 7.5L15.4 8.9L15.4 11.8L15.4 12.1L15.4 12.3L15.3 12.6L15.2 12.8L15.1 13L14.9 13.2L14.7 13.3L14.5 13.5L12 14.9L9.5 13.5L9.3 13.3L9.1 13.2L8.9 13L8.8 12.8Z"
      />
      <path
        fillRule="evenodd"
        fill="#1fb383"
        d="M14.8 1.1L15 1L15.2 0.9L15.5 0.8L15.7 0.8L16 0.8L16.2 0.9L16.4 1L16.7 1.1L21.9 4.1L22.1 4.2L22.3 4.4L22.5 4.6L22.6 4.8L22.7 5L22.8 5.2L22.9 5.5L22.9 5.8L22.9 11.8L22.9 12.1L22.8 12.3L22.7 12.6L22.6 12.8L22.5 13L22.3 13.2L22.1 13.3L21.9 13.5L16.7 16.5L16.4 16.6L16.2 16.7L16 16.7L15.7 16.8L15.5 16.7L15.2 16.7L15 16.6L14.8 16.5L9.5 13.5L9.3 13.3L9.1 13.2L8.9 13L8.8 12.8L8.7 12.6L8.6 12.3L8.6 12.1L8.6 11.8L8.6 5.8L8.6 5.5L8.6 5.2L8.7 5L8.8 4.8L8.9 4.6L9.1 4.4L9.3 4.2L9.5 4.1ZM8.7 12.6L8.6 12.3L8.6 12.1L8.6 11.8L8.6 8.9L11 7.5L11.3 7.4L11.5 7.3L11.8 7.3L12 7.2L12.2 7.3L12.5 7.3L12.7 7.4L13 7.5L15.4 8.9L15.4 11.8L15.4 12.1L15.4 12.3L15.3 12.6L15.2 12.8L15.1 13L14.9 13.2L14.7 13.3L14.5 13.5L12 14.9L9.5 13.5L9.3 13.3L9.1 13.2L8.9 13L8.8 12.8Z"
      />
      <path
        fillRule="evenodd"
        fill="#f4b23c"
        d="M11 7.5L11.3 7.4L11.5 7.3L11.8 7.3L12 7.2L12.2 7.3L12.5 7.3L12.7 7.4L13 7.5L18.2 10.5L18.4 10.7L18.6 10.8L18.8 11L18.9 11.2L19 11.4L19.1 11.7L19.1 11.9L19.2 12.2L19.2 18.2L19.1 18.5L19.1 18.8L19 19L18.9 19.2L18.8 19.4L18.6 19.6L18.4 19.8L18.2 19.9L13 22.9L12.7 23L12.5 23.1L12.2 23.2L12 23.2L11.8 23.2L11.5 23.1L11.3 23L11 22.9L5.8 19.9L5.6 19.8L5.4 19.6L5.2 19.4L5.1 19.2L5 19L4.9 18.8L4.9 18.5L4.8 18.2L4.8 12.2L4.9 11.9L4.9 11.7L5 11.4L5.1 11.2L5.2 11L5.4 10.8L5.6 10.7L5.8 10.5ZM8.7 12.6L8.6 12.3L8.6 12.1L8.6 11.8L8.6 8.9L11 7.5L11.3 7.4L11.5 7.3L11.8 7.3L12 7.2L12.2 7.3L12.5 7.3L12.7 7.4L13 7.5L15.4 8.9L15.4 11.8L15.4 12.1L15.4 12.3L15.3 12.6L15.2 12.8L15.1 13L14.9 13.2L14.7 13.3L14.5 13.5L12 14.9L9.5 13.5L9.3 13.3L9.1 13.2L8.9 13L8.8 12.8Z"
      />
      <path
        fillRule="evenodd"
        fill="#2aa6c8"
        d="M12 2.7L14.5 4.1L14.7 4.2L14.9 4.4L15.1 4.6L15.2 4.8L15.3 5L15.4 5.2L15.4 5.5L15.4 5.8L15.4 11.8L15.4 12.1L15.4 12.3L15.3 12.6L15.2 12.8L15.1 13L14.9 13.2L14.7 13.3L14.5 13.5L12 14.9L9.5 13.5L9.3 13.3L9.1 13.2L8.9 13L8.8 12.8L8.7 12.6L8.6 12.3L8.6 12.1L8.6 11.8L8.6 5.8L8.6 5.5L8.6 5.2L8.7 5L8.8 4.8L8.9 4.6L9.1 4.4L9.3 4.2L9.5 4.1ZM8.7 12.6L8.6 12.3L8.6 12.1L8.6 11.8L8.6 8.9L11 7.5L11.3 7.4L11.5 7.3L11.8 7.3L12 7.2L12.2 7.3L12.5 7.3L12.7 7.4L13 7.5L15.4 8.9L15.4 11.8L15.4 12.1L15.4 12.3L15.3 12.6L15.2 12.8L15.1 13L14.9 13.2L14.7 13.3L14.5 13.5L12 14.9L9.5 13.5L9.3 13.3L9.1 13.2L8.9 13L8.8 12.8Z"
      />
      <path
        fillRule="evenodd"
        fill="#a8c740"
        d="M19.2 12.2L19.2 15.1L16.7 16.5L16.4 16.6L16.2 16.7L16 16.7L15.7 16.8L15.5 16.7L15.2 16.7L15 16.6L14.8 16.5L9.5 13.5L9.3 13.3L9.1 13.2L8.9 13L8.8 12.8L8.7 12.6L8.6 12.3L8.6 12.1L8.6 11.8L8.6 8.9L11 7.5L11.3 7.4L11.5 7.3L11.8 7.3L12 7.2L12.2 7.3L12.5 7.3L12.7 7.4L13 7.5L18.2 10.5L18.4 10.7L18.6 10.8L18.8 11L18.9 11.2L19 11.4L19.1 11.7L19.1 11.9ZM8.7 12.6L8.6 12.3L8.6 12.1L8.6 11.8L8.6 8.9L11 7.5L11.3 7.4L11.5 7.3L11.8 7.3L12 7.2L12.2 7.3L12.5 7.3L12.7 7.4L13 7.5L15.4 8.9L15.4 11.8L15.4 12.1L15.4 12.3L15.3 12.6L15.2 12.8L15.1 13L14.9 13.2L14.7 13.3L14.5 13.5L12 14.9L9.5 13.5L9.3 13.3L9.1 13.2L8.9 13L8.8 12.8Z"
      />
      <path
        fillRule="evenodd"
        fill="#ee7d6a"
        d="M9 16.6L8.8 16.7L8.5 16.7L8.3 16.8L8 16.7L7.8 16.7L7.6 16.6L7.3 16.5L4.8 15.1L4.8 12.2L4.9 11.9L4.9 11.7L5 11.4L5.1 11.2L5.2 11L5.4 10.8L5.6 10.7L5.8 10.5L11 7.5L11.3 7.4L11.5 7.3L11.8 7.3L12 7.2L12.2 7.3L12.5 7.3L12.7 7.4L13 7.5L15.4 8.9L15.4 11.8L15.4 12.1L15.4 12.3L15.3 12.6L15.2 12.8L15.1 13L14.9 13.2L14.7 13.3L14.5 13.5L9.2 16.5ZM8.7 12.6L8.6 12.3L8.6 12.1L8.6 11.8L8.6 8.9L11 7.5L11.3 7.4L11.5 7.3L11.8 7.3L12 7.2L12.2 7.3L12.5 7.3L12.7 7.4L13 7.5L15.4 8.9L15.4 11.8L15.4 12.1L15.4 12.3L15.3 12.6L15.2 12.8L15.1 13L14.9 13.2L14.7 13.3L14.5 13.5L12 14.9L9.5 13.5L9.3 13.3L9.1 13.2L8.9 13L8.8 12.8Z"
      />
    </svg>
  );
}

/**
 * What kind of device something is (ADR 0023: Mac, Windows, Linux or Android), drawn as line
 * marks in the same style as the other icons. Anything else gets the plain computer.
 */
const PLATFORM_PATHS: Record<string, string> = {
  darwin:
    'M10 6.6c-.9-.7-2-1-3-.8-1.9.4-3 2.2-2.8 4.5.3 3 2 6.2 3.7 6.2.9 0 1.2-.5 2.1-.5s1.2.5 2.1.5c1.7 0 3.4-3.2 3.7-6.2.2-2.3-.9-4.1-2.8-4.5-1-.2-2.1.1-3 .8zM10.2 5.6c.1-1.5 1-2.6 2.5-3-.1 1.5-1 2.6-2.5 3z',
  win32:
    'M3.5 3.5h5.3v5.3H3.5zM11.2 3.5h5.3v5.3h-5.3zM3.5 11.2h5.3v5.3H3.5zM11.2 11.2h5.3v5.3h-5.3z',
  linux:
    'M10 2.5c-1.9 0-3 1.5-3 3.6 0 1.3-.4 2.1-1.2 3.3-1 1.5-1.8 3-1.5 4.6.3 1.6 2 2.5 5.7 2.5s5.4-.9 5.7-2.5c.3-1.6-.5-3.1-1.5-4.6-.8-1.2-1.2-2-1.2-3.3 0-2.1-1.1-3.6-3-3.6zM10 9.5c-1.6 0-2.5 1.7-2.5 3.5s.9 2.9 2.5 2.9 2.5-1.1 2.5-2.9-.9-3.5-2.5-3.5zM8.9 5.4v.4M11.1 5.4v.4M9.2 7.2h1.6L10 8z',
  android: 'M4 14.5a6 6 0 0 1 12 0zM6.6 9.4 5 6.8M13.4 9.4 15 6.8M7.9 12v.1M12.1 12v.1',
};

export function platformLabel(platform: string | undefined): string {
  return platform === 'darwin'
    ? 'Mac'
    : platform === 'win32'
      ? 'Windows'
      : platform === 'linux'
        ? 'Linux'
        : platform === 'android'
          ? 'Android'
          : 'Computer';
}

/** A device's kind as an icon, with its name ("Mac") as the tooltip and accessible label. */
export function PlatformIcon({ platform, size = 18 }: { platform?: string; size?: number }) {
  const label = platformLabel(platform);
  return (
    <svg
      className="platform-icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <path d={PLATFORM_PATHS[platform ?? ''] ?? paths.device} />
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
