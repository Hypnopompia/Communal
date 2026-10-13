/**
 * Auto-update through electron-updater (HANDOFF §12 M9). It only runs in packaged builds that
 * were published with an update feed (`publish` in electron-builder.yml writes
 * `app-update.yml`). Updates download in the background and install on the next quit, or
 * right away when the person clicks "Restart to update".
 */
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import electronUpdater from 'electron-updater';
import type { UpdateState } from '../shared/bridge.js';

const { autoUpdater } = electronUpdater;

export class Updater extends EventEmitter<{ state: [UpdateState] }> {
  private timer?: NodeJS.Timeout;

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
    const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
    check();
    this.timer = setInterval(check, 6 * 3600_000);
    this.timer.unref();
  }

  install() {
    autoUpdater.quitAndInstall();
  }
}
