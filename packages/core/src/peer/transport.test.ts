import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { bytesEqual, generateKeyPair } from '@communal/crypto';
import { PeerTransport, type PeerChannel } from './transport.js';

const log = pino({ level: 'silent' });

describe('PeerTransport', () => {
  const transports: PeerTransport[] = [];
  afterEach(async () => {
    for (const t of transports.splice(0)) await t.stop();
  });

  it('reports udx link stats for a connection (ADR 0024)', async () => {
    const [ka, kb] = [generateKeyPair(), generateKeyPair()];
    const a = new PeerTransport({ device: ka, host: '127.0.0.1', loopback: true, log });
    const b = new PeerTransport({ device: kb, host: '127.0.0.1', loopback: true, log });
    transports.push(a, b);
    await a.start();
    await b.start();
    const [ida, idb] = [a.newStreamId(), b.newStreamId()];
    const session = 's_link_stats';
    const [ca, cb] = await Promise.all([
      a.connect({
        session,
        localStreamId: ida,
        remoteStreamId: idb,
        candidates: b.candidates(),
        initiator: true,
        verifyPeer: (k) => bytesEqual(k, kb.publicKey),
      }),
      b.connect({
        session,
        localStreamId: idb,
        remoteStreamId: ida,
        candidates: a.candidates(),
        initiator: false,
        verifyPeer: (k) => bytesEqual(k, ka.publicKey),
      }),
    ]);
    const got = cb.next((h) => h.t === 'chunk');
    await ca.send({ t: 'chunk', hash: 'ab'.repeat(32), index: 0 }, new Uint8Array(256 * 1024));
    expect((await got).payload.length).toBe(256 * 1024);

    for (const ch of [ca, cb] as PeerChannel[]) {
      const s = ch.linkStats()!;
      expect(s.mtu).toBeGreaterThanOrEqual(1200);
      expect(s.cwnd).toBeGreaterThan(0);
      expect(s.rtt_ms).toBeGreaterThanOrEqual(0);
      for (const n of [s.retransmits, s.fast_recoveries, s.rtos]) {
        expect(Number.isInteger(n) && n >= 0).toBe(true);
      }
    }
  });
});
