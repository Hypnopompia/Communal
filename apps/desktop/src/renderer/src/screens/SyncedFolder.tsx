/**
 * The synced folder (ADR 0019): one folder kept the same on all your computers. It's turned on
 * per computer; each one then follows the others' folders both ways.
 */
import { useState } from 'react';
import { api, type SyncFolderState } from '../api';
import { plural } from '../format';
import { useNames } from '../hubs';
import { useApi } from '../query';
import { FolderIcon, PlatformIcon } from '../ui/icons';
import { Dialog, ErrorNote, useAction } from '../ui/kit';

export function SyncedFolderPanel() {
  const st = useApi<SyncFolderState>(['index', 'subscriptions', 'devices'], '/v1/sync');
  const [turningOn, setTurningOn] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  if (!st.data) return <ErrorNote error={st.error} />;
  const s = st.data;
  return (
    <section className="panel">
      <div className="row">
        <FolderIcon size={34} />
        <div className="grow">
          <div className="title">Synced folder</div>
          <div className="sub">
            {s.enabled
              ? s.path
              : 'One folder that’s the same on all your computers. Only you can see it.'}
          </div>
        </div>
        <div className="end">
          {s.enabled ? (
            <>
              <button
                className="btn small quiet"
                onClick={() => void window.communal.openPath(s.path!)}
              >
                Open
              </button>
              <button className="btn small" onClick={() => setTurningOff(true)}>
                Turn off
              </button>
            </>
          ) : (
            <button className="btn small primary" onClick={() => setTurningOn(true)}>
              Turn on…
            </button>
          )}
        </div>
      </div>
      {s.enabled && <Peers state={s} />}
      {turningOn && (
        <TurnOn state={s} onClose={() => setTurningOn(false)} onDone={() => void st.refetch()} />
      )}
      {turningOff && (
        <TurnOff onClose={() => setTurningOff(false)} onDone={() => void st.refetch()} />
      )}
    </section>
  );
}

/** Which of your other computers this one is in step with. */
function Peers({ state }: { state: SyncFolderState }) {
  const names = useNames();
  if (state.devices.length === 0)
    return (
      <div className="row">
        <span className="muted small">
          Turn it on on your other computers too (in My shares). They find each other by themselves.
        </span>
      </div>
    );
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: '6px 18px' }}>
      <span className="muted small">In step with</span>
      {state.devices.map((d) => {
        const name = d.name ?? names.device(d.device_id)?.name ?? 'another computer';
        const note =
          d.status === 'no_access'
            ? 'can’t be reached through the hub'
            : d.status === 'paused'
              ? 'paused'
              : d.files.pending > 0
                ? `${plural(d.files.pending, 'file')} on the way`
                : d.files.failed > 0
                  ? `${plural(d.files.failed, 'file')} couldn’t be copied`
                  : null;
        return (
          <span key={d.device_id} className="small">
            <PlatformIcon platform={names.device(d.device_id)?.platform} size={13} /> <b>{name}</b>
            {note && <span className="muted"> ({note})</span>}
          </span>
        );
      })}
    </div>
  );
}

function TurnOn({
  state,
  onClose,
  onDone,
}: {
  state: SyncFolderState;
  onClose: () => void;
  onDone: () => void;
}) {
  const [path, setPath] = useState(state.default_path);
  const on = useAction((p: string) => api.put<SyncFolderState>('/v1/sync', { path: p }), {
    topics: ['index', 'subscriptions'],
    done: 'Synced folder turned on',
    onDone: () => {
      onDone();
      onClose();
    },
  });
  const pick = async () => {
    const d = await window.communal.pickFolder('Choose the folder to keep in sync', path);
    if (d) setPath(d);
  };
  return (
    <Dialog title="Turn on the synced folder" onClose={onClose}>
      <p className="muted">
        Whatever you put in this folder appears on your other computers that have the synced folder
        turned on, and changes and deletions follow everywhere. Deleted files go to the trash.
      </p>
      <div className="field">
        <span>Folder on this computer</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            className="muted"
            style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={path}
          >
            {path}
          </span>
          <button className="btn small" onClick={() => void pick()}>
            Change…
          </button>
        </div>
        <small>It’s created if it doesn’t exist. Files already in it are synced too.</small>
      </div>
      <div className="notice">
        <span>
          Only you can see it. Computers sync while both are on, directly with each other: nothing
          is stored on the hub.
        </span>
      </div>
      <ErrorNote error={on.error} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={on.busy} onClick={() => void on.run(path)}>
          Turn on
        </button>
      </div>
    </Dialog>
  );
}

function TurnOff({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const off = useAction(() => api.del<SyncFolderState>('/v1/sync'), {
    topics: ['index', 'subscriptions'],
    done: 'Synced folder turned off',
    onDone: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Dialog title="Turn off the synced folder?" onClose={onClose}>
      <p className="muted">
        This computer stops sending its changes to your other computers and stops getting theirs.
        Nothing is deleted here or on them, and you can turn it on again later.
      </p>
      <ErrorNote error={off.error} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Keep it on
        </button>
        <button className="btn primary" disabled={off.busy} onClick={() => void off.run()}>
          Turn off
        </button>
      </div>
    </Dialog>
  );
}
