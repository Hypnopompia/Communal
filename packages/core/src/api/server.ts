import { chmodSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { Kind } from '@communal/protocol';
import { CoreError, type CommunalCore } from '../core.js';
import { HubError } from '../hub-client.js';
import { PeopleError } from '../people.js';
import { explain } from '../transfer/diagnosis.js';
import { iconFor } from '../media/icons.js';
import type { Kind as KindT } from '../index/detect.js';

/** A handler's non-JSON answer: raw bytes or a byte stream (thumbnails, file streams). */
export class RawReply {
  constructor(
    readonly status: number,
    readonly headers: Record<string, string>,
    readonly body: Buffer | AsyncIterable<Buffer>,
  ) {}
}

const withIcon = <T extends { mime: string; kind: KindT }>(e: T, name: string) => ({
  ...e,
  icon: iconFor(e.mime, name, e.kind),
});
const baseName = (p: string) => p.slice(p.replace(/\/$/, '').lastIndexOf('/') + 1);
const ThumbSizeQ = z.coerce
  .number()
  .pipe(z.union([z.literal(320), z.literal(1600)]))
  .default(320);
const HashParam = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The core's local API (HANDOFF §3): HTTP+JSON for the CLI and the desktop renderer.
 * - Headless: a Unix socket created with mode 0600 inside the 0700 data dir.
 * - Desktop: 127.0.0.1 on a random port with a random bearer token.
 */
export type ListenOn =
  { socketPath: string; token?: string } | { host: '127.0.0.1'; port: number; token: string };

const AddHub = z.object({
  url: z.string().url().max(512),
  display_name: z.string().trim().min(1).max(64),
  device_name: z.string().trim().min(1).max(64),
});
const AddShare = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1).max(4096),
  hubs: z.array(z.string()).optional(),
});
const SetHubs = z.object({ hubs: z.array(z.string()) });
const AudienceBody = z.union([
  z.literal('me'),
  z.literal('hub'),
  z
    .object({ users: z.array(z.string()).optional(), groups: z.array(z.string()).optional() })
    .strict(),
]);
const SetRule = z.object({
  hub: z.string(),
  path: z.string().min(1).max(4096),
  audience: AudienceBody.nullable(),
});
const PersonAction = z.object({ hub: z.string(), user_id: z.string() });
const Verify = PersonAction.extend({ verified: z.boolean() });
const UpsertGroup = z.object({
  hub: z.string(),
  group_id: z.string().optional(),
  name: z.string().trim().min(1).max(64),
  members: z.array(z.string()).max(1000),
});
const HubQuery = z.object({ hub: z.string() });

type Handler = (req: IncomingMessage, url: URL, body: unknown) => Promise<unknown>;

export class LocalApi {
  private server?: Server;
  private readonly routes: { method: string; pattern: RegExp; handler: Handler }[] = [];

