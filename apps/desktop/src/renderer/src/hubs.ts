import { useQueries } from '@tanstack/react-query';
import { api, qs, type Connection, type HubStatus, type LibraryDevice, type Status } from './api';
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
      return h ? hubName(h) : 'a hub you left';
    },
  };
}

/**
 * Everyone whose devices this account can browse, merged across hubs by user id (the same
 * account on every hub, ADR 0007). Used for names wherever only a user or device id is known.
 */
export function useLibrary() {
  return useApi<{ devices: LibraryDevice[]; hubs: { hub: string; ok: boolean; error?: string }[] }>(
    ['presence', 'people', 'hubs', 'devices', 'library'],
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
  const verified = new Set<string>();
  const devices = new Map<
    string,
    { name: string; user: string; user_id: string; platform: string | undefined }
  >();
  // Hubs in the order you joined them: someone on several is named as on the first (ADR 0021).
  for (const q of people)
    for (const c of q.data?.connections ?? []) {
      if (!users.has(c.user_id)) users.set(c.user_id, c.display_name);
      if (c.verified) verified.add(c.user_id);
    }
  for (const d of data?.devices ?? []) {
    if (!users.has(d.user.user_id)) users.set(d.user.user_id, d.user.display_name);
    if (d.user.verified) verified.add(d.user.user_id);
    devices.set(d.device_id, {
      name: d.device_name,
      user: d.user.display_name,
      user_id: d.user.user_id,
      platform: d.platform,
    });
  }
  return {
    user: (id: string) => users.get(id) ?? 'Someone',
    /** Whether this user verified them by comparing safety codes. */
    verified: (id: string) => verified.has(id),
    device: (id: string) => devices.get(id),
  };
}

/**
 * Your connection state with each person on each ready hub (connections are per hub), from the
 * same queries as the People screen. `undefined` for a hub means it hasn't answered yet; a
 * person missing from a loaded hub's map isn't connected there and nobody has asked.
 */
export function useConnectionStates(): Map<string, Map<string, Connection['state']> | undefined> {
  const { hubs } = useHubs();
  const ready = hubs.filter((h) => h.ready);
  const lists = useQueries({
    queries: ready.map((h) => {
      const path = `/v1/people${qs({ hub: h.id })}`;
      return {
        queryKey: ['api', ['people', 'presence'], path],
        queryFn: () => api.get<{ connections: Connection[] }>(path),
      };
    }),
  });
  return new Map(
    ready.map((h, i) => {
      const data = lists[i]?.data;
      return [h.id, data ? new Map(data.connections.map((c) => [c.user_id, c.state])) : undefined];
    }),
  );
}
