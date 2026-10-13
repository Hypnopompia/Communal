import type { CommunalCore } from './core.js';
import { ffmpegVersion } from './media/ffmpeg.js';

export type SelfCheck = Record<string, { ok: boolean; detail?: string }>;

/**
 * Checks that the parts of the core that depend on the platform actually load and run here:
 * native modules (SQLite, the UDP transport, sharp, canvas), the ffmpeg binary, pdf.js and the
 * OS trash helper. A packaged desktop app or a fresh server install runs this to catch a
 * missing or mismatched binary before a person hits it (`GET /v1/self-check`).
 */
export async function selfCheck(core: CommunalCore): Promise<SelfCheck> {
  const out: SelfCheck = {};
  const check = async (name: string, f: () => Promise<string | undefined> | string | undefined) => {
    try {
      const detail = await f();
      out[name] = { ok: true, ...(detail ? { detail } : {}) };
    } catch (err) {
      out[name] = { ok: false, detail: (err as Error).message };
    }
  };
  await check('sqlite', () => `${core.store.counts().files} files indexed`);
  await check('transport', () => {
    if (!core.transport.port) throw new Error('UDP socket not bound');
    return `UDP port ${core.transport.port}`;
  });
  await check('sharp', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } })
      .webp()
      .toBuffer();
    return `${png.length} byte test image`;
  });
  await check('canvas', async () => {
    const { createCanvas } = await import('@napi-rs/canvas');
    return `${createCanvas(2, 2).width}px test canvas`;
  });
  await check('pdf', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    return `pdf.js ${pdfjs.version}`;
  });
  await check('ffmpeg', () => ffmpegVersion());
  await check('trash', async () => {
    await import('trash');
    return undefined;
  });
  return out;
}
