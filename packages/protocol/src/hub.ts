import { z } from 'zod';
import {
  Audience,
  B64,
  Candidate,
  CertChain,
  ConnectCause,
  DeviceCert,
  DeviceId,
  Entry,
  ErrorCode,
  Fingerprint,
  GroupId,
  Hash,
  Kind,
  NetworkProfile,
  Platform,
  PublicKey,
  RevocationProof,
  Sealed,
  SessionId,
  SharePath,
  Signature,
  UnixSeconds,
  UserId,
  UserSummary,
} from './common.js';

/*
 * Client ↔ hub message bodies (HANDOFF §5), keyed by envelope `t`. Some types flow in both
 * directions with different bodies (e.g. `connection.request`), so there is one map per
 * direction. Additions beyond the HANDOFF catalog are listed in docs/adr/0004-protocol-catalog.md.
 */

const Empty = z.object({}).strict();
/** udx stream id: one per side per peer connection (ADR 0010). */
const StreamId = z.number().int().min(1).max(0xffffffff);
const ClientInfo = z.object({ name: z.string().max(32), version: z.string().max(32) });
const DeviceName = z.string().min(1).max(64);
/**
 * Names a client sends: no control characters and no bidirectional overrides, which could make
 * a name read as someone else's (or reverse a file extension). Names the hub sends back stay
 * permissive, so a name stored before this check can still be read (ADR 0022).
 */
const UNSAFE_NAME = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const clean = (s: z.ZodString) =>
  s.refine((v) => !UNSAFE_NAME.test(v), { message: 'name has control or direction characters' });
const SentDeviceName = clean(z.string().min(1).max(64));
const DisplayName = clean(z.string().trim().min(1).max(64));

const NatObservation = z.object({
  nat: NetworkProfile.shape.nat,
  upnp: z.boolean(),
  ipv6: z.boolean(),
  cgnat: z.boolean(),
});

/**
 * When a source's device was last connected, rounded so search doesn't publish anyone's exact
 * activity history (ADR 0015). `now` means online.
 */
export const Seen = z.enum(['now', 'today', 'week', 'month', 'older']);
export type Seen = z.infer<typeof Seen>;

const Source = z.object({
  device_id: DeviceId,
  owner: UserId,
  path: SharePath,
  online: z.boolean(),
  seen: Seen,
});

const SearchHit = z.object({
  hash: Hash,
  name: z.string(),
  size: z.number().int().nonnegative(),
  mime: z.string(),
  kind: Kind,
  meta: Entry.shape.meta,
  thumb: z.boolean(),
  sources: z.array(Source),
});

const Group = z.object({
  group_id: GroupId,
  name: z.string().trim().min(1).max(64),
  members: z.array(UserId).max(1000),
});

/** Who did something in the hub's audit log: an admin's account, the shell, or the hub itself. */
const Actor = z.union([UserId, z.enum(['cli', 'hub'])]);

