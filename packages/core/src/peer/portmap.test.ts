import { createSocket, type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { RouterPortMapper } from './netcheck.js';

/** A NAT-PMP router on 127.0.0.1:5351 that grants every request (RFC 6886 replies). */
async function fakePmpRouter() {
  const requests: { op: number; port: number; ttl: number }[] = [];
  const sock: Socket = createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, from) => {
    const op = msg.readUInt8(1);
    if (op === 0) {
      const res = Buffer.alloc(12);
      res.writeUInt8(128, 1);
      res.set([203, 0, 113, 7], 8);
      sock.send(res, from.port, from.address);
      return;
    }
    const port = msg.readUInt16BE(4);
    const ttl = msg.readUInt32BE(8);
    requests.push({ op, port, ttl });
    const res = Buffer.alloc(16);
    res.writeUInt8(128 + op, 1);
    res.writeUInt16BE(port, 8);
    res.writeUInt16BE(port, 10);
    res.writeUInt32BE(ttl, 12);
    sock.send(res, from.port, from.address);
  });
  await new Promise<void>((resolve) => sock.bind(5351, '127.0.0.1', resolve));
  return { requests, close: () => new Promise<void>((r) => sock.close(() => r())) };
}

/**
 * NAT-PMP clients listen on port 5350. If something here already does (an open Communal app),
 * the router's replies may go to it instead, so the test can't run.
 */
const clientPortFree = await new Promise<boolean>((resolve) => {
  const s = createSocket('udp4');
  s.once('error', () => resolve(false));
  s.bind(5350, () => s.close(() => resolve(true)));
});

describe.skipIf(!clientPortFree)('RouterPortMapper (NAT-PMP)', () => {
  let router: Awaited<ReturnType<typeof fakePmpRouter>> | undefined;
  afterEach(async () => {
    await router?.close();
    router = undefined;
  });

  it('removes its mapping once on stop, with no refresh loop or negative timer', async () => {
    router = await fakePmpRouter();
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on('warning', onWarning);
    try {
      const mapper = new RouterPortMapper({
        gateway: async () => '127.0.0.1',
        upnp: false,
        timeoutMs: 2_000,
      });
      const { mapping } = await mapper.map(41641);
      expect(mapping).toMatchObject({ method: 'pmp', host: '203.0.113.7', port: 41641 });
      await mapper.stop();
      await new Promise((r) => setTimeout(r, 200));
      // One mapping and one removal (a zero lease), nothing after.
      expect(router.requests).toEqual([
        { op: 1, port: 41641, ttl: 7200 },
        { op: 1, port: 41641, ttl: 0 },
      ]);
      expect(warnings).not.toContain('TimeoutNegativeWarning');
    } finally {
      process.off('warning', onWarning);
    }
  });
});
