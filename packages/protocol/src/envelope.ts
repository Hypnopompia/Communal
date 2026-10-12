import { ulid } from 'ulid';
import { z } from 'zod';
import { PROTOCOL_VERSION } from './common.js';
import {
  clientBodies,
  hubBodies,
  type ClientBody,
  type ClientType,
  type HubBody,
  type HubType,
} from './hub.js';

export const MessageId = z.string().regex(/^m_[0-9A-HJKMNP-TV-Z]{26}$/);

/** Outer frame; `body` is validated separately against the schema for `t`. */
export const RawEnvelope = z.object({
  v: z.number().int().positive(),
  id: MessageId,
  re: MessageId.optional(),
  t: z.string().min(1).max(64),
  body: z.unknown(),
});

export interface Envelope<T extends string, B> {
  v: number;
  id: string;
  re?: string;
  t: T;
  body: B;
}

export type ClientMessage = { [T in ClientType]: Envelope<T, ClientBody<T>> }[ClientType];
export type HubMessage = { [T in HubType]: Envelope<T, HubBody<T>> }[HubType];

export const newMessageId = (): string => 'm_' + ulid();
export const newSessionId = (): string => 'x_' + ulid();
export const newGroupId = (): string => 'g_' + ulid();

export type ParseResult<M> =
  | { ok: true; msg: M }
  | {
      ok: false;
      /** Error code to send back, and the id of the offending message if it had one. */
      code: 'bad_request' | 'upgrade_required';
      message: string;
      re?: string;
    };

/** Max JSON frame size accepted from a peer of the hub (an index page of 5,000 entries fits). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function parseWith<M>(raw: string, bodies: Record<string, z.ZodType>): ParseResult<M> {
  if (raw.length > MAX_FRAME_BYTES)
    return { ok: false, code: 'bad_request', message: 'frame too large' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'bad_request', message: 'invalid JSON' };
  }
  const env = RawEnvelope.safeParse(json);
  if (!env.success) return { ok: false, code: 'bad_request', message: 'invalid envelope' };
  const { v, id, t } = env.data;
  if (v !== PROTOCOL_VERSION) {
    return { ok: false, code: 'upgrade_required', message: `protocol v${v} not supported`, re: id };
  }
  const schema = Object.hasOwn(bodies, t) ? bodies[t] : undefined;
  if (!schema) return { ok: false, code: 'bad_request', message: `unknown type ${t}`, re: id };
  const body = schema.safeParse(env.data.body);
  if (!body.success) {
    return { ok: false, code: 'bad_request', message: z.prettifyError(body.error), re: id };
  }
  return { ok: true, msg: { ...env.data, body: body.data } as M };
}

/** Used by the hub on frames from clients. */
export const parseClientMessage = (raw: string): ParseResult<ClientMessage> =>
  parseWith(raw, clientBodies);

/** Used by clients on frames from the hub. */
export const parseHubMessage = (raw: string): ParseResult<HubMessage> => parseWith(raw, hubBodies);

export function encode<T extends string, B>(
  t: T,
  body: B,
  opts: { re?: string; id?: string } = {},
): string {
  const env: Envelope<T, B> = { v: PROTOCOL_VERSION, id: opts.id ?? newMessageId(), t, body };
  if (opts.re) env.re = opts.re;
  return JSON.stringify(env);
}

export const encodeClient = <T extends ClientType>(
  t: T,
  body: ClientBody<T>,
  opts?: { re?: string; id?: string },
): string => encode(t, body, opts);

export const encodeHub = <T extends HubType>(
  t: T,
  body: HubBody<T>,
  opts?: { re?: string; id?: string },
): string => encode(t, body, opts);
