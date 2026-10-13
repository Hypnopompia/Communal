/**
 * Electron main process (HANDOFF §3, §11). It owns the window, the keys (`safeStorage`) and the
 * core host process, and proxies the renderer's API calls. It holds no app logic of its own:
 * everything the screens do goes through the core's local API.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  shell,
  Tray,
} from 'electron';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { CoreHost } from './host.js';
import { PrefsFile } from './prefs.js';
import { KeyStore } from './keys.js';
import { Updater } from './updater.js';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'communal',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const dev = !app.isPackaged;
// Dev-only switches take effect only in dev builds (ADR 0006).
const devBuild = dev && process.env.COMMUNAL_BUILD === 'dev';
if (process.env.COMMUNAL_USER_DATA) app.setPath('userData', process.env.COMMUNAL_USER_DATA);

let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showWindow());
  void app.whenReady().then(start);
}

function start() {
  const smokeTest = process.env.COMMUNAL_SMOKE === '1';
  const keys = new KeyStore(app.getPath('userData'), !smokeTest);
  if (!keys.encrypted && !smokeTest)
    console.warn('safeStorage is unavailable: keys are stored unencrypted with mode 0600');
  const prefs = new PrefsFile(app.getPath('userData'));
  const host = new CoreHost({
    keys,
    control: prefs.value.control,
    dataDir: join(app.getPath('userData'), 'core'),
    downloadsDir: process.env.COMMUNAL_DOWNLOADS ?? join(app.getPath('downloads'), 'Communal'),
    version: app.getVersion(),
    insecureTls: devBuild && process.env.COMMUNAL_DEV_TLS === 'self-signed',
    upnp: process.env.COMMUNAL_UPNP !== 'false',
  });
  const updater = new Updater(!dev);

  // communal://api/<path> → the local API, with the token added here.
  protocol.handle('communal', async (req) => {
    const url = new URL(req.url);
    if (url.host !== 'api') return new Response(null, { status: 404 });
    const body =
      req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
    const res = await host.fetch(url.pathname + url.search, {
      method: req.method,
      headers: req.headers,
      ...(body ? { body } : {}),
    });
    // The renderer's origin differs in dev (Vite's server) and packaged builds (file://).
    const headers = new Headers(res.headers);
    headers.set('access-control-allow-origin', '*');
    return new Response(res.body, { status: res.status, headers });
  });

  host.on('state', (s) => win?.webContents.send('host:state', s));
  host.on('topics', (t) => win?.webContents.send('core:topics', t));
  host.on('control', () => win?.webContents.send('agents:state', agentsState(host)));
  // An agent asked to show a screen: bring the window forward and go there.
  host.on('ui', (route) => {
    showWindow();
    win?.webContents.send('ui:navigate', route);
  });
  updater.on('state', (s) => win?.webContents.send('update:state', s));

  ipcMain.handle('host:state', () => host.status);
  ipcMain.handle('agents:get', () => agentsState(host));
  ipcMain.handle('agents:set', (_e, on: boolean) => {
    prefs.set({ control: on });
    host.setControl(on);
    return agentsState(host);
  });
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text));
  ipcMain.handle('app:device-name', () => hostname().split('.')[0] || hostname());
  ipcMain.handle('dialog:folder', async (_e, title: string) => {
    const r = await dialog.showOpenDialog(win!, {
      title,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('dialog:open-text', async (_e, title: string, extensions: string[]) => {
    const r = await dialog.showOpenDialog(win!, {
      title,
      properties: ['openFile'],
      filters: [{ name: title, extensions }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const text = await readFile(r.filePaths[0], 'utf8');
    return text.length > 1024 * 1024 ? null : text;
  });
  ipcMain.handle('dialog:save-text', async (_e, title: string, name: string, text: string) => {
    const r = await dialog.showSaveDialog(win!, { title, defaultPath: name });
    if (r.canceled || !r.filePath) return false;
    await writeFile(r.filePath, text, { mode: 0o600 });
    return true;
  });
  ipcMain.handle('shell:open', (_e, p: string) => shell.openPath(p).then(() => undefined));
  ipcMain.handle('shell:show', (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.handle('shell:external', (_e, url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle('update:install', () => {
    quitting = true;
    updater.install();
  });

  host.start();
  if (smokeTest) return void smoke(host);
  createWindow();
  createTray();
  updater.start();

  app.on('activate', () => showWindow());
  // Quitting stops the core cleanly first (index flushed, hubs told we're leaving).
  let stopped = false;
  app.on('before-quit', (e) => {
    quitting = true;
    if (stopped) return;
    e.preventDefault();
    void host.stop().finally(() => {
      stopped = true;
      app.quit();
    });
  });
}

/**
 * `COMMUNAL_SMOKE=1`: no window. Waits for the core in its utilityProcess, checks that the
 * native modules, ffmpeg and the API proxy work, then quits with 0 (or 1 and the reason).
 * CI runs it against the dev build and the packaged app (`pnpm --filter @communal/desktop smoke`).
 */
