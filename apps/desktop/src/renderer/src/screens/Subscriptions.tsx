/**
 * Subscriptions (HANDOFF §11): followed folders, where they go, mirror-deletes, pause, remove.
 * Grouped by device: this computer, then your other computers, whose subscriptions are listed
 * and changed through remote control (ADR 0023) while it's switched on there.
 */
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api, type RemoteSubscription, type Subscription } from '../api';
import { baseName, hubName, computerName } from '../format';
import { useHubs, useNames } from '../hubs';
import { useNav } from '../nav';
import { useApi } from '../query';
import { FolderIcon, PlatformIcon } from '../ui/icons';
import { Dialog, Empty, ErrorNote, useAction } from '../ui/kit';
import { remote, useRemoteComputers, type RemoteComputer } from '../ui/remote';
import { VerifiedMark } from '../ui/VerifiedMark';

type Patch = { mirror_deletes?: boolean; paused?: boolean };

export function Subscriptions() {
  const { computers } = useRemoteComputers();
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
      {computers.length > 0 && (
        <h2 className="device-head">
          <PlatformIcon platform={window.communal.platform} size={20} />
          This computer
        </h2>
      )}
      <LocalSubscriptions />
      {computers.map((c) => (
        <section key={c.device_id} style={{ display: 'grid', gap: 12 }}>
          <h2 className="device-head">
            <PlatformIcon platform={c.platform} size={20} />
            {c.name}
            {c.state === 'offline' && (
              <span className="tag" style={{ marginLeft: 8 }}>
                Offline
              </span>
            )}
          </h2>
          <RemoteSection computer={c} />
        </section>
      ))}
    </div>
  );
}

