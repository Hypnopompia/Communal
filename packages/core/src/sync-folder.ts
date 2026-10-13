import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pino, type Logger } from 'pino';
import { CoreError } from './errors.js';
import type { HubManager } from './hub-manager.js';
import { SYNC_MARKER } from './index/indexer.js';
import type { IndexStore, ShareRow, SubFileRow } from './index/store.js';
import type { Subscriptions } from './subscriptions.js';

/** The synced folder is the share with this name on each of your computers (ADR 0019). */
export const SYNC_SHARE = 'Communal';

/** The marker's content: the same everywhere, so the copies the devices trade never clash. */
const MARKER_TEXT =
  'This folder is kept the same on all your computers by Communal.\n' +
  'Turn that off in Communal (Shares), not by deleting this file: it comes back.\n';

/** Puts the marker in a synced folder, so the folder shows on hubs even when it's empty. */
async function mark(dir: string) {
  const p = join(dir, SYNC_MARKER);
  if (!(await stat(p).catch(() => null))) await writeFile(p, MARKER_TEXT);
}

/** One of your computers, as `devices()` reports it. */
interface OwnDevice {
  device_id: string;
  name: string;
  this_device: boolean;
  revoked: boolean;
  hubs: { hub: string }[];
}

export interface SyncFolderHost {
  store: IndexStore;
  hubs: HubManager;
  subscriptions: Subscriptions;
  devices(): Promise<OwnDevice[]>;
  addShare(name: string, path: string): Promise<ShareRow>;
  removeShare(name: string): Promise<void>;
}

export interface SyncFolderOptions {
  /** How often to look for computers that started or stopped syncing (default 60 s). */
  refreshMs?: number;
  /** Where the folder goes when the person doesn't choose (default ~/Communal). */
  defaultPath?: string;
  log?: Logger;
}

export interface SyncFolderState {
  enabled: boolean;
  /** The folder on this computer, when syncing is on. */
  path: string | null;
  default_path: string;
  /** Your other computers this one syncs with. */
  devices: {
    device_id: string;
    name: string | null;
    hub: string;
    status: 'ok' | 'no_access' | 'paused';
    files: Record<SubFileRow['state'], number>;
  }[];
}

/**
 * A folder kept the same on all your computers (ADR 0019). Turning it on shares a folder as
 * `Communal` (only you can see it), and from then on this computer follows the `Communal`
 * folder of each of your other computers into its own, two-way, deletions included. Computers
 * that turn it on later are found by a periodic look at your device list.
 */
export class SyncFolder {
  private readonly log: Logger;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private again = false;
  private stopped = false;
  private names = new Map<string, string>();

  constructor(
    private readonly host: SyncFolderHost,
    private readonly o: SyncFolderOptions = {},
  ) {
    this.log = o.log ?? pino({ name: 'sync-folder' });
    host.hubs.on('ready', () => this.kick());
    // A device linked or removed: look again now rather than at the next tick.
    host.hubs.on('event', ({ msg }) => {
      if (msg.t === 'link.done' || msg.t === 'device.revoked' || msg.t === 'library.changed')
        this.kick();
    });
  }

  get defaultPath(): string {
    return this.o.defaultPath ?? join(homedir(), SYNC_SHARE);
  }

  start() {
    this.timer = setInterval(() => this.kick(), this.o.refreshMs ?? 60_000);
    this.kick();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }

  private share(): ShareRow | undefined {
    return this.host.store.share(SYNC_SHARE);
  }

  /** Turns syncing on with this folder (default ~/Communal), created if needed. */
  async enable(path?: string): Promise<SyncFolderState> {
    const existing = this.share();
    const dir = path ? resolve(path) : (existing?.root ?? this.defaultPath);
    if (existing && (await realpath(dir).catch(() => dir)) !== existing.root) {
      throw new CoreError(
        'conflict',
        `a folder is already shared as "${SYNC_SHARE}" (${existing.root}); stop sharing it first`,
      );
    }
    if (!existing) {
      await mkdir(dir, { recursive: true });
      await mark(dir);
      // Shared on every hub, and like any new share, seen only by your own devices.
      await this.host.addShare(SYNC_SHARE, dir);
    }
    await this.refresh();
    return this.state();
  }

