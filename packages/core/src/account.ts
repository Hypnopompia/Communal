import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pino, type Logger } from 'pino';
import {
  deviceId,
  fingerprint,
  fromB64,
  issueDeviceCert,
  keyPairFromSecret,
  openSealed,
  sealTo,
  toB64,
  userId,
  utf8,
  verifyRevocation,
  type CertChain,
  type KeyPair,
  type RevocationProof,
} from '@communal/crypto';
import { CoreError } from './errors.js';
import { HubFatalError, type Enrolled, type Enrollment } from './hub-client.js';
import type { HubEntry, HubManager } from './hub-manager.js';
import type { IndexStore } from './index/store.js';

/**
 * The account this device belongs to (ADR 0014), the same on every hub (ADR 0007): the root
 * key, the user id derived from it, and this device's cert chain (empty on the root device).
 */
export interface AccountIdentity {
  user_id: string;
  root_pubkey: string;
  chain: CertChain;
}

/** `<data>/account.json`, written atomically with mode 0600. */
export class AccountFile {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'account.json');
  }

  load(): AccountIdentity | undefined {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as AccountIdentity;
    } catch {
      return undefined;
    }
  }

  save(a: AccountIdentity) {
    mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 });
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(a, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /**
   * The saved account. Installs from before M8 have no file, and every device was its own
   * root then, so a device registered on some hub is migrated as a root device.
   */
  loadOrMigrate(device: KeyPair, hubs: HubEntry[]): AccountIdentity | undefined {
    const a = this.load();
    if (a) return a;
    if (!hubs.some((h) => h.state.registered)) return undefined;
    const self = selfRoot(device);
    this.save(self);
    return self;
  }
}

/** The device is the root of its own account (the first device of a new account). */
export function selfRoot(device: KeyPair): AccountIdentity {
  return { user_id: userId(device.publicKey), root_pubkey: toB64(device.publicKey), chain: [] };
}

/** `account.create` fields that put this device in its existing account on another hub. */
export function accountFields(a: AccountIdentity | undefined) {
  return a && a.chain.length > 0 ? { root_pubkey: a.root_pubkey, chain: a.chain } : {};
}

/**
 * Revocations we've verified, for our own account and for peers' (ADR 0014). A proof counts
 * when it's signed by a device whose chain leads to the account root and wasn't already revoked,
 * and never for the root device itself.
 */
export class Revocations {
  constructor(private readonly store: IndexStore) {}

  proofs(user: string): RevocationProof[] {
    return this.store.revocations(user);
  }

  /** Revoked device ids of the account rooted at `root`, after taking in valid `incoming`. */
  revokedFor(root: string, incoming: RevocationProof[] = []): Set<string> {
    const user = userId(fromB64(root));
    const set = new Set(this.store.revocations(user).map((p) => p.revocation.device_id));
    for (const p of incoming) this.accept(root, p, set);
    return set;
  }

  /** Verifies and keeps a proof. True when it revoked a device we didn't know was revoked. */
  accept(root: string, p: RevocationProof, known?: Set<string>): boolean {
    let rootKey: Uint8Array;
    try {
      rootKey = fromB64(root);
    } catch {
      return false;
    }
    const rev = p.revocation;
    if (userId(rootKey) !== rev.user_id || rev.device_id === deviceId(rootKey)) return false;
    const set = known ?? this.revokedFor(root);
    if (set.has(rev.device_id)) return false;
    if (!verifyRevocation(rev, rootKey, p.chain, set)) return false;
    this.store.addRevocation(p);
    set.add(rev.device_id);
    return true;
  }
}

