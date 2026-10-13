/** Subscriptions (HANDOFF §11): followed folders, where they go, mirror-deletes, pause, remove. */
import { useState } from 'react';
import { api, type Subscription } from '../api';
import { baseName, hubName, computerName } from '../format';
import { useHubs, useNames } from '../hubs';
import { useNav } from '../nav';
import { useApi } from '../query';
import { FolderIcon } from '../ui/icons';
import { Dialog, Empty, ErrorNote, useAction } from '../ui/kit';

export function Subscriptions() {
  const list = useApi<{ subscriptions: Subscription[] }>(
    ['subscriptions', 'transfers'],
    '/v1/subscriptions',
  );
  const go = useNav();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Subscriptions</h1>
          <p className="lede">
            Folders you follow. New files in them download automatically, even after you’ve been
            away.
          </p>
        </div>
      </div>
      <ErrorNote error={list.error} />
      {list.data?.subscriptions.length === 0 && (
        <Empty
          title="You’re not following any folders"
          action={
            <button className="btn" onClick={() => go({ screen: 'library' })}>
              Open the Library
            </button>
          }
        >
          Open a folder someone shared with you and choose “Subscribe to this folder”.
        </Empty>
      )}
      {(list.data?.subscriptions.length ?? 0) > 0 && (
        <div className="panel rows">
          {list.data!.subscriptions.map((s) => (
            <SubRow key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function SubRow({ s }: { s: Subscription }) {
  const names = useNames();
  const { hubs } = useHubs();
  const [removing, setRemoving] = useState(false);
  const update = useAction(
    (b: { mirror_deletes?: boolean; paused?: boolean }) => api.put(`/v1/subscriptions/${s.id}`, b),
    {
      topics: ['subscriptions'],
    },
  );
  const remove = useAction(() => api.del(`/v1/subscriptions/${s.id}`), {
    topics: ['subscriptions'],
    done: `Stopped following ${baseName(s.path)}`,
  });
  const d = names.device(s.device_id);
  const hub = hubs.find((h) => h.id === s.hub);
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <FolderIcon size={32} />
      <div className="grow" style={{ display: 'grid', gap: 6 }}>
        <div className="title">{baseName(s.path)}</div>
        <div className="sub">
          From {d ? computerName(d.user, d.name) : 'another computer'}
          {hubs.length > 1 && hub ? ` on ${hubName(hub.url)}` : ''}. Saved in{' '}
          <a
            href="#"
            title={s.dest_dir}
            onClick={(e) => {
              e.preventDefault();
              void window.communal.openPath(s.dest_dir);
            }}
          >
            {baseName(s.dest_dir)}
          </a>
        </div>
        {s.status === 'no_access' && (
          <div className="notice warn">
            This folder isn’t shared with you any more, or it was removed. Your copies stay where
            they are.
          </div>
        )}
        <label className="check small">
          <input
            type="checkbox"
            checked={s.mirror_deletes}
            onChange={(e) => void update.run({ mirror_deletes: e.target.checked })}
          />
          <span>When the owner deletes a file, move my copy to the trash</span>
        </label>
        <ErrorNote error={update.error ?? remove.error} />
      </div>
      <div className="end">
        {s.paused && <span className="tag">Paused</span>}
        <button className="btn small quiet" onClick={() => void update.run({ paused: !s.paused })}>
          {s.paused ? 'Resume' : 'Pause'}
        </button>
        <button className="btn small quiet" onClick={() => setRemoving(true)}>
          Unsubscribe
        </button>
      </div>
      {removing && (
        <Dialog title={`Stop following “${baseName(s.path)}”?`} onClose={() => setRemoving(false)}>
          <p className="muted">
            New files stop arriving. The files you already have stay on your computer.
          </p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setRemoving(false)}>
              Keep following
            </button>
            <button
              className="btn primary"
              onClick={() => void remove.run().then(() => setRemoving(false))}
            >
              Unsubscribe
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
