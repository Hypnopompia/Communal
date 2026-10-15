import { describe, expect, it } from 'vitest';
import {
  Audience,
  CHUNK_SIZE,
  clientBodies,
  encodeClient,
  encodeHub,
  encodePeerFrame,
  hubBodies,
  parseClientMessage,
  parseHubMessage,
  PeerFrameDecoder,
  PeerFrameError,
  RemoteRequest,
  SharePath,
  type ClientType,
  type HubType,
} from './index.js';
import { clientFixtures, hubFixtures } from './fixtures.js';

describe('hub protocol round-trip', () => {
  it('has a fixture for every message type', () => {
    expect(Object.keys(clientFixtures).sort()).toEqual(Object.keys(clientBodies).sort());
    expect(Object.keys(hubFixtures).sort()).toEqual(Object.keys(hubBodies).sort());
  });

  it.each(Object.keys(clientBodies) as ClientType[])('client %s', (t) => {
    const raw = encodeClient(t, clientFixtures[t] as never, { re: 'm_01J9Z3QX7M8N4P5R6S7T8V9W0X' });
    const res = parseClientMessage(raw);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.msg.t).toBe(t);
      expect(res.msg.body).toEqual(clientFixtures[t]);
      expect(
        JSON.parse(encodeClient(t, res.msg.body as never, { id: res.msg.id, re: res.msg.re })),
      ).toEqual(JSON.parse(raw));
    }
  });

  it.each(Object.keys(hubBodies) as HubType[])('hub %s', (t) => {
    const raw = encodeHub(t, hubFixtures[t] as never);
    const res = parseHubMessage(raw);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.msg.body).toEqual(hubFixtures[t]);
  });
});

