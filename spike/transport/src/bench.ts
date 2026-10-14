#!/usr/bin/env node
/**
 * M0 peer-transport spike: udx-native (reliable streams over UDP) + Noise XX via
 * @hyperswarm/secret-stream, authenticated with Communal device keys.
 *
 *   tsx src/bench.ts local [--bytes 1G]
 *       Spawns an uploader and a downloader process on 127.0.0.1 and moves --bytes between them.
 *
 *   Either mode takes --streams N (parallel udx streams on the one socket, each with its own
 *   Noise session) and --stats (udx congestion state every second).
 *
 *   tsx src/bench.ts peer --me alice --peer bob --role up|down --port 41641 \
 *       --peer-addr host:port [--bytes 1G]
 *       One side of a transfer, for runs between containers or LAN hosts. Start both sides;
 *       order doesn't matter (both punch, then connect).
 *
 * Identities are derived from the --me/--peer names so the two sides can find each other's
 * expected keys without a hub. Each side proves its device key in the Noise handshake, then
 * sends its account cert chain, which the other side verifies against the expected root.
 */
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { createHash, randomFillSync } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import SecretStream from '@hyperswarm/secret-stream';
import UDX, { type UDXSocket } from 'udx-native';
import { blake3 } from '@noble/hashes/blake3.js';
import {
  bytesEqual,
  deviceId,
  fromB64,
  issueDeviceCert,
  keyPairFromSecret,
  userId,
  utf8,
  verifyCertChain,
  type CertChain,
  type KeyPair,
} from '@communal/crypto';
import type { Duplex } from 'node:stream';

// Stream ids are exchanged via the hub in production (connect.offer/answer); fixed here.
const UP_STREAM_ID = 1;
const DOWN_STREAM_ID = 2;
const BLOCK = 1024 * 1024;

interface Identity {
  name: string;
  root: KeyPair;
  device: KeyPair;
  chain: CertChain;
}

function identity(name: string): Identity {
  const root = keyPairFromSecret(blake3(utf8(`spike-root:${name}`)));
  const device = keyPairFromSecret(blake3(utf8(`spike-device:${name}`)));
  const chain = [issueDeviceCert(root, userId(root.publicKey), device.publicKey, 1_700_000_000)];
  return { name, root, device, chain };
}

function sodiumKeyPair(kp: KeyPair) {
  const secretKey = Buffer.alloc(64);
  secretKey.set(kp.secretKey, 0);
  secretKey.set(kp.publicKey, 32);
  return { publicKey: Buffer.from(kp.publicKey), secretKey };
}

function parseBytes(s: string): number {
  const m = /^(\d+(?:\.\d+)?)([KMG]?)$/i.exec(s);
  if (!m) throw new Error(`bad size: ${s}`);
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[
    m[2]!.toUpperCase() as '' | 'K' | 'M' | 'G'
  ];
  return Math.round(Number(m[1]) * mult);
}

function log(role: string, msg: string) {
  process.stderr.write(`[${role}] ${msg}\n`);
}

/** Reads exactly n bytes from a stream (in paused/readable mode). */
async function readExactly(s: Duplex, n: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let got = 0;
  while (got < n) {
    const chunk = s.read() as Buffer | null;
    if (chunk === null) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          s.off('readable', done);
          s.off('end', onEnd);
          s.off('error', reject);
          resolve();
        };
        const onEnd = () => reject(new Error('stream ended early'));
        s.once('readable', done);
        s.once('end', onEnd);
        s.once('error', reject);
      });
      continue;
    }
    if (got + chunk.length > n) {
      const need = n - got;
      parts.push(chunk.subarray(0, need));
      s.unshift(chunk.subarray(need));
      got = n;
    } else {
      parts.push(chunk);
      got += chunk.length;
    }
  }
  return Buffer.concat(parts, n);
}

async function write(s: Duplex, buf: Uint8Array): Promise<void> {
  if (!s.write(buf)) await new Promise((r) => s.once('drain', r));
}

/** Length-prefixed JSON control frame, used only for the identity exchange. */
async function sendJson(s: Duplex, obj: unknown) {
  const body = Buffer.from(JSON.stringify(obj));
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(body.length);
  await write(s, Buffer.concat([hdr, body]));
}

async function recvJson<T>(s: Duplex): Promise<T> {
  const len = (await readExactly(s, 4)).readUInt32BE(0);
  if (len > 64 * 1024) throw new Error('control frame too large');
  return JSON.parse((await readExactly(s, len)).toString()) as T;
}

