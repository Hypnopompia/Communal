import type { ClientBody, HubBody } from '@communal/protocol';

/** One side's view of a failed connection: its network profile plus what its punching saw. */
export type Observation = ClientBody<'connect.failed'>['observations'];
export type NatObservation = HubBody<'connect.failed'>['you'];
export type Diagnosis = Pick<HubBody<'connect.failed'>, 'cause' | 'easier_fix'>;

/** A side's profile, with punching stats when it reported (not when judged by its profile). */
type Side = NatObservation & Partial<Observation>;

export const UNKNOWN: NatObservation = { nat: 'unknown', upnp: false, ipv6: false, cgnat: false };

/**
 * Combines both sides' observations of a failed direct connection into one `cause` and the
 * side whose setup is easier to fix (HANDOFF §8 table, ADR 0011). `down` is the downloader
 * (the "you" of the answer), `up` the owner. A side that never reported is `undefined`; the
 * hub then falls back to that side's last `network.profile`, if any.
 *
 * Order matters: the most specific explanation wins.
 * 1. The owner never answered the offer: it's gone (`peer_offline`).
 * 2. A side whose probe got no reply at all can't send UDP anywhere (`udp_blocked`).
 * 3. A side that should accept incoming packets (no NAT, or a UPnP/NAT-PMP mapping) but heard
 *    nothing while the other side heard it: its own firewall dropped them (`os_firewall`).
 * 4. A carrier-grade NAT on a side with no mapping: only the other side can open a port, or
 *    the CGNAT side needs IPv6 / a public IPv4 (`cgnat`).
 * 5. Anything else: neither side accepts unsolicited packets (`both_restrictive_nat`). One
 *    port forward on either side is enough.
 */
export function diagnose(x: { answered: boolean; down?: Side; up?: Side }): Diagnosis {
  if (!x.answered) return { cause: 'peer_offline', easier_fix: 'none' };
  const you: Side = x.down ?? UNKNOWN;
  const them: Side = x.up ?? UNKNOWN;

  const youBlocked = you.nat === 'blocked';
  const themBlocked = them.nat === 'blocked';
  if (youBlocked || themBlocked) {
    // Both blocked: start with your own network, the one you can change right now.
    return { cause: 'udp_blocked', easier_fix: youBlocked ? 'you' : 'them' };
  }

  const reachable = (o: NatObservation) => o.upnp || o.nat === 'none';
  // Heard nothing although it accepts inbound packets, while the other side did hear it
  // (or, with no report from the other side, the reachable one simply heard nothing).
  const firewalled = (self: Side, other: Side) =>
    reachable(self) && self.udp_received === false && other.udp_received !== false;
  const youFw = firewalled(you, them);
  const themFw = firewalled(them, you);
  if (youFw !== themFw) return { cause: 'os_firewall', easier_fix: youFw ? 'you' : 'them' };
  if (youFw && themFw) return { cause: 'os_firewall', easier_fix: 'either' };

  // Either side being reachable would normally have worked; neither is.
  if (!reachable(you) && !reachable(them)) {
    if (you.cgnat && them.cgnat) return { cause: 'cgnat', easier_fix: 'either' };
    if (you.cgnat) return { cause: 'cgnat', easier_fix: 'them' };
    if (them.cgnat) return { cause: 'cgnat', easier_fix: 'you' };
  }

  // One side's packets got through but the other's didn't: that receiving side filters.
  if (you.udp_received === true && them.udp_received === false) {
    return { cause: 'both_restrictive_nat', easier_fix: 'them' };
  }
  if (them.udp_received === true && you.udp_received === false) {
    return { cause: 'both_restrictive_nat', easier_fix: 'you' };
  }
  // A symmetric NAT can't be punched from the other side's mapping; the side that isn't
  // symmetric is the one where a single port forward reliably fixes it.
  if (you.nat === 'symmetric' && them.nat !== 'symmetric') {
    return { cause: 'both_restrictive_nat', easier_fix: 'them' };
  }
  if (them.nat === 'symmetric' && you.nat !== 'symmetric') {
    return { cause: 'both_restrictive_nat', easier_fix: 'you' };
  }
  return { cause: 'both_restrictive_nat', easier_fix: 'either' };
}

/** Strips the punching stats: the answer only carries the four profile fields. */
export function natView(o: Side | undefined): NatObservation {
  if (!o) return UNKNOWN;
  return { nat: o.nat, upnp: o.upnp, ipv6: o.ipv6, cgnat: o.cgnat };
}
