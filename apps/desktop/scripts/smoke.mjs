// Starts the built app with no window: the core must start in its utilityProcess and pass its
// self-check (src/main/index.ts). Exits non-zero otherwise. `pnpm --filter @communal/desktop smoke`
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(join(app, 'package.json'))('electron');
const data = mkdtempSync(join(tmpdir(), 'communal-smoke-'));
// Chromium refuses to run as root with its sandbox (containers, some CI); only then turn it off.
const asRoot = process.platform === 'linux' && process.getuid?.() === 0;
const r = spawnSync(electron, asRoot ? [app, '--no-sandbox'] : [app], {
  stdio: 'inherit',
  env: { ...process.env, COMMUNAL_SMOKE: '1', COMMUNAL_UPNP: 'false', COMMUNAL_USER_DATA: data },
});
rmSync(data, { recursive: true, force: true });
process.exit(r.status ?? 1);
