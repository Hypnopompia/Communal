import { describe, expect, it } from 'vitest';
import type { Connection } from './api';
import { mergePeople } from './people-merge';

const conn = (over: Partial<Connection> & Pick<Connection, 'user_id'>): Connection => ({
  display_name: 'Ann',
  fingerprint: 'fp',
  verified: false,
  state: 'accepted',
  since: 100,
  ...over,
});

describe('mergePeople', () => {
  it('shows someone on two hubs once, named as on the first hub', () => {
    const merged = mergePeople([
      { hub: 'h_a', connections: [conn({ user_id: 'u_ann', display_name: 'Ann', seen: 'week' })] },
      {
        hub: 'h_b',
        connections: [
          conn({ user_id: 'u_ann', display_name: 'Annie', online: true, seen: 'now' }),
          conn({ user_id: 'u_ben', display_name: 'Ben', state: 'pending_in' }),
        ],
      },
    ]);
    expect(merged.map((p) => p.display_name)).toEqual(['Ann', 'Ben']);
    expect(merged[0]).toMatchObject({ online: true, seen: 'now' });
    expect(merged[0]!.hubs.map((h) => [h.hub, h.state])).toEqual([
      ['h_a', 'accepted'],
      ['h_b', 'accepted'],
    ]);
    expect(merged[1]!.hubs).toEqual([{ hub: 'h_b', state: 'pending_in', since: 100 }]);
  });

  it('counts presence only where you are connected, and keeps any verification', () => {
    const [p] = mergePeople([
      { hub: 'h_a', connections: [conn({ user_id: 'u_ann', state: 'pending_out', online: true })] },
      { hub: 'h_b', connections: [conn({ user_id: 'u_ann', verified: true, seen: 'month' })] },
    ]);
    expect(p).toMatchObject({ online: false, seen: 'month', verified: true });
  });
});
