#!/usr/bin/env node
/**
 * Headless client (HANDOFF §11). `communal daemon` runs the core engine and serves the local
 * API on a Unix socket; the other commands talk to it. `init` / `hub add` also work while the
 * daemon is stopped, so a device can be set up before its service starts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { pino } from 'pino';
import {
  deviceId,
  exportRecoveryFile,
  formatFingerprint,
  generateKeyPair,
  importRecoveryFile,
  keyPairFromSecret,
  RecoveryError,
  rootSecretToWords,
  toB64,
  wordsToRootSecret,
  type KeyPair,
  type RecoveryFile,
} from '@communal/crypto';
import {
  AccountFile,
  accountFields,
  CommunalCore,
  joinHub as coreJoinHub,
  linkDevice,
  restoreAccount,
  selfRoot,
  type AccountContext,
  HubManager,
  LocalApi,
  LocalApiClient,
  newHubId,
  type HubClientState,
  type HubEntry,
  type MergedSearch,
  apiSocketPath,
  discoverApi,
  seenLabel,
  RouterPortMapper,
  type Explained,
} from '@communal/core';
import { PROTOCOL_VERSION } from '@communal/protocol';

/** From package.json, which sits next to src/ and dist/ in the workspace and in releases. */
const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const log = pino({ name: 'communal', level: process.env.LOG_LEVEL ?? 'info' });
const dataDir = process.env.COMMUNAL_DATA ?? join(process.env.HOME ?? '.', '.communal');
/** Dev-only conveniences need a dev build (see docs/adr/0006-hub-sessions-and-tls.md). */
const devBuild = (process.env.COMMUNAL_BUILD ?? 'release') === 'dev';
const insecureTls = devBuild && process.env.COMMUNAL_DEV_TLS === 'self-signed';
const client = { name: 'communal-cli', version: VERSION };

const paths = {
  key: () => join(dataDir, 'device.key'),
  /** The account root secret on a device restored from a recovery key (ADR 0014). */
  rootKey: () => join(dataDir, 'root.key'),
  hubs: () => join(dataDir, 'hubs.json'),
  /** Single-hub config written before multi-hub support; migrated on first load. */
  legacyHub: () => join(dataDir, 'hub.json'),
  socket: () => process.env.COMMUNAL_API_SOCKET ?? apiSocketPath(dataDir),
};

function loadDeviceKey(): KeyPair | null {
  try {
    return keyPairFromSecret(new Uint8Array(readFileSync(paths.key())));
  } catch {
    return null;
  }
}

function ensureDeviceKey(): KeyPair {
  const existing = loadDeviceKey();
  if (existing) return existing;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const kp = generateKeyPair();
  writeFileSync(paths.key(), kp.secretKey, { mode: 0o600 });
  return kp;
}

function loadRootSecret(): Uint8Array | undefined {
  try {
    const b = new Uint8Array(readFileSync(paths.rootKey()));
    return b.length === 32 ? b : undefined;
  } catch {
    return undefined;
  }
}

function saveRootSecret(secret: Uint8Array) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.rootKey(), secret, { mode: 0o600 });
}

/**
 * Hubs and account files used directly, for setting a device up while the daemon is stopped.
 * The caller stops `hubs` when done.
 */
function offlineContext(): AccountContext {
  const device = ensureDeviceKey();
  return {
    device,
    hubs: new HubManager({
      device,
      hubs: loadHubs(),
      save: saveHubs,
      client,
      insecureTls,
      log: pino({ level: 'warn' }),
    }),
    account: new AccountFile(dataDir),
    saveRootSecret,
    log: pino({ level: 'warn' }),
  };
}

function saveHubs(hubs: HubEntry[]) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = paths.hubs() + '.tmp';
  writeFileSync(tmp, JSON.stringify({ hubs }, null, 2), { mode: 0o600 });
  renameSync(tmp, paths.hubs());
}

function loadHubs(): HubEntry[] {
  try {
    return (JSON.parse(readFileSync(paths.hubs(), 'utf8')) as { hubs: HubEntry[] }).hubs;
  } catch {
    // fall through to the legacy file / empty config
  }
  if (existsSync(paths.legacyHub())) {
    const legacy = JSON.parse(readFileSync(paths.legacyHub(), 'utf8')) as {
      hub: string;
      state: HubClientState;
    };
    const hubs = [{ id: newHubId(), url: legacy.hub, state: legacy.state }];
    saveHubs(hubs);
    renameSync(paths.legacyHub(), paths.legacyHub() + '.migrated');
    return hubs;
  }
  return [];
}

const platform = (): 'darwin' | 'win32' | 'linux' =>
  process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';

const api = () => new LocalApiClient({ socketPath: paths.socket() });

async function daemonRunning(): Promise<boolean> {
  if (!existsSync(paths.socket())) return false;
  return api()
    .get('/v1/status')
    .then(() => true)
    .catch(() => false);
}

/**
 * The core to send commands to: the headless daemon for this data dir, else (when no data dir
 * or socket was named) the open desktop app, if it allows control (ADR 0017).
 */
async function runningCore(): Promise<LocalApiClient | null> {
  if (await daemonRunning()) return api();
  if (process.env.COMMUNAL_DATA || process.env.COMMUNAL_API_SOCKET) return null;
  const found = await discoverApi();
  return found?.kind === 'desktop' ? found.client : null;
}

