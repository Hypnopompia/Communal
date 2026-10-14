/**
 * Transfers (HANDOFF §11): the queue with progress and per-source speeds, and failures with
 * the hub's diagnosis, tips and who can fix it (ADR 0011).
 */
import { useState } from 'react';
import { api, type Transfer } from '../api';
import { ago, rate, size, computerName } from '../format';
import { useNames } from '../hubs';
import { useApi } from '../query';
import { FileIcon, iconForName } from '../ui/icons';
import { Empty, ErrorNote, Progress, useAction } from '../ui/kit';
import { VerifiedMark } from '../ui/VerifiedMark';
import { RemoteTransfers, useRemoteTargets } from '../ui/remote';

const ACTIVE: Transfer['state'][] = ['active', 'queued', 'waiting'];

export function Transfers() {
  const targets = useRemoteTargets();
  const [on, setOn] = useState<string | null>(null);
  const device = targets.find((t) => t.device_id === on);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Transfers</h1>
          <p className="lede">Downloads come straight from the computers that have the file.</p>
        </div>
      </div>
      {targets.length > 0 && (
        <div
          className="segmented"
          role="tablist"
          aria-label="Whose transfers"
          style={{ justifySelf: 'start' }}
        >
          {[{ device_id: null, name: 'This computer' }, ...targets].map((t) => (
            <button
              key={t.device_id ?? 'here'}
              role="tab"
              aria-pressed={(device?.device_id ?? null) === t.device_id}
              aria-selected={(device?.device_id ?? null) === t.device_id}
              onClick={() => setOn(t.device_id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}
      {device ? <RemoteTransfers device={device} /> : <LocalTransfers />}
    </div>
  );
}

function LocalTransfers() {
  const list = useApi<{ downloads: Transfer[] }>(['transfers'], '/v1/downloads', {
    // Speeds change between progress hints, so refresh while something runs.
    refetchInterval: (q) =>
      q.state.data?.downloads.some((d) => d.state === 'active') ? 1_000 : 10_000,
  });
  const cancel = useAction((id: string) => api.del(`/v1/downloads/${id}`), {
    topics: ['transfers'],
  });
  // Only the list: downloaded files stay where they are.
  const clear = useAction(() => api.post('/v1/downloads/clear'), { topics: ['transfers'] });
  const all = list.data?.downloads ?? [];
  const running = all.filter((d) => ACTIVE.includes(d.state));
  const finished = all
    .filter((d) => !ACTIVE.includes(d.state))
    .sort((a, b) => b.updated_at - a.updated_at);
  return (
    <>
      <ErrorNote error={list.error ?? cancel.error ?? clear.error} />
      {list.data && all.length === 0 && (
        <Empty title="No downloads yet">
          Find something in Search or the Library and choose Download.
        </Empty>
      )}
      {running.length > 0 && (
        <div className="panel rows">
          {running.map((t) => (
            <TransferRow key={t.id} t={t} onCancel={() => void cancel.run(t.id)} />
          ))}
        </div>
      )}
      {finished.length > 0 && (
        <section className="section">
          <div className="section-head" style={{ alignItems: 'center' }}>
            <h2 style={{ flex: 1 }}>Finished</h2>
            <button
              className="btn small quiet"
              disabled={clear.busy}
              title="Removes finished downloads from this list. The files stay where they are."
              onClick={() => void clear.run()}
            >
              Clear
            </button>
          </div>
          <div className="panel rows">
            {finished.slice(0, 100).map((t) => (
              <TransferRow key={t.id} t={t} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function TransferRow({ t, onCancel }: { t: Transfer; onCancel?: () => void }) {
  const names = useNames();
  const total = t.size ?? 0;
  const speed = t.sources.reduce((n, s) => n + s.rate, 0);
  const sub = (() => {
    switch (t.state) {
      case 'queued':
        return t.error
          ? 'Waiting its turn: the computer that has it is sending other files.'
          : 'Starting…';
      case 'active':
        return total
          ? `${size(t.bytes_done)} of ${size(total)}${speed ? `, ${rate(speed)}` : ''}`
          : 'Getting the file’s details…';
      case 'waiting':
        return t.diagnosis?.message ?? 'Waiting for a computer that has it to come online.';
      case 'done':
        return `Downloaded ${ago(t.updated_at)}, ${size(total)}`;
      case 'failed':
        return t.diagnosis?.message ?? t.error ?? 'Failed';
      case 'cancelled':
        return 'Cancelled';
    }
  })();
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <FileIcon icon={iconForName(t.name)} size={32} />
      <div className="grow" style={{ display: 'grid', gap: 6 }}>
        <div className="title">{t.name}</div>
        <div className="sub" style={{ whiteSpace: 'normal' }}>
          {sub}
          {t.requested_by && ` · Started from ${t.requested_by}`}
        </div>
        {t.state === 'active' && total > 0 && <Progress value={t.bytes_done / total} />}
        {t.state === 'active' && t.sources.length > 0 && (
          <div
            className="small muted"
            style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 16px' }}
          >
            {t.sources.map((s) => {
              const d = names.device(s.device_id);
              return (
                <span key={s.device_id}>
                  {d ? computerName(d.user, d.name) : 'A computer'}
                  <VerifiedMark on={d && names.verified(d.user_id)} />: {rate(s.rate)}
                </span>
              );
            })}
          </div>
        )}
        {(t.state === 'waiting' || t.state === 'failed') &&
          t.diagnosis &&
          t.diagnosis.tips.length > 0 && (
            <div className="notice warn">
              {t.diagnosis.fix && <strong>{t.diagnosis.fix}</strong>}
              <ul>
                {t.diagnosis.tips.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
            </div>
          )}
      </div>
      <div className="end">
        {t.state === 'done' && t.final_path && (
          <>
            <button
              className="btn small quiet"
              onClick={() => void window.communal.showInFolder(t.final_path!)}
            >
              Show in folder
            </button>
            <button
              className="btn small"
              onClick={() => void window.communal.openPath(t.final_path!)}
            >
              Open
            </button>
          </>
        )}
        {onCancel && (
          <button className="btn small quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
