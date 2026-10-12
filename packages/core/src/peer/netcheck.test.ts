import { describe, expect, it } from 'vitest';
import { classifyNat, isCgnatAddress } from './netcheck.js';
import { explain, mostUseful, type TransferDiagnosis } from '../transfer/diagnosis.js';

describe('NAT classification (HANDOFF §8)', () => {
  const local = { port: 41641, addrs: new Set(['192.168.1.20', '127.0.0.1']) };
  const at = (host: string, port: number) => ({ host, port });

  it('same mapped port towards both probe ports: endpoint-independent', () => {
    expect(classifyNat([at('203.0.113.7', 41641), at('203.0.113.7', 41641)], local)).toBe(
      'endpoint_independent',
    );
    // A NAT that keeps the port but maps it consistently is still endpoint-independent.
    expect(classifyNat([at('203.0.113.7', 60001), at('203.0.113.7', 60001)], local)).toBe(
      'endpoint_independent',
    );
  });

  it('a different port (or address) per destination: symmetric', () => {
    expect(classifyNat([at('203.0.113.7', 60001), at('203.0.113.7', 60002)], local)).toBe(
      'symmetric',
    );
    expect(classifyNat([at('203.0.113.7', 60001), at('203.0.113.8', 60001)], local)).toBe(
      'symmetric',
    );
  });

  it('the hub sees one of our own addresses and our port: no NAT', () => {
    expect(classifyNat([at('192.168.1.20', 41641), at('192.168.1.20', 41641)], local)).toBe('none');
  });

  it('no reply at all: UDP blocked; a single reply: unknown', () => {
    expect(classifyNat([null, null], local)).toBe('blocked');
    expect(classifyNat([at('203.0.113.7', 41641), null], local)).toBe('unknown');
  });

  it('spots the carrier-grade NAT range 100.64.0.0/10 exactly', () => {
    for (const ip of ['100.64.0.1', '100.100.3.4', '100.127.255.254'])
      expect(isCgnatAddress(ip)).toBe(true);
    for (const ip of ['100.63.255.255', '100.128.0.1', '10.64.0.1', '192.168.1.1'])
      expect(isCgnatAddress(ip)).toBe(false);
  });
});

describe('diagnosis messages (HANDOFF §8 table)', () => {
  const unknown = { nat: 'unknown', upnp: false, ipv6: false, cgnat: false } as const;
  const d = (cause: TransferDiagnosis['cause'], easier_fix: TransferDiagnosis['easier_fix']) =>
    ({ cause, easier_fix, you: unknown, them: unknown, at: 1 }) as TransferDiagnosis;

  it('gives every cause a message and tips, and says whose side to fix', () => {
    for (const cause of [
      'peer_offline',
      'both_restrictive_nat',
      'cgnat',
      'udp_blocked',
      'os_firewall',
    ] as const) {
      const e = explain(d(cause, 'either'));
      expect(e.message.length).toBeGreaterThan(10);
      expect(e.tips.length).toBeGreaterThan(0);
    }
    expect(explain(d('peer_offline', 'none')).fix).toBeNull();
    expect(explain(d('both_restrictive_nat', 'them')).fix).toMatch(/owner's side/);
    expect(explain(d('udp_blocked', 'you')).message).toMatch(/^This network blocks/);
    expect(explain(d('udp_blocked', 'them')).message).toMatch(/^The owner's network/);
    expect(explain(d('os_firewall', 'them')).message).toMatch(/owner's firewall/);
    expect(explain(d('cgnat', 'you')).message).toMatch(/owner's internet provider/);
  });

  it('prefers an actionable diagnosis over "offline" when sources disagree', () => {
    expect(mostUseful([d('peer_offline', 'none'), d('cgnat', 'them')])?.cause).toBe('cgnat');
    expect(mostUseful([d('peer_offline', 'none')])?.cause).toBe('peer_offline');
    expect(mostUseful([])).toBeUndefined();
  });
});