/**
 * Hole punch: fire a few raw datagrams at the peer so both NATs/firewalls open a mapping,
 * then let udx take over. On a LAN or loopback this is a no-op in effect.
 */
async function punch(socket: UDXSocket, port: number, host: string) {
  for (let i = 0; i < 5; i++) {
    socket.trySend(Buffer.from('communal-punch'), port, host);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function authenticate(
  role: string,
  s: SecretStream,
  me: Identity,
  peer: { root: Uint8Array; deviceId: string },
) {
  await new Promise<void>((resolve, reject) => {
    s.once('connect', resolve);
    s.once('error', reject);
  });
  const remote = s.remotePublicKey;
  if (!remote) throw new Error('no remote key after handshake');
  // 1) Noise proved the peer holds `remote`; it must be the device the hub told us about.
  if (deviceId(remote) !== peer.deviceId) throw new Error('peer device key mismatch');
  // 2) Exchange cert chains; the peer's must chain `remote` to the expected account root.
  await sendJson(s, {
    root_pubkey: Buffer.from(me.root.publicKey).toString('base64url'),
    chain: me.chain,
  });
  const theirs = await recvJson<{ root_pubkey: string; chain: CertChain }>(s);
  if (!bytesEqual(fromB64(theirs.root_pubkey), peer.root)) throw new Error('peer root mismatch');
  const res = verifyCertChain(peer.root, remote, theirs.chain);
  if (!res.ok) throw new Error(`peer cert chain rejected: ${res.reason}`);
  log(role, `authenticated peer ${res.device_id} of ${res.user_id}`);
}

async function runPeer(opts: {
  me: string;
  peer: string;
  role: 'up' | 'down';
  port: number;
  peerHost: string;
  peerPort: number;
  bytes: number;
  streams: number;
  stats: boolean;
}) {
  const me = identity(opts.me);
  const them = identity(opts.peer);
  const udx = new UDX();
  const socket = udx.createSocket();
  socket.bind(opts.port, '0.0.0.0');
  // Bigger kernel buffers help a lot on fast links; ignore failures (capped by the OS).
  try {
    socket.setRecvBufferSize(8 * 1024 * 1024);
    socket.setSendBufferSize(8 * 1024 * 1024);
  } catch {
    /* best effort */
  }

  await punch(socket, opts.peerPort, opts.peerHost);
  // Several streams share the one socket, each with its own Noise session and congestion state.
  const n = opts.streams;
  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: n }, (_, k) =>
      runStream(udx, socket, opts, k, Math.ceil(opts.bytes / n), me, them),
    ),
  );
  if (opts.role === 'down') {
    const secs = (performance.now() - t0) / 1000;
    const total = results.reduce((a, r) => a + r.bytes, 0);
    const ok = results.every((r) => r.ok);
    const result = {
      ok,
      streams: n,
      bytes: total,
      seconds: Number(secs.toFixed(2)),
      MBps: Number((total / 1e6 / secs).toFixed(1)),
      Mbps: Number(((total * 8) / 1e6 / secs).toFixed(0)),
      rtt_ms: results[0]!.rtt,
    };
    console.log(JSON.stringify(result));
    if (!ok) process.exitCode = 1;
  }
  await socket.close();
}

