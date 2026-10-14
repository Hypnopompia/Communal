/**
 * Remote control (ADR 0023): any device of this account can ask another to download a file,
 * download or follow a folder, and show or cancel its transfers. The other device acts only
 * while its Settings › Downloads switch is on, and saves into its own downloads folder.
 */
import { useQuery } from '@tanstack/react-query';
import { api, type RemoteDevice, type RemoteTransfer } from '../api';
import { size } from '../format';
import { Progress, useAction } from './kit';

/** Sends one request to another device of this account; resolves with its result. */
export async function remote<T>(device: string, request: object): Promise<T> {
  return (await api.post<{ result: T }>(`/v1/remote/${encodeURIComponent(device)}`, request))
    .result;
}

/**
 * Your other devices that take requests now: online, and with remote control switched on.
 * Phones are left out: they only run while open, so they can't be relied on to download.
 */
export type RemoteTarget = RemoteDevice & { destinations: string[] };

export function useRemoteTargets(): RemoteTarget[] {
  const q = useQuery({
    // Tagged like useApi's keys, so device and presence hints refresh it.
    queryKey: ['api', ['devices', 'presence'], 'remote-targets'],
    queryFn: async () => {
      const { devices } = await api.get<{ devices: RemoteDevice[] }>('/v1/remote/devices');
      const candidates = devices.filter((d) => d.online && d.platform !== 'android');
      const answers = await Promise.all(
        candidates.map((d) =>
          remote<{ allowed: boolean; destinations?: string[] }>(d.device_id, {
            op: 'hello',
          }).catch(() => null),
        ),
      );
      return candidates.flatMap((d, i) => {
        const a = answers[i];
        return a?.allowed ? [{ ...d, destinations: a.destinations ?? ['Downloads'] }] : [];
      });
    },
    staleTime: 30_000,
    retry: false,
  });
  return q.data ?? [];
}

/** Has another device download a file into its downloads folder. */
export function useRemoteDownload() {
  return useAction(
    async (device: RemoteDevice, hash: string, name: string, destination?: string) => {
      await remote(device.device_id, {
        op: 'download',
        hash,
        name,
        ...(destination ? { destination } : {}),
      });
      return { device, name, destination };
    },
    {
      done: (r) =>
        `${r.device.name} is downloading ${r.name}` +
        (r.destination ? ` into ${r.destination}` : ''),
      toastErrors: true,
    },
  );
}

/** Where a folder download or subscription goes: this computer, or one of your devices. */
export function WhereField({
  value,
  onChange,
  targets,
  here = true,
}: {
  value: string | null;
  onChange: (device: string | null) => void;
  targets: RemoteDevice[];
  /** False for files already on this computer: only another device makes sense. */
  here?: boolean;
}) {
  if (targets.length === 0) return null;
  return (
    <label className="field">
      <span>On</span>
      <select
        className="input"
        style={{ width: 'auto' }}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        {here && <option value="">This computer</option>}
        {targets.map((t) => (
          <option key={t.device_id} value={t.device_id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Another device's downloads, asked for every few seconds while shown. */
export function RemoteTransfers({ device }: { device: RemoteDevice }) {
  const q = useQuery({
    queryKey: ['remote-transfers', device.device_id],
    queryFn: () =>
      remote<{ transfers: RemoteTransfer[] }>(device.device_id, { op: 'transfers' }).then(
        (r) => r.transfers,
      ),
    refetchInterval: (query) =>
      query.state.data?.some((t) => t.state === 'active') ? 2_000 : 10_000,
  });
  const cancel = useAction((id: string) => remote(device.device_id, { op: 'cancel', id }), {
    onDone: () => void q.refetch(),
    toastErrors: true,
  });
  if (q.error) return <div className="notice warn">{q.error.message}</div>;
  if (!q.data) return <div className="muted">Asking {device.name}…</div>;
  if (q.data.length === 0) return <div className="muted">No downloads on {device.name}.</div>;
  return (
    <div className="panel rows">
      {q.data.map((t) => {
        const total = t.size ?? 0;
        const sub =
          t.state === 'active'
            ? total > 0
              ? `${size(t.bytes_done)} of ${size(total)}`
              : 'Starting…'
            : t.state === 'done'
              ? `Done${total ? `, ${size(total)}` : ''}`
              : t.state === 'queued'
                ? 'Waiting its turn'
                : t.state === 'waiting'
                  ? (t.error ?? 'Waiting for a source to come online')
                  : t.state === 'failed'
                    ? (t.error ?? 'Failed')
                    : 'Cancelled';
        return (
          <div key={t.id} className="row" style={{ alignItems: 'flex-start' }}>
            <div className="grow" style={{ display: 'grid', gap: 6 }}>
              <div className="title">{t.name}</div>
              <div className="sub" style={{ whiteSpace: 'normal' }}>
                {sub}
                {t.requested_by && ` · Started from ${t.requested_by}`}
              </div>
              {t.state === 'active' && total > 0 && <Progress value={t.bytes_done / total} />}
            </div>
            {['active', 'queued', 'waiting'].includes(t.state) && (
              <button
                className="btn small quiet"
                disabled={cancel.busy}
                onClick={() => void cancel.run(t.id)}
              >
                Cancel
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Which of the other device's destinations (names only; its first is its downloads folder). */
export function RemoteDestinationField({
  target,
  value,
  onChange,
}: {
  target: RemoteTarget;
  value: string | null;
  onChange: (destination: string | null) => void;
}) {
  if (target.destinations.length <= 1)
    return <p className="muted small">Into {target.name}’s downloads folder.</p>;
  return (
    <label className="field">
      <span>Destination on {target.name}</span>
      <select
        className="input"
        style={{ width: 'auto' }}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        {target.destinations.map((d, i) => (
          <option key={d} value={i === 0 ? '' : d}>
            {d}
          </option>
        ))}
      </select>
    </label>
  );
}