function smoke(host: CoreHost) {
  const fail = (why: string) => {
    console.error(`smoke: FAILED: ${why}`);
    app.exit(1);
  };
  const timer = setTimeout(() => fail('the core did not start within 60 s'), 60_000);
  host.on('state', (s) => {
    if (s.state === 'failed') return fail(s.message);
    if (s.state !== 'ready') return;
    void (async () => {
      const res = await host.fetch('/v1/self-check', { method: 'GET', headers: new Headers() });
      const body = (await res.json()) as { ok: boolean; checks: Record<string, unknown> };
      console.log(`smoke: ${JSON.stringify(body.checks)}`);
      clearTimeout(timer);
      if (!res.ok || !body.ok) return fail('a check failed');
      quitting = true;
      await host.stop();
      app.exit(0);
    })().catch((err: Error) => fail(err.message));
  });
}

/**
 * The control socket's state plus how to connect an MCP client to this install: this app's own
 * binary runs the bundled MCP server as plain Node (ELECTRON_RUN_AS_NODE), so nothing else needs
 * installing (ADR 0017).
 */
function agentsState(host: CoreHost) {
  const script = join(
    dirname(createRequire(import.meta.url).resolve('@communal/mcp/package.json')),
    'dist/main.js',
  );
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
  if (process.env.COMMUNAL_USER_DATA) env.COMMUNAL_USER_DATA = process.env.COMMUNAL_USER_DATA;
  const quote = (s: string) => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const envFlags = Object.entries(env)
    .map(([k, v]) => `--env ${k}=${quote(v)}`)
    .join(' ');
  return {
    ...host.control,
    claudeCode: `claude mcp add --scope user communal ${envFlags} -- ${quote(process.execPath)} ${quote(script)}`,
    json: JSON.stringify(
      { mcpServers: { communal: { command: process.execPath, args: [script], env } } },
      null,
      2,
    ),
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'Communal',
    show: false,
    backgroundColor: '#f7f6f3',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: join(import.meta.dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--communal-version=${app.getVersion()}`],
    },
  });
  win.once('ready-to-show', () => win?.show());
  // The window never navigates away from the app; links open in the browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Closing the window keeps sharing in the background; quit from the tray or app menu.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });
  if (dev && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

function showWindow() {
  if (!win) return createWindow();
  win.show();
  win.focus();
}

function createTray() {
  // macOS tints a template image to suit the menu bar; elsewhere the colour icon reads better.
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'icon.png';
  const icon = nativeImage.createFromPath(join(import.meta.dirname, '../../resources', file));
  if (icon.isEmpty()) return;
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Communal');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Communal', click: () => showWindow() },
      { type: 'separator' },
      {
        label: 'Quit Communal',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => showWindow());
}
