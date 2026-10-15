/**
 * Auto-update through electron-updater (HANDOFF §12 M9). It only runs in packaged builds that
 * were published with an update feed (`publish` in electron-builder.yml writes
 * `app-update.yml`). Updates download in the background and install on the next quit, or
 * right away when the person clicks "Restart to update".
 *
 * It checks at start, on waking from sleep, and whenever 6 hours of wall-clock time have passed.
 * A plain 6-hour interval isn't enough: its clock stops while the computer sleeps, so a laptop
 * that sleeps between uses would rarely get past the check at start.
 */
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { powerMonitor } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateState } from '../shared/bridge.js';

const { autoUpdater } = electronUpdater;

const EVERY_MS = 6 * 3600_000;
const TICK_MS = 15 * 60_000;

export class Updater extends EventEmitter<{ state: [UpdateState] }> {
  private timer?: NodeJS.Timeout;
  private checkedAt = 0;

  constructor(private readonly enabled: boolean) {
    super();
  }

  start() {
    if (!this.enabled || !existsSync(join(process.resourcesPath, 'app-update.yml'))) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (i: { version: string }) =>
      this.emit('state', { state: 'available', version: i.version }),
    );
    autoUpdater.on('update-downloaded', (i: { version: string }) =>
      this.emit('state', { state: 'downloaded', version: i.version }),
    );
    autoUpdater.on('error', (err: Error) =>
      this.emit('state', { state: 'error', message: err.message }),
    );
    this.check();
    this.timer = setInterval(() => {
      if (Date.now() - this.checkedAt >= EVERY_MS) this.check();
    }, TICK_MS);
    this.timer.unref();
    // Give the network a minute to come back after waking.
    powerMonitor.on('resume', () => setTimeout(() => this.check(), 60_000).unref());
  }

  private check() {
    this.checkedAt = Date.now();
    void autoUpdater.checkForUpdates().catch(() => undefined);
  }

  install() {
    autoUpdater.quitAndInstall();
  }
}
