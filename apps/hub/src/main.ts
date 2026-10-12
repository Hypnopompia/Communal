#!/usr/bin/env node
/**
 * M0 hub skeleton: proves the image, ports and protocol package wire up. It sends the session
 * `challenge`, answers `ping`, and runs the two-port UDP NAT-probe responder (HANDOFF §8).
 * Accounts, auth and everything else arrive in M1.
 */
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import { WebSocketServer } from 'ws';
import { generateKeyPair, keyPairFromSecret, toB64, type KeyPair } from '@communal/crypto';
import { encodeHub, MAX_FRAME_BYTES, parseClientMessage } from '@communal/protocol';

const log = pino({ name: 'hub' });

const env = {
  dataDir: process.env.COMMUNAL_HUB_DATA ?? './hub-data',
  port: Number(process.env.COMMUNAL_HUB_PORT ?? 8443),
  probePorts: [
    Number(process.env.COMMUNAL_PROBE_PORT_A ?? 3478),
    Number(process.env.COMMUNAL_PROBE_PORT_B ?? 3479),
  ] as [number, number],
  hubId: process.env.COMMUNAL_HUB_ID ?? 'dev-hub',
};

function loadHubKey(dir: string): KeyPair {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'hub.key');
  try {
    return keyPairFromSecret(new Uint8Array(readFileSync(file)));
  } catch {
    const kp = generateKeyPair();
    writeFileSync(file, kp.secretKey, { mode: 0o600 });
    log.info('generated new hub key');
    return kp;
  }
}

const hubKey = loadHubKey(env.dataDir);

const http = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hub_id: env.hubId, hub_pubkey: toB64(hubKey.publicKey) }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http, path: '/v1', maxPayload: MAX_FRAME_BYTES });

wss.on('connection', (ws, req) => {
  const session = randomBytes(8).toString('hex');
  const slog = log.child({ session_id: session });
  slog.info({ remote: req.socket.remoteAddress }, 'client connected');
  ws.send(
    encodeHub('challenge', {
      nonce: toB64(randomBytes(32)),
      hub_id: env.hubId,
      hub_pubkey: toB64(hubKey.publicKey),
    }),
  );
  ws.on('message', (data) => {
    const res = parseClientMessage(data.toString());
    if (!res.ok) {
      ws.send(encodeHub('error', { code: res.code, message: res.message }, { re: res.re }));
      return;
    }
    if (res.msg.t === 'ping') {
      ws.send(encodeHub('pong', {}, { re: res.msg.id }));
      return;
    }
    ws.send(
      encodeHub('error', { code: 'internal', message: 'not implemented yet' }, { re: res.msg.id }),
    );
  });
  ws.on('close', () => slog.info('client disconnected'));
});

// NAT probe: reply to each datagram with the address/port we observed it from. A client sends
// from one local socket to both ports; differing observed ports mean a symmetric NAT.
for (const port of env.probePorts) {
  const sock = createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    if (msg.length > 64) return; // never amplify
    sock.send(
      JSON.stringify({ addr: rinfo.address, port: rinfo.port, probe: port }),
      rinfo.port,
      rinfo.address,
    );
  });
  sock.bind(port, () => log.info({ port }, 'nat probe listening'));
}

http.listen(env.port, () =>
  log.info(
    { port: env.port, hub_id: env.hubId, tls: false },
    'hub listening (plain ws until TLS lands in M1)',
  ),
);

const shutdown = () => {
  log.info('shutting down');
  wss.close();
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
