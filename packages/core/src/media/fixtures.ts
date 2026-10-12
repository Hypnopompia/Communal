import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpegPath } from './ffmpeg.js';

/*
 * Real media files for tests, generated on the fly (no binary fixtures in the repo): a JPEG
 * with EXIF (incl. GPS and a rotation), a PNG, an MP4 test pattern, an MP3 with tags and cover
 * art, a hand-built PDF, plus text and code.
 */

/** A minimal valid PDF with `pages` pages and a document title. */
export function makePdf(title: string, pages = 2): Buffer {
  const objs: string[] = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  const font = 3 + pages * 2;
  for (let i = 0; i < pages; i++) {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents ${4 + i * 2} 0 R ` +
        `/Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
    const s = `BT /F1 24 Tf 40 300 Td (Page ${i + 1}) Tj ET 0 0 1 rg 40 40 220 120 re f`;
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objs.push(`<< /Title (${title}) >>`);
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out +=
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\n` +
    `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(
      ffmpegPath() ?? 'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', ...args],
      (e) => (e ? reject(e) : resolve()),
    ),
  );
}

/** A JPEG photo with a capture date, GPS position and a 90° rotation in its EXIF. */
export async function photoWithExif(path: string, width = 400, height = 300) {
  const sharp = (await import('sharp')).default;
  await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'TestCam' },
      IFD2: { DateTimeOriginal: '2021:06:01 12:30:00' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '51/1 30/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 7/1 0/1',
      },
    })
    // Set after withExif: sharp writes the orientation tag itself.
    .withMetadata({ orientation: 6 })
    .toFile(path);
}

export async function png(path: string, width: number, height: number, seed = 0) {
  const sharp = (await import('sharp')).default;
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: (seed * 37) % 255, g: (seed * 91) % 255, b: (seed * 13) % 255 },
    },
  })
    .png()
    .toFile(path);
}

/** A 3 s, 640×360 H.264 test pattern. */
export async function video(path: string) {
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-t', '3',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', path,
  ]); // prettier-ignore
}

/** A 2 s MP3 with ID3 tags and embedded cover art. */
export async function song(path: string, dir: string) {
  const cover = join(dir, '.cover.png');
  await png(cover, 200, 200, 7);
  await ffmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-i', cover,
    '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'png', '-disposition:v', 'attached_pic',
    '-id3v2_version', '3', '-metadata', 'artist=The Testers', '-metadata', 'album=Fixtures',
    '-metadata', 'title=Sine Song', path,
  ]); // prettier-ignore
}

/** The mixed folder of HANDOFF §12 M6, written into `dir`. Returns the file names. */
export async function mixedFolder(dir: string) {
  await photoWithExif(join(dir, 'holiday.jpg'));
  await png(join(dir, 'diagram.png'), 800, 200);
  await video(join(dir, 'clip.mp4'));
  await song(join(dir, 'song.mp3'), dir);
  await writeFile(join(dir, 'report.pdf'), makePdf('Annual Report', 3));
  await writeFile(join(dir, 'notes.md'), '# Notes\n\nhello world\n');
  await writeFile(join(dir, 'main.rs'), 'fn main() { println!("hi"); }\n');
  await writeFile(join(dir, 'data.csv'), 'a,b\n1,2\n');
  await writeFile(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 250, 251]));
}
