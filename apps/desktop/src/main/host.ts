/**
 * Starts the core host in a `utilityProcess` and keeps it running. The main process holds the
 * local API's token and forwards the renderer's `communal://api/...` requests to it, so the
 * renderer never sees the token.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { utilityProcess, type UtilityProcess } from 'electron';
import { WebSocket } from 'ws';
import type { FromHost, HostInit } from '../shared/host.js';
import type { KeyStore } from './keys.js';

import type { HostState } from '../shared/bridge.js';

interface HostEvents {
  state: [HostState];
  topics: [string[]];
}

export class CoreHost extends EventEmitter<HostEvents> {
  private child?: UtilityProcess;
  private readonly token = randomBytes(32).toString('base64url');
  private base?: string;
  private events?: WebSocket;
  private stopping = false;
  private restarts = 0;
  status: HostState = { state: 'starting' };

  constructor(
    private readonly o: Omit<HostInit, 't' | 'token' | 'deviceSecret' | 'rootSecret'> & {
      keys: KeyStore;
    },
  ) {
    super();
  }

  start() {
    this.setState({ state: 'starting' });
    const child = utilityProcess.fork(join(import.meta.dirname, 'core-host.js'), [], {
      serviceName: 'Communal core',
      stdio: 'inherit',
    });
    this.child = child;
    const { keys, ...rest } = this.o;
    const root = keys.rootSecret();
    const init: HostInit = {
      t: 'init',
      ...rest,
      token: this.token,
      deviceSecret: keys.deviceSecret(),
      ...(root ? { rootSecret: root } : {}),
    };
    child.postMessage(init);
    child.on('message', (m: FromHost) => {
      if (m.t === 'ready') {
        this.base = m.url;
        this.restarts = 0;
        this.listen();
        this.setState({ state: 'ready', deviceId: m.deviceId });
      } else if (m.t === 'save-root') keys.saveRoot(new Uint8Array(m.secret));
      else if (m.t === 'fatal') this.setState({ state: 'failed', message: m.message });
    });
    child.on('exit', (code) => {
      this.base = undefined;
      this.events?.terminate();
      if (this.stopping || this.child !== child) return;
      // Crashed: restart with backoff, and give up after a few quick failures in a row.
      if (this.restarts++ < 5) setTimeout(() => this.start(), 500 * 2 ** this.restarts);
      else this.setState({ state: 'failed', message: `the core stopped (exit code ${code})` });
    });
  }

  async stop() {
    this.stopping = true;
    this.events?.terminate();
    const child = this.child;
    if (!child?.pid) return;
    await new Promise<void>((done) => {
      const kill = setTimeout(() => {
        child.kill();
        done();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(kill);
        done();
      });
      child.postMessage({ t: 'stop' });
    });
  }

  /** Forwards one renderer request to the local API. */
  async fetch(path: string, init: { method: string; headers: Headers; body?: ArrayBuffer }) {
    if (!this.base)
      return Response.json({ error: 'unavailable', message: 'core is starting' }, { status: 503 });
    const headers = new Headers();
    for (const h of ['content-type', 'range', 'accept']) {
      const v = init.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('authorization', `Bearer ${this.token}`);
    return fetch(this.base + path, {
      method: init.method,
      headers,
      ...(init.body && init.body.byteLength ? { body: init.body } : {}),
    });
  }

  private listen() {
    const ws = new WebSocket(this.base!.replace(/^http/, 'ws') + '/v1/events', {
      headers: { authorization: `Bearer ${this.token}` },
    });
    this.events = ws;
    ws.on('message', (m: Buffer) => {
      try {
        this.emit('topics', (JSON.parse(m.toString()) as { topics: string[] }).topics);
      } catch {
        // ignore malformed hints
      }
    });
    ws.on('error', () => ws.terminate());
  }

  private setState(s: HostState) {
    this.status = s;
    this.emit('state', s);
  }
}
