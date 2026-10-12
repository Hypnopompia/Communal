import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { pino, type Logger } from 'pino';
import type { Gateway } from '@achingbrain/nat-port-mapper';
import type { ClientBody, HubBody } from '@communal/protocol';
import type { HubManager } from '../hub-manager.js';
import { localAddresses, type PeerTransport, type PunchStats } from './transport.js';

export type NetworkProfile = ClientBody<'network.profile'>;
export type NatType = NetworkProfile['nat'];
export type Observations = ClientBody<'connect.failed'>['observations'];

/** A port mapping on the router, made with UPnP IGD or NAT-PMP (ADR 0011). */
export interface PortMapping {
  method: 'upnp' | 'pmp';
  /** The router's external address and the external port it forwards to our UDP port. */
  host: string;
  port: number;
}

/**
 * Opens our UDP port on the home router. Implementations never throw: no gateway, a refusal
 * or a timeout is `mapping: null`. `routerIp` is the router's own external address when it
 * told us (CGNAT detection), even if it refused the mapping.
 */
export interface PortMapper {
  map(port: number): Promise<{ mapping: PortMapping | null; routerIp: string | null }>;
  stop(): Promise<void>;
}

/** What one hub's probe responders saw, plus the result, per hub. */
export interface HubNetwork {
  profile: NetworkProfile;
  /** Our address as each probe port saw it (null: no reply). */
  observed: ({ host: string; port: number } | null)[];
  checked_at: number;
}

const CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
/** RFC 6598 shared address space, used by carrier-grade NATs. */
export const isCgnatAddress = (ip: string) => CGNAT.test(ip);

/**
 * NAT type from the addresses the hub's two probe ports saw us at, both probed from the one
 * peer socket (HANDOFF §8). Same mapped port → endpoint-independent mapping; different →
 * symmetric; one of our own addresses → no NAT at all.
 */
export function classifyNat(
  observed: ({ host: string; port: number } | null)[],
  local: { port: number; addrs: Set<string> },
): NatType {
  const [a, b] = observed;
  if (!a && !b) return 'blocked';
  if (!a || !b) return 'unknown';
  if (a.host !== b.host || a.port !== b.port) return 'symmetric';
  if (local.addrs.has(a.host) && a.port === local.port) return 'none';
  return 'endpoint_independent';
}

/** A global unicast IPv6 address on any interface (not link-local, not ULA). */
export function hasGlobalIpv6(): boolean {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv6' || a.internal) continue;
      if (/^(2|3)[0-9a-f]{3}:/i.test(a.address)) return true;
    }
  }
  return false;
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out.slice(0, 32);
}

export interface NetworkCheckOptions {
  transport: PeerTransport;
  hubs: HubManager;
  /** null disables UPnP/NAT-PMP (tests; COMMUNAL_UPNP=false). */
  mapper: PortMapper | null;
  /** Tests: replace parts of every measured profile (e.g. pretend to be behind a symmetric NAT). */
  override?: () => Partial<NetworkProfile> | undefined;
  log?: Logger;
}

/**
 * The client half of HANDOFF §8 diagnostics: classifies the NAT towards each hub, tries a
 * UPnP/NAT-PMP mapping, notes global IPv6 and CGNAT, and sends each hub `network.profile`.
 * Failed connections report these observations, so the hub can say what went wrong.
 */
export class NetworkCheck {
  private readonly log: Logger;
  private readonly perHub = new Map<string, HubNetwork>();
  private mapping?: Promise<{ mapping: PortMapping | null; routerIp: string | null }>;
  private stopped = false;

  constructor(private readonly o: NetworkCheckOptions) {
    this.log = o.log ?? pino({ name: 'netcheck' });
    o.hubs.on('ready', ({ hub }) => void this.check(hub));
  }

  /** Starts the router port mapping (in the background; hub checks wait for it). */
  start() {
    this.mapping = this.mapPort();
  }

  async stop() {
    this.stopped = true;
    await this.o.mapper?.stop().catch(() => {});
  }

  private async mapPort() {
    if (!this.o.mapper) return { mapping: null, routerIp: null };
    const r = await this.o.mapper.map(this.o.transport.port);
    if (r.mapping) {
      this.o.transport.setMapped(r.mapping);
      this.log.info(
        { method: r.mapping.method, external_port: r.mapping.port },
        'router port mapping made',
      );
    } else {
      this.log.info('no UPnP/NAT-PMP port mapping (router lacks it or refused)');
    }
    return r;
  }

  /** The latest profile sent to `hub` (undefined until its first check finished). */
  profile(hub: string): NetworkProfile | undefined {
    return this.perHub.get(hub)?.profile;
  }

  /** Everything known, per hub, plus the router mapping (for the API and `netcheck`). */
  async summary() {
    const m = await (this.mapping ?? Promise.resolve({ mapping: null, routerIp: null }));
    return {
      port: this.o.transport.port,
      mapping: m.mapping,
      router_ip: m.routerIp,
      hubs: Object.fromEntries([...this.perHub].filter(([h]) => this.o.hubs.find(h))),
    };
  }