/** What a hub admin sees about one device (ADR 0020): counts, never file names or paths. */
const AdminDevice = z.object({
  device_id: DeviceId,
  name: DeviceName,
  platform: Platform,
  created_at: UnixSeconds,
  last_seen: UnixSeconds.nullable(),
  revoked_at: UnixSeconds.nullable(),
  online: z.boolean(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  /** The NAT side of its latest network profile, while it's signed in (no addresses). */
  nat: NatObservation.optional(),
});

const AdminUser = z.object({
  user_id: UserId,
  display_name: z.string(),
  fingerprint: Fingerprint,
  status: z.enum(['active', 'pending']),
  admin: z.boolean(),
  created_at: UnixSeconds,
  banned_at: UnixSeconds.nullable(),
  ban_reason: z.string().nullable(),
  devices: z.array(AdminDevice),
});

const JoinMode = z.enum(['open', 'approval']);
const HubName = z.string().trim().min(1).max(64);
/** Abuse limits an admin can change (ADR 0022); 0 means no limit. */
const HubLimits = z.object({
  signups_per_hour: z.number().int().min(0).max(10_000),
  max_files_per_device: z.number().int().min(0).max(100_000_000),
  max_devices_per_account: z.number().int().min(0).max(1_000),
});

const TransferToken = z.object({
  claims: z.object({
    session_id: SessionId,
    from: DeviceId,
    to: DeviceId,
    hash: Hash,
    exp: UnixSeconds,
  }),
  sig: Signature,
});

export const clientBodies = {
  // Session. `auth` proves possession of the device key over (nonce ‖ hub_id).
  auth: z.object({ device_id: DeviceId, sig: Signature, client: ClientInfo }),
  // Account creation / linking / restore happen on an unauthenticated session, so each one
  // carries its own proof-of-possession signature over the challenge.
  'account.create': z.object({
    display_name: DisplayName,
    device_name: SentDeviceName,
    device_pubkey: PublicKey,
    platform: Platform,
    client: ClientInfo,
    sig: Signature,
    /**
     * Joining another hub from a device that isn't the account root: the root key plus this
     * device's cert chain, so the account keeps the same user_id on every hub (ADR 0007).
     * Omitted when the device itself is the root (a brand-new account).
     */
    root_pubkey: PublicKey.optional(),
    chain: CertChain.optional(),
  }),
  'link.code.create': Empty,
  'link.claim': z.object({
    code: z.string().regex(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/),
    device_name: SentDeviceName,
    device_pubkey: PublicKey,
    platform: Platform,
    sig: Signature,
  }),
  /** `sealed`: the account's hub list for the new device, which the hub can't read (ADR 0014). */
  'link.approve': z.object({
    request_id: z.string().max(64),
    cert: DeviceCert,
    sealed: Sealed.optional(),
  }),
  'link.deny': z.object({ request_id: z.string().max(64) }),
  'account.restore': z.object({
    root_pubkey: PublicKey,
    device_pubkey: PublicKey,
    device_name: SentDeviceName,
    platform: Platform,
    issued_at: UnixSeconds,
    /** A device-cert signature by the root key over the new device. */
    root_sig: Signature,
    sig: Signature,
  }),
  /** Any device of the account may submit any valid proof, so proofs can be gossiped. */
  'device.revoke': RevocationProof,
  'device.list': Empty,
  /**
   * A message for another device of the same account, sealed to its key so the hub can't read
   * it: remote control from a phone (ADR 0023). Never file data. The hub forwards it only
   * within one account, to a device that is online now, and keeps nothing.
   */
  'device.message': z.object({ to: DeviceId, sealed: Sealed }),
  'network.profile': NetworkProfile,

  'user.search': z.object({
    q: z.string().trim().min(1).max(64),
    limit: z.number().int().min(1).max(50),
  }),
  'connection.request': z.object({ user_id: UserId }),
  'connection.accept': z.object({ user_id: UserId }),
  'connection.remove': z.object({ user_id: UserId }),
  'connection.list': Empty,
  'group.upsert': Group.extend({
    group_id: GroupId.optional(),
    name: clean(z.string().trim().min(1).max(64)),
  }),
  'group.delete': z.object({ group_id: GroupId }),
  'group.list': Empty,
  'acl.set': z.object({ device_id: DeviceId, path: SharePath, audience: Audience.nullable() }),
  /** Replaces every rule for the device on this hub (sent on sign-in; ADR 0009). */
  'acl.replace': z.object({
    device_id: DeviceId,
    rules: z.array(z.object({ path: SharePath, audience: Audience })).max(10_000),
  }),

  'index.snapshot': z.object({
    rev: z.number().int().nonnegative(),
    page: z.number().int().nonnegative(),
    last: z.boolean(),
    entries: z.array(Entry).max(5000),
  }),
  'index.delta': z.object({
    base_rev: z.number().int().nonnegative(),
    rev: z.number().int().positive(),
    upsert: z.array(Entry).max(5000),
    remove: z.array(SharePath).max(5000),
  }),

  search: z.object({
    q: z.string().max(256),
    kind: Kind.optional(),
    min_size: z.number().int().nonnegative().optional(),
    /** Only hits with a source seen at least this recently (ADR 0015). Omitted: any. */
    available: Seen.exclude(['older']).optional(),
    limit: z.number().int().min(1).max(500),
    cursor: z.string().max(256).optional(),
  }),
  browse: z.object({ device_id: DeviceId, path: z.union([z.literal(''), SharePath]) }),
  /**
   * The device this session is browsing, so the hub can say when it changes (`browse.changed`).
   * One per session, memory only; null stops it.
   */
  'browse.follow': z.object({ device_id: DeviceId.nullable() }),
  /** Devices the viewer can browse (the desktop Library, M9). */
  library: Empty,
  sources: z.object({ hash: Hash }),
  watch: z.object({
    device_id: DeviceId,
    path: SharePath,
    recursive: z.boolean(),
    mirror_deletes: z.boolean(),
    since_rev: z.number().int().nonnegative(),
  }),
  unwatch: z.object({ device_id: DeviceId, path: SharePath }),

  /** Downloader asks the hub to broker a connection (ADR 0010: + its stream id and candidates). */
  'connect.request': z.object({
    target: DeviceId,
    hash: Hash,
    session_id: SessionId,
    stream_id: StreamId,
    candidates: z.array(Candidate).max(16),
  }),
  'connect.answer': z.object({
    session_id: SessionId,
    stream_id: StreamId,
    candidates: z.array(Candidate).max(16),
  }),
  'connect.failed': z.object({
    session_id: SessionId,
    observations: NatObservation.extend({
      attempts: z.number().int().nonnegative(),
      udp_sent: z.boolean(),
      udp_received: z.boolean(),
    }),
  }),

  /*
   * Hub administration (ADR 0020). Only admins may send these; anyone else gets the same
   * `bad_request` "unknown type" an older hub would give.
   */
  'admin.users': Empty,
  'admin.approve': z.object({ user_id: UserId }),
  /** Admins can't be banned from a client, only from the hub's shell. */
  'admin.ban': z.object({ user_id: UserId, reason: z.string().trim().max(200).optional() }),
  'admin.unban': z.object({ user_id: UserId }),
  'admin.settings.get': Empty,
  /** Only the fields given change; `name: null` clears the name. */
  'admin.settings.set': z.object({
    join_mode: JoinMode.optional(),
    name: clean(HubName).nullable().optional(),
    ...HubLimits.partial().shape,
  }),
  'admin.graph': Empty,
  /** Newest first; `before` is the id of the oldest entry already shown. */
  'admin.log': z.object({
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(500),
  }),

  ping: Empty,
  pong: Empty,
  error: z.object({ code: ErrorCode, message: z.string().max(1024) }),
} as const;

export const hubBodies = {
  challenge: z.object({
    nonce: B64.length(43),
    hub_id: z.string().max(64),
    hub_pubkey: PublicKey,
    /** What the hub's admin calls it, for people to read (older hubs leave it out). */
    name: z.string().trim().min(1).max(64).optional(),
  }),
  welcome: z.object({
    session: z.string().max(64),
    user_id: UserId,
    device_id: DeviceId,
    observed_addr: z.string().max(64),
    index_rev: z.number().int().nonnegative(),
    nat_probe_ports: z.tuple([z.number().int(), z.number().int()]),
    /** This account administers the hub (ADR 0020). Older hubs leave it out. */
    admin: z.boolean().optional(),
  }),
  'account.created': z.object({
    user_id: UserId,
    device_id: DeviceId,
    fingerprint: Fingerprint,
    status: z.enum(['active', 'pending_approval']),
  }),
  'link.code': z.object({ code: z.string(), expires_in: z.number().int().positive() }),
  'link.request': z.object({
    request_id: z.string().max(64),
    device_name: DeviceName,
    platform: Platform,
    device_pubkey: PublicKey,
  }),
  'link.done': z.object({
    user_id: UserId,
    device_id: DeviceId,
    chain: CertChain,
    sealed: Sealed.optional(),
  }),
  'link.denied': Empty,
  'device.listing': z.object({
    devices: z.array(
      z.object({
        device_id: DeviceId,
        name: DeviceName,
        platform: Platform,
        online: z.boolean(),
        last_seen: UnixSeconds.nullable(),
        revoked_at: UnixSeconds.nullable(),
        /** The account's first device: it holds the root key and can't be revoked. */
        root: z.boolean(),
        /**
         * Its key and cert chain, so another device can seal a `device.message` to it after
         * checking the chain itself (ADR 0023). Older hubs leave them out.
         */
        pubkey: PublicKey.optional(),
        chain: CertChain.optional(),
      }),
    ),
  }),
  'device.revoked': RevocationProof,
  /** A `device.message` from another device of this account, as sealed by the sender. */
  'device.message': z.object({ from: DeviceId, sealed: Sealed }),

  'user.results': z.object({ users: z.array(UserSummary) }),
  'connection.request': z.object({ user: UserSummary }),
  'connection.accept': z.object({ user: UserSummary }),
  'connection.remove': z.object({ user_id: UserId }),
  'connection.listing': z.object({
    connections: z.array(
      z.object({
        user: UserSummary,
        state: z.enum(['accepted', 'pending_in', 'pending_out']),
        since: UnixSeconds,
        /** Accepted connections only: whether any of their computers is online, else when last. */
        online: z.boolean().optional(),
        seen: Seen.optional(),
      }),
    ),
  }),
  'group.listing': z.object({ groups: z.array(Group) }),

  'index.ack': z.object({ rev: z.number().int().nonnegative() }),
  'index.resync': z.object({ reason: z.enum(['rev_mismatch', 'hub_reset']) }),

  'search.results': z.object({ hits: z.array(SearchHit), cursor: z.string().max(256).optional() }),
  'browse.listing': z.object({
    online: z.boolean(),
    dirs: z.array(z.object({ name: z.string() })),
    files: z.array(Entry),
  }),
  'library.listing': z.object({
    devices: z
      .array(
        z.object({
          device_id: DeviceId,
          device_name: DeviceName,
          user: UserSummary,
          online: z.boolean(),
          seen: Seen,
        }),
      )
      .max(5000),
  }),
  /** The devices the last `library` answer listed changed: ask again. Carries no data. */
  'library.changed': Empty,
  /** The followed device's listing changed for this viewer: browse it again. Carries no data. */
  'browse.changed': z.object({ device_id: DeviceId }),
  'sources.list': z.object({
    hash: Hash,
    sources: z.array(Source),
  }),
  'watch.event': z.object({
    device_id: DeviceId,
    path: SharePath,
    rev: z.number().int().nonnegative(),
    added: z.array(Entry),
    removed: z.array(SharePath),
  }),
  presence: z.object({
    device_id: DeviceId,
    user_id: UserId,
    online: z.boolean(),
  }),

  'connect.offer': z.object({
    session_id: SessionId,
    from: DeviceId,
    from_user: UserId,
    from_root_pubkey: PublicKey,
    from_chain: CertChain,
    /** The downloader's account's revocations, checked and kept by the owner (ADR 0014). */
    from_revocations: z.array(RevocationProof).max(256),
    token: TransferToken,
    stream_id: StreamId,
    candidates: z.array(Candidate).max(16),
  }),
  /** Forwarded to the downloader with the uploader's identity, so it can check the peer too. */
  'connect.answer': z.object({
    session_id: SessionId,
    stream_id: StreamId,
    candidates: z.array(Candidate).max(16),
    to_user: UserId,
    to_root_pubkey: PublicKey,
    to_chain: CertChain,
    to_revocations: z.array(RevocationProof).max(256),
    /** The same hub-signed token the uploader got; the downloader presents it in `hello`. */
    token: TransferToken,
  }),
  'connect.failed': z.object({
    session_id: SessionId,
    cause: ConnectCause,
    easier_fix: z.enum(['you', 'them', 'either', 'none']),
    you: NatObservation,
    them: NatObservation,
  }),

  'admin.user.listing': z.object({ users: z.array(AdminUser).max(10_000) }),
  /** The limits are optional so a client can read the settings of a hub older than ADR 0022. */
  'admin.settings': z
    .object({ join_mode: JoinMode, name: HubName.nullable() })
    .extend(HubLimits.partial().shape),
  /** Accounts and connections only: never groups, rules or files (ADR 0020). */
  'admin.graph.listing': z.object({
    connections: z
      .array(
        z.object({
          a: UserId,
          b: UserId,
          state: z.enum(['accepted', 'pending']),
          requested_by: UserId,
          since: UnixSeconds,
        }),
      )
      .max(100_000),
  }),
  'admin.log.listing': z.object({
    entries: z.array(
      z.object({
        id: z.number().int().positive(),
        at: UnixSeconds,
        actor: Actor,
        action: z.string().max(64),
        target: z.string().max(256).nullable(),
        details: z.string().max(1024).nullable(),
      }),
    ),
    more: z.boolean(),
  }),
  /** Something an admin screen shows changed (a new account, an admin action): ask again. */
  'admin.changed': Empty,

  ok: Empty,
  ping: Empty,
  pong: Empty,
  error: z.object({ code: ErrorCode, message: z.string().max(1024) }),
} as const;

export type ClientType = keyof typeof clientBodies;
export type HubType = keyof typeof hubBodies;
export type ClientBody<T extends ClientType> = z.infer<(typeof clientBodies)[T]>;
export type HubBody<T extends HubType> = z.infer<(typeof hubBodies)[T]>;