/** Link codes as people type them: any case, spaces or no dash. */
export function normalizeLinkCode(input: string): string {
  const c = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (c.length !== 8) throw new CoreError('bad_request', 'a link code looks like K7Q2-9XZD');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** What an approving device seals to the new one: the hubs to join, with pinned keys. */
interface LinkBundle {
  v: 1;
  hubs: { url: string; hub_pubkey: string }[];
}

export function sealBundle(hubs: HubManager, to: Uint8Array): string {
  const bundle: LinkBundle = {
    v: 1,
    hubs: hubs
      .list()
      .filter((h) => h.state.registered && h.state.hubPubkey)
      .map((h) => ({ url: h.url, hub_pubkey: h.state.hubPubkey! })),
  };
  return sealTo(to, utf8(JSON.stringify(bundle)));
}

function openBundle(device: KeyPair, sealed: string): LinkBundle['hubs'] {
  const b = JSON.parse(new TextDecoder().decode(openSealed(device, sealed))) as LinkBundle;
  if (b.v !== 1 || !Array.isArray(b.hubs)) return [];
  return b.hubs.filter(
    (h) =>
      typeof h.url === 'string' && /^wss?:\/\//.test(h.url) && typeof h.hub_pubkey === 'string',
  );
}

export interface JoinResult {
  hub: HubEntry;
  status: 'ready' | 'pending_approval';
  enrolled?: Enrolled;
}

/**
 * Adds a hub, registers this device on it with `enroll`, and waits until signed in (or pending
 * approval). The hub is forgotten again if registration fails. Works whether or not the
 * manager is running, so the CLI can set a device up before its daemon starts.
 */
export async function joinHub(
  hubs: HubManager,
  url: string,
  enroll: Enrollment,
  opts: { hubPubkey?: string; timeoutMs?: number } = {},
): Promise<JoinResult> {
  const entry = await hubs.add(url, enroll, opts.hubPubkey).catch((e: Error) => {
    throw new CoreError('conflict', e.message);
  });
  const client = hubs.get(entry.id)!;
  let enrolled: Enrolled | undefined;
  const outcome = await new Promise<'ready' | 'pending_approval' | Error>((resolve) => {
    const onEnrolled = (e: Enrolled) => (enrolled = e);
    const onReady = () => done('ready');
    const onPending = () => done('pending_approval');
    const onFatal = (e: Error) => done(e);
    const timer = setTimeout(
      () => done(new Error('timed out connecting to the hub')),
      opts.timeoutMs ?? 30_000,
    );
    const done = (v: 'ready' | 'pending_approval' | Error) => {
      clearTimeout(timer);
      client.off('enrolled', onEnrolled);
      client.off('ready', onReady);
      client.off('pending_approval', onPending);
      client.off('fatal', onFatal);
      resolve(v);
    };
    client.on('enrolled', onEnrolled);
    client.on('ready', onReady);
    client.on('pending_approval', onPending);
    client.on('fatal', onFatal);
    client.start(); // no-op when the manager already started it
  });
  if (outcome instanceof Error) {
    if (!entry.state.registered) await hubs.remove(entry.id);
    const denied = outcome instanceof HubFatalError && outcome.reason === 'link_denied';
    throw new CoreError(denied ? 'forbidden' : 'unavailable', outcome.message);
  }
  return { hub: entry, status: outcome, ...(enrolled ? { enrolled } : {}) };
}

export interface AccountContext {
  hubs: HubManager;
  device: KeyPair;
  account: AccountFile;
  /** Keeps a recovered root secret (restore), e.g. in `root.key` with mode 0600. */
  saveRootSecret?: (secret: Uint8Array) => void | Promise<void>;
  log?: Logger;
}

type Platform = 'darwin' | 'win32' | 'linux' | 'android';

export interface OtherHub {
  url: string;
  ok: boolean;
  status?: 'ready' | 'pending_approval';
  error?: string;
}

/**
 * Adds this fresh device to an existing account with a link code (HANDOFF §2): claims the
 * code, waits for the other device's approval, then joins every hub the approving device sent
 * in its sealed bundle.
 */
export async function linkDevice(
  ctx: AccountContext,
  o: { url: string; code: string; device_name: string; platform: Platform; timeoutMs?: number },
): Promise<{ account: AccountIdentity; fingerprint: string; hub: JoinResult; others: OtherHub[] }> {
  if (ctx.account.load())
    throw new CoreError('conflict', 'this device already belongs to an account');
  const log = ctx.log ?? pino({ name: 'account' });
  const first = await joinHub(
    ctx.hubs,
    o.url,
    {
      kind: 'link',
      code: normalizeLinkCode(o.code),
      device_name: o.device_name,
      platform: o.platform,
    },
    // The code is valid for 10 minutes, and the approval can take that long.
    { timeoutMs: o.timeoutMs ?? 11 * 60_000 },
  );
  const chain = first.enrolled?.chain;
  if (!chain?.length) throw new CoreError('unavailable', 'the hub did not complete the link');
  const account = { user_id: first.enrolled!.user_id, root_pubkey: chain[0]!.signer_pubkey, chain };
  ctx.account.save(account);

  let bundle: LinkBundle['hubs'] = [];
  if (first.enrolled?.sealed) {
    try {
      bundle = openBundle(ctx.device, first.enrolled.sealed);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'could not open the hub list from the link');
    }
  }
  const others: OtherHub[] = [];
  for (const h of bundle) {
    if (ctx.hubs.find(h.url)) continue;
    try {
      const r = await joinHub(
        ctx.hubs,
        h.url,
        {
          kind: 'create',
          display_name: o.device_name,
          device_name: o.device_name,
          platform: o.platform,
          ...accountFields(account),
        },
        { hubPubkey: h.hub_pubkey },
      );
      others.push({ url: h.url, ok: true, status: r.status });
    } catch (err) {
      others.push({ url: h.url, ok: false, error: (err as Error).message });
    }
  }
  return { account, fingerprint: fingerprint(fromB64(account.root_pubkey)), hub: first, others };
}

