import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { createBLAKE3 } from 'hash-wasm';
import { detect, kindFor } from './detect.js';
import { CHUNK_SIZE, hashFile } from './hasher.js';
import { Indexer, isIgnored } from './indexer.js';
import { IndexStore } from './store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'communal-idx-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f50000000049454e44ae426082',
  'hex',
);

describe('type detection', () => {
  it('trusts magic bytes over a misleading extension', async () => {
    writeFileSync(join(dir, 'photo.txt'), PNG);
    expect(await detect(join(dir, 'photo.txt'), 'photo.txt')).toEqual({
      mime: 'image/png',
      kind: 'image',
    });
  });

  it('falls back to the extension for formats without magic', async () => {
    writeFileSync(join(dir, 'notes.md'), '# hi');
    writeFileSync(join(dir, 'main.rs'), 'fn main() {}');
    writeFileSync(join(dir, 'blob.weird'), Buffer.from([1, 2, 3]));
    writeFileSync(join(dir, 'app.ts'), 'export const x = 1;');
    expect(await detect(join(dir, 'app.ts'), 'app.ts')).toEqual({
      mime: 'text/typescript',
      kind: 'code',
    });
    expect((await detect(join(dir, 'notes.md'), 'notes.md')).kind).toBe('text');
    expect((await detect(join(dir, 'main.rs'), 'main.rs')).kind).toBe('code');
    expect(await detect(join(dir, 'blob.weird'), 'blob.weird')).toEqual({
      mime: 'application/octet-stream',
      kind: 'other',
    });
  });

  it.each([
    ['video/x-matroska', 'a.mkv', 'video'],
    ['audio/flac', 'a.flac', 'audio'],
    ['application/pdf', 'a.pdf', 'document'],
    ['application/x-7z-compressed', 'a.7z', 'archive'],
    ['application/octet-stream', 'ubuntu.iso', 'disk_image'],
    ['application/octet-stream', 'Makefile', 'code'],
  ] as const)('%s %s → %s', (mime, name, kind) => expect(kindFor(mime, name)).toBe(kind));
});

describe('hashing', () => {
  it('hashes the empty file as BLAKE3 of no chunk hashes', async () => {
    writeFileSync(join(dir, 'empty'), '');
    const h = await hashFile(join(dir, 'empty'));
    const b = await createBLAKE3();
    expect(h).toMatchObject({ size: 0, hash: b.init().update(new Uint8Array(0)).digest('hex') });
    expect(h.chunkHashes).toHaveLength(0);
  });

  it('defines the file hash over 1 MiB chunk hashes', async () => {
    const data = Buffer.alloc(CHUNK_SIZE * 2 + 123).map((_, i) => (i * 7) & 0xff);
    writeFileSync(join(dir, 'f'), data);
    const h = await hashFile(join(dir, 'f'));
    const b = await createBLAKE3();
    const chunks = [0, 1, 2].map((i) =>
      b
        .init()
        .update(data.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE))
        .digest('binary'),
    );
    expect(h.size).toBe(data.length);
    expect(Buffer.from(h.chunkHashes)).toEqual(Buffer.concat(chunks));
    expect(h.hash).toBe(b.init().update(Buffer.concat(chunks)).digest('hex'));
  });
});

