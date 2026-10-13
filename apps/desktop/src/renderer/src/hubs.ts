import { useQueries } from '@tanstack/react-query';
import { api, type Connection, type HubStatus, type LibraryDevice, type Status } from './api';
import { hubName } from './format';
import { useApi } from './query';

export function useStatus() {
  return useApi<Status>(['hubs', 'index', 'devices'], '/v1/status', { refetchInterval: 5_000 });
}

/** Hubs by local id, with a readable name for each. */
export function useHubs(): { hubs: HubStatus[]; name: (id: string) => string } {
  const { data } = useStatus();
  const hubs = data?.hubs ?? [];
  return {
    hubs,
    name: (id) => {
      const h = hubs.find((x) => x.id === id);
      return h ? hubName(h.url) : 'a hub you left';
    },
  };
}

/**
 * Everyone whose devices this account can browse, merged across hubs by user id (the same
 * account on every hub, ADR 0007). Used for names wherever only a user or device id is known.
 */
export function useLibrary() {
  return useApi<{ devices: LibraryDevice[]; hubs: { hub: string; ok: boolean; error?: string }[] }>(
    ['presence', 'people', 'hubs', 'devices'],
    '/v1/library',
    { refetchInterval: 30_000 },
  );
}

export function useNames() {
  const { data } = useLibrary();
  const { hubs } = useHubs();
  // Connections name people who download from us without sharing anything back.
  const people = useQueries({
    queries: hubs
      .filter((h) => h.ready)
      .map((h) => ({
        queryKey: ['api', ['people'], `/v1/people?hub=${h.id}`],
        queryFn: () =>
          api.get<{ connections: Connection[] }>(`/v1/people?hub=${encodeURIComponent(h.id)}`),
      })),
  });
  const users = new Map<string, string>();
  const devices = new Map<string, { name: string; user: string }>();
  for (const q of people)
    for (const c of q.data?.connections ?? []) users.set(c.user_id, c.display_name);
  for (const d of data?.devices ?? []) {
    users.set(d.user.user_id, d.user.display_name);
    devices.set(d.device_id, { name: d.device_name, user: d.user.display_name });
  }
  return {
    user: (id: string) => users.get(id) ?? 'Someone',
    device: (id: string) => devices.get(id),
  };
}