/**
 * Restores the account onto this fresh device from the root secret (HANDOFF §4): the root key
 * certifies this device, and each hub registers it under the existing account. The root secret
 * is kept so this device can export a recovery key again.
 */
export async function restoreAccount(
  ctx: AccountContext,
  o: {
    rootSecret: Uint8Array;
    /** From the recovery file, if it names one; must match the key. */
    user_id?: string;
    hubs: { url: string; hub_pubkey?: string }[];
    device_name: string;
    platform: Platform;
  },
): Promise<{ account: AccountIdentity; fingerprint: string; hubs: OtherHub[] }> {
  if (ctx.account.load())
    throw new CoreError('conflict', 'this device already belongs to an account');
  const root = keyPairFromSecret(o.rootSecret);
  const uid = userId(root.publicKey);
  if (o.user_id && o.user_id !== uid)
    throw new CoreError('bad_request', 'the recovery key does not match its account id');
  if (o.hubs.length === 0)
    throw new CoreError('bad_request', 'no hub to restore onto; give at least one hub address');
  const cert = issueDeviceCert(root, uid, ctx.device.publicKey);
  const enroll: Enrollment = {
    kind: 'restore',
    root_pubkey: toB64(root.publicKey),
    cert,
    device_name: o.device_name,
    platform: o.platform,
  };
  const results: OtherHub[] = [];
  for (const h of o.hubs) {
    if (ctx.hubs.find(h.url)) {
      results.push({ url: h.url, ok: false, error: 'already configured' });
      continue;
    }
    try {
      const r = await joinHub(ctx.hubs, h.url, enroll, {
        ...(h.hub_pubkey ? { hubPubkey: h.hub_pubkey } : {}),
      });
      results.push({ url: h.url, ok: true, status: r.status });
    } catch (err) {
      results.push({ url: h.url, ok: false, error: (err as Error).message });
    }
  }
  if (!results.some((r) => r.ok)) {
    throw new CoreError(
      'unavailable',
      `could not restore on any hub: ${results.map((r) => `${r.url}: ${r.error}`).join('; ')}`,
    );
  }
  const account = { user_id: uid, root_pubkey: toB64(root.publicKey), chain: [cert] };
  ctx.account.save(account);
  await ctx.saveRootSecret?.(o.rootSecret);
  return { account, fingerprint: fingerprint(root.publicKey), hubs: results };
}