describe('envelope validation', () => {
  it('rejects unknown majors with upgrade_required', () => {
    const raw = JSON.stringify({ ...JSON.parse(encodeClient('ping', {})), v: 2 });
    expect(parseClientMessage(raw)).toMatchObject({ ok: false, code: 'upgrade_required' });
  });

  it('rejects unknown types, wrong direction, bad bodies and junk', () => {
    expect(parseClientMessage(encodeHub('welcome', hubFixtures.welcome))).toMatchObject({
      ok: false,
      code: 'bad_request',
    });
    expect(parseClientMessage(encodeClient('sources', { hash: 'nothex' } as never))).toMatchObject({
      ok: false,
      code: 'bad_request',
    });
    expect(parseClientMessage('{not json')).toMatchObject({ ok: false, message: 'invalid JSON' });
    expect(parseClientMessage(JSON.stringify({ v: 1, t: 'ping', body: {} }))).toMatchObject({
      ok: false,
      message: 'invalid envelope',
    });
    expect(
      parseClientMessage(
        JSON.stringify({ v: 1, id: 'm_01J9Z3QX7M8N4P5R6S7T8V9W0X', t: '__proto__', body: {} }),
      ),
    ).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('rejects unexpected fields on empty bodies', () => {
    expect(parseClientMessage(encodeClient('ping', { x: 1 } as never))).toMatchObject({
      ok: false,
    });
  });
});

describe('share paths and audiences', () => {
  it.each(['Photos/a.jpg', 'Photos/2024/', 'Photos', 'Movies/Alien (1979).mkv'])(
    'accepts %s',
    (p) => expect(SharePath.safeParse(p).success).toBe(true),
  );
  it.each(['/etc/passwd', 'Photos/../x', 'Photos//a', 'C:\\x', '', './a', 'a/./b'])(
    'rejects %s',
    (p) => expect(SharePath.safeParse(p).success).toBe(false),
  );
  it('parses audiences', () => {
    expect(Audience.safeParse('me').success).toBe(true);
    expect(Audience.safeParse('hub').success).toBe(true);
    expect(Audience.safeParse({}).success).toBe(true);
    expect(Audience.safeParse('everyone').success).toBe(false);
    expect(Audience.safeParse({ users: [], extra: 1 }).success).toBe(false);
  });
});

describe('peer frames', () => {
  const hash = 'ab'.repeat(32);

  it('round-trips headers and payloads through a byte stream split arbitrarily', () => {
    const payload = new Uint8Array(CHUNK_SIZE).map((_, i) => i & 0xff);
    const frames = [
      encodePeerFrame({ t: 'get', hash, ranges: [[0, 3]] }),
      encodePeerFrame({ t: 'chunk', hash, index: 2 }, payload),
      encodePeerFrame({
        t: 'manifest',
        hash,
        size: 10,
        chunk_size: CHUNK_SIZE,
        chunk_hashes: new Uint8Array(64).fill(9),
      }),
      encodePeerFrame({ t: 'busy', retry_after_s: 5 }),
      encodePeerFrame({ t: 'thumb.get', hashes: [hash, hash], size: 320 }),
      encodePeerFrame({ t: 'thumb', hash, mime: 'image/webp' }, new Uint8Array([1, 2, 3])),
      encodePeerFrame({ t: 'thumb.none', hash }),
      encodePeerFrame({ t: 'peek.data', hash, truncated: true }, new Uint8Array(10)),
      encodePeerFrame({ t: 'peek.none', hash }),
    ];
    const stream = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let off = 0;
    for (const f of frames) {
      stream.set(f, off);
      off += f.length;
    }
    const dec = new PeerFrameDecoder();
    const out = [];
    for (let i = 0; i < stream.length; i += 7919)
      out.push(...dec.push(stream.subarray(i, i + 7919)));

    expect(out.map((f) => f.header.t)).toEqual([
      'get',
      'chunk',
      'manifest',
      'busy',
      'thumb.get',
      'thumb',
      'thumb.none',
      'peek.data',
      'peek.none',
    ]);
    expect(Array.from(out[5]!.payload)).toEqual([1, 2, 3]);
    expect(out[0]!.header).toEqual({ t: 'get', hash, ranges: [[0, 3]] });
    expect(Buffer.compare(out[1]!.payload, payload)).toBe(0);
    const m = out[2]!.header;
    expect(m.t === 'manifest' && Array.from(m.chunk_hashes)).toEqual(Array(64).fill(9));
  });

  it('rejects oversize, unknown and invalid frames', () => {
    const big = new Uint8Array(4);
    new DataView(big.buffer).setUint32(0, CHUNK_SIZE * 4);
    expect(() => new PeerFrameDecoder().push(big)).toThrow(PeerFrameError);
    expect(() => new PeerFrameDecoder().push(encodePeerFrame({ t: 'nope' } as never))).toThrow(
      /unknown/,
    );
    expect(() =>
      new PeerFrameDecoder().push(encodePeerFrame({ t: 'chunk', hash, index: -1 })),
    ).toThrow(/invalid chunk/);
  });
});

describe('remote requests (ADR 0023)', () => {
  it('manages another device’s subscriptions by id, never by path', () => {
    for (const r of [
      { op: 'subscriptions' },
      { op: 'update_subscription', id: 'sub_1', paused: true },
      { op: 'update_subscription', id: 'sub_1', mirror_deletes: false },
      { op: 'unsubscribe', id: 'sub_1' },
    ])
      expect(RemoteRequest.safeParse(r).success).toBe(true);
    for (const r of [
      { op: 'update_subscription', paused: true },
      { op: 'update_subscription', id: '', paused: true },
      { op: 'unsubscribe', id: 'x'.repeat(65) },
      { op: 'update_subscription', id: 'sub_1', paused: 'yes' },
    ])
      expect(RemoteRequest.safeParse(r).success).toBe(false);
    // Unknown fields such as a folder are dropped, never used.
    const parsed = RemoteRequest.parse({ op: 'update_subscription', id: 's', dest: '/etc' });
    expect(parsed).toEqual({ op: 'update_subscription', id: 's' });
  });
});
