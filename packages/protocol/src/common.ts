import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const UserId = z.string().regex(/^u_[a-z2-7]{26}$/);
export const DeviceId = z.string().regex(/^d_[a-z2-7]{26}$/);
export const Fingerprint = z.string().regex(/^[a-z2-7]{52}$/);
/** base64url, no padding. Ed25519 public keys are 32 bytes → 43 chars. */
export const B64 = z.string().regex(/^[A-Za-z0-9_-]*$/);
export const PublicKey = B64.length(43);
/** Ed25519 signature, 64 bytes → 86 chars. */
export const Signature = B64.length(86);
/** File content hash: lowercase hex BLAKE3 root (see ADR 0002). */
export const Hash = z.string().regex(/^[0-9a-f]{64}$/);
export const GroupId = z.string().regex(/^g_[0-9A-HJKMNP-TV-Z]{26}$/);
export const SessionId = z.string().regex(/^x_[0-9A-HJKMNP-TV-Z]{26}$/);
export const UnixSeconds = z.number().int().nonnegative();
export const Platform = z.enum(['darwin', 'win32', 'linux']);

/**
 * Hub-visible path: `ShareName/relative/path`. Never absolute, never `..`, `/` separators,
 * no empty segments. A trailing `/` denotes a folder (used by ACL rules and browse).
 */
export const SharePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) => {
      if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
      const segs = (p.endsWith('/') ? p.slice(0, -1) : p).split('/');
      return segs.every((s) => s !== '' && s !== '.' && s !== '..');
    },
    { message: 'invalid share path' },
  );

export const DeviceCert = z.object({
  user_id: UserId,
  device_pubkey: PublicKey,
  issued_at: UnixSeconds,
  signer_pubkey: PublicKey,
  sig: Signature,
});

export const CertChain = z.array(DeviceCert).max(16);

export const Revocation = z.object({
  user_id: UserId,
  device_id: DeviceId,
  revoked_at: UnixSeconds,
  signer_pubkey: PublicKey,
  sig: Signature,
});

export const UserSummary = z.object({
  user_id: UserId,
  display_name: z.string().min(1).max(64),
  fingerprint: Fingerprint,
  root_pubkey: PublicKey,
});

export const Kind = z.enum([
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

export const EntryMeta = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    duration: z.number().nonnegative(),
    taken_at: UnixSeconds,
    codec: z.string().max(64),
    artist: z.string().max(512),
    album: z.string().max(512),
    title: z.string().max(512),
    pages: z.number().int().positive(),
  })
  .partial();

export const Entry = z.object({
  path: SharePath,
  size: z.number().int().nonnegative(),
  mtime: UnixSeconds,
  mime: z.string().max(255),
  kind: Kind,
  meta: EntryMeta,
  thumb: z.boolean(),
  hash: Hash.nullable(),
});

/** `"me" | "hub" | { users?, groups? }` (HANDOFF §6). */
export const Audience = z.union([
  z.literal('me'),
  z.literal('hub'),
  z.object({ users: z.array(UserId).optional(), groups: z.array(GroupId).optional() }).strict(),
]);

/**
 * What the NAT probe found (HANDOFF §8, ADR 0011): `none` = the hub saw one of our own
 * addresses (no NAT); `endpoint_independent` = same mapped port towards both probe ports;
 * `symmetric` = a different port per destination; `blocked` = no probe reply at all (UDP
 * blocked); `unknown` = couldn't tell (one reply only, or the hub runs no probe).
 */
export const NatType = z.enum(['none', 'endpoint_independent', 'symmetric', 'blocked', 'unknown']);

export const NetworkProfile = z.object({
  nat: NatType,
  upnp: z.boolean(),
  ipv6: z.boolean(),
  cgnat: z.boolean(),
  lan_addrs: z.array(z.string().max(64)).max(32),
});

export const Candidate = z.object({
  kind: z.enum(['lan', 'public', 'mapped', 'ipv6', 'advertised']),
  host: z.string().max(64),
  port: z.number().int().min(1).max(65535),
});

export const ConnectCause = z.enum([
  'peer_offline',
  'both_restrictive_nat',
  'cgnat',
  'udp_blocked',
  'os_firewall',
]);

export const ErrorCode = z.enum([
  'bad_request',
  'upgrade_required',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'pending_approval',
  'banned',
  'expired',
  'not_implemented',
  'internal',
]);
