/**
 * Data fetching. Every query is tagged with the core topics it depends on; a hint on
 * `/v1/events` (forwarded by main) invalidates the matching queries, so screens refresh when
 * something changes instead of polling.
 */
import { QueryClient, useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { api, ApiError } from './api';

export type Topic =
  | 'hubs'
  | 'presence'
  | 'people'
  | 'devices'
  | 'transfers'
  | 'index'
  | 'subscriptions'
  | 'browse'
  | 'library'
  | 'admin';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
    },
  },
});

/** Each query key starts with its topics: ['topics', [...topics], path]. */
export function useApi<T>(
  topics: Topic[],
  path: string | null,
  opts: Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'> = {},
) {
  return useQuery<T, Error>({
    queryKey: ['api', topics, path],
    queryFn: () => api.get<T>(path!),
    enabled: path !== null && (opts.enabled ?? true),
    ...opts,
  });
}

export function invalidate(topics: string[]) {
  void queryClient.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === 'api' &&
      Array.isArray(q.queryKey[1]) &&
      (q.queryKey[1] as string[]).some((t) => topics.includes(t)),
  });
}

window.communal.onTopics(invalidate);
