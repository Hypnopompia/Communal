import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Downloads } from '../transfer/downloader.js';
import { IndexStore } from './store.js';

let dir: string;
let store: IndexStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'communal-clear-'));
  store = new IndexStore(join(dir, 'index.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (
  id: string,
  state: 'queued' | 'active' | 'waiting' | 'done' | 'failed' | 'cancelled',
) => {
  store.addTransfer({ id, hash: 'ab'.repeat(32), name: `${id}.bin`, dest_dir: dir, size: 10 });
  if (state !== 'queued') store.updateTransfer(id, { state });
};

describe('clearing Transfers and Activity', () => {
  it('forgets finished downloads only, and drops a failed one’s partial file', async () => {
    for (const s of ['queued', 'active', 'waiting', 'done', 'failed', 'cancelled'] as const)
      add(`t_${s}`, s);
    writeFileSync(join(dir, 't_failed.bin.part'), 'x');
    writeFileSync(join(dir, 't_failed.bin.partmap'), 'x');
    writeFileSync(join(dir, 't_done.bin'), 'the download itself');
    const downloads = new Downloads({
      store,
      hubs: new EventEmitter(),
      log: pino({ level: 'silent' }),
    } as never);

    expect(await downloads.clearFinished()).toBe(3);
    expect(
      store
        .transfers()
        .map((t) => t.id)
        .sort(),
    ).toEqual(['t_active', 't_queued', 't_waiting']);
    expect(existsSync(join(dir, 't_done.bin'))).toBe(true);
    expect(existsSync(join(dir, 't_failed.bin.part'))).toBe(false);
    expect(existsSync(join(dir, 't_failed.bin.partmap'))).toBe(false);
  });

  it('keeps a finished download a subscription is still waiting on', () => {
    add('t_sub', 'done');
    add('t_other', 'done');
    store.addSubscription({
      id: 's_1',
      hub: 'h',
      device_id: 'd_x',
      path: 'Share/',
      recursive: true,
      dest_dir: dir,
      mirror_deletes: false,
    });
    store.putSubFile({
      sub_id: 's_1',
      path: 'Share/a',
      hash: 'ab'.repeat(32),
      state: 'pending',
      transfer_id: 't_sub',
      local: null,
      prev: null,
    });
    expect(store.clearFinishedTransfers().map((t) => t.id)).toEqual(['t_other']);
    expect(store.transfer('t_sub')).toBeDefined();
  });

  it('empties the upload log', () => {
    for (let i = 0; i < 3; i++)
      store.logUpload({
        hub: 'h',
        requester_user: 'u_x',
        requester_dev: 'd_x',
        path: `S/${i}`,
        hash: 'ab'.repeat(32),
        bytes: 1,
        status: 'completed',
        kind: 'file',
      });
    expect(store.clearUploadLog()).toBe(3);
    expect(store.uploadLog()).toEqual([]);
  });
});
