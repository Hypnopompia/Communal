/**
 * Activity (HANDOFF §11): who downloaded what from this computer. The log never leaves this
 * computer; the hub doesn't have it.
 */
import { useState } from 'react';
import { api, qs, type UploadLogRow } from '../api';
import { ago, size } from '../format';
import { useNames } from '../hubs';
import { useApi } from '../query';
import { Dialog, Empty, ErrorNote, useAction } from '../ui/kit';
import { VerifiedMark } from '../ui/VerifiedMark';

const STATUS: Record<UploadLogRow['status'], string> = {
  completed: 'Downloaded',
  partial: 'Partly downloaded',
  cancelled: 'Stopped',
  denied: 'Refused',
};

export function Activity() {
  const [thumbs, setThumbs] = useState(false);
  const log = useApi<{ log: UploadLogRow[] }>(
    ['transfers'],
    `/v1/uploads/log${qs({ limit: 500 })}`,
    { refetchInterval: 15_000 },
  );
  const names = useNames();
  const [confirm, setConfirm] = useState(false);
  const clear = useAction(() => api.post('/v1/uploads/log/clear'), {
    topics: ['transfers'],
    onDone: () => setConfirm(false),
  });
  const rows = (log.data?.log ?? []).filter((r) => thumbs || r.kind === 'file');
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="lede">
            Who got files from this computer. This list stays on your computer.
          </p>
        </div>
        <div className="actions">
          <label className="check" style={{ alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={thumbs}
              onChange={(e) => setThumbs(e.target.checked)}
              style={{ marginTop: 0 }}
            />
            <span>Include previews</span>
          </label>
          {(log.data?.log.length ?? 0) > 0 && (
            <button className="btn quiet" onClick={() => setConfirm(true)}>
              Clear…
            </button>
          )}
        </div>
      </div>
      <ErrorNote error={log.error} />
      {confirm && (
        <Dialog title="Clear the activity list?" onClose={() => setConfirm(false)}>
          <p className="muted">
            This forgets who got which files from this computer, previews included. It can’t be
            undone. Nothing changes for anyone else: the list only ever lived here.
          </p>
          <ErrorNote error={clear.error} />
          <div className="dialog-actions">
            <button className="btn" onClick={() => setConfirm(false)}>
              Keep it
            </button>
            <button className="btn primary" disabled={clear.busy} onClick={() => void clear.run()}>
              Clear
            </button>
          </div>
        </Dialog>
      )}
      {log.data && rows.length === 0 && (
        <Empty title="Nobody has downloaded anything yet">
          When someone gets a file you share, it’s listed here.
        </Empty>
      )}
      {rows.length > 0 && (
        <div className="panel rows">
          {rows.map((r) => (
            <div key={r.id} className="row">
              <div className="grow">
                <div className="title">{r.path}</div>
                <div className="sub">
                  {names.user(r.requester_user)}
                  <VerifiedMark on={names.verified(r.requester_user)} />
                  {r.kind === 'thumbnail' ? ' looked at a preview' : ''}, {size(r.bytes)}
                </div>
              </div>
              <div className="end">
                <span className={`tag${r.status === 'completed' ? ' online' : ''}`}>
                  {STATUS[r.status]}
                </span>
                <span
                  className="faint small"
                  style={{ minWidth: 90, textAlign: 'right' }}
                  title={new Date(r.at * 1000).toLocaleString()}
                >
                  {ago(r.at)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