function LocalSubscriptions() {
  const list = useApi<{ subscriptions: Subscription[] }>(
    ['subscriptions', 'transfers'],
    '/v1/subscriptions',
  );
  const go = useNav();
  // The synced folder's subscriptions are shown with it, in My shares.
  const subs = list.data?.subscriptions.filter((s) => !s.sync);
  return (
    <>
      <ErrorNote error={list.error} />
      {subs?.length === 0 && (
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
      {subs && subs.length > 0 && (
        <div className="panel rows">
          {subs.map((s) => (
            <LocalSubRow key={s.id} s={s} />
          ))}
        </div>
      )}
    </>
  );
}

function LocalSubRow({ s }: { s: Subscription }) {
  const { hubs } = useHubs();
  const update = useAction((b: Patch) => api.put(`/v1/subscriptions/${s.id}`, b), {
    topics: ['subscriptions'],
  });
  const remove = useAction(() => api.del(`/v1/subscriptions/${s.id}`), {
    topics: ['subscriptions'],
    done: `Stopped following ${baseName(s.path)}`,
  });
  return (
    <SubRow
      s={s}
      hub={hubs.find((h) => h.id === s.hub)}
      savedIn={
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
      }
      where="your computer"
      update={update}
      remove={remove}
    />
  );
}

/** Another computer's subscriptions, or why they can't be shown. */
function RemoteSection({ computer: c }: { computer: RemoteComputer }) {
  const q = useQuery({
    queryKey: ['remote-subscriptions', c.device_id],
    queryFn: () =>
      remote<{ subscriptions: RemoteSubscription[] }>(c.device_id, { op: 'subscriptions' }).then(
        (r) => r.subscriptions,
      ),
    enabled: c.state === 'ready',
    refetchInterval: 15_000,
    retry: false,
  });
  if (c.state === 'offline')
    return (
      <p className="muted">
        {c.name} is offline. Its subscriptions show here when it’s back, and it catches up on what
        changed meanwhile.
      </p>
    );
  if (c.state === 'off')
    return (
      <p className="muted">
        Remote control is off on {c.name}, so its subscriptions can’t be shown or changed from here.
        Turn on “Let my other devices start downloads on this computer” in its Settings › Downloads,
        or run <code>communal remote allow</code> on it.
      </p>
    );
  if (c.state === 'unreachable')
    return <p className="muted">{c.name} is online but didn’t answer. Try again in a moment.</p>;
  if (q.error) return <div className="notice warn">{q.error.message}</div>;
  if (!q.data) return <div className="muted">Asking {c.name}…</div>;
  if (q.data.length === 0) return <p className="muted">{c.name} isn’t following any folders.</p>;
  return (
    <div className="panel rows">
      {q.data.map((s) => (
        <RemoteSubRow key={s.id} s={s} computer={c} refetch={() => void q.refetch()} />
      ))}
    </div>
  );
}

function RemoteSubRow({
  s,
  computer,
  refetch,
}: {
  s: RemoteSubscription;
  computer: RemoteComputer;
  refetch: () => void;
}) {
  const { hubs } = useHubs();
  const update = useAction(
    (b: Patch) => remote(computer.device_id, { op: 'update_subscription', id: s.id, ...b }),
    { onDone: refetch },
  );
  const remove = useAction(() => remote(computer.device_id, { op: 'unsubscribe', id: s.id }), {
    onDone: refetch,
    done: `${computer.name} stopped following ${baseName(s.path)}`,
  });
  return (
    <SubRow
      s={s}
      hub={hubs.find((h) => h.url === s.hub) ?? { url: s.hub }}
      savedIn={<span>{s.destination ? `${s.destination} › ${s.folder}` : s.folder}</span>}
      where={computer.name}
      update={update}
      remove={remove}
    />
  );
}

/** One followed folder, on this computer or another (`where`, for the remove dialog). */
function SubRow({
  s,
  hub,
  savedIn,
  where,
  update,
  remove,
}: {
  s: Subscription | RemoteSubscription;
  hub: Parameters<typeof hubName>[0] | undefined;
  savedIn: ReactNode;
  where: string;
  update: { run: (b: Patch) => Promise<unknown>; busy: boolean; error: Error | null };
  remove: { run: () => Promise<unknown>; busy: boolean; error: Error | null };
}) {
  const names = useNames();
  const { hubs } = useHubs();
  const [removing, setRemoving] = useState(false);
  const d = names.device(s.device_id);
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <FolderIcon size={32} />
      <div className="grow" style={{ display: 'grid', gap: 6 }}>
        <div className="title" title={s.path}>
          {baseName(s.path)}
        </div>
        <div className="sub">
          From {d && <PlatformIcon platform={d.platform} size={13} />}
          {d && ' '}
          {d ? computerName(d.user, d.name) : 'another computer'}
          <VerifiedMark on={d && names.verified(d.user_id)} />
          {hubs.length > 1 && hub ? ` on ${hubName(hub)}` : ''}. Saved in {savedIn}
        </div>
        {s.status === 'no_access' && (
          <div className="notice warn">
            This folder isn’t shared any more, or it was removed. The copies already downloaded stay
            where they are.
          </div>
        )}
        <label className="check small">
          <input
            type="checkbox"
            checked={s.mirror_deletes}
            disabled={update.busy}
            onChange={(e) => void update.run({ mirror_deletes: e.target.checked })}
          />
          <span>When the owner deletes a file, move the copy to the trash</span>
        </label>
        <ErrorNote error={update.error ?? remove.error} />
      </div>
      <div className="end">
        {s.paused && <span className="tag">Paused</span>}
        <button
          className="btn small quiet"
          disabled={update.busy}
          onClick={() => void update.run({ paused: !s.paused })}
        >
          {s.paused ? 'Resume' : 'Pause'}
        </button>
        <button className="btn small quiet" onClick={() => setRemoving(true)}>
          Unsubscribe
        </button>
      </div>
      {removing && (
        <Dialog title={`Stop following “${baseName(s.path)}”?`} onClose={() => setRemoving(false)}>
          <p className="muted">
            New files stop arriving. The files already downloaded stay on {where}.
          </p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setRemoving(false)}>
              Keep following
            </button>
            <button
              className="btn primary"
              disabled={remove.busy}
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
