import { chmodSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { Kind, RemoteRequest, Seen } from '@communal/protocol';
import {
  importRecoveryFile,
  RecoveryError,
  wordsToRootSecret,
  type RecoveryFile,
} from '@communal/crypto';
import { CoreError, platform, type CommunalCore } from '../core.js';
import { RemoteError } from '../remote.js';
import { HubError } from '../hub-client.js';
import { PeopleError } from '../people.js';
import { explain } from '../transfer/diagnosis.js';
import { selfCheck } from '../selfcheck.js';
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
const Ban = z.object({ reason: z.string().trim().max(200).optional() });
const AdminSettingsChange = z
  .object({
    join_mode: z.enum(['open', 'approval']).optional(),
    name: z.string().trim().min(1).max(64).nullable().optional(),
    signups_per_hour: z.number().int().min(0).max(10_000).optional(),
    max_files_per_device: z.number().int().min(0).max(100_000_000).optional(),
    max_devices_per_account: z.number().int().min(0).max(1_000).optional(),
  })
  .strict();
const AdminLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  before: z.coerce.number().int().positive().optional(),
});
const DeviceName = z.string().trim().min(1).max(64);
const Link = z.object({
  url: z.string().url().max(512),
  code: z.string().min(1).max(32),
  device_name: DeviceName,
});
const Restore = z.object({
  file: z.looseObject({ format: z.literal('communal-recovery') }).optional(),
  passphrase: z.string().max(1024).optional(),
  words: z.string().max(1024).optional(),
  hubs: z
    .array(z.object({ url: z.string().url().max(512) }))
    .max(32)
    .optional(),
  device_name: DeviceName,
});
const ExportRecovery = z.union([
  z.object({ format: z.literal('words') }),
  z.object({ format: z.literal('file'), passphrase: z.string().max(1024) }),
]);

type Handler = (req: IncomingMessage, url: URL, body: unknown) => Promise<unknown>;

/** A desktop screen to show (the renderer's routes, ADR 0017). */
export const UiRoute = z.discriminatedUnion('screen', [
  z.object({
    screen: z.literal('library'),
    hub: z.string().max(64).optional(),
    device: z.string().max(128).optional(),
    path: z.string().max(4096).optional(),
  }),
  z.object({ screen: z.literal('search'), q: z.string().max(256).optional() }),
  z.object({
    screen: z.enum(['shares', 'people', 'transfers', 'subscriptions', 'activity']),
  }),
  z.object({
    screen: z.literal('manage'),
    hub: z.string().max(64),
    tab: z.enum(['people', 'connections', 'log', 'settings']).optional(),
  }),
  z.object({
    screen: z.literal('settings'),
    tab: z
      .enum([
        'account',
        'devices',
        'hubs',
        'network',
        'bandwidth',
        'downloads',
        'storage',
        'agents',
      ])
      .optional(),
  }),
]);
export type UiRoute = z.infer<typeof UiRoute>;

/**
 * What `GET /v1/events` (WebSocket) announces: which parts of the state changed, never the data
 * itself. Clients refetch what they show. Sent as `{"topics": [...]}`, at most every 250 ms.
 */
export type ApiTopic =
  | 'hubs'
  | 'presence'
  | 'people'
  | 'devices'
  | 'transfers'
  | 'index'
  | 'subscriptions'
  | 'browse'
  | 'library'
  | 'admin';

const HUB_EVENT_TOPIC: Partial<Record<string, ApiTopic>> = {
  'connection.request': 'people',
  'connection.accept': 'people',
  'connection.remove': 'people',
  'link.request': 'devices',
  'link.done': 'devices',
  'link.denied': 'devices',
  'device.revoked': 'devices',
  'watch.event': 'subscriptions',
  'browse.changed': 'browse',
  'library.changed': 'library',
  'admin.changed': 'admin',
};