describe('indexer', () => {
  const quiet = pino({ level: 'silent' });

  function setup() {
    const root = join(dir, 'share');
    mkdirSync(join(root, 'sub', 'deep'), { recursive: true });
    const store = new IndexStore(join(dir, 'index.db'));
    store.addShare('Stuff', root, []);
    const idx = new Indexer(store, { flushMs: 50, log: quiet });
    return { root, store, idx };
  }

  async function until(cond: () => boolean, ms = 5_000) {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('skips junk, dotfiles and symlinks', async () => {
    const { root, store, idx } = setup();
    writeFileSync(join(root, 'a.txt'), 'a');
    writeFileSync(join(root, 'sub', 'deep', 'b.png'), PNG);
    for (const junk of ['.DS_Store', 'Thumbs.db', 'movie.mkv.part', '.hidden'])
      writeFileSync(join(root, junk), 'x');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), 'x');
    // Creating symlinks needs admin rights on Windows.
    if (process.platform !== 'win32') {
      symlinkSync('/etc', join(root, 'escape'));
      symlinkSync(join(root, 'a.txt'), join(root, 'link.txt'));
    }
    expect(await idx.scan('Stuff')).toBe(2);
    expect(store.file('Stuff', 'sub/deep/b.png')).toMatchObject({
      kind: 'image',
      size: PNG.length,
    });
    expect(isIgnored('.git')).toBe(true);
    store.close();
  });

  it('hashes in the background, then follows edits, deletes and new folders', async () => {
    const { root, store, idx } = setup();
    writeFileSync(join(root, 'a.txt'), 'hello');
    let changes = 0;
    idx.on('changed', () => changes++);
    await idx.start();
    await until(() => store.counts().hashed === 1);
    const first = store.file('Stuff', 'a.txt')!.hash;
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    // Edit: metadata updates, the old hash is dropped, then re-hashed.
    writeFileSync(join(root, 'a.txt'), 'hello, world');
    await until(() => {
      const f = store.file('Stuff', 'a.txt');
      return !!f && f.size === 12 && f.hash !== null && f.hash !== first;
    });

    // New nested folder appears; a file is deleted.
    mkdirSync(join(root, 'new', 'inner'), { recursive: true });
    writeFileSync(join(root, 'new', 'inner', 'c.md'), '# c');
    unlinkSync(join(root, 'a.txt'));
    await until(() => !!store.file('Stuff', 'new/inner/c.md') && !store.file('Stuff', 'a.txt'));

    // Folder removed: everything under it goes.
    rmSync(join(root, 'new'), { recursive: true });
    await until(() => store.counts().files === 0);
    expect(changes).toBeGreaterThan(0);
    await idx.stop();
    store.close();
  });

  it('rescans on start and logs only what changed since last time', async () => {
    const { root, store, idx } = setup();
    writeFileSync(join(root, 'keep.txt'), 'k');
    writeFileSync(join(root, 'gone.txt'), 'g');
    await idx.scan('Stuff');
    const before = store.maxSeq();
    unlinkSync(join(root, 'gone.txt'));
    writeFileSync(join(root, 'new.txt'), 'n');
    await idx.scan('Stuff');
    const log = store.changesSince(before, 100).map((c) => `${c.op} ${c.rel}`);
    expect(log.sort()).toEqual(['remove gone.txt', 'upsert new.txt']);
    store.close();
  });

  it('keeps the hash of a renamed or moved file instead of hashing it again', async () => {
    const { root, store, idx } = setup();
    writeFileSync(join(root, 'a.txt'), 'same content');
    writeFileSync(join(root, 'sub', 'x.bin'), 'xx');
    writeFileSync(join(root, 'sub', 'y.bin'), 'yy');
    await idx.start();
    await until(() => store.counts().hashed === 3);
    const hash = store.file('Stuff', 'a.txt')!.hash;
    // Watch the hasher: an adopted hash means renamed files never go back into its queue.
    const queued: string[] = [];
    const next = store.nextUnhashed.bind(store);
    store.nextUnhashed = (n) => {
      const rows = next(n);
      queued.push(...rows.map((r) => r.rel));
      return rows;
    };

    // Live rename: its unlink and add in one watcher batch. The events are fed in by hand
    // because macOS can drop folder events outright under heavy disk load (FSEvents), e.g. while
    // the M2 test writes 100k files; only the periodic rescan would then notice the move.
    await idx.removeShare('Stuff');
    renameSync(join(root, 'a.txt'), join(root, 'sub', 'b.txt'));
    idx.touch('Stuff', 'a.txt');
    idx.touch('Stuff', 'sub/b.txt');
    await idx.flush(); // also wakes the hasher
    expect(store.file('Stuff', 'a.txt')).toBeUndefined();
    expect(store.file('Stuff', 'sub/b.txt')!.hash).toBe(hash);
    await new Promise((r) => setTimeout(r, 100));
    expect(queued).not.toContain('sub/b.txt');

    // … and one only a scan sees.
    renameSync(join(root, 'sub', 'b.txt'), join(root, 'c.txt'));
    await idx.rescanAll(); // also wakes the hasher
    expect(store.file('Stuff', 'c.txt')!.hash).toBe(hash);
    await new Promise((r) => setTimeout(r, 100));
    expect(queued).not.toContain('c.txt');

    // Two vanished files alike can't be told apart: both new names are hashed afresh.
    const t = new Date('2024-01-01T00:00:00Z');
    for (const n of ['x.bin', 'y.bin']) utimesSync(join(root, 'sub', n), t, t);
    await idx.scan('Stuff');
    renameSync(join(root, 'sub', 'x.bin'), join(root, 'x2.bin'));
    renameSync(join(root, 'sub', 'y.bin'), join(root, 'y2.bin'));
    await idx.scan('Stuff');
    expect(store.file('Stuff', 'x2.bin')!.hash).toBeNull();
    await idx.stop();
    store.close();
  });

  it('catches siblings the watcher missed when anything in their folder changes', async () => {
    const root = join(dir, 'share');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'a');
    writeFileSync(join(root, 'sub', 'keep.txt'), 'k');
    const store = new IndexStore(join(dir, 'index.db'));
    store.addShare('Stuff', root, []);
    const idx = new Indexer(store, { flushMs: 10_000, log: quiet });
    await idx.start();
    // No watcher: every event below is "missed" except the one reported by hand.
    await idx.removeShare('Stuff');
    writeFileSync(join(root, 'b.txt'), 'b');
    writeFileSync(join(root, 'c.txt'), 'c');
    unlinkSync(join(root, 'a.txt'));
    writeFileSync(join(root, '.DS_Store'), 'junk');
    idx.noteChange('Stuff', 'b.txt');
    await idx.flush();
    const rels = () => [...store.fileNamesIn('Stuff', '')].sort();
    expect(rels()).toEqual(['b.txt', 'c.txt']);
    // Files in other folders are left to their own events (and the periodic rescan).
    expect([...store.fileNamesIn('Stuff', 'sub')]).toEqual(['keep.txt']);
    await idx.stop();
    store.close();
  });

  it('catches changes the watcher missed with a periodic rescan', async () => {
    const root = join(dir, 'share');
    mkdirSync(root);
    writeFileSync(join(root, 'a.txt'), 'a');
    const store = new IndexStore(join(dir, 'index.db'));
    store.addShare('Stuff', root, []);
    const idx = new Indexer(store, { flushMs: 10_000, rescanMs: 200, log: quiet });
    await idx.start();
    // Stop the watcher so only the rescan can notice the delete.
    await idx.removeShare('Stuff');
    unlinkSync(join(root, 'a.txt'));
    await until(() => store.counts().files === 0, 3_000);
    await idx.stop();
    store.close();
  });
});
