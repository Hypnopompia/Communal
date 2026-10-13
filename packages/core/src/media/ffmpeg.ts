import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * ffmpeg for video metadata and frames (ADR 0012). One binary does both: its stream report
 * (`ffmpeg -i`) carries duration, size and codec, so there's no separate ffprobe.
 *
 * Which ffmpeg: `COMMUNAL_FFMPEG`, else the `ffmpeg-static` binary (a static build for this
 * platform, fetched at install), else `ffmpeg` on PATH. null when none can be found.
 */
let resolved: string | null | undefined;
export function ffmpegPath(): string | null {
  if (resolved !== undefined) return resolved;
  if (process.env.COMMUNAL_FFMPEG) return (resolved = process.env.COMMUNAL_FFMPEG);
  try {
    const p = createRequire(import.meta.url)('ffmpeg-static') as string | null;
    if (p) return (resolved = p);
  } catch {
    // not installed: fall through
  }
  return (resolved = 'ffmpeg');
}

interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Runs ffmpeg with a hard timeout and an output cap (never trust a media file). */
function run(args: string[], timeoutMs = 30_000, maxOut = 32 * 1024 * 1024): Promise<RunResult> {
  const bin = ffmpegPath();
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('ffmpeg not available'));
    const p = spawn(bin, ['-hide_banner', '-nostdin', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d: Buffer) => {
      outLen += d.length;
      if (outLen > maxOut) p.kill('SIGKILL');
      else out.push(d);
    });
    p.stderr.on('data', (d: Buffer) => {
      if (err.length < 64 * 1024) err += d.toString();
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

export interface VideoInfo {
  duration?: number;
  width?: number;
  height?: number;
  codec?: string;
  /** Whether there's a video stream (an audio-only file has none). */
  video: boolean;
}

/** Parses ffmpeg's input report: `Duration: 00:01:02.50` and `Stream #0:0…: Video: h264 …, 1920x1080`. */
export function parseReport(report: string): VideoInfo {
  const info: VideoInfo = { video: false };
  const d = /Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(report);
  if (d) info.duration = Math.round((+d[1]! * 3600 + +d[2]! * 60 + +d[3]!) * 100) / 100;
  for (const line of report.split('\n')) {
    const m = /Stream #\d+:\d+.*?: Video: ([a-z0-9_]+)/i.exec(line);
    if (!m) continue;
    // Embedded cover art shows up as a video stream too; skip it.
    if (/\(attached pic\)/.test(line)) continue;
    info.video = true;
    info.codec = m[1]!.toLowerCase();
    const wh = /, (\d{2,5})x(\d{2,5})[\s,[]/.exec(line);
    if (wh) {
      info.width = +wh[1]!;
      info.height = +wh[2]!;
    }
    break;
  }
  return info;
}

/** The first line of `ffmpeg -version` (installs and self-checks), or throws. */
export async function ffmpegVersion(): Promise<string> {
  const r = await run(['-version'], 10_000, 1024 * 1024);
  if (r.code !== 0) throw new Error(`ffmpeg exited with ${r.code}`);
  return r.stdout.toString().split('\n')[0] ?? '';
}

export async function probe(abs: string): Promise<VideoInfo> {
  // With no output given ffmpeg exits non-zero after printing the input report: that's fine.
  const r = await run(['-i', abs], 15_000);
  return parseReport(r.stderr);
}

/** One frame at `atSeconds` as PNG (scaled down to at most `maxSide`), or null. */
export async function frame(
  abs: string,
  atSeconds: number,
  maxSide: number,
): Promise<Buffer | null> {
  const scale = `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`;
  const r = await run([
    '-ss',
    String(Math.max(0, atSeconds)),
    '-i',
    abs,
    '-frames:v',
    '1',
    '-vf',
    scale,
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    '-',
  ]);
  return r.code === 0 && r.stdout.length > 0 ? r.stdout : null;
}