export class LocalApi {
  private server?: Server;
  private readonly routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private readonly pending = new Set<ApiTopic>();
  private flushTimer?: NodeJS.Timeout;
  private unsubscribe?: () => void;

  constructor(
    private readonly core: CommunalCore,
    /** The desktop app passes this so agents can move its window to a screen (`/v1/ui/show`). */
    private readonly ui?: { show(route: UiRoute): void },
  ) {
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
    route('POST', '/v1/ui/show', async (_req, _url, body) => {
      if (!this.ui) throw new CoreError('not_found', 'no app window: this core runs headless');
      this.ui.show(UiRoute.parse(body));
      return { ok: true };
    });
    // Platform pieces (native modules, ffmpeg, trash helper) load and run here.
    route('GET', '/v1/self-check', async () => {
      const checks = await selfCheck(this.core);
      return { ok: Object.values(checks).every((c) => c.ok), checks };
    });

    route('GET', '/v1/hubs', async () => ({ hubs: this.core.status().hubs }));
    route('POST', '/v1/hubs', async (_req, _url, body) => {
      const b = AddHub.parse(body);
      const { hub, status } = await this.core.addHub(b.url, {
        display_name: b.display_name,
        device_name: b.device_name,
        platform: platform(),
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

    // ── hub administration (ADR 0020): only on hubs this account administers ──
    const admin = this.core.admin;
    route('GET', '/v1/hubs/:id/admin/users', async (req, url) => ({
      users: await admin.users(param(req, url, 1)),
    }));
    for (const action of ['approve', 'unban'] as const) {
      route('POST', `/v1/hubs/:id/admin/users/:user/${action}`, async (req, url) => {
        await admin[action](param(req, url, 1), param(req, url, 2));
        return { ok: true };
      });
    }
    route('POST', '/v1/hubs/:id/admin/users/:user/ban', async (req, url, body) => {
      await admin.ban(param(req, url, 1), param(req, url, 2), Ban.parse(body).reason);
      return { ok: true };
    });
    route('GET', '/v1/hubs/:id/admin/settings', async (req, url) =>
      admin.settings(param(req, url, 1)),
    );
    route('PUT', '/v1/hubs/:id/admin/settings', async (req, url, body) =>
      admin.updateSettings(param(req, url, 1), AdminSettingsChange.parse(body)),
    );
    route('GET', '/v1/hubs/:id/admin/graph', async (req, url) => admin.graph(param(req, url, 1)));
    route('GET', '/v1/hubs/:id/admin/log', async (req, url) =>
      admin.log(param(req, url, 1), AdminLogQuery.parse(Object.fromEntries(url.searchParams))),
    );

    // ── account and devices (M8, ADR 0014) ──
    route('GET', '/v1/account', async () => this.core.identity());
    route('POST', '/v1/account/link', async (_req, _url, body) => {
      const b = Link.parse(body);
      const r = await this.core.link(b.url, b.code, b.device_name);
      return {
        user_id: r.account.user_id,
        fingerprint: r.fingerprint,
        hub: { id: r.hub.hub.id, url: r.hub.hub.url, status: r.hub.status },
        others: r.others,
      };
    });
    route('POST', '/v1/account/restore', async (_req, _url, body) => {
      const b = Restore.parse(body);
      let rootSecret: Uint8Array;
      try {
        if (b.file) {
          if (b.passphrase === undefined)
            throw new CoreError('bad_request', 'a recovery file needs its passphrase');
          rootSecret = await importRecoveryFile(b.file as unknown as RecoveryFile, b.passphrase);
        } else if (b.words) {
          rootSecret = wordsToRootSecret(b.words);
        } else {
          throw new CoreError('bad_request', 'give a recovery file or the recovery words');
        }
      } catch (err) {
        if (err instanceof RecoveryError) throw new CoreError('bad_request', err.message);
        throw err;
      }
      const file = b.file as unknown as RecoveryFile | undefined;
      // Hubs named on the command line come first; the file's carry their pinned keys.
      const hubs = [...(b.hubs ?? [])];
      for (const h of file?.hubs ?? []) if (!hubs.some((x) => x.url === h.url)) hubs.push(h);
      const r = await this.core.restore({
        rootSecret,
        ...(file?.user_id ? { user_id: file.user_id } : {}),
        hubs,
        deviceName: b.device_name,
      });
      return { user_id: r.account.user_id, fingerprint: r.fingerprint, hubs: r.hubs };
    });
    route('POST', '/v1/recovery', async (_req, _url, body) =>
      this.core.exportRecovery(ExportRecovery.parse(body)),
    );
    route('POST', '/v1/link/codes', async (_req, _url, body) =>
      this.core.createLinkCode(z.object({ hub: z.string().optional() }).parse(body).hub),
    );
    route('GET', '/v1/link/requests', async () => ({ requests: this.core.linkRequests() }));
    route('POST', '/v1/link/requests/:id/approve', async (req, url) =>
      this.core.approveLink(param(req, url, 1)),
    );
    route('POST', '/v1/link/requests/:id/deny', async (req, url) => {
      await this.core.denyLink(param(req, url, 1));
      return { ok: true };
    });
    route('GET', '/v1/devices', async () => ({ devices: await this.core.devices() }));
    route('POST', '/v1/devices/:id/revoke', async (req, url) =>
      this.core.revokeDevice(param(req, url, 1)),
    );

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
    // What a rule change would do, without making it (ADR 0021).
    route('POST', '/v1/acl/preview', async (_req, _url, body) => {
      const b = SetRule.parse(body);
      return this.core.previewRule(b.hub, b.path, b.audience);
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
    route('GET', '/v1/library', async () => people.library());
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
      downloads: this.core.downloads.list().map((d) => ({
        ...d,
        diagnosis: d.diagnosis && explain(d.diagnosis),
        sources: this.core.downloads.liveSources(d.id),
      })),
    }));
    route('POST', '/v1/downloads', async (_req, _url, body) => {
      const b = z
        .object({
          hash: z.string().regex(/^[0-9a-f]{64}$/),
          name: z.string().min(1).max(255).optional(),
          dest: z.string().min(1).max(4096).optional(),
        })
        .parse(body);
      const download = await this.core.download(b.hash, { name: b.name, destDir: b.dest });
      return { download, ...(await this.reshared(download.dest_dir, download.name)) };
    });
    // Who would see files saved into a folder: the re-share warning (ADR 0021).
    route('GET', '/v1/exposure', async (_req, url) => {
      const p = z
        .object({ dir: z.string().min(1).max(4096), inside: z.string().max(4096).optional() })
        .parse(Object.fromEntries(url.searchParams));
      return this.core.exposure(p.dir, p.inside);
    });
    // A folder and its subfolders, once (ADR 0018).
    route('POST', '/v1/downloads/folder', async (_req, _url, body) => {
      const b = z
        .object({
          hub: z.string(),
          device: z.string(),
          path: z.string().min(1).max(4096),
          dest: z.string().min(1).max(4096).optional(),
        })
        .parse(body);
      const folder = await this.core.downloadFolder(b.hub, b.device, b.path, {
        ...(b.dest ? { destDir: b.dest } : {}),
      });
      return { folder, ...(await this.reshared(folder.dest)) };
    });
    // Finished downloads leave the list; the files stay.
    route('POST', '/v1/downloads/clear', async () => {
      const cleared = await this.core.downloads.clearFinished();
      this.notify('transfers');
      return { cleared };
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
      const subscription = await this.core.subscriptions.add({
        hub: b.hub,
        device: b.device,
        path: b.path,
        mirrorDeletes: b.mirror_deletes,
        recursive: b.recursive,
        ...(b.dest ? { dest: b.dest } : {}),
      });
      return { subscription, ...(await this.reshared(subscription.dest_dir)) };
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

    // ── remote control (ADR 0023) ──
    // This device's switch: may the account's other devices start downloads here?
    route('GET', '/v1/settings/remote', async () => ({ allowed: this.core.remoteAllowed }));
    route('PUT', '/v1/settings/remote', async (_req, _url, body) => {
      const b = z.object({ allowed: z.boolean() }).parse(body);
      await this.core.updateSettings({ remote_control: b.allowed });
      return { allowed: this.core.remoteAllowed };
    });
    // Asking another device: the phone side.
    route('GET', '/v1/remote/devices', async () => ({ devices: await this.core.remote.devices() }));
    route('POST', '/v1/remote/:device', async (req, url, body) => {
      const r = RemoteRequest.parse(body);
      return { result: await this.core.remote.request(param(req, url, 1), r) };
    });

    // ── the synced folder (ADR 0019) ──
    route('GET', '/v1/sync', async () => this.core.syncFolder.state());
    route('PUT', '/v1/sync', async (_req, _url, body) => {
      const b = z.object({ path: z.string().min(1).max(4096).optional() }).parse(body ?? {});
      return this.core.syncFolder.enable(b.path);
    });
    route('DELETE', '/v1/sync', async () => {
      await this.core.syncFolder.disable();
      return this.core.syncFolder.state();
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
    route('POST', '/v1/uploads/log/clear', async () => {
      const cleared = this.core.store.clearUploadLog();
      this.notify('transfers');
      return { cleared };
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
      await this.core.updateSettings({ uploads: b });
      return this.core.uploadLimits;
    });
    const downloadsSettings = () => ({
      dir: this.core.downloadsDir,
      default_dir: this.core.defaultDownloadsDir,
    });
    route('GET', '/v1/settings/downloads', async () => downloadsSettings());
    route('PUT', '/v1/settings/downloads', async (_req, _url, body) => {
      // null goes back to the app's own downloads folder.
      const b = z.object({ dir: z.string().min(1).max(4096).nullable() }).parse(body);
      await this.core.updateSettings({ downloads_dir: b.dir });
      return downloadsSettings();
    });
    route('GET', '/v1/settings/storage', async () => this.core.storage());
    route('PUT', '/v1/settings/storage', async (_req, _url, body) => {
      const b = z
        .object({
          thumb_cache_bytes: z
            .number()
            .int()
            .min(16 * 1024 * 1024)
            .max(64 * 1024 ** 3),
        })
        .parse(body);
      await this.core.updateSettings(b);
      return this.core.storage();
    });
    route('POST', '/v1/settings/storage/clear', async () => {
      await this.core.thumbCache.clear();
      return this.core.storage();
    });

    route('GET', '/v1/search', async (_req, url) => {
      const q = url.searchParams;
      const parsed = z
        .object({
          q: z.string().max(256).default(''),
          kind: Kind.optional(),
          min_size: z.coerce.number().int().nonnegative().optional(),
          available: Seen.exclude(['older']).optional(),
          from: z.enum(['anyone', 'connections', 'verified']).default('anyone'),
          limit: z.coerce.number().int().min(1).max(500).default(50),
          cursors: z
            .string()
            .optional()
            .transform((s) => (s ? (JSON.parse(s) as Record<string, string>) : undefined)),
        })
        .parse(Object.fromEntries(q));
      const { cursors, from, ...query } = parsed;
      const r = await this.core.search(query, cursors, from);
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
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head, token));
    this.unsubscribe = this.watchCore();
    if ('socketPath' in on) {
      // Windows named pipes (\\.\pipe\…) have no file to clear or chmod; access is per user.
      const pipe = on.socketPath.startsWith('\\\\');
      // Unix socket paths are short (104 bytes on macOS, 108 on Linux): say so, don't crash.
      if (!pipe && Buffer.byteLength(on.socketPath) > 103)
        throw new Error(
          `the API socket path is too long for this OS (${on.socketPath.length} characters); ` +
            'use a shorter data directory or set COMMUNAL_API_SOCKET',
        );
      if (!pipe) rmSync(on.socketPath, { force: true });
      await this.listenOn((r) => this.server!.listen(on.socketPath, r));
      if (!pipe) chmodSync(on.socketPath, 0o600);
      return on.socketPath;
    }
    await this.listenOn((r) => this.server!.listen(on.port, on.host, r));
    const a = this.server.address() as AddressInfo;
    return `http://${on.host}:${a.port}`;
  }

  /** Starts listening; a failure (port in use, bad path) rejects instead of crashing. */
  private listenOn(start: (ready: () => void) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      start(() => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  async close() {
    this.unsubscribe?.();
    clearTimeout(this.flushTimer);
    for (const ws of this.sockets.clients) ws.terminate();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /**
   * `{reshared}` when files saved at `dir` (+ `inside`) land in a share someone else can see, so
   * the CLI and agents can tell the person (ADR 0021). The app asks before downloading.
   */
  private async reshared(dir: string, inside?: string) {
    const e = await this.core.exposure(dir, inside).catch(() => null);
    return e?.shared && e.others ? { reshared: e } : {};
  }

  private authorized(req: IncomingMessage, token?: Buffer): boolean {
    if (!token) return true;
    const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    return got.length === token.length && timingSafeEqual(got, token);
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, token?: Buffer) {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname !== '/v1/events' || !this.authorized(req, token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    this.sockets.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      // Incoming messages are ignored; the channel only goes one way.
      ws.on('error', () => ws.terminate());
    });
  }

  /** Turns core events into topic hints for `/v1/events`. Returns the unsubscribe function. */
  private watchCore(): () => void {
    const offs: (() => void)[] = [];
    const on = <
      E extends { on(e: string, f: () => void): unknown; off(e: string, f: () => void): unknown },
    >(
      emitter: E,
      events: string[],
      topic: ApiTopic,
    ) => {
      const f = () => this.notify(topic);
      for (const e of events) {
        emitter.on(e, f);
        offs.push(() => emitter.off(e, f));
      }
    };
    const c = this.core;
    on(c.hubs, ['ready', 'disconnected', 'fatal', 'pending_approval', 'enrolled'], 'hubs');
    on(c.hubs, ['presence'], 'presence');
    on(c.downloads, ['progress', 'done', 'waiting', 'queued', 'failed'], 'transfers');
    on(c.indexer, ['changed', 'scanned'], 'index');
    on(c.media, ['changed'], 'index');
    const hubEvent = ({ msg }: { msg: { t: string } }) => {
      const topic = HUB_EVENT_TOPIC[msg.t];
      if (topic) this.notify(topic);
    };
    c.hubs.on('event', hubEvent);
    offs.push(() => c.hubs.off('event', hubEvent));
    return () => offs.forEach((f) => f());
  }

  /** Something changed; tell event listeners soon, coalescing bursts (progress, scans). */
  notify(topic: ApiTopic) {
    if (this.sockets.clients.size === 0) return;
    this.pending.add(topic);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      const msg = JSON.stringify({ topics: [...this.pending] });
      this.pending.clear();
      for (const ws of this.sockets.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
    }, 250);
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
    if (!this.authorized(req, token)) return send(401, { error: 'unauthorized' });
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
        const status = {
          bad_request: 400,
          forbidden: 403,
          not_found: 404,
          conflict: 409,
          unavailable: 503,
        }[err.code];
        return send(status, { error: err.code, message: err.message });
      }
      if (err instanceof HubError) {
        const status =
          { not_found: 404, bad_request: 400, forbidden: 403, conflict: 409 }[err.code as string] ??
          502;
        return send(status, { error: err.code, message: err.message });
      }
      if (err instanceof RemoteError) {
        const status = { not_allowed: 403, bad_request: 400, not_found: 404 }[err.code as string];
        return send(status ?? 502, { error: err.code, message: err.message });
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