  constructor(private readonly core: CommunalCore) {
    const route = (method: string, path: string, handler: Handler) =>
      this.routes.push({
        method,
        pattern: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`),
        handler,
      });
    const param = (req: IncomingMessage, url: URL, i: number) => {
      const r = this.routes.find((x) => x.pattern.test(url.pathname) && x.method === req.method)!;
      return decodeURIComponent(r.pattern.exec(url.pathname)![i]!);
    };

    route('GET', '/v1/status', async () => this.core.status());

    route('GET', '/v1/hubs', async () => ({ hubs: this.core.status().hubs }));
    route('POST', '/v1/hubs', async (_req, _url, body) => {
      const b = AddHub.parse(body);
      const platform =
        process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
      const { hub, status } = await this.core.addHub(b.url, {
        display_name: b.display_name,
        device_name: b.device_name,
        platform,
      });
      return {
        hub: {
          id: hub.id,
          url: hub.url,
          user_id: hub.state.userId,
          fingerprint: hub.state.fingerprint,
        },
        status,
      };
    });
    route('DELETE', '/v1/hubs/:id', async (req, url) => {
      await this.core.removeHub(param(req, url, 1));
      return { ok: true };
    });

    route('GET', '/v1/shares', async () => ({ shares: this.core.shares() }));
    route('POST', '/v1/shares', async (_req, _url, body) => {
      const b = AddShare.parse(body);
      return { share: await this.core.addShare(b.name, b.path, b.hubs) };
    });
    route('DELETE', '/v1/shares/:name', async (req, url) => {
      await this.core.removeShare(param(req, url, 1));
      return { ok: true };
    });
    route('PUT', '/v1/shares/:name/hubs', async (req, url, body) => {
      this.core.setShareHubs(param(req, url, 1), SetHubs.parse(body).hubs);
      return { ok: true };
    });

    route('GET', '/v1/acl', async (_req, url) => {
      const hub = url.searchParams.get('hub') ?? undefined;
      return { rules: this.core.rules(hub) };
    });
    route('PUT', '/v1/acl', async (_req, _url, body) => {
      const b = SetRule.parse(body);
      await this.core.setRule(b.hub, b.path, b.audience);
      return { ok: true };
    });

    const people = this.core.people;
    const q = (url: URL) => Object.fromEntries(url.searchParams);
    route('GET', '/v1/people', async (_req, url) => ({
      connections: await people.connections(HubQuery.parse(q(url)).hub),
    }));
    route('GET', '/v1/people/search', async (_req, url) => {
      const p = HubQuery.extend({ q: z.string().trim().min(1).max(64) }).parse(q(url));
      return { users: await people.search(p.hub, p.q) };
    });
    for (const action of ['request', 'accept', 'remove'] as const) {
      route('POST', `/v1/people/${action}`, async (_req, _url, body) => {
        const b = PersonAction.parse(body);
        await people[action](b.hub, b.user_id);
        return { ok: true };
      });
    }
    route('GET', '/v1/people/safety-code', async (_req, url) => {
      const p = HubQuery.extend({ user: z.string() }).parse(q(url));
      return people.safetyCode(p.hub, p.user);
    });
    route('POST', '/v1/people/verify', async (_req, _url, body) => {
      const b = Verify.parse(body);
      await people.verify(b.hub, b.user_id, b.verified);
      return { ok: true };
    });

    route('GET', '/v1/groups', async (_req, url) => ({
      groups: await people.groups(HubQuery.parse(q(url)).hub),
    }));
    route('POST', '/v1/groups', async (_req, _url, body) => {
      const { hub, ...group } = UpsertGroup.parse(body);
      return { group: await people.upsertGroup(hub, group) };
    });
    route('DELETE', '/v1/groups/:id', async (req, url) => {
      await people.deleteGroup(HubQuery.parse(q(url)).hub, param(req, url, 1));
      return { ok: true };
    });

    // A failed connection's diagnosis comes with its user message, tips and whose side to fix.
    route('GET', '/v1/downloads', async () => ({
      downloads: this.core.downloads
        .list()
        .map((d) => ({ ...d, diagnosis: d.diagnosis && explain(d.diagnosis) })),
    }));
    route('POST', '/v1/downloads', async (_req, _url, body) => {
      const b = z
        .object({
          hash: z.string().regex(/^[0-9a-f]{64}$/),
          name: z.string().min(1).max(255).optional(),
          dest: z.string().min(1).max(4096).optional(),
        })
        .parse(body);
      return { download: await this.core.download(b.hash, { name: b.name, destDir: b.dest }) };
    });
    route('DELETE', '/v1/downloads/:id', async (req, url) => {
      if (!this.core.downloads.cancel(param(req, url, 1)))
        throw new CoreError('not_found', 'no such download');
      return { ok: true };
    });
    // ── subscriptions (M7) ──
    route('GET', '/v1/subscriptions', async () => ({
      subscriptions: this.core.subscriptions.list(),
    }));
    route('POST', '/v1/subscriptions', async (_req, _url, body) => {
      const b = z
        .object({
          hub: z.string(),
          device: z.string(),
          path: z.string().min(1).max(4096),
          dest: z.string().min(1).max(4096).optional(),
          // Asked at subscribe time (HANDOFF §5), so it's required here rather than defaulted.
          mirror_deletes: z.boolean(),
          recursive: z.boolean().default(true),
        })
        .parse(body);
      return {
        subscription: await this.core.subscriptions.add({
          hub: b.hub,
          device: b.device,
          path: b.path,
          mirrorDeletes: b.mirror_deletes,
          recursive: b.recursive,
          ...(b.dest ? { dest: b.dest } : {}),
        }),
      };
    });
    route('PUT', '/v1/subscriptions/:id', async (req, url, body) => {
      const b = z
        .object({ mirror_deletes: z.boolean(), paused: z.boolean() })
        .partial()
        .parse(body);
      await this.core.subscriptions.update(param(req, url, 1), b);
      return { ok: true };
    });
    route('DELETE', '/v1/subscriptions/:id', async (req, url) => {
      await this.core.subscriptions.remove(param(req, url, 1));
      return { ok: true };
    });

    route('GET', '/v1/uploads/log', async (_req, url) => {
      const p = z
        .object({
          user: z.string().optional(),
          path: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(1000).default(100),
        })
        .parse(Object.fromEntries(url.searchParams));
      return {
        log: this.core.store.uploadLog({ user: p.user, pathPrefix: p.path, limit: p.limit }),
      };
    });
    route('GET', '/v1/network', async () => this.core.network.summary());
    route('POST', '/v1/network/check', async () => {
      await this.core.network.recheck();
      return this.core.network.summary();
    });
    route('GET', '/v1/settings/uploads', async () => this.core.uploadLimits);
    route('PUT', '/v1/settings/uploads', async (_req, _url, body) => {
      const b = z
        .object({
          maxConcurrent: z.number().int().min(0).max(100),
          bytesPerSecond: z.number().int().min(0),
          lanOnly: z.boolean(),
        })
        .partial()
        .parse(body);
      this.core.uploadLimits = { ...this.core.uploadLimits, ...b };
      return this.core.uploadLimits;
    });

    route('GET', '/v1/search', async (_req, url) => {
      const q = url.searchParams;
      const parsed = z
        .object({
          q: z.string().max(256).default(''),
          kind: Kind.optional(),
          min_size: z.coerce.number().int().nonnegative().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(50),
          cursors: z
            .string()
            .optional()
            .transform((s) => (s ? (JSON.parse(s) as Record<string, string>) : undefined)),
        })
        .parse(Object.fromEntries(q));
      const { cursors, ...query } = parsed;
      const r = await this.core.search(query, cursors);
      return { ...r, hits: r.hits.map((h) => withIcon(h, h.name)) };
    });
    route('GET', '/v1/browse', async (_req, url) => {
      const q = z
        .object({ hub: z.string(), device: z.string(), path: z.string().default('') })
        .parse(Object.fromEntries(url.searchParams));
      const r = await this.core.browse(q.hub, q.device, q.path);
      return { ...r, files: r.files.map((f) => withIcon(f, baseName(f.path))) };
    });

    // ── previews (M6) ──
    // Fetch a batch (e.g. a whole folder) into the cache; then GET each one as image/webp.
    route('POST', '/v1/thumbs', async (_req, _url, body) => {
      const b = z
        .object({
          hub: z.string(),
          device: z.string(),
          hashes: z.array(HashParam).min(1).max(5000),
          size: ThumbSizeQ,
        })
        .parse(body);
      return { thumbs: await this.core.fetchThumbnails(b.hub, b.device, b.hashes, b.size) };
    });
    route('GET', '/v1/thumbs/:hash', async (req, url) => {
      const hash = HashParam.parse(param(req, url, 1));
      const size = ThumbSizeQ.parse(url.searchParams.get('size') ?? undefined);
      const data = await this.core.thumbnail(hash, size);
      if (!data) throw new CoreError('not_found', 'no thumbnail');
      // Content-addressed: the bytes for a hash never change.
      return new RawReply(
        200,
        { 'content-type': 'image/webp', 'cache-control': 'private, max-age=31536000, immutable' },
        data,
      );
    });
    route('GET', '/v1/peek', async (_req, url) => {
      const q = z
        .object({ hub: z.string(), device: z.string(), hash: HashParam })
        .parse(Object.fromEntries(url.searchParams));
      const r = await this.core.peek(q.hub, q.device, q.hash);
      if (!r) throw new CoreError('not_found', 'nothing to show');
      return { text: r.data.toString('utf8'), truncated: r.truncated };
    });
    // Plays a file from its owner without downloading it (HTTP ranges, verified chunks).
    route('GET', '/v1/stream/:hash', async (req, url) => {
      const hash = HashParam.parse(param(req, url, 1));
      const type = url.searchParams.get('type');
      const s = await this.core.streams.get(hash).catch((e: Error) => {
        throw new CoreError('unavailable', e.message);
      });
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      let start = 0;
      let end = s.size - 1;
      if (range && (range[1] || range[2])) {
        if (range[1]) {
          start = Number(range[1]);
          if (range[2]) end = Math.min(end, Number(range[2]));
        } else start = Math.max(0, s.size - Number(range[2]));
        if (start > end || start >= s.size)
          return new RawReply(416, { 'content-range': `bytes */${s.size}` }, Buffer.alloc(0));
      }
      return new RawReply(
        range ? 206 : 200,
        {
          'content-type':
            type && /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream',
          'accept-ranges': 'bytes',
          'content-length': String(end - start + 1),
          ...(range ? { 'content-range': `bytes ${start}-${end}/${s.size}` } : {}),
        },
        s.read(start, end),
      );
    });
  }

  async listen(on: ListenOn): Promise<string> {
    const token = on.token ? Buffer.from(on.token) : undefined;
    this.server = createServer((req, res) => void this.handle(req, res, token));
    if ('socketPath' in on) {
      rmSync(on.socketPath, { force: true });
      await new Promise<void>((r) => this.server!.listen(on.socketPath, r));
      chmodSync(on.socketPath, 0o600);
      return on.socketPath;
    }
    await new Promise<void>((r) => this.server!.listen(on.port, on.host, r));
    const a = this.server.address() as AddressInfo;
    return `http://${on.host}:${a.port}`;
  }

  async close() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private async sendRaw(res: ServerResponse, r: RawReply) {
    res.writeHead(r.status, r.headers);
    if (Buffer.isBuffer(r.body)) return void res.end(r.body);
    try {
      for await (const chunk of r.body) {
        if (res.destroyed) break;
        if (!res.write(chunk))
          await new Promise((ok) => {
            res.once('drain', ok);
            res.once('close', ok);
          });
      }
      res.end();
    } catch (err) {
      // Headers are out: all we can do is cut the response short.
      this.core.log.info({ err: (err as Error).message }, 'stream ended early');
      res.destroy();
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse, token?: Buffer) {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (token) {
      const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (got.length !== token.length || !timingSafeEqual(got, token))
        return send(401, { error: 'unauthorized' });
    }
    const url = new URL(req.url ?? '/', 'http://local');
    const route = this.routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!route) return send(404, { error: 'not_found' });
    try {
      let body: unknown;
      if (req.method === 'POST' || req.method === 'PUT') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > 1024 * 1024) return send(413, { error: 'too_large' });
          chunks.push(c as Buffer);
        }
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      }
      const out = await route.handler(req, url, body);
      if (out instanceof RawReply) return await this.sendRaw(res, out);
      send(200, out);
    } catch (err) {
      if (err instanceof z.ZodError)
        return send(400, { error: 'bad_request', message: z.prettifyError(err) });
      if (err instanceof SyntaxError)
        return send(400, { error: 'bad_request', message: 'invalid JSON' });
      if (err instanceof CoreError) {
        const status = { bad_request: 400, not_found: 404, conflict: 409, unavailable: 503 }[
          err.code
        ];
        return send(status, { error: err.code, message: err.message });
      }
      if (err instanceof HubError) {
        const status =
          { not_found: 404, bad_request: 400, forbidden: 403, conflict: 409 }[err.code as string] ??
          502;
        return send(status, { error: err.code, message: err.message });
      }
      if (err instanceof PeopleError) {
        const status = { not_found: 404, unavailable: 503, hub_mismatch: 502, rejected: 502 }[
          err.code
        ];
        return send(status, { error: err.code, message: err.message });
      }
      this.core.log.error({ err }, 'local API handler failed');
      send(500, { error: 'internal' });
    }
  }
}