  /** What to put in `connect.failed` for a session brokered by `hub`. */
  observations(hub: string, stats: PunchStats | undefined): Observations {
    const p = this.profile(hub);
    return {
      nat: p?.nat ?? 'unknown',
      upnp: p?.upnp ?? false,
      ipv6: p?.ipv6 ?? false,
      cgnat: p?.cgnat ?? false,
      attempts: stats?.attempts ?? 0,
      udp_sent: stats?.udp_sent ?? false,
      udp_received: stats?.udp_received ?? false,
    };
  }

  /** Re-runs the whole check: the router mapping, then every connected hub. */
  async recheck(): Promise<void> {
    if (this.o.mapper) {
      await this.o.mapper.stop().catch(() => {});
      this.o.transport.setMapped(undefined);
    }
    this.mapping = this.mapPort();
    await Promise.all(this.o.hubs.list().map((h) => this.check(h.id)));
  }

  /** Probes `hub` from the peer socket, builds the profile and sends it (if signed in). */
  async check(hub: string): Promise<HubNetwork | undefined> {
    const client = this.o.hubs.get(hub);
    const entry = this.o.hubs.find(hub);
    const ports = client?.session?.nat_probe_ports;
    if (!client || !entry || !ports || this.stopped) return;
    const [observed, mapped] = await Promise.all([
      this.probe(entry.url, ports),
      this.mapping ?? Promise.resolve({ mapping: null, routerIp: null }),
    ]);
    const routerIp = mapped.routerIp ?? mapped.mapping?.host ?? null;
    const measured: NetworkProfile = {
      nat: observed
        ? classifyNat(observed, { port: this.o.transport.port, addrs: localAddresses() })
        : 'unknown',
      upnp: mapped.mapping !== null,
      ipv6: hasGlobalIpv6(),
      // The router's own "external" address is in the carrier's shared space, or the hub sees
      // us there: someone upstream NATs again (HANDOFF §8).
      cgnat:
        (routerIp !== null && isCgnatAddress(routerIp)) ||
        (observed ?? []).some((o) => o !== null && isCgnatAddress(o.host)),
      lan_addrs: lanAddresses(),
    };
    const profile = { ...measured, ...this.o.override?.() };
    const result = { profile, observed: observed ?? [], checked_at: Math.floor(Date.now() / 1000) };
    this.perHub.set(hub, result);
    const first = observed?.find((o) => o !== null);
    this.log.info(
      {
        hub,
        nat: profile.nat,
        upnp: profile.upnp,
        ipv6: profile.ipv6,
        cgnat: profile.cgnat,
        ...(first ? { public_addr: `${first.host}:${first.port}` } : {}),
      },
      'network checked',
    );
    if (client.ready) {
      await client.request('network.profile', profile).catch((err: Error) => {
        this.log.debug({ hub, err: err.message }, 'could not send network profile');
      });
    }
    return result;
  }

  /** Our address as each of the hub's two probe ports sees it (null when the hub has none). */
  private async probe(
    url: string,
    ports: HubBody<'welcome'>['nat_probe_ports'],
  ): Promise<({ host: string; port: number } | null)[] | null> {
    if (!ports[0] || !ports[1]) return null;
    try {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
      const ip = isIP(host) ? host : (await lookup(host)).address;
      if (isIP(ip) !== 4) return null; // the probe responders are IPv4 only
      // Both from the same socket, at once: the NAT sees two destinations from one source.
      const once = () => Promise.all(ports.map((p) => this.o.transport.probe(ip, p)));
      let observed = await once();
      // A lost datagram looks like a missing reply: one retry before calling UDP blocked.
      if (observed.some((o) => o === null)) {
        const again = await once();
        observed = observed.map((o, i) => o ?? again[i] ?? null);
      }
      return observed;
    } catch (err) {
      this.log.debug({ err: (err as Error).message }, 'NAT probe failed');
      return null;
    }
  }
}

// ── UPnP / NAT-PMP (ADR 0011: @achingbrain/nat-port-mapper) ─────────────────

/**
 * Tries NAT-PMP (asks the default gateway directly) and UPnP IGD (SSDP discovery) together;
 * the first mapping wins and the other is dropped. Mappings auto-refresh in the library, and
 * `stop()` removes them from the router.
 */
export class RouterPortMapper implements PortMapper {
  private gateways: Gateway[] = [];
  /** NAT-PMP is refreshed here, not by the library (ADR 0011: its TTL units are mixed up). */
  private pmp?: { gateway: Gateway; port: number; timer: NodeJS.Timeout };
  private readonly log: Logger;

  constructor(private readonly o: { timeoutMs?: number; ttlS?: number; log?: Logger } = {}) {
    this.log = o.log ?? pino({ name: 'portmap' });
  }