  /** Turns syncing off: stops sharing the folder and following the others. Files stay. */
  async disable() {
    if (!this.share()) return;
    await this.host.removeShare(SYNC_SHARE);
    await this.refresh();
  }

  state(): SyncFolderState {
    const share = this.share();
    return {
      enabled: !!share,
      path: share?.root ?? null,
      default_path: this.defaultPath,
      devices: this.host.subscriptions
        .list()
        .filter((s) => s.sync)
        .map((s) => ({
          device_id: s.device_id,
          name: this.names.get(s.device_id) ?? null,
          hub: s.hub,
          status: s.paused ? 'paused' : s.status,
          files: s.files,
        })),
    };
  }

  /** Looks again soon; overlapping calls fold into one more pass. */
  kick() {
    if (this.stopped) return;
    void this.refresh().catch((err: Error) =>
      this.log.warn({ err: err.message }, 'synced folder check failed'),
    );
  }

  /** Brings the subscriptions in line with which of your computers share a synced folder. */
  async refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          if (!this.stopped) await this.pass();
        } while (this.again);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async pass() {
    const subs = () => this.host.store.subscriptions().filter((s) => s.sync);
    const share = this.share();
    if (!share) {
      for (const s of subs()) await this.host.subscriptions.remove(s.id);
      return;
    }
    await mark(share.root).catch(() => undefined);
    const ready = this.host.hubs
      .list()
      .filter((h) => h.ready)
      .map((h) => h.id);
    if (ready.length === 0) return;
    let devices: OwnDevice[];
    try {
      devices = await this.host.devices();
    } catch {
      return; // no account yet
    }
    for (const d of devices) this.names.set(d.device_id, d.name);

    for (const d of devices) {
      if (d.this_device) continue;
      const mine = subs().filter((s) => s.device_id === d.device_id);
      if (d.revoked) {
        for (const s of mine) await this.host.subscriptions.remove(s.id);
        continue;
      }
      const on = ready.filter((h) => d.hubs.some((x) => x.hub === h));
      const hub = await this.sharing(d.device_id, on);
      if (hub === undefined) continue; // can't tell right now
      if (hub === null) {
        // Not syncing (any more). Its files here stay; they're just not followed.
        for (const s of mine) await this.host.subscriptions.remove(s.id);
        continue;
      }
      const keep = mine.find((s) => s.dest_dir === share.root);
      for (const s of mine) if (s !== keep) await this.host.subscriptions.remove(s.id);
      if (keep) continue;
      // A subscription made by hand between the two folders (how it was done before this)
      // becomes part of the synced folder.
      let manual;
      for (const s of this.host.store.subscriptions())
        if (
          !s.sync &&
          s.device_id === d.device_id &&
          s.path === `${SYNC_SHARE}/` &&
          (await realpath(s.dest_dir).catch(() => s.dest_dir)) === share.root
        )
          manual = s;
      if (manual) {
        await this.host.subscriptions.update(manual.id, { sync: true, mirror_deletes: true });
        this.log.info({ device: d.device_id }, 'synced folder: took over a subscription');
        continue;
      }
      try {
        await this.host.subscriptions.add({
          hub,
          device: d.device_id,
          path: `${SYNC_SHARE}/`,
          dest: share.root,
          mirrorDeletes: true,
          sync: true,
        });
        this.log.info({ device: d.device_id, hub }, 'synced folder: following another computer');
      } catch (err) {
        this.log.warn(
          { device: d.device_id, err: (err as Error).message },
          'synced folder: could not follow another computer',
        );
      }
    }
  }

  /**
   * Whether `device` shares a synced folder: the hub to follow it through, null when it
   * doesn't, undefined when no hub could say.
   */
  private async sharing(device: string, hubs: string[]): Promise<string | null | undefined> {
    let answered = false;
    for (const hub of hubs) {
      const client = this.host.hubs.get(hub);
      if (!client?.ready) continue;
      try {
        const r = await client.request('browse', { device_id: device, path: '' });
        if (r.t !== 'browse.listing') continue;
        answered = true;
        // A share can be on some hubs only: look on each before saying no.
        if (r.body.dirs.some((x) => x.name === SYNC_SHARE)) return hub;
      } catch {
        // Try the next hub.
      }
    }
    return answered ? null : undefined;
  }
}
