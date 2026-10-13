/**
 * The core engine inside Electron's `utilityProcess` (HANDOFF §3). Like `communal daemon`, it
 * runs `CommunalCore` and serves the local API, here on 127.0.0.1 with a bearer token that only
 * the main process knows. It never imports Electron: the core must not depend on it.
 */
import { pino } from 'pino';
import { keyPairFromSecret } from '@communal/crypto';
import {
  apiSocketPath,
  CommunalCore,
  LocalApi,
  RouterPortMapper,
  type UiRoute,
} from '@communal/core';
import type { FromHost, HostInit, ToHost } from '../shared/host.js';

const port = process.parentPort;
const send = (m: FromHost) => port.postMessage(m);
const log = pino({ level: process.env.COMMUNAL_LOG ?? 'info' });

/** Agents can move the window to a screen (`POST /v1/ui/show`); main does the moving. */
const ui = { show: (route: UiRoute) => send({ t: 'ui', route }) };

let running: { core: CommunalCore; api: LocalApi; dataDir: string } | undefined;
/** The API on the local socket, for the CLI and AI agents, while the person allows it. */
let control: LocalApi | undefined;

async function setControl(on: boolean) {
  if (!running) return;
  if (!on) {
    await control?.close();
    control = undefined;
    return send({ t: 'control', socket: null });
  }
  if (control) return;
  const api = new LocalApi(running.core, ui);
  try {
    const socket = await api.listen({ socketPath: apiSocketPath(running.dataDir) });
    control = api;
    send({ t: 'control', socket });
  } catch (err) {
    await api.close();
    send({ t: 'control', socket: null, error: (err as Error).message });
  }
}

async function start(init: HostInit) {
  const core = new CommunalCore({
    dataDir: init.dataDir,
    device: keyPairFromSecret(init.deviceSecret),
    hubClient: {
      client: { name: 'communal-desktop', version: init.version },
      insecureTls: init.insecureTls,
    },
    network: init.upnp ? { mapper: new RouterPortMapper({ log }) } : {},
    downloadsDir: init.downloadsDir,
    root: {
      ...(init.rootSecret ? { secret: init.rootSecret } : {}),
      save: (secret) => send({ t: 'save-root', secret }),
    },
    log,
  });
  // A fatal error on one hub (banned, key changed) leaves the others running.
  core.hubs.on('fatal', ({ hub, error }) =>
    log.error({ hub, reason: error.reason }, error.message),
  );
  const prune = setInterval(() => core.store.pruneUploadLog(365), 86_400_000);
  prune.unref();
  await core.start();
  const api = new LocalApi(core, ui);
  const url = await api.listen({ host: '127.0.0.1', port: 0, token: init.token });
  running = { core, api, dataDir: init.dataDir };
  send({ t: 'ready', url, deviceId: core.deviceId });
  if (init.control) await setControl(true);
}

async function stop() {
  if (running) {
    await control?.close();
    await running.api.close();
    await running.core.stop();
    running = undefined;
  }
  send({ t: 'stopped' });
  process.exit(0);
}

port.on('message', (e: { data: ToHost }) => {
  const m = e.data;
  if (m.t === 'init')
    start(m).catch((err: Error) => {
      log.error({ err }, 'core failed to start');
      send({ t: 'fatal', message: err.message });
    });
  else if (m.t === 'stop') void stop();
  else if (m.t === 'control') void setControl(m.on);
});