  async map(port: number): Promise<{ mapping: PortMapping | null; routerIp: string | null }> {
    if (!port) return { mapping: null, routerIp: null };
    const timeoutMs = this.o.timeoutMs ?? 4_000;
    const signal = AbortSignal.timeout(timeoutMs);
    const lib = await import('@achingbrain/nat-port-mapper');
    const ttlS = this.o.ttlS ?? 7200;
    // UPnP takes the lease in ms and refreshes itself.
    const opts = {
      protocol: 'UDP' as const,
      externalPort: port,
      ttl: ttlS * 1000,
      description: 'Communal',
      autoRefresh: true,
      signal,
    };
    let routerIp: string | null = null;

    const viaPmp = async (): Promise<PortMapping> => {
      const gw = await defaultGateway();
      if (!gw) throw new Error('no default gateway');
      const g = lib.pmpNat(gw);
      (g as unknown as NodeJS.EventEmitter).on?.('error', () => {});
      this.gateways.push(g);
      routerIp = await g.externalIp({ signal }).catch(() => routerIp);
      // NAT-PMP puts `ttl` on the wire as seconds but would also use it as a ms timer, so
      // refresh it ourselves at half the lease.
      const local = localAddressFor(gw) ?? '0.0.0.0';
      const pmpOpts = { ...opts, ttl: ttlS, autoRefresh: false };
      const m = await g.map(port, local, pmpOpts);
      const timer = setInterval(
        () => {
          const { signal: _s, ...again } = pmpOpts;
          void g
            .map(port, local, { ...again, signal: AbortSignal.timeout(10_000) })
            .catch((err: Error) => this.log.warn({ err: err.message }, 'NAT-PMP refresh failed'));
        },
        (ttlS * 1000) / 2,
      );
      timer.unref();
      this.pmp = { gateway: g, port, timer };
      return { method: 'pmp', host: m.externalHost, port: m.externalPort };
    };
    const viaUpnp = async (): Promise<PortMapping> => {
      for await (const g of lib.upnpNat().findGateways({ signal })) {
        if (g.family !== 'IPv4') continue;
        this.gateways.push(g);
        routerIp = await g.externalIp({ signal }).catch(() => routerIp);
        const local = localAddressFor(g.host);
        if (!local) continue;
        const m = await g.map(port, local, opts);
        return { method: 'upnp', host: m.externalHost, port: m.externalPort };
      }
      throw new Error('no UPnP gateway');
    };

    try {
      const mapping = await Promise.any([viaPmp(), viaUpnp()]);
      if (!isIP(mapping.host)) return { mapping: null, routerIp };
      return { mapping, routerIp: routerIp ?? mapping.host };
    } catch (err) {
      const errors = err instanceof AggregateError ? err.errors : [err];
      this.log.debug(
        { errs: errors.map((e: unknown) => (e as Error).message) },
        'port mapping failed',
      );
      return { mapping: null, routerIp };
    }
  }

  async stop() {
    const gws = this.gateways;
    this.gateways = [];
    if (this.pmp) {
      clearInterval(this.pmp.timer);
      await this.pmp.gateway
        .unmap(this.pmp.port, { signal: AbortSignal.timeout(2_000) })
        .catch(() => {});
      this.pmp = undefined;
    }
    await Promise.all(
      gws.map((g) => g.stop({ signal: AbortSignal.timeout(2_000) }).catch(() => {})),
    );
  }
}

/** The local IPv4 address on the same subnet as `gateway` (what the router forwards to). */
function localAddressFor(gateway: string): string | undefined {
  const toInt = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  if (isIP(gateway) !== 4) return undefined;
  const g = toInt(gateway);
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const mask = toInt(a.netmask);
      if ((toInt(a.address) & mask) >>> 0 === (g & mask) >>> 0) return a.address;
    }
  }
  return undefined;
}

/** The IPv4 default gateway (NAT-PMP talks to it directly). Best effort per platform. */
export async function defaultGateway(): Promise<string | null> {
  const run = (cmd: string, args: string[]) =>
    new Promise<string>((resolve) =>
      execFile(cmd, args, { timeout: 2_000 }, (err, out) => resolve(err ? '' : out)),
    );
  let gw: string | undefined;
  if (process.platform === 'linux') {
    const table = await readFile('/proc/net/route', 'utf8').catch(() => '');
    for (const line of table.split('\n').slice(1)) {
      const [, dest, hex] = line.trim().split(/\s+/);
      if (dest === '00000000' && hex && hex !== '00000000') {
        const n = parseInt(hex, 16);
        gw = [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join('.');
        break;
      }
    }
  } else if (process.platform === 'win32') {
    gw = /0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/.exec(
      await run('route', ['print', '0.0.0.0']),
    )?.[1];
  } else {
    gw = /gateway:\s*(\d+\.\d+\.\d+\.\d+)/.exec(await run('route', ['-n', 'get', 'default']))?.[1];
  }
  return gw && isIP(gw) === 4 ? gw : null;
}
