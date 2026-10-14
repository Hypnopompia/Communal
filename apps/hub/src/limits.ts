/**
 * Abuse limits for the hub (ADR 0022): per-address counters and the per-session message budget.
 * The numbers an admin can change live in the settings table (`HubDb.limits`); the rest are
 * fixed here and only tests change them.
 */
import { isIPv6 } from 'node:net';

export interface FixedLimits {
  /** Open WebSocket connections from one address (an IPv4 address or an IPv6 /64). */
  connectionsPerAddress: number;
  /** Message budget per session: tokens refilled per second, and the bucket size. */
  messageRate: number;
  messageBurst: number;
  /** Messages a session may have waiting for budget (count and bytes) before it's closed. */
  queueMessages: number;
  queueBytes: number;
  /** NAT probe replies per second to one address. */
  probeRate: number;
  /** Groups per account, rules per device, stored subscriptions per watching device. */
  groupsPerUser: number;
  rulesPerDevice: number;
  watchesPerDevice: number;
  /** Connection requests one account may have waiting for an answer. */
  pendingRequestsPerUser: number;
  /** Brokered connections one session may have waiting at once. */
  brokeredPerSession: number;
}

export const FIXED_LIMITS: FixedLimits = {
  connectionsPerAddress: 20,
  messageRate: 100,
  messageBurst: 1_000,
  queueMessages: 2_000,
  queueBytes: 32 * 1024 * 1024,
  probeRate: 10,
  groupsPerUser: 100,
  rulesPerDevice: 10_000,
  watchesPerDevice: 1_000,
  pendingRequestsPerUser: 50,
  brokeredPerSession: 64,
};

/**
 * What a message costs from the session's budget. Queries that scan the index or reach another
 * device cost more than bookkeeping; anything not listed costs 1.
 */
export const MESSAGE_COST: Partial<Record<string, number>> = {
  search: 4,
  'user.search': 4,
  sources: 4,
  browse: 4,
  library: 4,
  'connect.request': 4,
  'device.message': 2,
  'index.snapshot': 4,
  'index.delta': 4,
};

/**
 * The key per-address limits count under: an IPv4 address as is, an IPv6 address by its /64
 * (one home or phone gets a whole /64, so counting single addresses would be no limit at all).
 */
export function addressKey(addr: string): string {
  const a = addr.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (!isIPv6(a)) return a;
  const [head = '', tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = a.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return (
    full
      .slice(0, 4)
      .map((x) => x.toLowerCase().replace(/^0+(?=.)/, ''))
      .join(':') + '::/64'
  );
}

/** A token bucket: `rate` tokens per second, holding at most `burst`. Starts full. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
  }

  /** Takes `n` tokens if there are that many (a cost above the burst needs a full bucket). */
  take(n = 1): boolean {
    this.refill();
    const need = Math.min(n, this.burst);
    if (this.tokens < need) return false;
    this.tokens -= need;
    return true;
  }

  /** Milliseconds until `n` tokens will be there. */
  waitFor(n = 1): number {
    this.refill();
    const need = Math.min(n, this.burst);
    return this.tokens >= need ? 0 : Math.ceil(((need - this.tokens) / this.rate) * 1000);
  }
}

/** Counts events per key over a sliding window (sign-ups per address per hour). */
export class WindowCounter {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  count(key: string): number {
    const list = this.events.get(key);
    if (!list) return 0;
    const from = this.now() - this.windowMs;
    while (list.length && list[0]! <= from) list.shift();
    if (list.length === 0) this.events.delete(key);
    return list.length;
  }

  add(key: string) {
    const list = this.events.get(key);
    if (list) list.push(this.now());
    else this.events.set(key, [this.now()]);
  }

  /** Forgets keys with nothing left in the window. */
  prune() {
    for (const key of [...this.events.keys()]) this.count(key);
  }
}

/** Token buckets per key, forgotten once they've had time to fill up again. */
export class BucketMap {
  private readonly buckets = new Map<string, { bucket: TokenBucket; used: number }>();

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string, n = 1): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = { bucket: new TokenBucket(this.rate, this.burst, this.now), used: 0 };
      this.buckets.set(key, b);
    }
    b.used = this.now();
    return b.bucket.take(n);
  }

  prune() {
    const full = (this.burst / this.rate) * 1000;
    for (const [k, b] of this.buckets) if (this.now() - b.used > full) this.buckets.delete(k);
  }
}
