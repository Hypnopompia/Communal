/**
 * The Communal MCP server (ADR 0017): tools an AI agent uses to work with Communal through a
 * running core's local API (the headless daemon, or the open desktop app). Everything a person
 * can do in the app is here except handling secrets and trust: exporting the recovery key,
 * linking, approving or removing devices, and marking a person as verified (that needs two
 * people comparing a code). Hub admins also get tools to manage their hub (ADR 0020), but
 * nothing here can make or remove admins: that's done on the hub's server. Changes are
 * annotated so clients ask before running them.
 */
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { LocalApiClient } from '@communal/core';

export const MCP_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

type Json = Record<string, unknown>;
const q = (params: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
const enc = encodeURIComponent;

const Kind = z.enum([
  'image',
  'video',
  'audio',
  'document',
  'archive',
  'code',
  'text',
  'disk_image',
  'other',
]);
const Hub = z.string().describe('Local hub id, from list_hubs (e.g. "h_ab12cd34ef")');
const Audience = z
  .union([
    z.literal('me'),
    z.literal('hub'),
    z.object({ users: z.array(z.string()).optional(), groups: z.array(z.string()).optional() }),
  ])
  .describe(
    '"me" = only my own devices; "hub" = everyone signed in to that hub; or {users, groups}: ' +
      'connected people (user ids) and my groups (group ids)',
  );

/** A tool result that isn't JSON text: images, say. */
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
class Raw {
  constructor(readonly content: Content[]) {}
}

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const THUMB_LIMIT = { small: 12, large: 2 } as const;

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const CHANGE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const REMOVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

type RemoteDevice = { device_id: string; name: string; platform: string; online: boolean };

/** A request on another device of mine (ADR 0023), by its id or name. */
async function remote<T = unknown>(c: LocalApiClient, which: string, request: object): Promise<T> {
  let id = which;
  if (!/^d_[a-z2-7]{26}$/.test(which)) {
    const { devices } = await c.get<{ devices: RemoteDevice[] }>('/v1/remote/devices');
    const hits = devices.filter((d) => d.name.toLowerCase() === which.toLowerCase());
    if (hits.length !== 1)
      throw new Error(
        hits.length
          ? `several devices are called ${which}: use its id`
          : `no device of mine called ${which}`,
      );
    id = hits[0]!.device_id;
  }
  return (await c.post<{ result: T }>(`/v1/remote/${encodeURIComponent(id)}`, request)).result;
}

/** Another device numbers its hubs its own way: requests name them by URL. */
async function hubUrl(c: LocalApiClient, hub: string): Promise<string> {
  const { hubs } = await c.get<{ hubs: { id: string; url: string }[] }>('/v1/hubs');
  const h = hubs.find((x) => x.id === hub || x.url === hub);
  if (!h) throw new Error(`no such hub: ${hub}`);
  return h.url;
}

/** Another device saves only into its downloads folder or a destination, never a path. */
function noPath(dest: string | undefined) {
  if (dest) throw new Error('dest is a folder on this computer; on another device use destination');
}

export function createServer(api: () => Promise<LocalApiClient>, where: () => string): McpServer {
  const server = new McpServer(
    { name: 'communal', version: MCP_VERSION },
    {
      instructions:
        'Communal is private, Napster-style file sharing: people join hubs, share folders from ' +
        'their computers, choose who can see each folder or file (per hub), and download ' +
        'directly from each other. Use list_hubs first; most tools take a hub id. Files are ' +
        'identified by content hash. Paths on hubs look like "ShareName/folder/file". ' +
        'Changing who can see something (set_access) exposes files to other people: run ' +
        'preview_access first, show the user its summary and wait for them to agree; a ' +
        'preview is never a confirmation. show_in_app moves the open ' +
        'desktop window to a screen so the user can see what you did. On hubs where list_hubs ' +
        'says admin: true, the *_hub_* tools manage the hub (people waiting to join, bans, its ' +
        'settings, connections and the admin log); confirm every ban, approval and settings ' +
        'change with the user first. Admins are only made on the hub server, never here. ' +
        'Downloads can go to a named destination (list_destinations) and, with on_device, to ' +
        'another of my devices (list_remote_devices), which saves only into its downloads folder ' +
        'or its destinations; confirm with the user before set_remote_settings turns allowed on.',
    },
  );

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    annotations: ToolAnnotations,
    run: (c: LocalApiClient, args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any) => {
        try {
          const out = await run(await api(), args as z.infer<z.ZodObject<S>>);
          if (out instanceof Raw) return { content: out.content };
          return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] };
        } catch (err) {
          const e = err as Error & { code?: string };
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: `${e.code ? `${e.code}: ` : ''}${e.message}` },
            ],
          };
        }
      }) as never,
    );

  // ── overview ──
  tool(
    'get_status',
    'This device, its account, connected hubs, indexing progress and which Communal (desktop app or headless daemon) the tools are talking to.',
    {},
    READ,
    async (c) => ({ connected_to: where(), ...(await c.get<Json>('/v1/status')) }),
  );
  tool(
    'list_hubs',
    'Hubs this device is on, with their local ids and connection state.',
    {},
    READ,
    (c) => c.get('/v1/hubs'),
  );
  tool(
    'self_check',
    'Checks that the install works here: native modules, ffmpeg, the trash helper.',
    {},
    READ,
    (c) => c.get('/v1/self-check'),
  );

  // ── finding files ──
  tool(
    'search_files',
    'Searches every hub for files shared with this account. Every word must match the start of a word in the file name. One hit per distinct content (hash), with its sources and how recently each source was online.',
    {
      query: z.string().max(256).describe('Words to look for, e.g. "beach 2019"'),
      kind: Kind.optional(),
      min_size: z.number().int().nonnegative().optional().describe('Smallest size in bytes'),
      available: z
        .enum(['now', 'today', 'week', 'month'])
        .optional()
        .describe('Only files with a source seen at least this recently'),
      from: z
        .enum(['anyone', 'connections', 'verified'])
        .optional()
        .describe(
          'Only files from my connections, or from people I verified by safety code (and me)',
        ),
      limit: z.number().int().min(1).max(200).default(25),
    },
    READ,
    (c, a) =>
      c.get(
        `/v1/search${q({ q: a.query, kind: a.kind, min_size: a.min_size, available: a.available, from: a.from, limit: a.limit })}`,
      ),
  );
  tool(
    'list_library',
    "Every computer this account can browse (its own and other people's), with the owner, whether it is online, and the hub to use when browsing it.",
    {},
    READ,
    (c) => c.get('/v1/library'),
  );
  tool(
    'browse_folder',
    'Lists one folder on a computer: subfolders and files with size, type, metadata and hash. Use path "" for the computer\'s shared folders.',
    {
      hub: Hub,
      device: z.string().describe('Device id from list_library'),
      path: z.string().default('').describe('Folder path, e.g. "Photos/2024/"'),
    },
    READ,
    (c, a) => c.get(`/v1/browse${q({ hub: a.hub, device: a.device, path: a.path })}`),
  );
  tool(
    'preview_text',
    "Reads the start of a text or code file from its owner's computer without downloading it.",
    { hub: Hub, device: z.string(), hash: z.string().regex(/^[0-9a-f]{64}$/) },
    READ,
    (c, a) => c.get(`/v1/peek${q(a)}`),
  );

  tool(
    'view_thumbnails',
    "Shows thumbnails of files on someone's computer (or this one) as images, so you can see what photos, videos, PDFs and other files with a thumbnail look like without downloading them. Use hashes of entries whose thumb is true (from browse_folder or search_files). small (320 px) takes up to 12 at once, large (1600 px) up to 2. The owner's computer checks access for every file, and location data is stripped.",
    {
      hub: Hub,
      device: z.string().describe('Device id that has the files (a source from search or browse)'),
      hashes: z.array(Hash).min(1).max(THUMB_LIMIT.small),
      size: z.enum(['small', 'large']).default('small'),
    },
    READ,
    async (c, a) => {
      const size = a.size === 'large' ? 1600 : 320;
      const hashes = [...new Set(a.hashes)];
      if (hashes.length > THUMB_LIMIT[a.size])
        throw new Error(`${a.size} thumbnails: at most ${THUMB_LIMIT[a.size]} at once`);
      const { thumbs } = await c.post<{ thumbs: Record<string, boolean> }>('/v1/thumbs', {
        hub: a.hub,
        device: a.device,
        hashes,
        size,
      });
      const content: Content[] = [];
      const missing: string[] = [];
      for (const h of hashes) {
        const img = thumbs[h]
          ? await c.bytes(`/v1/thumbs/${h}?size=${size}`).catch(() => null)
          : null;
        if (!img) {
          missing.push(h);
          continue;
        }
        content.push({ type: 'text', text: `Thumbnail of ${h}:` });
        content.push({ type: 'image', data: img.data.toString('base64'), mimeType: img.type });
      }
      if (missing.length)
        content.push({
          type: 'text',
          text: `No thumbnail (none made, not allowed, or the computer is offline): ${missing.join(', ')}`,
        });
      return new Raw(content);
    },
  );

  // ── downloads ──
  tool(
    'download_file',
    'Downloads a file by content hash from every online source, on this computer or, with on_device, on another of my devices. It lands in the downloads folder unless dest (a path, this computer only) or destination (a name) is given. If the folder is inside one of my shares, the files are shared like the rest of it: the answer then carries reshared (who will see them), which you should tell the user. Check first with check_destination when choosing dest.',
    {
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      name: z.string().max(255).optional().describe('File name to save as'),
      dest: z.string().max(4096).optional().describe('Folder to save into (absolute path)'),
      destination: z
        .string()
        .max(40)
        .optional()
        .describe('A named destination from list_destinations, e.g. "Movies" (instead of dest)'),
      on_device: z
        .string()
        .max(64)
        .optional()
        .describe(
          'Another device of mine (id or name from list_remote_devices) to do it instead; it saves into its downloads folder or one of its destinations, never a path',
        ),
    },
    CHANGE,
    async (c, { on_device, ...a }) => {
      if (!on_device) return c.post('/v1/downloads', a);
      noPath(a.dest);
      return remote(c, on_device, {
        op: 'download',
        hash: a.hash,
        ...(a.name ? { name: a.name } : {}),
        ...(a.destination ? { destination: a.destination } : {}),
      });
    },
  );
  tool(
    'list_destinations',
    'The named places to save on this computer (ADR 0018), like Movies or Music, with their folders. "Downloads" is the downloads folder. Pass a name as destination to download_file, download_folder or subscribe_folder.',
    {},
    READ,
    (c) => c.get('/v1/destinations'),
  );
  tool(
    'save_destination',
    'Adds a named destination on this computer (e.g. Movies → /media/movies), or with was, renames or moves one. The folder is created if missing. Other devices of mine can then ask this computer to save into it by name. Check the folder with check_destination first: one inside my shares re-shares what lands there.',
    {
      name: z.string().min(1).max(40),
      folder: z.string().min(1).max(4096).describe('Absolute folder path'),
      was: z.string().max(40).optional().describe('The current name, to rename or move it'),
    },
    CHANGE,
    (c, a) =>
      a.was
        ? c.put(`/v1/destinations/${enc(a.was)}`, { name: a.name, path: a.folder })
        : c.post('/v1/destinations', { name: a.name, path: a.folder }),
  );
  tool(
    'remove_destination',
    'Forgets a named destination. The folder and its files stay. "Downloads" is the downloads folder and can\'t be removed.',
    { name: z.string().min(1).max(40) },
    REMOVE,
    (c, a) => c.delete(`/v1/destinations/${enc(a.name)}`),
  );
  tool(
    'check_destination',
    "Who would see files saved into a folder of this computer. A folder inside one of my shares re-shares what lands there, possibly to people the original owner didn't choose. Pass inside to name the file or folder that will be created there. If others is true, tell the user its summary and ask before saving there.",
    {
      dir: z.string().min(1).max(4096).describe('Absolute folder path'),
      inside: z.string().max(4096).optional().describe('File or "Folder/" to be created in dir'),
    },
    READ,
    (c, a) => c.get(`/v1/exposure${q({ dir: a.dir, inside: a.inside })}`),
  );
  tool(
    'download_folder',
    "Downloads a folder of another computer once, with its subfolders, into <dest or the downloads folder>/<folder name>. Content this computer already has is copied instead of downloaded. Answers with how many files were queued, copied, already there, or still being prepared on the owner's side. If the folder is inside one of my shares, the files are shared like the rest of it: the answer then carries reshared (who will see them), which you should tell the user. Check first with check_destination when choosing dest.",
    {
      hub: z.string(),
      device: z.string().describe('The device_id of the computer the folder is on'),
      path: z.string().max(4096).describe('The folder, e.g. "Music/Albums/Blue/"'),
      dest: z.string().max(4096).optional().describe('Folder to save into (absolute path)'),
      destination: z
        .string()
        .max(40)
        .optional()
        .describe('A named destination from list_destinations, e.g. "Movies" (instead of dest)'),
      on_device: z
        .string()
        .max(64)
        .optional()
        .describe(
          'Another device of mine (id or name from list_remote_devices) to do it instead; it saves into its downloads folder or one of its destinations, never a path',
        ),
    },
    CHANGE,
    async (c, { on_device, ...a }) => {
      if (!on_device) return c.post('/v1/downloads/folder', a);
      noPath(a.dest);
      return remote(c, on_device, {
        op: 'download_folder',
        hub: await hubUrl(c, a.hub),
        device_id: a.device,
        path: a.path,
        ...(a.destination ? { destination: a.destination } : {}),
      });
    },
  );
  // ── remote control (ADR 0023): my devices downloading for each other ──
  tool(
    'get_remote_settings',
    'Whether my other devices may start downloads on this computer (allowed), and whether they may use its downloads folder or only its named destinations (downloads).',
    {},
    READ,
    (c) => c.get('/v1/settings/remote'),
  );
  tool(
    'set_remote_settings',
    'Changes whether my other devices may start downloads on this computer (allowed), and whether they may save into its downloads folder or only into its named destinations (downloads). Turning allowed on lets every device of mine start downloads here: confirm with the user first.',
    { allowed: z.boolean().optional(), downloads: z.boolean().optional() },
    CHANGE,
    (c, a) => c.put('/v1/settings/remote', a),
  );
  tool(
    'list_remote_devices',
    'My other devices, whether each is online and takes requests, and the names of the destinations each offers (its folders never leave it). Use one as on_device in download_file, download_folder, subscribe_folder, list_transfers and cancel_transfer.',
    {},
    READ,
    async (c) => {
      const { devices } = await c.get<{ devices: RemoteDevice[] }>('/v1/remote/devices');
      return {
        devices: await Promise.all(
          devices.map(async (d) => {
            if (!d.online) return { ...d, takes_requests: false };
            const h = await remote<{ allowed: boolean; destinations?: string[] }>(c, d.device_id, {
              op: 'hello',
            }).catch(() => null);
            return {
              ...d,
              takes_requests: h?.allowed ?? false,
              ...(h?.allowed ? { destinations: h.destinations ?? ['Downloads'] } : {}),
            };
          }),
        ),
      };
    },
  );

  // ── the synced folder (ADR 0019) ──
  tool(
    'get_synced_folder',
    "The folder kept the same on all the user's computers: whether it's on here, where, and which other computers it's in step with.",
    {},
    READ,
    (c) => c.get('/v1/sync'),
  );
  tool(
    'set_synced_folder',
    'Turns the synced folder on (optionally at path, default ~/Communal; only the user can see it) or off on this computer. Turning it off deletes nothing.',
    {
      on: z.boolean(),
      path: z.string().max(4096).optional().describe('Folder to sync (absolute path)'),
    },
    CHANGE,
    (c, a) => (a.on ? c.put('/v1/sync', a.path ? { path: a.path } : {}) : c.delete('/v1/sync')),
  );
  tool(
    'list_transfers',
    "Downloads: queued, running (with per-source speeds), waiting, done and failed, with the diagnosis and tips when a source can't be reached. With on_device, another of my devices' 30 newest downloads instead.",
    { on_device: z.string().max(64).optional().describe('Another device of mine (id or name)') },
    READ,
    (c, a) => (a.on_device ? remote(c, a.on_device, { op: 'transfers' }) : c.get('/v1/downloads')),
  );
  tool(
    'cancel_transfer',
    'Cancels a download, here or, with on_device, on another of my devices.',
    { id: z.string(), on_device: z.string().max(64).optional() },
    REMOVE,
    (c, a) =>
      a.on_device
        ? remote(c, a.on_device, { op: 'cancel', id: a.id })
        : c.delete(`/v1/downloads/${enc(a.id)}`),
  );
  tool(
    'get_activity',
    'Who downloaded what from this computer (the local upload log, never sent to hubs).',
    { limit: z.number().int().min(1).max(1000).default(50) },
    READ,
    (c, a) => c.get(`/v1/uploads/log${q({ limit: a.limit })}`),
  );

  // ── sharing ──
  tool(
    'list_shares',
    'Folders this computer shares, with the hubs each is listed on.',
    {},
    READ,
    (c) => c.get('/v1/shares'),
  );
  tool(
    'share_folder',
    'Shares a local folder under a name. New shares are visible only to the owner until set_access opens them up. hubs defaults to every hub.',
    {
      path: z.string().min(1).max(4096).describe('Absolute path of the local folder'),
      name: z.string().min(1).max(255).describe('Name others see, e.g. "Photos"'),
      hubs: z.array(z.string()).optional(),
    },
    CHANGE,
    (c, a) => c.post('/v1/shares', a),
  );
  tool(
    'stop_sharing',
    'Stops sharing a folder. Nothing is deleted from disk; people lose access at once.',
    { name: z.string() },
    REMOVE,
    (c, a) => c.delete(`/v1/shares/${enc(a.name)}`),
  );
  tool(
    'set_share_hubs',
    'Chooses which hubs a share is listed on.',
    { name: z.string(), hubs: z.array(z.string()) },
    CHANGE,
    (c, a) => c.put(`/v1/shares/${enc(a.name)}/hubs`, { hubs: a.hubs }),
  );
  tool(
    'get_access_rules',
    'Who can see what on one hub: rules by path. A path without its own rule follows the nearest folder above it, else only me.',
    { hub: Hub },
    READ,
    (c, a) => c.get(`/v1/acl${q({ hub: a.hub })}`),
  );
  tool(
    'preview_access',
    'Shows what set_access would do without doing it: which of my files would be seen by whom instead, on that hub, with people named and counted, and whether anyone new could see them (widens). Run it before set_access and show the user its summary. It is not a confirmation: still ask the user.',
    {
      hub: Hub,
      path: z.string().min(1).max(4096).describe('e.g. "Photos/" or "Photos/2024/beach.jpg"'),
      audience: Audience.nullable(),
    },
    READ,
    (c, a) => c.post('/v1/acl/preview', a),
  );
  tool(
    'set_access',
    'Sets who can see a folder (path ending in "/") or file on one hub. audience null removes the rule so it follows its folder again. This can expose files to other people: run preview_access first, show the user what it says, and only go ahead once they agree.',
    {
      hub: Hub,
      path: z.string().min(1).max(4096).describe('e.g. "Photos/" or "Photos/2024/beach.jpg"'),
      audience: Audience.nullable(),
    },
    CHANGE,
    (c, a) => c.put('/v1/acl', a),
  );

  // ── people ──
  tool(
    'list_connections',
    'Connections on a hub: accepted, requests to me (pending_in) and from me (pending_out).',
    { hub: Hub },
    READ,
    (c, a) => c.get(`/v1/people${q({ hub: a.hub })}`),
  );
  tool(
    'find_people',
    'Finds people on a hub by name.',
    { hub: Hub, name: z.string().min(1).max(64) },
    READ,
    (c, a) => c.get(`/v1/people/search${q({ hub: a.hub, q: a.name })}`),
  );
  tool(
    'request_connection',
    'Asks someone to connect (or accepts their request if they already asked).',
    { hub: Hub, user_id: z.string() },
    CHANGE,
    (c, a) => c.post('/v1/people/request', a),
  );
  tool(
    'accept_connection',
    'Accepts a connection request.',
    { hub: Hub, user_id: z.string() },
    CHANGE,
    (c, a) => c.post('/v1/people/accept', a),
  );
  tool(
    'remove_connection',
    'Disconnects from someone (or declines/cancels a request). Access granted through the connection ends at once, both ways.',
    { hub: Hub, user_id: z.string() },
    REMOVE,
    (c, a) => c.post('/v1/people/remove', a),
  );
  tool('list_groups', 'My groups on a hub (private to me).', { hub: Hub }, READ, (c, a) =>
    c.get(`/v1/groups${q({ hub: a.hub })}`),
  );
  tool(
    'save_group',
    'Creates a group, or replaces one when group_id is given. Members must be connections.',
    {
      hub: Hub,
      group_id: z.string().optional(),
      name: z.string().min(1).max(64),
      members: z.array(z.string()).max(1000),
    },
    CHANGE,
    (c, a) => c.post('/v1/groups', a),
  );
  tool('delete_group', 'Deletes a group.', { hub: Hub, group_id: z.string() }, REMOVE, (c, a) =>
    c.delete(`/v1/groups/${enc(a.group_id)}${q({ hub: a.hub })}`),
  );

  // ── subscriptions ──
  tool(
    'list_subscriptions',
    'Folders this computer follows: new files download automatically.',
    {},
    READ,
    (c) => c.get('/v1/subscriptions'),
  );
  tool(
    'subscribe_folder',
    "Follows a folder on someone's computer. Ask the user whether to delete local copies when the owner deletes files (mirror_deletes); the safe default is false. If the folder is inside one of my shares, the files are shared like the rest of it: the answer then carries reshared (who will see them), which you should tell the user. Check first with check_destination when choosing dest.",
    {
      hub: Hub,
      device: z.string(),
      path: z.string().min(1).describe('Folder, e.g. "Photos/2024/"'),
      mirror_deletes: z.boolean(),
      dest: z.string().optional().describe('Local folder for the files (absolute path)'),
      destination: z
        .string()
        .max(40)
        .optional()
        .describe('A named destination from list_destinations, e.g. "Movies" (instead of dest)'),
      on_device: z
        .string()
        .max(64)
        .optional()
        .describe(
          'Another device of mine (id or name from list_remote_devices) to do it instead; it saves into its downloads folder or one of its destinations, never a path',
        ),
    },
    CHANGE,
    async (c, { on_device, ...a }) => {
      if (!on_device) return c.post('/v1/subscriptions', a);
      noPath(a.dest);
      return remote(c, on_device, {
        op: 'subscribe',
        hub: await hubUrl(c, a.hub),
        device_id: a.device,
        path: a.path,
        mirror_deletes: a.mirror_deletes,
        ...(a.destination ? { destination: a.destination } : {}),
      });
    },
  );
  tool(
    'update_subscription',
    'Pauses or resumes a subscription, or changes mirror_deletes.',
    { id: z.string(), paused: z.boolean().optional(), mirror_deletes: z.boolean().optional() },
    CHANGE,
    (c, { id, ...b }) => c.put(`/v1/subscriptions/${enc(id)}`, b),
  );
  tool(
    'unsubscribe',
    'Stops following a folder. Files already downloaded stay.',
    { id: z.string() },
    REMOVE,
    (c, a) => c.delete(`/v1/subscriptions/${enc(a.id)}`),
  );

  // ── hubs, network, settings ──
  tool(
    'join_hub',
    'Joins another hub with this account (creates the account there). Existing shares are not listed there until set_share_hubs.',
    {
      url: z.string().url().describe('e.g. "wss://hub.example.com/v1"'),
      display_name: z.string().min(1).max(64),
      device_name: z.string().min(1).max(64),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    (c, a) => c.post('/v1/hubs', a),
  );
  tool('leave_hub', 'Leaves a hub on this device.', { hub: Hub }, REMOVE, (c, a) =>
    c.delete(`/v1/hubs/${enc(a.hub)}`),
  );
  tool(
    'list_devices',
    "This account's computers, which is the first, and whether each is online.",
    {},
    READ,
    (c) => c.get('/v1/devices'),
  );
  tool(
    'get_network',
    'How reachable this computer is: NAT type per hub, router port mapping, IPv6.',
    {},
    READ,
    (c) => c.get('/v1/network'),
  );
  tool('check_network', 'Runs the network check again.', {}, READ, (c) =>
    c.post('/v1/network/check', {}),
  );
  tool(
    'get_settings',
    'Upload limits, the downloads folder and the thumbnail-cache size.',
    {},
    READ,
    async (c) => ({
      uploads: await c.get('/v1/settings/uploads'),
      downloads: await c.get('/v1/settings/downloads'),
      storage: await c.get('/v1/settings/storage'),
    }),
  );
  tool(
    'set_downloads_folder',
    'Where downloads land unless a dest is given (absolute path, created if needed). null goes back to the usual folder.',
    { dir: z.string().max(4096).nullable() },
    CHANGE,
    (c, a) => c.put('/v1/settings/downloads', a),
  );
  tool(
    'set_upload_limits',
    'Upload limits: speed in bytes per second (0 = none), people downloading at once, home-network only.',
    {
      bytesPerSecond: z.number().int().min(0).optional(),
      maxConcurrent: z.number().int().min(0).max(100).optional(),
      lanOnly: z.boolean().optional(),
    },
    CHANGE,
    (c, a) => c.put('/v1/settings/uploads', a),
  );

  // ── hub admin (ADR 0020): only on hubs where list_hubs says admin: true ──
  const admin = (hub: string, path: string) => `/v1/hubs/${enc(hub)}/admin${path}`;
  tool(
    'list_hub_users',
    'Everyone on a hub I administer: status (active or waiting to join), banned or not, admin or not, and their computers with online state and how many files and bytes each shares. Never file names.',
    { hub: Hub },
    READ,
    (c, a) => c.get(admin(a.hub, '/users')),
  );
  tool(
    'approve_hub_user',
    'Lets someone who is waiting to join into a hub I administer. Confirm with the user first.',
    { hub: Hub, user_id: z.string() },
    CHANGE,
    (c, a) => c.post(admin(a.hub, `/users/${enc(a.user_id)}/approve`), {}),
  );
  tool(
    'ban_hub_user',
    'Bans someone from a hub I administer: their computers are signed out at once and their files disappear from that hub. Admins can’t be banned this way. Confirm with the user first.',
    {
      hub: Hub,
      user_id: z.string(),
      reason: z.string().max(200).optional().describe('Kept in the admin log; not sent to them'),
    },
    REMOVE,
    (c, a) =>
      c.post(admin(a.hub, `/users/${enc(a.user_id)}/ban`), a.reason ? { reason: a.reason } : {}),
  );
  tool(
    'unban_hub_user',
    'Lifts a ban on a hub I administer.',
    { hub: Hub, user_id: z.string() },
    CHANGE,
    (c, a) => c.post(admin(a.hub, `/users/${enc(a.user_id)}/unban`), {}),
  );
  tool(
    'get_hub_settings',
    'A hub I administer: its name, join mode (open: anyone with the address; approval: people wait to be let in) and abuse limits (0 = no limit).',
    { hub: Hub },
    READ,
    (c, a) => c.get(admin(a.hub, '/settings')),
  );
  tool(
    'set_hub_settings',
    'Changes the name, join mode or abuse limits of a hub I administer. "open" lets anyone with the address in. Confirm with the user first.',
    {
      hub: Hub,
      join_mode: z.enum(['open', 'approval']).optional(),
      name: z
        .string()
        .min(1)
        .max(64)
        .nullable()
        .optional()
        .describe('What people see instead of the address; null removes it'),
      signups_per_hour: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional()
        .describe('New accounts and devices one internet address may add per hour; 0 = no limit'),
      max_files_per_device: z
        .number()
        .int()
        .min(0)
        .max(100_000_000)
        .optional()
        .describe('Files one device may share on the hub; 0 = no limit'),
      max_devices_per_account: z
        .number()
        .int()
        .min(0)
        .max(1_000)
        .optional()
        .describe('Devices one account may have on the hub; 0 = no limit'),
    },
    REMOVE,
    (c, a) => {
      const { hub, ...change } = a;
      return c.put(admin(hub, '/settings'), change);
    },
  );
  tool(
    'get_hub_graph',
    'Who is connected to whom on a hub I administer (accepted and pending). Never groups or who can see which files.',
    { hub: Hub },
    READ,
    (c, a) => c.get(admin(a.hub, '/graph')),
  );
  tool(
    'get_hub_admin_log',
    'The admin log of a hub I administer, newest first: approvals, bans, settings changes and admin changes, from the app or the server. Page with before (an entry id).',
    {
      hub: Hub,
      limit: z.number().int().min(1).max(500).optional(),
      before: z.number().int().positive().optional(),
    },
    READ,
    (c, a) => c.get(admin(a.hub, `/log${q({ limit: a.limit, before: a.before })}`)),
  );

  // ── the app window ──
  tool(
    'show_in_app',
    'Shows a screen in the open Communal desktop app (fails for the headless daemon). library takes hub, device and path to open a folder; search takes q; settings takes tab; manage (a hub I administer) takes hub and tab people|connections|log|settings.',
    {
      screen: z.enum([
        'library',
        'search',
        'shares',
        'people',
        'transfers',
        'subscriptions',
        'activity',
        'settings',
        'manage',
      ]),
      hub: z.string().optional(),
      device: z.string().optional(),
      path: z.string().optional(),
      q: z.string().optional(),
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
          'people',
          'connections',
          'log',
        ])
        .optional(),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    (c, a) => c.post('/v1/ui/show', a),
  );

  return server;
}
