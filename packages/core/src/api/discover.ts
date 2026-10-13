import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LocalApiClient } from './client.js';

/**
 * Where a core with this data dir serves its local API for other programs (the CLI, MCP
 * agents): a Unix socket in the data dir, or on Windows a per-data-dir named pipe.
 */
export function apiSocketPath(dataDir: string): string {
  if (process.platform === 'win32') {
    const id = createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\communal-${id}`;
  }
  return join(dataDir, 'api.sock');
}

/** The desktop app's core data dir (Electron's userData + /core), per platform. */
export function desktopDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.COMMUNAL_USER_DATA) return join(env.COMMUNAL_USER_DATA, 'core');
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library/Application Support/Communal/core');
  if (process.platform === 'win32')
    return join(env.APPDATA ?? join(home, 'AppData/Roaming'), 'Communal/core');
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Communal/core');
}

export interface FoundApi {
  kind: 'headless' | 'desktop' | 'custom';
  socketPath: string;
  client: LocalApiClient;
}

/**
 * Finds a running core to talk to, in order: `COMMUNAL_API_SOCKET`, the headless daemon
 * (`COMMUNAL_DATA` or ~/.communal), then the desktop app (which serves this only while
 * "Allow control from the CLI and AI agents" is on). Null when none answers.
 */
export async function discoverApi(env: NodeJS.ProcessEnv = process.env): Promise<FoundApi | null> {
  const candidates: { kind: FoundApi['kind']; socketPath: string }[] = [];
  if (env.COMMUNAL_API_SOCKET)
    candidates.push({ kind: 'custom', socketPath: env.COMMUNAL_API_SOCKET });
  candidates.push({
    kind: 'headless',
    socketPath: apiSocketPath(env.COMMUNAL_DATA ?? join(homedir(), '.communal')),
  });
  candidates.push({ kind: 'desktop', socketPath: apiSocketPath(desktopDataDir(env)) });
  for (const c of candidates) {
    const client = new LocalApiClient({ socketPath: c.socketPath });
    const alive = await Promise.race([
      client.get('/v1/status').then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1_500)),
    ]);
    if (alive) return { ...c, client };
  }
  return null;
}
