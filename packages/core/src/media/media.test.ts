import { mkdtempSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detect } from '../index/detect.js';
import { analyze, render, PREVIEW_SIZE } from './analyze.js';
import { parseReport } from './ffmpeg.js';
import { mixedFolder } from './fixtures.js';
import { iconFor } from './icons.js';
import { isWebp } from './thumbs.js';

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'communal-media-'));
  await mixedFolder(dir);
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(name: string) {
  const abs = join(dir, name);
  const t = await detect(abs, name);
  const r = await analyze(abs, t.mime, t.kind, (await stat(abs)).size);
  return { ...t, ...r, icon: iconFor(t.mime, name, t.kind) };
}

async function exifOf(webp: Buffer) {
  const sharp = (await import('sharp')).default;
  return sharp(webp).metadata();
}

describe('metadata, thumbnails and icons for a mixed folder (HANDOFF §9)', () => {
  it('photo: displayed size, capture date, rotated thumbnail with all EXIF/GPS stripped', async () => {
    const r = await run('holiday.jpg');
    expect(r).toMatchObject({ kind: 'image', mime: 'image/jpeg', icon: 'image' });
    // Orientation 6: stored 400×300, shown 300×400.
    expect(r.meta).toMatchObject({ width: 300, height: 400 });
    expect(new Date(r.meta.taken_at! * 1000).getFullYear()).toBe(2021);
    expect(isWebp(r.thumb!)).toBe(true);
    const m = await exifOf(r.thumb!);
    expect(m.format).toBe('webp');
    expect(Math.max(m.width, m.height)).toBe(320);
    expect(m.height).toBeGreaterThan(m.width); // rotated before stripping the orientation
    expect(m.exif).toBeUndefined();
    expect(m.xmp).toBeUndefined();
    expect(m.icc).toBeUndefined();
    // The original has a position; the thumbnail has none.
    const exifr = (await import('exifr')).default;
    expect((await exifr.gps(join(dir, 'holiday.jpg')))?.latitude).toBeCloseTo(51.5, 1);
    expect(await exifr.gps(r.thumb!).catch(() => undefined)).toBeUndefined();
    // Nothing in the bytes that looks like EXIF or a GPS tag.
    expect(r.thumb!.includes(Buffer.from('Exif'))).toBe(false);
    expect(r.thumb!.includes(Buffer.from('TestCam'))).toBe(false);
  });

  it('wide PNG: size, and a thumbnail never larger than 320 on its longest side', async () => {
    const r = await run('diagram.png');
    expect(r.meta).toEqual({ width: 800, height: 200 });
    const m = await exifOf(r.thumb!);
    expect([m.width, m.height]).toEqual([320, 80]);
  });

  it('video: duration, size and codec; a frame as thumbnail', async () => {
    const r = await run('clip.mp4');
    expect(r).toMatchObject({ kind: 'video', icon: 'video' });
    expect(r.meta).toMatchObject({ width: 640, height: 360, codec: 'h264' });
    expect(r.meta.duration).toBeCloseTo(3, 0);
    expect((await exifOf(r.thumb!)).width).toBe(320);
  });

  it('audio: tags and duration; the embedded cover becomes the thumbnail', async () => {
    const r = await run('song.mp3');
    expect(r).toMatchObject({ kind: 'audio', icon: 'audio' });
    expect(r.meta).toMatchObject({ artist: 'The Testers', album: 'Fixtures', title: 'Sine Song' });
    expect(r.meta.duration).toBeCloseTo(2, 0);
    expect(isWebp(r.thumb!)).toBe(true);
  });

  it('PDF: pages and title; page 1 as thumbnail, and a 1600 px preview on demand', async () => {
    const r = await run('report.pdf');
    expect(r).toMatchObject({ kind: 'document', icon: 'pdf' });
    expect(r.meta).toEqual({ pages: 3, title: 'Annual Report' });
    expect((await exifOf(r.thumb!)).height).toBe(320);
    const abs = join(dir, 'report.pdf');
    const big = await render(
      abs,
      'application/pdf',
      'document',
      (await stat(abs)).size,
      PREVIEW_SIZE,
    );
    expect((await exifOf(big!)).height).toBe(1600);
  });

  it('text, code and unknown files: icons, no metadata, no thumbnail', async () => {
    expect(await run('notes.md')).toMatchObject({
      kind: 'text',
      icon: 'markdown',
      meta: {},
      thumb: null,
    });
    expect(await run('main.rs')).toMatchObject({ kind: 'code', icon: 'code', thumb: null });
    expect(await run('data.csv')).toMatchObject({ icon: 'table', thumb: null });
    expect(await run('blob.bin')).toMatchObject({ kind: 'other', icon: 'file', thumb: null });
  });

  it('a file that only claims to be an image yields nothing, without throwing', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'fake.jpg'), 'not really a jpeg');
    const r = await run('fake.jpg');
    expect(r).toMatchObject({ kind: 'image', meta: {}, thumb: null });
  });
});

describe('ffmpeg report parsing', () => {
  it('reads duration, the video stream, and skips cover art', () => {
    expect(
      parseReport(
        `  Duration: 01:02:03.50, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv), 3840x2160 [SAR 1:1 DAR 16:9], 24 fps`,
      ),
    ).toEqual({ video: true, duration: 3723.5, codec: 'hevc', width: 3840, height: 2160 });
    expect(
      parseReport(`  Duration: 00:03:00.00, start: 0.025057, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s
  Stream #0:1: Video: png, rgb24(pc), 500x500, 90k tbr, 90k tbn (attached pic)`),
    ).toEqual({ video: false, duration: 180 });
  });
});
