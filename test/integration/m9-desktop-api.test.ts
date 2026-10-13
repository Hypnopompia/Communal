/**
 * M9: local API additions the desktop app relies on: settings that survive a restart, and the
 * thumbnail cache controls (ADR 0016).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPair, type KeyPair } from '@communal/crypto';
import { CommunalCore, LocalApi, LocalApiClient } from '@communal/core';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function serve(dataDir: string, device: KeyPair, uploads = {}) {
  const core = new CommunalCore({ dataDir, device, uploads, log: pino({ level: 'silent' }) });
  await core.start();
  const api = new LocalApi(core);
  const url = await api.listen({ host: '127.0.0.1', port: 0, token: 'sekret-token-123' });
  const stop = async () => {
    await api.close();
    await core.stop();
  };
  return { core, cli: new LocalApiClient({ url, token: 'sekret-token-123' }), stop };
}

describe('M9: desktop settings over the local API', () => {
  it('keeps upload and storage settings across a restart, over the host defaults', async () => {
    const dir = tmp('communal-m9-');
    const key = generateKeyPair();
    const first = await serve(dir, key, { maxConcurrent: 2 });
    expect(await first.cli.get('/v1/settings/uploads')).toMatchObject({ maxConcurrent: 2 });
    await first.cli.put('/v1/settings/uploads', { maxConcurrent: 7, lanOnly: true });
    const storage = await first.cli.put<{ thumb_cache: { cap: number; bytes: number } }>(
      '/v1/settings/storage',
      { thumb_cache_bytes: 64 * 1024 * 1024 },
    );
    expect(storage.thumb_cache).toEqual({ cap: 64 * 1024 * 1024, bytes: 0 });
    await expect(
      first.cli.put('/v1/settings/storage', { thumb_cache_bytes: 1 }),
    ).rejects.toMatchObject({ status: 400 });
    await first.stop();

    // The host still passes its default; what the person chose wins.
    const again = await serve(dir, key, { maxConcurrent: 2 });
    cleanups.push(again.stop);
    expect(await again.cli.get('/v1/settings/uploads')).toMatchObject({
      maxConcurrent: 7,
      lanOnly: true,
    });
    expect(await again.cli.get('/v1/settings/storage')).toMatchObject({
      thumb_cache: { cap: 64 * 1024 * 1024 },
    });
    expect(await again.cli.post('/v1/settings/storage/clear', {})).toMatchObject({
      thumb_cache: { bytes: 0, cap: 64 * 1024 * 1024 },
    });
  });

  it('reports that every platform piece loads and runs (self-check)', async () => {
    const s = await serve(tmp('communal-m9-'), generateKeyPair());
    cleanups.push(s.stop);
    const r = await s.cli.get<{ ok: boolean; checks: Record<string, { ok: boolean }> }>(
      '/v1/self-check',
    );
    expect(Object.keys(r.checks).sort()).toEqual(
      ['canvas', 'ffmpeg', 'pdf', 'sharp', 'sqlite', 'transport', 'trash'].sort(),
    );
    expect(r).toMatchObject({ ok: true });
  });
});
