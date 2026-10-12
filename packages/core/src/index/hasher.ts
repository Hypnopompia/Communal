import { open } from 'node:fs/promises';
import { createBLAKE3 } from 'hash-wasm';

/** Transfer chunk size (HANDOFF §7); file hashes are defined over these chunks. */
export const CHUNK_SIZE = 1024 * 1024;

export interface FileHash {
  /** Hex BLAKE3 over the concatenated chunk hashes (see docs/adr/0008-indexing.md). */
  hash: string;
  /** 32-byte BLAKE3 of each 1 MiB chunk, concatenated; the transfer manifest (M4). */
  chunkHashes: Uint8Array;
  size: number;
}

/**
 * Hashes a file chunk by chunk. hash = BLAKE3(chunk_hash_0 ‖ chunk_hash_1 ‖ …), so a
 * downloader can check the manifest against the hash before trusting any chunk. An empty file
 * has zero chunks and hash = BLAKE3("").
 */
export interface Hashers {
  chunk: Awaited<ReturnType<typeof createBLAKE3>>;
  root: Awaited<ReturnType<typeof createBLAKE3>>;
  /** Read buffer reused across files (allocating 1 MiB per file thrashes the GC). */
  buf: Buffer;
}

/** A pair of hasher instances for one caller to reuse across files (not shareable concurrently). */
export async function createHashers(): Promise<Hashers> {
  const [chunk, root] = await Promise.all([createBLAKE3(), createBLAKE3()]);
  return { chunk, root, buf: Buffer.allocUnsafe(CHUNK_SIZE) };
}

export async function hashFile(
  absPath: string,
  signal?: AbortSignal,
  hashers?: Hashers,
): Promise<FileHash> {
  const { chunk, root, buf } = hashers ?? (await createHashers());
  const fh = await open(absPath, 'r');
  try {
    const chunkHashes: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      if (signal?.aborted) throw new Error('hashing aborted');
      // Fill a whole chunk (read() may return short counts).
      let filled = 0;
      while (filled < CHUNK_SIZE) {
        const { bytesRead } = await fh.read(buf, filled, CHUNK_SIZE - filled, size + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled === 0) break;
      chunk.init();
      chunk.update(buf.subarray(0, filled));
      chunkHashes.push(chunk.digest('binary'));
      size += filled;
      if (filled < CHUNK_SIZE) break;
    }
    const all = Buffer.concat(chunkHashes);
    root.init();
    root.update(all);
    return { hash: root.digest('hex'), chunkHashes: all, size };
  } finally {
    await fh.close();
  }
}