async function runStream(
  udx: UDX,
  socket: UDXSocket,
  opts: { role: 'up' | 'down'; peerHost: string; peerPort: number; stats: boolean },
  k: number,
  bytes: number,
  me: Identity,
  them: Identity,
): Promise<{ ok: boolean; bytes: number; rtt: number }> {
  const [localId, remoteId] =
    opts.role === 'up'
      ? [UP_STREAM_ID + 2 * k, DOWN_STREAM_ID + 2 * k]
      : [DOWN_STREAM_ID + 2 * k, UP_STREAM_ID + 2 * k];
  const raw = udx.createStream(localId);
  raw.connect(socket, remoteId, opts.peerPort, opts.peerHost);

  // The downloader initiates the Noise handshake, matching who sends `hello` in §7.
  const s = new SecretStream(opts.role === 'down', raw, { keyPair: sodiumKeyPair(me.device) });
  s.setTimeout(15_000);
  await authenticate(opts.role, s, me, {
    root: them.root.publicKey,
    deviceId: deviceId(them.device.publicKey),
  });

  const stats =
    opts.stats && k === 0
      ? setInterval(() => {
          const r = raw as unknown as Record<string, number>;
          log(
            opts.role,
            `cwnd ${r.cwnd} inflight ${r.inflight} mtu ${r.mtu} srtt ${r.rtt} bbr ${r.bbrState} ` +
              `bw ${r.bbrBandwidth} retx ${r.retransmits} rto ${r.rtoCount} fr ${r.fastRecoveries}`,
          );
        }, 1000)
      : undefined;
  let out = { ok: true, bytes, rtt: 0 };
  if (opts.role === 'up') {
    const block = randomFillSync(Buffer.alloc(BLOCK));
    const hash = createHash('sha256');
    const hdr = Buffer.alloc(8);
    hdr.writeBigUInt64BE(BigInt(bytes));
    await write(s, hdr);
    let sent = 0;
    const t0 = performance.now();
    while (sent < bytes) {
      // Vary each block so the hash covers ordering, not just content.
      block.writeUInt32BE(sent / BLOCK, 0);
      const n = Math.min(BLOCK, bytes - sent);
      const piece = n === BLOCK ? block : block.subarray(0, n);
      hash.update(piece);
      await write(s, Buffer.from(piece));
      sent += n;
    }
    await write(s, hash.digest());
    await readExactly(s, 1); // ack
    const secs = (performance.now() - t0) / 1000;
    if (k === 0) log('up', `sent ${sent} bytes in ${secs.toFixed(2)}s`);
  } else {
    const total = Number((await readExactly(s, 8)).readBigUInt64BE(0));
    const hash = createHash('sha256');
    let got = 0;
    const t0 = performance.now();
    let lastReport = t0;
    while (got < total) {
      const want = Math.min(BLOCK, total - got);
      const piece = await readExactly(s, want);
      hash.update(piece);
      got += piece.length;
      const now = performance.now();
      if (k === 0 && now - lastReport > 2000) {
        log(
          'down',
          `${((got / total) * 100).toFixed(0)}%  ${(got / 1e6 / ((now - t0) / 1000)).toFixed(0)} MB/s`,
        );
        lastReport = now;
      }
    }
    const digest = await readExactly(s, 32);
    const ok = digest.equals(hash.digest());
    await write(s, Buffer.from([ok ? 1 : 0]));
    out = { ok, bytes: total, rtt: raw.rtt };
  }
  clearInterval(stats);
  await new Promise((r) => setTimeout(r, 200));
  s.destroy();
  return out;
}

async function runLocal(bytes: string, extra: string[]) {
  const self = fileURLToPath(import.meta.url);
  const common = ['--conditions=@communal/source', self, 'peer', '--bytes', bytes, ...extra];
  const run = (args: string[]) =>
    new Promise<number>((resolve) => {
      const p = spawn(process.execPath, ['--import', 'tsx', ...common, ...args], {
        stdio: 'inherit',
      });
      p.on('exit', (code) => resolve(code ?? 1));
    });
  const codes = await Promise.all([
    run([
      '--me',
      'alice',
      '--peer',
      'bob',
      '--role',
      'up',
      '--port',
      '41641',
      '--peer-addr',
      '127.0.0.1:41642',
    ]),
    run([
      '--me',
      'bob',
      '--peer',
      'alice',
      '--role',
      'down',
      '--port',
      '41642',
      '--peer-addr',
      '127.0.0.1:41641',
    ]),
  ]);
  process.exitCode = codes.some((c) => c !== 0) ? 1 : 0;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    me: { type: 'string' },
    peer: { type: 'string' },
    role: { type: 'string' },
    port: { type: 'string' },
    'peer-addr': { type: 'string' },
    bytes: { type: 'string', default: '1G' },
    streams: { type: 'string', default: '1' },
    stats: { type: 'boolean', default: false },
  },
});

const mode = positionals[0];
if (mode === 'local') {
  await runLocal(values.bytes, ['--streams', values.streams, ...(values.stats ? ['--stats'] : [])]);
} else if (mode === 'peer') {
  const [peerHost, peerPort] = (values['peer-addr'] ?? '').split(/:(?=\d+$)/);
  if (!values.me || !values.peer || !values.port || !peerHost || !peerPort) {
    throw new Error('peer mode needs --me --peer --role --port --peer-addr');
  }
  if (values.role !== 'up' && values.role !== 'down') throw new Error('--role must be up or down');
  await runPeer({
    me: values.me,
    peer: values.peer,
    role: values.role,
    port: Number(values.port),
    // udx only takes IP literals; candidates from the hub will always be IPs.
    peerHost: (await lookup(peerHost)).address,
    peerPort: Number(peerPort),
    bytes: parseBytes(values.bytes),
    streams: Math.max(1, Number(values.streams)),
    stats: values.stats,
  });
} else {
  console.error('usage: bench.ts local [--bytes 1G] | bench.ts peer ...');
  process.exitCode = 2;
}
