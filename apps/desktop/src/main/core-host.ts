/**
 * The core engine inside Electron's `utilityProcess` (HANDOFF §3). Like `communal daemon`, it
 * runs `CommunalCore` and serves the local API, here on 127.0.0.1 with a bearer token that only
 * the main process knows. It never imports Electron: the core must not depend on it.
 */
import { pino } from 'pino';
import { keyPairFromSecret } from '@communal/crypto';
import { CommunalCore, LocalApi, RouterPortMapper } from '@communal/core';
import type { FromHost, HostInit, ToHost } from '../shared/host.js';

const port = process.parentPort;
const send = (m: FromHost) => port.postMessage(m);
const log = pino({ level: process.env.COMMUNAL_LOG ?? 'info' });

let running: { core: CommunalCore; api: LocalApi } | undefined;

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
  const api = new LocalApi(core);
  const url = await api.listen({ host: '127.0.0.1', port: 0, token: init.token });
  running = { core, api };
  send({ t: 'ready', url, deviceId: core.deviceId });
}

async function stop() {
  if (running) {
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
});
