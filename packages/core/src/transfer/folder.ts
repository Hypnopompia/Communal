import { constants } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { HubBody } from '@communal/protocol';
import { CoreError } from '../errors.js';
import { HubError } from '../hub-client.js';
import type { HubManager } from '../hub-manager.js';
import { hashFile } from '../index/hasher.js';
import type { IndexStore } from '../index/store.js';
import { safeName, uniquePath, type Downloads } from './downloader.js';

/** A folder download lists every file first; past this, following the folder fits better. */
export const FOLDER_MAX_FILES = 10_000;

type Entry = HubBody<'browse.listing'>['files'][number];

export interface FolderDownload {
  /** The local folder the files go into: `<dest>/<folder name>`. */
  dest: string;
  /** Files being downloaded now. */
  queued: number;
  /** Files copied from content this computer already had (same hash). */
  copied: number;
  /** Files already at their place with the same content, or already downloading there. */
  skipped: number;
  /** Files the owner's computer hasn't finished preparing (no hash yet): left out. */
  unprepared: number;
  bytes: number;
}

/**
 * Downloads a folder of another device once, keeping its structure under `<destDir>/<folder>`
 * (ADR 0018). The folder is listed with `browse`, one level per request, so the hub's access
 * checks apply as for any browse. Content this computer already holds is copied (cloned where
 * the file system can), never fetched again.
 */
export async function downloadFolder(
  o: { hubs: HubManager; store: IndexStore; downloads: Downloads },
  req: { hub: string; device: string; path: string; destDir: string },
): Promise<FolderDownload> {
  const client = o.hubs.get(req.hub);
  if (!client) throw new CoreError('not_found', `no such hub: ${req.hub}`);
  if (!client.ready) throw new CoreError('unavailable', 'hub is offline');
  const root = req.path.endsWith('/') ? req.path : req.path + '/';
  const leaf = root.slice(0, -1).split('/').pop();
  if (!leaf) throw new CoreError('bad_request', 'choose a folder to download');

  const files: Entry[] = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop()!;
    const listing = await client
      .request('browse', { device_id: req.device, path: dir })
      .catch((err: unknown) => {
        if (err instanceof HubError && err.code === 'not_found')
          throw new CoreError('not_found', 'no such folder, or it is not shared with you');
        throw err;
      });
    if (listing.t !== 'browse.listing') throw new CoreError('not_found', 'no such device');
    files.push(...listing.body.files);
    for (const d of listing.body.dirs) pending.push(`${dir}${d.name}/`);
    if (files.length > FOLDER_MAX_FILES)
      throw new CoreError(
        'bad_request',
        `that folder has more than ${FOLDER_MAX_FILES.toLocaleString('en')} files; download a smaller folder or subscribe to it`,
      );
  }
  if (files.length === 0)
    throw new CoreError('not_found', 'no such folder, or nothing in it is shared with you');

  const dest = join(req.destDir, safeName(leaf));
  const out: FolderDownload = { dest, queued: 0, copied: 0, skipped: 0, unprepared: 0, bytes: 0 };
  const underway = o.store.transfers(['queued', 'active', 'waiting']);
  for (const e of files) {
    if (!e.hash) {
      out.unprepared++;
      continue;
    }
    const segs = e.path.slice(root.length).split('/').map(safeName);
    const name = segs.pop()!;
    const dir = join(dest, ...segs);
    const here = join(dir, name);
    if (
      underway.some((t) => t.hash === e.hash && t.dest_dir === dir && t.name === name) ||
      (await holds(o.store, here, e.hash, e.size))
    ) {
      out.skipped++;
      continue;
    }
    await mkdir(dir, { recursive: true });
    const have = await localCopy(o.store, e.hash);
    if (have) {
      // A clone on file systems that have them (APFS, btrfs), a plain copy elsewhere.
      await copyFile(have, await uniquePath(dir, name), constants.COPYFILE_FICLONE);
      out.copied++;
      continue;
    }
    o.downloads.add({ hash: e.hash, name, destDir: dir });
    out.queued++;
    out.bytes += e.size;
  }
  return out;
}

/** Whether `path` holds this content: from the index when it's in a share, else by hashing. */
async function holds(store: IndexStore, path: string, hash: string, size: number) {
  const st = await stat(path).catch(() => null);
  if (!st?.isFile() || st.size !== size) return false;
  for (const c of store.anyCopy(hash))
    if (join(c.root, ...c.rel.split('/')) === path && c.mtime === Math.floor(st.mtimeMs))
      return true;
  return (await hashFile(path).catch(() => null))?.hash === hash;
}

/** A file in our shares with this content that's still as the index last saw it. */
async function localCopy(store: IndexStore, hash: string): Promise<string | null> {
  for (const c of store.anyCopy(hash)) {
    const p = join(c.root, ...c.rel.split('/'));
    const st = await stat(p).catch(() => null);
    if (st?.isFile() && st.size === c.size && Math.floor(st.mtimeMs) === c.mtime) return p;
  }
  return null;
}
