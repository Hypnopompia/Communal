import { describe, expect, it } from 'vitest';
import { diagnose, type Observation } from './diagnosis.js';

/** A side behind an ordinary home router: NAT, no mapping, punches sent, nothing heard. */
const home: Observation = {
  nat: 'endpoint_independent',
  upnp: false,
  ipv6: false,
  cgnat: false,
  attempts: 100,
  udp_sent: true,
  udp_received: false,
};
const o = (patch: Partial<Observation>): Observation => ({ ...home, ...patch });

describe('diagnose (HANDOFF §8 table)', () => {
  const cases: [string, Parameters<typeof diagnose>[0], ReturnType<typeof diagnose>][] = [
    [
      'owner never answered the offer',
      { answered: false, down: home },
      { cause: 'peer_offline', easier_fix: 'none' },
    ],
    [
      'downloader cannot send UDP at all',
      { answered: true, down: o({ nat: 'blocked' }), up: home },
      { cause: 'udp_blocked', easier_fix: 'you' },
    ],
    [
      'owner cannot send UDP at all',
      { answered: true, down: home, up: o({ nat: 'blocked' }) },
      { cause: 'udp_blocked', easier_fix: 'them' },
    ],
    [
      'both blocked: start with your own network',
      { answered: true, down: o({ nat: 'blocked' }), up: o({ nat: 'blocked' }) },
      { cause: 'udp_blocked', easier_fix: 'you' },
    ],
    [
      'owner has a UPnP mapping but heard nothing while we heard them: their firewall',
      { answered: true, down: o({ udp_received: true }), up: o({ upnp: true }) },
      { cause: 'os_firewall', easier_fix: 'them' },
    ],
    [
      'we have a public address but heard nothing: our firewall',
      { answered: true, down: o({ nat: 'none' }), up: o({ udp_received: true }) },
      { cause: 'os_firewall', easier_fix: 'you' },
    ],
    [
      'downloader behind CGNAT, owner behind an ordinary NAT: the owner can forward a port',
      { answered: true, down: o({ cgnat: true }), up: home },
      { cause: 'cgnat', easier_fix: 'them' },
    ],
    [
      'owner behind CGNAT',
      { answered: true, down: home, up: o({ cgnat: true }) },
      { cause: 'cgnat', easier_fix: 'you' },
    ],
    [
      'both behind CGNAT',
      { answered: true, down: o({ cgnat: true }), up: o({ cgnat: true }) },
      { cause: 'cgnat', easier_fix: 'either' },
    ],
    [
      'symmetric downloader, ordinary owner: fix the owner side',
      { answered: true, down: o({ nat: 'symmetric' }), up: home },
      { cause: 'both_restrictive_nat', easier_fix: 'them' },
    ],
    [
      'symmetric owner, ordinary downloader: fix your side',
      { answered: true, down: home, up: o({ nat: 'symmetric' }) },
      { cause: 'both_restrictive_nat', easier_fix: 'you' },
    ],
    [
      'both symmetric',
      { answered: true, down: o({ nat: 'symmetric' }), up: o({ nat: 'symmetric' }) },
      { cause: 'both_restrictive_nat', easier_fix: 'either' },
    ],
    [
      'only our packets got through: their side filters',
      { answered: true, down: o({ udp_received: true }), up: home },
      { cause: 'both_restrictive_nat', easier_fix: 'them' },
    ],
    [
      'owner never reported and has no profile',
      { answered: true, down: home },
      { cause: 'both_restrictive_nat', easier_fix: 'either' },
    ],
    [
      'owner judged by its profile alone (no punch stats): blocked',
      {
        answered: true,
        down: home,
        up: { nat: 'blocked', upnp: false, ipv6: false, cgnat: false },
      },
      { cause: 'udp_blocked', easier_fix: 'them' },
    ],
  ];
  for (const [name, input, want] of cases) {
    it(name, () => expect(diagnose(input)).toEqual(want));
  }
});