/** Runs a command against the running core, turning errors into a message and exit code. */
async function viaDaemon(fn: (c: LocalApiClient) => Promise<void>) {
  const core = await runningCore();
  if (!core) {
    console.error(
      'Communal is not running here: start `communal daemon`, or open the Communal app and ' +
        'turn on Settings › AI agents › "Allow control from the CLI and AI agents"',
    );
    process.exitCode = 1;
    return;
  }
  try {
    await fn(core);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

function printJoined(url: string, id: string, status: string, userId?: string, fp?: string) {
  console.log(
    status === 'pending_approval'
      ? `Joined ${url} (${id}). The hub admin must approve the account first.`
      : `Joined ${url} (${id})`,
  );
  console.log(`  user:        ${userId}`);
  console.log(`  fingerprint: ${formatFingerprint(fp ?? '')}`);
}

/** Joins a hub, through the daemon if it's running, otherwise directly. */
async function joinHub(url: string, name: string, deviceName: string): Promise<boolean> {
  if (await daemonRunning()) {
    try {
      const r = await api().post<{
        hub: { id: string; user_id?: string; fingerprint?: string };
        status: string;
      }>('/v1/hubs', { url, display_name: name, device_name: deviceName });
      printJoined(url, r.hub.id, r.status, r.hub.user_id, r.hub.fingerprint);
      return true;
    } catch (err) {
      console.error(`could not join ${url}: ${(err as Error).message}`);
      return false;
    }
  }
  const ctx = offlineContext();
  const account = ctx.account.loadOrMigrate(ctx.device, ctx.hubs.list());
  try {
    const r = await coreJoinHub(ctx.hubs, url, {
      kind: 'create',
      display_name: name,
      device_name: deviceName,
      platform: platform(),
      ...accountFields(account),
    });
    // The first hub of a fresh device makes it the root of a new account.
    if (!account) ctx.account.save(selfRoot(ctx.device));
    printJoined(url, r.hub.id, r.status, r.hub.state.userId, r.hub.state.fingerprint);
    return true;
  } catch (err) {
    console.error(`could not join ${url}: ${(err as Error).message}`);
    return false;
  } finally {
    await ctx.hubs.stop();
  }
}

function humanSize(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const program = new Command()
  .name('communal')
  .description('Communal headless client')
  .version(`${VERSION} (protocol v${PROTOCOL_VERSION})`);

program
  .command('init')
  .description('set up this device and join a first hub (same as `hub add`)')
  .requiredOption('--hub <url>', 'hub address, e.g. wss://hub.example.org/v1')
  .requiredOption('--name <display_name>', 'your display name on the hub')
  .option('--device-name <name>', 'name for this device', hostname())
  .action(async (opts: { hub: string; name: string; deviceName: string }) => {
    if (!(await joinHub(opts.hub, opts.name, opts.deviceName))) process.exitCode = 1;
  });

// ── hubs ────────────────────────────────────────────────────────────────────

const hub = program.command('hub').description('manage the hubs this device is on');

hub
  .command('add <url>')
  .description('join another hub with this device')
  .requiredOption('--name <display_name>', 'your display name on that hub')
  .option('--device-name <name>', 'name for this device', hostname())
  .action(async (url: string, opts: { name: string; deviceName: string }) => {
    if (!(await joinHub(url, opts.name, opts.deviceName))) process.exitCode = 1;
  });

hub
  .command('list')
  .description('list configured hubs')
  .action(async () => {
    if (await daemonRunning()) {
      const { hubs } = await api().get<{ hubs: { id: string; url: string; ready: boolean }[] }>(
        '/v1/hubs',
      );
      for (const h of hubs) console.log(`${h.id}  ${h.ready ? 'online ' : 'offline'}  ${h.url}`);
      if (hubs.length === 0)
        console.log('no hubs; add one with `communal hub add <url> --name <name>`');
      return;
    }
    const hubs = loadHubs();
    if (hubs.length === 0)
      console.log('no hubs; add one with `communal hub add <url> --name <name>`');
    for (const h of hubs)
      console.log(`${h.id}  ${h.state.registered ? 'joined ' : 'pending'}  ${h.url}`);
  });

hub
  .command('remove <id_or_url>')
  .description('stop using a hub on this device (your account stays on the hub)')
  .action(async (target: string) => {
    if (await daemonRunning()) {
      return viaDaemon(async (c) => {
        await c.delete(`/v1/hubs/${encodeURIComponent(target)}`);
        console.log(`removed ${target}`);
      });
    }
    const hubs = new HubManager({
      device: ensureDeviceKey(),
      hubs: loadHubs(),
      save: saveHubs,
      log,
    });
    if (await hubs.remove(target)) console.log(`removed ${target}`);
    else {
      console.error(`no such hub: ${target}`);
      process.exitCode = 1;
    }
  });

// ── shares ──────────────────────────────────────────────────────────────────

const share = program.command('share').description('manage shared folders');

share
  .command('add <path>')
  .description('share a folder (published to every hub this device is on, unless --hub is given)')
  .requiredOption('--name <name>', 'share name, shown to others as the top-level folder')
  .option('--hub <id...>', 'publish only to these hubs')
  .action((path: string, opts: { name: string; hub?: string[] }) =>
    viaDaemon(async (c) => {
      await c.post('/v1/shares', { name: opts.name, path: resolve(path), hubs: opts.hub });
      console.log(
        `sharing ${opts.name}: only you can see it until you set access (communal acl set ${opts.name}/ …)`,
      );
    }),
  );

share
  .command('remove <name>')
  .description('stop sharing a folder (files stay on disk)')
  .action((name: string) =>
    viaDaemon(async (c) => {
      await c.delete(`/v1/shares/${encodeURIComponent(name)}`);
      console.log(`stopped sharing ${name}`);
    }),
  );

share
  .command('list')
  .description('list shared folders')
  .action(() =>
    viaDaemon(async (c) => {
      const { shares } = await c.get<{ shares: { name: string; root: string; hubs: string[] }[] }>(
        '/v1/shares',
      );
      if (shares.length === 0)
        console.log('no shares; add one with `communal share add <path> --name <name>`');
      for (const s of shares)
        console.log(`${s.name}  ${s.root}  hubs: ${s.hubs.join(', ') || '(none)'}`);
    }),
  );

share
  .command('hubs <name> [hub_ids...]')
  .description('set which hubs a share is published to (none = unpublished everywhere)')
  .action((name: string, hubIds: string[]) =>
    viaDaemon(async (c) => {
      await c.put(`/v1/shares/${encodeURIComponent(name)}/hubs`, { hubs: hubIds });
      console.log(`${name} is published to: ${hubIds.join(', ') || '(no hubs)'}`);
    }),
  );

// ── search & browse ─────────────────────────────────────────────────────────

program
  .command('search [query...]')
  .description('search every connected hub at once')
  .option('--kind <kind>', 'image, video, audio, document, archive, code, text, disk_image, other')
  .option('--min-size <bytes>', 'smallest file size')
  .option('--online', 'only files with a source online now')
  .option('--seen <when>', 'only files with a source seen within: today, week, month')
  .option('--limit <n>', 'results per hub', '50')
  .option('--json', 'machine-readable output')
  .action(
    (
      words: string[],
      opts: {
        kind?: string;
        minSize?: string;
        online?: boolean;
        seen?: string;
        limit: string;
        json?: boolean;
      },
    ) =>
      viaDaemon(async (c) => {
        const p = new URLSearchParams({ q: words.join(' '), limit: opts.limit });
        if (opts.kind) p.set('kind', opts.kind);
        if (opts.minSize) p.set('min_size', opts.minSize);
        if (opts.seen && !['today', 'week', 'month'].includes(opts.seen))
          throw new Error('--seen must be today, week or month');
        const available = opts.online ? 'now' : opts.seen;
        if (available) p.set('available', available);
        const r = await c.get<MergedSearch>(`/v1/search?${p}`);
        if (opts.json) return console.log(JSON.stringify(r, null, 2));
        for (const h of r.hits) {
          const online = h.sources.filter((s) => s.online).length;
          // Sources come most available first.
          const best = online ? `${online} online` : seenLabel(h.sources[0]!.seen);
          console.log(
            `${h.name}  ${humanSize(h.size)}  ${h.kind}  ${h.sources.length} source(s), ${best}  ${h.hash.slice(0, 12)}`,
          );
        }
        const down = r.hubs.filter((h) => !h.ok);
        console.log(
          `${r.hits.length} result(s)` +
            (down.length
              ? `; unavailable: ${down.map((h) => `${h.hub} (${h.error})`).join(', ')}`
              : ''),
        );
      }),
  );

program
  .command('browse <hub> <device_id> [path]')
  .description('list a folder on a device you can see: icon, size, metadata, hash')
  .action((hubId: string, device: string, path = '') =>
    viaDaemon(async (c) => {
      const p = new URLSearchParams({ hub: hubId, device, path });
      const r = await c.get<{
        online: boolean;
        dirs: { name: string }[];
        files: {
          path: string;
          size: number;
          hash: string | null;
          icon: string;
          thumb: boolean;
          meta: Record<string, string | number>;
        }[];
      }>(`/v1/browse?${p}`);
      for (const d of r.dirs) console.log(`[folder]        ${d.name}/`);
      for (const f of r.files) {
        const name = f.path.slice(f.path.lastIndexOf('/') + 1);
        const meta = metaLine(f.meta);
        console.log(
          `[${f.icon}]`.padEnd(16) +
            `${name}  ${humanSize(f.size)}${meta ? `  ${meta}` : ''}${f.thumb ? '  ▣' : ''}` +
            (f.hash ? `  ${f.hash.slice(0, 12)}` : '  (hashing…)'),
        );
      }
      console.log(`device ${r.online ? 'online' : 'offline'}`);
    }),
  );

/** The interesting metadata of a file on one line (HANDOFF §9 fields). */
function metaLine(m: Record<string, string | number>): string {
  const parts: string[] = [];
  if (m.width && m.height) parts.push(`${m.width}×${m.height}`);
  if (typeof m.duration === 'number') {
    const s = Math.round(m.duration);
    parts.push(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
  }
  if (m.codec) parts.push(String(m.codec));
  if (m.artist) parts.push([m.artist, m.title].filter(Boolean).join(' – '));
  else if (m.title) parts.push(`“${m.title}”`);
  if (m.album) parts.push(`(${m.album})`);
  if (m.pages) parts.push(`${m.pages} pages`);
  if (typeof m.taken_at === 'number')
    parts.push(new Date(m.taken_at * 1000).toISOString().slice(0, 10));
  return parts.join(' ');
}

program
  .command('peek <hub> <device_id> <hash>')
  .description('show the start (64 KB) of a text or code file on another device')
  .action((hubId: string, device: string, hash: string) =>
    viaDaemon(async (c) => {
      const r = await c.get<{ text: string; truncated: boolean }>(
        `/v1/peek?${new URLSearchParams({ hub: hubId, device, hash })}`,
      );
      process.stdout.write(r.text);
      if (r.truncated) console.log('\n… (first 64 KB only)');
    }),
  );

program
  .command('thumbs <hub> <device_id> <path>')
  .description("fetch a folder's thumbnails into the local cache in one request")
  .option('--size <px>', '320 or 1600', '320')
  .action((hubId: string, device: string, path: string, opts: { size: string }) =>
    viaDaemon(async (c) => {
      const p = new URLSearchParams({ hub: hubId, device, path });
      const r = await c.get<{ files: { hash: string | null; thumb: boolean }[] }>(
        `/v1/browse?${p}`,
      );
      const hashes = r.files.filter((f) => f.thumb && f.hash).map((f) => f.hash!);
      if (hashes.length === 0) return console.log('no thumbnails in that folder');
      const t0 = Date.now();
      const { thumbs } = await c.post<{ thumbs: Record<string, boolean> }>('/v1/thumbs', {
        hub: hubId,
        device,
        hashes,
        size: Number(opts.size),
      });
      const ok = Object.values(thumbs).filter(Boolean).length;
      console.log(`${ok}/${hashes.length} thumbnails cached in ${Date.now() - t0} ms`);
    }),
  );

// ── people, groups, access rules (all per hub) ─────────────────────────────

/** The hub a per-hub command applies to: --hub, or the only hub. Never guesses among several. */
async function pickHub(c: LocalApiClient, hub?: string): Promise<string> {
  const { hubs } = await c.get<{ hubs: { id: string; url: string }[] }>('/v1/hubs');
  if (hub) {
    const h = hubs.find((x) => x.id === hub || x.url === hub);
    if (!h) throw new Error(`no such hub: ${hub}`);
    return h.id;
  }
  if (hubs.length === 1) return hubs[0]!.id;
  if (hubs.length === 0) throw new Error('not on any hub yet');
  throw new Error(
    `you're on ${hubs.length} hubs; choose one with --hub (${hubs.map((h) => h.id).join(', ')})`,
  );
}

/** `me` | `hub` | `users:u_a,u_b` | `groups:g_x` | `users:…+groups:…` */
function parseAudience(s: string): 'me' | 'hub' | { users?: string[]; groups?: string[] } {
  if (s === 'me' || s === 'hub') return s;
  const out: { users?: string[]; groups?: string[] } = {};
  for (const part of s.split('+')) {
    const m = /^(users|groups):(.+)$/.exec(part);
    if (!m)
      throw new Error(
        `bad audience "${s}": use me, hub, users:<ids>, groups:<ids>, or users:…+groups:…`,
      );
    out[m[1] as 'users' | 'groups'] = m[2]!
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return out;
}

function describeAudience(a: 'me' | 'hub' | { users?: string[]; groups?: string[] }): string {
  if (a === 'me') return 'only me';
  if (a === 'hub') return 'everyone on this hub';
  return [
    a.users?.length ? `users ${a.users.join(', ')}` : '',
    a.groups?.length ? `groups ${a.groups.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' + ');
}

const acl = program
  .command('acl')
  .description('who can see your shared files, set separately on each hub');

acl
  .command('set <path> <audience>')
  .description('set access for a file or folder on one hub (folders end with /, e.g. Photos/2024/)')
  .option('--hub <id>', 'the hub this rule applies to (required if you are on several)')
  .addHelpText(
    'after',
    '\nAudience: me | hub | users:<user_id,…> | groups:<group_id,…> | users:…+groups:…',
  )
  .action((path: string, audience: string, opts: { hub?: string }) =>
    viaDaemon(async (c) => {
      const hub = await pickHub(c, opts.hub);
      const a = parseAudience(audience);
      await c.put('/v1/acl', { hub, path, audience: a });
      console.log(`${path} on ${hub}: ${describeAudience(a)}`);
    }),
  );

acl
  .command('clear <path>')
  .description('remove the rule on a path so it inherits from its folder again')
  .option('--hub <id>', 'the hub to clear it on')
  .action((path: string, opts: { hub?: string }) =>
    viaDaemon(async (c) => {
      const hub = await pickHub(c, opts.hub);
      await c.put('/v1/acl', { hub, path, audience: null });
      console.log(`${path} on ${hub}: rule removed`);
    }),
  );

acl
  .command('list')
  .description('list your access rules on every hub (anything without a rule is "only me")')
  .option('--hub <id>', 'only this hub')
  .action((opts: { hub?: string }) =>
    viaDaemon(async (c) => {
      const p = opts.hub ? `?hub=${encodeURIComponent(await pickHub(c, opts.hub))}` : '';
      const { rules } = await c.get<{ rules: Record<string, { path: string; audience: never }[]> }>(
        `/v1/acl${p}`,
      );
      for (const [hub, list] of Object.entries(rules)) {
        console.log(`${hub}:${list.length ? '' : ' (no rules: everything is only you)'}`);
        for (const r of list) console.log(`  ${r.path}  ${describeAudience(r.audience)}`);
      }
    }),
  );

type Person = {
  user_id: string;
  display_name: string;
  fingerprint: string;
  verified: boolean;
  state?: string;
};
const fmtPerson = (p: Person) =>
  `${p.user_id}  ${p.display_name}${p.verified ? '  ✔ verified' : ''}${p.state ? `  [${p.state}]` : ''}`;

const people = program.command('people').description('connections on a hub');
const hubOpt = ['--hub <id>', 'the hub (required if you are on several)'] as const;

people
  .command('search <name>')
  .description('find people on a hub by display name')
  .option(...hubOpt)
  .action((name: string, opts: { hub?: string }) =>
    viaDaemon(async (c) => {
      const hub = await pickHub(c, opts.hub);
      const { users } = await c.get<{ users: Person[] }>(
        `/v1/people/search?${new URLSearchParams({ hub, q: name })}`,
      );
      for (const u of users) console.log(fmtPerson(u));
      if (users.length === 0) console.log('nobody found');
    }),
  );

people
  .command('list')
  .description('your connections and pending requests')
  .option(...hubOpt)
  .action((opts: { hub?: string }) =>
    viaDaemon(async (c) => {
      const hub = await pickHub(c, opts.hub);
      const { connections } = await c.get<{ connections: Person[] }>(
        `/v1/people?hub=${encodeURIComponent(hub)}`,
      );
      for (const p of connections) console.log(fmtPerson(p));
      if (connections.length === 0)
        console.log('no connections yet; try `communal people search <name>`');
    }),
  );

for (const [action, verb] of [
  ['request', 'sent a connection request to'],
  ['accept', 'connected with'],
  ['remove', 'removed'],
] as const) {
  people
    .command(`${action} <user_id>`)
    .description(
      {
        request: 'ask to connect',
        accept: 'accept a connection request',
        remove: 'remove a connection or request',
      }[action],
    )
    .option(...hubOpt)
    .action((user: string, opts: { hub?: string }) =>
      viaDaemon(async (c) => {
        const hub = await pickHub(c, opts.hub);
        await c.post(`/v1/people/${action}`, { hub, user_id: user });
        console.log(`${verb} ${user}`);
      }),
    );
}

people
  .command('verify <user_id>')
  .description(
    'show the safety code to compare with them in person or on a call; --confirm marks them verified',
  )
  .option(...hubOpt)
  .option('--confirm', 'the codes matched')
  .option('--unverify', 'remove the verified mark')
  .action((user: string, opts: { hub?: string; confirm?: boolean; unverify?: boolean }) =>
    viaDaemon(async (c) => {
      const hub = await pickHub(c, opts.hub);
      if (opts.confirm || opts.unverify) {
        await c.post('/v1/people/verify', { hub, user_id: user, verified: !!opts.confirm });
        console.log(opts.confirm ? `${user} verified` : `${user} no longer marked verified`);
        return;
      }
      const r = await c.get<{ person: Person; code: string }>(
        `/v1/people/safety-code?${new URLSearchParams({ hub, user })}`,
      );
      console.log(`Safety code with ${r.person.display_name}:  ${r.code}`);
      console.log('Compare it with them out of band. If it matches, run again with --confirm.');
    }),
  );

const group = program
  .command('group')
  .description('your private groups on a hub (only you see them)');

group
  .command('list')
  .option(...hubOpt)
  .action((opts: { hub?: string }) =>
    viaDaemon(async (c) => {
      const hub = await pickHub(c, opts.hub);
      const { groups } = await c.get<{
        groups: { group_id: string; name: string; members: string[] }[];
      }>(`/v1/groups?hub=${encodeURIComponent(hub)}`);
      for (const g of groups)
        console.log(`${g.group_id}  ${g.name}  (${g.members.length}): ${g.members.join(', ')}`);
      if (groups.length === 0) console.log('no groups');
    }),
  );

group
  .command('set <name> [members...]')
  .description('create a group (or replace an existing one with --id) from your connections')
  .option('--id <group_id>', 'update this group')
  .option(...hubOpt)
  .action((name: string, members: string[], opts: { id?: string; hub?: string }) =>
    viaDaemon(async (c) => {
      const hub = await pickHub(c, opts.hub);
      const { group } = await c.post<{ group: { group_id: string; members: string[] } }>(
        '/v1/groups',
        {
          hub,
          name,
          members,
          ...(opts.id ? { group_id: opts.id } : {}),
        },
      );
      console.log(`${group.group_id}  ${name}  (${group.members.length} member(s))`);
    }),
  );

group
  .command('delete <group_id>')
  .option(...hubOpt)
  .action((id: string, opts: { hub?: string }) =>
    viaDaemon(async (c) => {
      const hub = await pickHub(c, opts.hub);
      await c.delete(`/v1/groups/${encodeURIComponent(id)}?hub=${encodeURIComponent(hub)}`);
      console.log(`deleted ${id}`);
    }),
  );

// ── transfers ───────────────────────────────────────────────────────────────

type Download = {
  id: string;
  name: string;
  state: string;
  size: number | null;
  bytes_done: number;
  error: string | null;
  final_path: string | null;
  diagnosis: Explained | null;
};

program
  .command('get <hash>')
  .description('download a file by its hash (see `communal search`), from every online source')
  .option('--name <file>', 'save as (default: the name the owner uses)')
  .option('--dest <dir>', 'folder to save into')
  .action((hash: string, opts: { name?: string; dest?: string }) =>
    viaDaemon(async (c) => {
      const { download } = await c.post<{ download: Download }>('/v1/downloads', {
        hash,
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.dest ? { dest: resolve(opts.dest) } : {}),
      });
      console.log(`${download.id}  queued ${download.name}  (follow with \`communal transfers\`)`);
    }),
  );

program
  .command('get-folder <device_id> <path>')
  .description('download a folder of another device once, with its subfolders')
  .option('--hub <id>', 'the hub to list it through (needed when on several)')
  .option('--dest <dir>', 'folder to save into (default: the downloads folder)')
  .action((device: string, path: string, opts: { hub?: string; dest?: string }) =>
    viaDaemon(async (c) => {
      const hubId = await pickHub(c, opts.hub);
      const { folder: f } = await c.post<{
        folder: {
          dest: string;
          queued: number;
          copied: number;
          skipped: number;
          unprepared: number;
          bytes: number;
        };
      }>('/v1/downloads/folder', {
        hub: hubId,
        device,
        path,
        ...(opts.dest ? { dest: resolve(opts.dest) } : {}),
      });
      console.log(`→ ${f.dest}`);
      console.log(`  ${f.queued} queued (${f.bytes} bytes; follow with \`communal transfers\`)`);
      if (f.copied) console.log(`  ${f.copied} copied from files already on this computer`);
      if (f.skipped) console.log(`  ${f.skipped} already there`);
      if (f.unprepared)
        console.log(`  ${f.unprepared} left out: still being prepared by the owner`);
    }),
  );

program
  .command('download-dir [dir]')
  .description('show or change where downloads go by default')
  .option('--reset', 'go back to the usual folder')
  .action((dir: string | undefined, opts: { reset?: boolean }) =>
    viaDaemon(async (c) => {
      const r =
        dir || opts.reset
          ? await c.put<{ dir: string }>('/v1/settings/downloads', {
              dir: opts.reset ? null : resolve(dir!),
            })
          : await c.get<{ dir: string }>('/v1/settings/downloads');
      console.log(r.dir);
    }),
  );

program
  .command('transfers')
  .description('downloads: queued, in progress, waiting for a source, done, failed')
  .action(() =>
    viaDaemon(async (c) => {
      const { downloads } = await c.get<{ downloads: Download[] }>('/v1/downloads');
      if (downloads.length === 0) console.log('no downloads');
      for (const d of downloads) {
        const pct = d.size ? ` ${Math.floor((d.bytes_done / d.size) * 100)}%` : '';
        const extra = d.state === 'done' ? `  → ${d.final_path}` : d.error ? `  (${d.error})` : '';
        console.log(`${d.id}  ${d.state.padEnd(9)}${pct.padStart(5)}  ${d.name}${extra}`);
        // Why it couldn't connect, and what would fix it (HANDOFF §8). No relay, ever.
        const g = d.diagnosis;
        if (g && d.state !== 'done') {
          console.log(`    cause: ${g.cause}  (easier fix: ${g.easier_fix})`);
          console.log(`    ${g.message}`);
          for (const tip of g.tips) console.log(`    - ${tip}`);
          if (g.fix) console.log(`    ${g.fix}`);
          if (g.cause !== 'peer_offline')
            console.log(`    you: ${natLine(g.you)}\n    them: ${natLine(g.them)}`);
        }
      }
    }),
  );

program
  .command('netcheck')
  .description('check this network: NAT type per hub, UPnP/NAT-PMP, IPv6, carrier-grade NAT')
  .option('--json', 'raw JSON')
  .action((opts: { json?: boolean }) =>
    viaDaemon(async (c) => {
      const r = await c.post<{
        port: number;
        mapping: { method: string; host: string; port: number } | null;
        router_ip: string | null;
        hubs: Record<
          string,
          { profile: NetProfile; observed: ({ host: string; port: number } | null)[] }
        >;
      }>('/v1/network/check', {});
      if (opts.json) return console.log(JSON.stringify(r, null, 2));
      console.log(`peer port: UDP ${r.port}`);
      console.log(
        r.mapping
          ? `router port mapping: ${r.mapping.method} ${r.mapping.host}:${r.mapping.port}`
          : 'router port mapping: none (no UPnP/NAT-PMP, or it is turned off)',
      );
      if (r.router_ip) console.log(`router's external address: ${r.router_ip}`);
      const ids = Object.keys(r.hubs);
      if (ids.length === 0) console.log('no hub connected');
      for (const id of ids) {
        const h = r.hubs[id]!;
        const seen = h.observed.map((o) => (o ? `${o.host}:${o.port}` : 'no reply')).join(', ');
        console.log(`${id}: ${natLine(h.profile)}${seen ? `  (hub sees ${seen})` : ''}`);
        console.log(`    ${natAdvice(h.profile)}`);
      }
    }),
  );

type NetProfile = { nat: string; upnp: boolean; ipv6: boolean; cgnat: boolean };

function natLine(p: NetProfile): string {
  const flags = [p.upnp && 'upnp', p.ipv6 && 'ipv6', p.cgnat && 'cgnat'].filter(Boolean);
  return `nat=${p.nat}${flags.length ? ` ${flags.join(' ')}` : ''}`;
}

/** One line on what the profile means for direct connections. */
function natAdvice(p: NetProfile): string {
  if (p.nat === 'blocked')
    return 'UDP is blocked here: direct transfers will not work on this network.';
  if (p.upnp || p.nat === 'none') return 'Reachable: others can connect to this device directly.';
  if (p.cgnat)
    return 'Carrier-grade NAT: works only with peers who are reachable (UPnP or a forwarded port).';
  if (p.nat === 'symmetric')
    return 'Symmetric NAT: works only with peers who are reachable. Enable UPnP or forward the peer port.';
  if (p.nat === 'endpoint_independent')
    return 'Ordinary NAT: hole punching works with most peers. UPnP or a forwarded port makes it certain.';
  return 'Could not tell (the hub may not run its UDP probe).';
}

program
  .command('cancel <download_id>')
  .description('cancel a download and delete its partial file')
  .action((id: string) =>
    viaDaemon(async (c) => {
      await c.delete(`/v1/downloads/${encodeURIComponent(id)}`);
      console.log(`cancelled ${id}`);
    }),
  );

program
  .command('log')
  .description('who downloaded what from this device (kept locally, never sent to a hub)')
  .option('--user <user_id>', 'only this person')
  .option('--path <prefix>', 'only files under this share path, e.g. Photos/')
  .option('--limit <n>', 'entries', '50')
  .action((opts: { user?: string; path?: string; limit: string }) =>
    viaDaemon(async (c) => {
      const p = new URLSearchParams({ limit: opts.limit });
      if (opts.user) p.set('user', opts.user);
      if (opts.path) p.set('path', opts.path);
      const { log: rows } = await c.get<{
        log: {
          at: number;
          requester_user: string;
          path: string;
          bytes: number;
          status: string;
          kind: string;
        }[];
      }>(`/v1/uploads/log?${p}`);
      if (rows.length === 0) console.log('nothing uploaded yet');
      for (const r of rows) {
        const when = new Date(r.at * 1000).toISOString().slice(0, 16).replace('T', ' ');
        console.log(
          `${when}  ${r.requester_user}  ${r.status.padEnd(9)}  ${humanSize(r.bytes).padStart(9)}  ${r.path || '(refused)'}`,
        );
      }
    }),
  );

// ── subscriptions (M7) ──────────────────────────────────────────────────────

type Subscription = {
  id: string;
  hub: string;
  device_id: string;
  path: string;
  dest_dir: string;
  mirror_deletes: boolean;
  paused: boolean;
  status: 'ok' | 'no_access';
  files: { pending: number; done: number; failed: number; removed: number };
};

/** HANDOFF §5: whether to mirror deletions is asked at subscribe time, defaulting to no. */
async function askMirrorDeletes(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = await rl.question(
      'When a file is deleted at the source, move your copy to the trash too? [y/N] ',
    );
    return /^y(es)?$/i.test(a.trim());
  } finally {
    rl.close();
  }
}

program
  .command('subscribe <device_id> <path>')
  .description('follow a folder on another device: new files download, changes follow')
  .option('--hub <id>', 'the hub to follow it through (needed when on several)')
  .option('--dest <dir>', 'folder to keep the files in (default: downloads/<folder name>)')
  .option('--mirror-deletes', 'move local copies to the trash when deleted at the source')
  .option('--no-mirror-deletes', 'keep local copies when files are deleted at the source')
  .option('--flat', 'only the files directly in the folder, not its subfolders')
  .action(
    (
      device: string,
      path: string,
      opts: { hub?: string; dest?: string; mirrorDeletes?: boolean; flat?: boolean },
    ) =>
      viaDaemon(async (c) => {
        const hubId = await pickHub(c, opts.hub);
        const mirror = opts.mirrorDeletes ?? (await askMirrorDeletes());
        const { subscription: s } = await c.post<{ subscription: Subscription }>(
          '/v1/subscriptions',
          {
            hub: hubId,
            device,
            path,
            mirror_deletes: mirror,
            recursive: !opts.flat,
            ...(opts.dest ? { dest: resolve(opts.dest) } : {}),
          },
        );
        console.log(`${s.id}  following ${s.path} → ${s.dest_dir}`);
        console.log(
          `  deletions at the source: ${s.mirror_deletes ? 'moved to the trash here too' : 'kept here'}`,
        );
      }),
  );

type SyncState = {
  enabled: boolean;
  path: string | null;
  devices: {
    device_id: string;
    name: string | null;
    status: string;
    files: { pending: number; done: number; failed: number };
  }[];
};

function printSync(s: SyncState) {
  if (!s.enabled) {
    console.log('synced folder: off (`communal sync on [folder]` turns it on)');
    return;
  }
  console.log(`synced folder: ${s.path}`);
  if (s.devices.length === 0) console.log('  no other computer has it turned on yet');
  for (const d of s.devices)
    console.log(
      `  ${d.name ?? d.device_id}  ${d.status}  ${d.files.done} files` +
        (d.files.pending ? `, ${d.files.pending} on the way` : '') +
        (d.files.failed ? `, ${d.files.failed} failed` : ''),
    );
}

const syncCmd = program
  .command('sync')
  .description('a folder kept the same on all your computers (only you can see it)');
syncCmd
  .command('status', { isDefault: true })
  .description('whether it is on, where, and which computers it is in step with')
  .action(() => viaDaemon(async (c) => printSync(await c.get<SyncState>('/v1/sync'))));
syncCmd
  .command('on [folder]')
  .description('turn it on (default folder: ~/Communal); do this on each computer')
  .action((folder: string | undefined) =>
    viaDaemon(async (c) =>
      printSync(await c.put<SyncState>('/v1/sync', folder ? { path: resolve(folder) } : {})),
    ),
  );
syncCmd
  .command('off')
  .description('stop syncing this computer; nothing is deleted anywhere')
  .action(() =>
    viaDaemon(async (c) => {
      await c.delete('/v1/sync');
      console.log('synced folder: off; the files stay where they are');
    }),
  );

const subs = program.command('subscriptions').description('folders you follow');

subs
  .command('list', { isDefault: true })
  .description('list subscriptions and their files')
  .action(() =>
    viaDaemon(async (c) => {
      const { subscriptions } = await c.get<{ subscriptions: Subscription[] }>('/v1/subscriptions');
      if (subscriptions.length === 0) console.log('no subscriptions');
      for (const s of subscriptions) {
        const state = s.paused
          ? 'paused'
          : s.status === 'no_access'
            ? 'not shared with you (or gone)'
            : 'following';
        const f = s.files;
        console.log(`${s.id}  ${state}  ${s.hub}  ${s.device_id}  ${s.path} → ${s.dest_dir}`);
        console.log(
          `    ${f.done} here, ${f.pending} downloading` +
            (f.failed ? `, ${f.failed} no longer available` : '') +
            (f.removed ? `, ${f.removed} kept after deletion at the source` : '') +
            `; deletions: ${s.mirror_deletes ? 'mirrored to the trash' : 'kept'}`,
        );
      }
    }),
  );

subs
  .command('set <id>')
  .description('change a subscription')
  .option('--mirror-deletes <on|off>', 'mirror deletions at the source (to the trash)')
  .option('--pause', 'stop following for now')
  .option('--resume', 'follow again, catching up on what changed')
  .action((id: string, opts: { mirrorDeletes?: string; pause?: boolean; resume?: boolean }) =>
    viaDaemon(async (c) => {
      const patch: { mirror_deletes?: boolean; paused?: boolean } = {};
      if (opts.mirrorDeletes !== undefined) {
        if (!['on', 'off'].includes(opts.mirrorDeletes))
          throw new Error('--mirror-deletes takes on or off');
        patch.mirror_deletes = opts.mirrorDeletes === 'on';
      }
      if (opts.pause && opts.resume) throw new Error('choose --pause or --resume');
      if (opts.pause || opts.resume) patch.paused = !!opts.pause;
      if (Object.keys(patch).length === 0) throw new Error('nothing to change');
      await c.put(`/v1/subscriptions/${encodeURIComponent(id)}`, patch);
      console.log(`updated ${id}`);
    }),
  );

subs
  .command('remove <id>')
  .description('stop following (files already here stay)')
  .action((id: string) =>
    viaDaemon(async (c) => {
      await c.delete(`/v1/subscriptions/${encodeURIComponent(id)}`);
      console.log(`stopped following (${id}); files already here stay`);
    }),
  );

// ── devices, linking and recovery (M8, ADR 0014) ────────────────────────────

/** Reads a line from the terminal; `hidden` doesn't echo it (passphrases, recovery words). */
async function ask(question: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('needs a terminal (or set the environment variable)');
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Echo nothing while the answer is typed.
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    let shown = false;
    out._writeToOutput = (str: string) => {
      if (!shown) process.stdout.write(str);
      shown = true;
    };
  }
  try {
    return (await rl.question(question)).trim();
  } finally {
    if (hidden) process.stdout.write('\n');
    rl.close();
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  return /^y(es)?$/i.test(await ask(`${question} [y/N] `));
}

program
  .command('link <code...>')
  .description('add this device to your account with a link code from another of your devices')
  .requiredOption('--hub <url>', 'the hub the other device made the code on')
  .option('--device-name <name>', 'name for this device', hostname())
  .action(async (parts: string[], opts: { hub: string; deviceName: string }) => {
    const code = parts.join(''); // "K7Q2 9XZD" typed with a space is fine too
    const me = deviceId(ensureDeviceKey().publicKey);
    console.log(`This device is ${me}. Check that your other device shows the same id.`);
    console.log('Waiting for you to approve it on the other device…');
    type Linked = {
      user_id: string;
      fingerprint: string;
      others: { url: string; ok: boolean; status?: string; error?: string }[];
    };
    let r: Linked;
    try {
      if (await daemonRunning()) {
        r = await api().post<Linked>('/v1/account/link', {
          url: opts.hub,
          code,
          device_name: opts.deviceName,
        });
      } else {
        const ctx = offlineContext();
        try {
          r = await linkDevice(ctx, {
            url: opts.hub,
            code,
            device_name: opts.deviceName,
            platform: platform(),
          }).then((x) => ({
            user_id: x.account.user_id,
            fingerprint: x.fingerprint,
            others: x.others,
          }));
        } finally {
          await ctx.hubs.stop();
        }
      }
    } catch (err) {
      console.error(`could not link: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Linked to account ${r.user_id}`);
    console.log(`  fingerprint: ${formatFingerprint(r.fingerprint)}`);
    for (const o of r.others)
      console.log(o.ok ? `  also joined ${o.url}` : `  could not join ${o.url}: ${o.error}`);
  });

program
  .command('restore [recovery_file]')
  .description('restore your account onto this fresh device from a recovery key')
  .option('--words', 'type the 24 recovery words instead of using a file')
  .option('--hub <url...>', 'hub(s) to restore onto (needed with --words)')
  .option('--device-name <name>', 'name for this device', hostname())
  .action(
    async (
      file: string | undefined,
      opts: { words?: boolean; hub?: string[]; deviceName: string },
    ) => {
      if (!file && !opts.words) {
        console.error('give the recovery file, or --words to type the recovery words');
        process.exitCode = 1;
        return;
      }
      try {
        let rec: RecoveryFile | undefined;
        let secret: Uint8Array;
        let passphrase: string | undefined;
        if (file) {
          rec = JSON.parse(readFileSync(resolve(file), 'utf8')) as RecoveryFile;
          passphrase =
            process.env.COMMUNAL_RECOVERY_PASSPHRASE ?? (await ask('Recovery passphrase: ', true));
          console.log('Unlocking (this takes a few seconds)…');
          secret = await importRecoveryFile(rec, passphrase);
        } else {
          secret = wordsToRootSecret(
            process.env.COMMUNAL_RECOVERY_WORDS ?? (await ask('Recovery words: ', true)),
          );
        }
        const hubs = (opts.hub ?? []).map((url) => ({ url }));
        for (const h of rec?.hubs ?? []) if (!hubs.some((x) => x.url === h.url)) hubs.push(h);
        type Restored = {
          user_id: string;
          fingerprint: string;
          hubs: { url: string; ok: boolean; error?: string }[];
        };
        let r: Restored;
        if (await daemonRunning()) {
          r = await api().post<Restored>('/v1/account/restore', {
            ...(rec ? { file: rec, passphrase } : { words: rootSecretToWords(secret).join(' ') }),
            hubs: opts.hub?.map((url) => ({ url })) ?? [],
            device_name: opts.deviceName,
          });
        } else {
          const ctx = offlineContext();
          try {
            const x = await restoreAccount(ctx, {
              rootSecret: secret,
              ...(rec ? { user_id: rec.user_id } : {}),
              hubs,
              device_name: opts.deviceName,
              platform: platform(),
            });
            r = { user_id: x.account.user_id, fingerprint: x.fingerprint, hubs: x.hubs };
          } finally {
            await ctx.hubs.stop();
          }
        }
        console.log(`Restored account ${r.user_id}`);
        console.log(`  fingerprint: ${formatFingerprint(r.fingerprint)}`);
        for (const h of r.hubs)
          console.log(h.ok ? `  on ${h.url}` : `  could not restore on ${h.url}: ${h.error}`);
        console.log('Revoke lost devices with `communal devices revoke <device_id>`.');
      } catch (err) {
        console.error(
          err instanceof RecoveryError
            ? err.message
            : `could not restore: ${(err as Error).message}`,
        );
        process.exitCode = 1;
      }
    },
  );

const recovery = program.command('recovery').description('your account recovery key');

recovery
  .command('export')
  .description('save the recovery key (only on the device that holds the account root key)')
  .option('--out <file>', 'where to write the passphrase-protected recovery file')
  .option('--words', 'show 24 words to write down instead of writing a file')
  .action(async (opts: { out?: string; words?: boolean }) => {
    // Works from the files alone, daemon or not: no network is involved.
    const device = loadDeviceKey();
    const account = device ? new AccountFile(dataDir).loadOrMigrate(device, loadHubs()) : undefined;
    if (!device || !account) {
      console.error('this device has no account yet');
      process.exitCode = 1;
      return;
    }
    const secret =
      account.root_pubkey === toB64(device.publicKey) ? device.secretKey : loadRootSecret();
    if (!secret) {
      console.error(
        "this device doesn't hold the account's root key; export the recovery key from your first device",
      );
      process.exitCode = 1;
      return;
    }
    if (opts.words) {
      console.log('Write these words down and keep them somewhere safe. Anyone who has them');
      console.log('can take over your account.\n');
      const words = rootSecretToWords(secret);
      for (let i = 0; i < words.length; i += 6)
        console.log(
          words
            .slice(i, i + 6)
            .map((w, j) => `${String(i + j + 1).padStart(2)}. ${w.padEnd(9)}`)
            .join(' '),
        );
      return;
    }
    if (!opts.out) {
      console.error('give --out <file>, or --words');
      process.exitCode = 1;
      return;
    }
    const out = resolve(opts.out);
    if (existsSync(out)) {
      console.error(`${out} already exists`);
      process.exitCode = 1;
      return;
    }
    let passphrase = process.env.COMMUNAL_RECOVERY_PASSPHRASE;
    if (passphrase === undefined) {
      passphrase = await ask('Choose a passphrase: ', true);
      if ((await ask('Repeat it: ', true)) !== passphrase) {
        console.error('the passphrases differ');
        process.exitCode = 1;
        return;
      }
    }
    if (passphrase.length < 8) {
      console.error('use a passphrase of at least 8 characters');
      process.exitCode = 1;
      return;
    }
    const hubs = loadHubs()
      .filter((h) => h.state.registered && h.state.hubPubkey)
      .map((h) => ({ url: h.url, hub_pubkey: h.state.hubPubkey! }));
    const rec = await exportRecoveryFile(secret, account.user_id, passphrase, undefined, hubs);
    writeFileSync(out, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`Recovery file written to ${out}`);
    console.log('Keep it and its passphrase safe: together they can take over your account.');
  });

type DeviceView = {
  device_id: string;
  name: string;
  platform: string;
  root: boolean;
  this_device: boolean;
  revoked: boolean;
  hubs: { hub: string; online: boolean }[];
};
type LinkRequestView = {
  request_id: string;
  hub: string;
  device_name: string;
  platform: string;
  device_id: string;
};

const devices = program
  .command('devices')
  .description('your devices: link new ones, revoke lost ones');

devices
  .command('list', { isDefault: true })
  .description("this account's devices")
  .action(() =>
    viaDaemon(async (c) => {
      const { devices: list } = await c.get<{ devices: DeviceView[] }>('/v1/devices');
      for (const d of list) {
        const tags = [
          d.this_device ? 'this device' : '',
          d.root ? 'first device' : '',
          d.revoked ? 'REVOKED' : d.hubs.some((h) => h.online) ? 'online' : 'offline',
        ].filter(Boolean);
        console.log(
          `${d.device_id}  ${d.name.padEnd(16)} ${d.platform.padEnd(7)} ${tags.join(', ')}`,
        );
      }
    }),
  );

devices
  .command('add')
  .description('make a link code for a new device, then approve it when it claims the code')
  .option('--hub <id>', 'the hub to make the code on (default: the first one online)')
  .option(
    '--yes',
    'approve the device that claims the code without asking (the code is the secret)',
  )
  .action((opts: { hub?: string; yes?: boolean }) =>
    viaDaemon(async (c) => {
      const before = new Set(
        (await c.get<{ requests: LinkRequestView[] }>('/v1/link/requests')).requests.map(
          (r) => r.request_id,
        ),
      );
      const code = await c.post<{ hub: string; code: string; expires_in: number }>(
        '/v1/link/codes',
        opts.hub ? { hub: opts.hub } : {},
      );
      const { hubs } = await c.get<{ hubs: { id: string; url: string }[] }>('/v1/hubs');
      const url = hubs.find((h) => h.id === code.hub)?.url ?? code.hub;
      console.log(
        `Link code: ${code.code}  (valid for ${Math.round(code.expires_in / 60)} minutes)`,
      );
      console.log(`On the new device run:  communal link ${code.code} --hub ${url}`);
      console.log('Waiting for it…');
      const until = Date.now() + code.expires_in * 1000;
      let req: LinkRequestView | undefined;
      while (!req && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1000));
        req = (await c.get<{ requests: LinkRequestView[] }>('/v1/link/requests')).requests.find(
          (r) => !before.has(r.request_id) && r.hub === code.hub,
        );
      }
      if (!req) throw new Error('the code expired before a device claimed it');
      console.log(`"${req.device_name}" (${req.platform}) wants to join, as ${req.device_id}.`);
      const yes =
        opts.yes ||
        (await confirm('Approve it? It will see all your files and can act for your account.'));
      if (!yes) {
        await c.post(`/v1/link/requests/${req.request_id}/deny`, {});
        console.log('Denied.');
        return;
      }
      await c.post(`/v1/link/requests/${req.request_id}/approve`, {});
      console.log(`Approved. ${req.device_name} is now one of your devices.`);
    }),
  );

devices
  .command('requests')
  .description('devices waiting for approval')
  .action(() =>
    viaDaemon(async (c) => {
      const { requests } = await c.get<{ requests: LinkRequestView[] }>('/v1/link/requests');
      for (const r of requests)
        console.log(`${r.request_id}  ${r.device_name} (${r.platform})  ${r.device_id}`);
      if (requests.length === 0) console.log('none');
    }),
  );

for (const verb of ['approve', 'deny'] as const) {
  devices
    .command(`${verb} <request_id>`)
    .description(`${verb} a device waiting to be linked`)
    .action((id: string) =>
      viaDaemon(async (c) => {
        await c.post(`/v1/link/requests/${encodeURIComponent(id)}/${verb}`, {});
        console.log(verb === 'approve' ? 'Approved.' : 'Denied.');
      }),
    );
}

devices
  .command('revoke <device_id>')
  .description('revoke a lost or retired device on every hub (cannot be undone)')
  .option('--yes', "don't ask for confirmation")
  .action((id: string, opts: { yes?: boolean }) =>
    viaDaemon(async (c) => {
      if (
        !opts.yes &&
        !(await confirm(`Revoke ${id}? It loses access to your account for good.`))
      ) {
        console.log('Not revoked.');
        return;
      }
      const r = await c.post<{ hubs: { hub: string; ok: boolean; error?: string }[] }>(
        `/v1/devices/${encodeURIComponent(id)}/revoke`,
        {},
      );
      console.log(`Revoked ${id}.`);
      for (const h of r.hubs.filter((x) => !x.ok))
        console.log(`  ${h.hub} will hear about it when it's back (${h.error})`);
    }),
  );

// ── daemon & status ─────────────────────────────────────────────────────────

program
  .command('daemon')
  .description('run the client engine in the foreground, connected to every configured hub')
  .action(async () => {
    if (await daemonRunning()) {
      log.fatal(
        { socket: paths.socket() },
        'another communal daemon is already running for this data dir',
      );
      process.exitCode = 1;
      return;
    }
    const key = ensureDeviceKey();
    loadHubs(); // migrates a legacy hub.json before the core reads hubs.json
    const env = process.env;
    const rescanMinutes = Number(env.COMMUNAL_RESCAN_MINUTES ?? 15);
    // host:port[,host:port…]; hosts must be IP addresses (ADR 0001).
    const advertise = (env.COMMUNAL_ADVERTISE_ADDR ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => {
        const m = /^\[?([^\]]+)\]?:(\d+)$/.exec(a);
        if (!m) throw new Error(`COMMUNAL_ADVERTISE_ADDR: expected host:port, got "${a}"`);
        return { host: m[1]!, port: Number(m[2]) };
      });
    const core = new CommunalCore({
      dataDir,
      device: key,
      hubClient: { client, insecureTls },
      indexer: { rescanMs: rescanMinutes * 60_000 },
      peer: { port: Number(env.COMMUNAL_PEER_PORT ?? 0), advertise },
      // UPnP / NAT-PMP port mapping on the home router, unless turned off (HANDOFF §8).
      network: env.COMMUNAL_UPNP === 'false' ? {} : { mapper: new RouterPortMapper({ log }) },
      uploads: {
        ...(env.COMMUNAL_MAX_UPLOADS ? { maxConcurrent: Number(env.COMMUNAL_MAX_UPLOADS) } : {}),
        ...(env.COMMUNAL_UPLOAD_KBPS
          ? { bytesPerSecond: Number(env.COMMUNAL_UPLOAD_KBPS) * 1024 }
          : {}),
        ...(env.COMMUNAL_LAN_ONLY ? { lanOnly: env.COMMUNAL_LAN_ONLY === 'true' } : {}),
      },
      ...(env.COMMUNAL_DOWNLOADS ? { downloadsDir: env.COMMUNAL_DOWNLOADS } : {}),
      root: { secret: loadRootSecret(), save: saveRootSecret },
      log,
    });
    // Upload log retention (HANDOFF §7), checked daily.
    const retentionDays = Number(env.COMMUNAL_LOG_RETENTION_DAYS ?? 365);
    const prune = () => core.store.pruneUploadLog(retentionDays);
    const pruneTimer = setInterval(prune, 86_400_000);
    pruneTimer.unref();
    const localApi = new LocalApi(core);

    core.hubs.on('ready', ({ hub, welcome }) =>
      log.info(
        { hub, user_id: welcome.user_id, observed_addr: welcome.observed_addr },
        'connected to hub',
      ),
    );
    core.hubs.on('presence', ({ hub, presence }) => log.info({ hub, ...presence }, 'presence'));
    core.hubs.on('pending_approval', ({ hub }) =>
      log.warn({ hub }, 'account is waiting for hub admin approval'),
    );
    // A fatal error on one hub (banned, key changed) leaves the others running.
    core.hubs.on('fatal', ({ hub, error }) =>
      log.error({ hub, reason: error.reason }, error.message),
    );

    await core.start();
    await localApi.listen({ socketPath: paths.socket() });
    log.info({ device_id: core.deviceId }, 'daemon ready');

    // Dev only: COMMUNAL_HUB (comma-separated) + COMMUNAL_DISPLAY_NAME join hubs on first start.
    if (
      devBuild &&
      process.env.COMMUNAL_AUTO_INIT === 'true' &&
      process.env.COMMUNAL_DISPLAY_NAME
    ) {
      for (const url of (process.env.COMMUNAL_HUB ?? '').split(',').map((u) => u.trim())) {
        if (!url || core.hubs.find(url)) continue;
        log.warn({ hub: url }, 'dev build: COMMUNAL_AUTO_INIT is joining this hub');
        core
          .addHub(url, {
            display_name: process.env.COMMUNAL_DISPLAY_NAME,
            device_name: hostname(),
            platform: platform(),
          })
          .catch((err: Error) => log.error({ hub: url, err: err.message }, 'auto-join failed'));
      }
    } else if (core.hubs.list().length === 0) {
      log.warn('no hubs configured yet; run `communal hub add <url> --name <name>`');
    }

    await new Promise<void>((done) => {
      process.once('SIGTERM', done);
      process.once('SIGINT', done);
    });
    await localApi.close();
    await core.stop();
    log.info('daemon stopped');
  });

program
  .command('mcp')
  .description(
    'run the MCP server on stdio, so an AI agent can use Communal (`claude mcp add communal -- communal mcp`)',
  )
  .action(async () => {
    const { runStdio } = await import('@communal/mcp');
    await runStdio();
  });

program
  .command('check')
  .description('check that this install works: native modules, ffmpeg, the trash helper')
  .action(() =>
    viaDaemon(async (c) => {
      const r = await c.get<{
        ok: boolean;
        checks: Record<string, { ok: boolean; detail?: string }>;
      }>('/v1/self-check');
      for (const [name, x] of Object.entries(r.checks))
        console.log(`${x.ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(10)} ${x.detail ?? ''}`);
      if (!r.ok) process.exitCode = 1;
    }),
  );

program
  .command('status')
  .description('show this device, its hubs and indexing progress')
  .action(async () => {
    if (await daemonRunning()) {
      console.log(JSON.stringify(await api().get('/v1/status'), null, 2));
      return;
    }
    const kp = loadDeviceKey();
    const hubs = loadHubs();
    const withFp = hubs.find((h) => h.state.fingerprint);
    console.log(
      JSON.stringify(
        {
          daemon: 'stopped',
          device_id: kp ? deviceId(kp.publicKey) : null,
          user_id: hubs.find((h) => h.state.userId)?.state.userId ?? null,
          fingerprint: withFp ? formatFingerprint(withFp.state.fingerprint!) : null,
          hubs: hubs.map((h) => ({ id: h.id, url: h.url, registered: h.state.registered })),
          data_dir: dataDir,
        },
        null,
        2,
      ),
    );
  });

await program.parseAsync();
