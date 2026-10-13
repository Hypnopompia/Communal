/**
 * The core's local API as the renderer sees it. Requests go to `communal://api`, which the
 * main process forwards to the core with its token. These types describe the HTTP contract
 * (packages/core/src/api/server.ts); they're declared here because the renderer can't import
 * the core's Node-typed sources.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const BASE = 'communal://api';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, 'bad_response', 'The app’s engine sent something unreadable.');
  }
  if (!res.ok) {
    const e = (json ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? 'error', e.message ?? e.error ?? 'Request failed');
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => call<T>('PUT', path, body),
  del: <T>(path: string) => call<T>('DELETE', path),
};

export const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const thumbUrl = (hash: string, size: 320 | 1600 = 320) =>
  `${BASE}/v1/thumbs/${hash}?size=${size}`;
export const streamUrl = (hash: string, mime: string) =>
  `${BASE}/v1/stream/${hash}?type=${encodeURIComponent(mime)}`;

// ── wire types ──────────────────────────────────────────────────────────────

export type Kind =
  'image' | 'video' | 'audio' | 'document' | 'archive' | 'code' | 'text' | 'disk_image' | 'other';

export type Seen = 'now' | 'today' | 'week' | 'month' | 'older';

export interface Meta {
  width?: number;
  height?: number;
  duration?: number;
  taken_at?: number;
  codec?: string;
  artist?: string;
  album?: string;
  title?: string;
  pages?: number;
}

export interface Person {
  user_id: string;
  display_name: string;
  fingerprint: string;
  verified: boolean;
}

export interface HubProblem {
  reason: string;
  message: string;
}

export interface HubStatus {
  id: string;
  url: string;
  ready: boolean;
  problem: HubProblem | null;
  registered: boolean;
  user_id: string | null;
  network: { nat: string; upnp: boolean; ipv6: boolean; cgnat: boolean } | null;
}

export interface Status {
  device_id: string;
  account: Identity;
  hubs: HubStatus[];
  index: {
    files: number;
    hashed: number;
    bytes: number;
    analysed: number;
    pending: number;
    thumbs: number;
  };
  peer_port: number;
  uploads: { active: number; limits: UploadLimits };
  shares: { name: string; hubs: string[] }[];
}

export interface Identity {
  device_id: string;
  user_id: string | null;
  fingerprint: string | null;
  root_device: boolean;
  holds_root_key: boolean;
}

export interface UploadLimits {
  maxConcurrent: number;
  bytesPerSecond: number;
  lanOnly: boolean;
}

export interface LibraryDevice {
  hub: string;
  device_id: string;
  device_name: string;
  user: Person;
  online: boolean;
  seen: Seen;
}

export interface FileEntry {
  path: string;
  size: number;
  mtime: number;
  mime: string;
  kind: Kind;
  meta: Meta;
  thumb: boolean;
  hash: string | null;
  icon: string;
}

export interface Listing {
  online: boolean;
  dirs: { name: string }[];
  files: FileEntry[];
}

export interface Source {
  hub: string;
  device_id: string;
  owner: string;
  path: string;
  online: boolean;
  seen: Seen;
}

export interface Hit {
  hash: string;
  name: string;
  size: number;
  mime: string;
  kind: Kind;
  meta: Meta;
  thumb: boolean;
  icon: string;
  sources: Source[];
}

export interface SearchResult {
  hits: Hit[];
  hubs: { hub: string; ok: boolean; cursor?: string; error?: string }[];
}

export interface Share {
  name: string;
  root: string;
  hubs: string[];
  created_at: number;
}

export type Audience = 'me' | 'hub' | { users?: string[]; groups?: string[] };

export interface Connection extends Person {
  state: 'accepted' | 'pending_in' | 'pending_out';
  since: number;
}

export interface Group {
  group_id: string;
  name: string;
  members: string[];
}

export interface Diagnosis {
  cause: string;
  easier_fix: string;
  message: string;
  tips: string[];
  fix: string | null;
}

export interface Transfer {
  id: string;
  hash: string;
  name: string;
  dest_dir: string;
  size: number | null;
  state: 'queued' | 'active' | 'waiting' | 'done' | 'failed' | 'cancelled';
  bytes_done: number;
  error: string | null;
  final_path: string | null;
  diagnosis: Diagnosis | null;
  created_at: number;
  updated_at: number;
  sources: { hub: string; device_id: string; bytes: number; rate: number }[];
}

export interface Subscription {
  id: string;
  hub: string;
  device_id: string;
  path: string;
  recursive: boolean;
  dest_dir: string;
  mirror_deletes: boolean;
  paused: boolean;
  rev: number;
  status: 'ok' | 'no_access';
  created_at: number;
}

export interface UploadLogRow {
  id: number;
  at: number;
  hub: string;
  requester_user: string;
  requester_dev: string;
  path: string;
  hash: string;
  bytes: number;
  status: 'completed' | 'partial' | 'cancelled' | 'denied';
  kind: 'file' | 'thumbnail';
}

export interface Device {
  device_id: string;
  name: string;
  platform: string;
  root: boolean;
  this_device: boolean;
  revoked: boolean;
  hubs: { hub: string; online: boolean; last_seen: number | null }[];
}

export interface LinkRequest {
  request_id: string;
  hub: string;
  device_name: string;
  platform: string;
  device_id: string;
  at: number;
}

export interface NetworkProfile {
  nat: 'none' | 'endpoint_independent' | 'symmetric' | 'blocked' | 'unknown';
  upnp: boolean;
  ipv6: boolean;
  cgnat: boolean;
  lan_addrs: string[];
}

export interface NetworkSummary {
  port: number;
  mapping: { method: 'upnp' | 'pmp'; host: string; port: number } | null;
  router_ip: string | null;
  hubs: Record<string, { profile: NetworkProfile; checked_at: number }>;
}
