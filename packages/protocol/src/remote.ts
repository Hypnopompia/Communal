import { z } from 'zod';
import { B64, CertChain, DeviceId, Hash, PublicKey, SharePath, UnixSeconds } from './common.js';

/*
 * Remote control between devices of one account (ADR 0023): a phone asks one of your computers
 * to download something. Each message travels in a hub `device.message`, sealed to the
 * receiving device's key so the hub can't read it, and signed inside the seal by the sender,
 * whose cert chain the receiver checks against its own account root.
 *
 *   sealed plaintext = sig (64 bytes) ‖ body      sig: Ed25519 over the body, domain
 *                                                  `communal/remote/v1`
 *   body             = UTF-8 JSON RemoteBody, at most REMOTE_MAX_BODY bytes
 */

/** What fits in a hub `Sealed` (16 KiB of base64) after the seal's and signature's overhead. */
export const REMOTE_MAX_BODY = 12_000;

/** How far a message's clock may be from ours, and how long a nonce is remembered. */
export const REMOTE_SKEW_S = 120;

/** Hubs are named by URL: each device numbers its own hubs. */
const HubUrl = z.string().min(1).max(512);

export const RemoteRequest = z.discriminatedUnion('op', [
  /** Is remote control on, and what is this device called? */
  z.object({ op: z.literal('hello') }),
  z.object({ op: z.literal('download'), hash: Hash, name: z.string().min(1).max(255).optional() }),
  z.object({
    op: z.literal('download_folder'),
    hub: HubUrl,
    device_id: DeviceId,
    path: SharePath,
  }),
  z.object({
    op: z.literal('subscribe'),
    hub: HubUrl,
    device_id: DeviceId,
    path: SharePath,
    mirror_deletes: z.boolean(),
  }),
  z.object({ op: z.literal('transfers') }),
  z.object({ op: z.literal('cancel'), id: z.string().min(1).max(64) }),
]);
export type RemoteRequest = z.infer<typeof RemoteRequest>;

export const RemoteErrorCode = z.enum([
  /** Remote control is off on that device (Settings › Remote control). */
  'not_allowed',
  'bad_request',
  'not_found',
  'unavailable',
  'failed',
]);
export type RemoteErrorCode = z.infer<typeof RemoteErrorCode>;

export const RemoteReply = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), code: RemoteErrorCode, message: z.string().max(1024) }),
]);
export type RemoteReply = z.infer<typeof RemoteReply>;

export const RemoteBody = z.object({
  v: z.literal(1),
  from: DeviceId,
  /** The sender's key and chain to the account root: the receiver checks both. */
  from_pubkey: PublicKey,
  chain: CertChain,
  to: DeviceId,
  nonce: B64.length(22),
  ts: UnixSeconds,
  /** Set on replies: the request's nonce. */
  re: B64.length(22).optional(),
  request: RemoteRequest.optional(),
  reply: RemoteReply.optional(),
});
export type RemoteBody = z.infer<typeof RemoteBody>;

/** What `transfers` answers with: enough for a phone to show progress, no local paths. */
export const RemoteTransfer = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().nullable(),
  bytes_done: z.number(),
  state: z.string(),
  error: z.string().nullable(),
  requested_by: z.string().nullable(),
  updated_at: UnixSeconds,
});
export type RemoteTransfer = z.infer<typeof RemoteTransfer>;
