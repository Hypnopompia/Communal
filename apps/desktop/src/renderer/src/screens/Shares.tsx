/**
 * My shares (HANDOFF §11): add and remove folders, choose who can see each folder or file, and
 * follow hashing and thumbnail progress. Access rules are per hub (ADR 0007/0009), so the
 * access editor always works on one hub at a time and says which.
 */
import { useState } from 'react';
import {
  api,
  qs,
  type Audience,
  type Connection,
  type Group,
  type HubStatus,
  type Listing,
  type Share,
} from '../api';
import { baseName, hubName, plural, size } from '../format';
import { effective } from '../access';
import { useHubs, useStatus } from '../hubs';
import { useApi } from '../query';
import { FileIcon, FolderIcon, Icon } from '../ui/icons';
import { Dialog, Empty, ErrorNote, Progress, useAction } from '../ui/kit';
import { SyncedFolderPanel } from './SyncedFolder';

/** The synced folder's share (ADR 0019): shown in its own panel, not as a share. */
const SYNC_SHARE = 'Communal';

type Rules = Record<string, { path: string; audience: Audience }[]>;

export function Shares() {
  const shares = useApi<{ shares: Share[] }>(['index'], '/v1/shares');
  const status = useStatus().data;
  const { hubs } = useHubs();
  const [adding, setAdding] = useState(false);
  const [hub, setHub] = useState<string | null>(null);
  const activeHub = hubs.find((h) => h.id === hub) ?? hubs[0];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>My shares</h1>
          <p className="lede">
            Folders on this computer that you share. New folders are visible only to you until you
            choose who can see them.
          </p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> Share a folder
          </button>
        </div>
      </div>

      {status && <IndexProgress index={status.index} />}
      <ErrorNote error={shares.error} />
      <SyncedFolderPanel />

      {shares.data?.shares.every((s) => s.name === SYNC_SHARE) && (
        <Empty
          title="You’re not sharing anything yet"
          action={
            <button className="btn primary" onClick={() => setAdding(true)}>
              Share a folder
            </button>
          }
        >
          Pick a folder of photos, music or documents. You decide who can see it afterwards.
        </Empty>
      )}

      {shares.data?.shares
        .filter((s) => s.name !== SYNC_SHARE)
        .map((s) => (
          <ShareRowView key={s.name} share={s} hubs={hubs} />
        ))}

      {shares.data && shares.data.shares.length > 0 && activeHub && (
        <section className="section">
          <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <h2>Who can see what</h2>
            {hubs.length > 1 && (
              <div className="segmented" role="group" aria-label="Hub">
                {hubs.map((h) => (
                  <button
                    key={h.id}
                    aria-pressed={h.id === activeHub.id}
                    onClick={() => setHub(h.id)}
                  >
                    {hubName(h.url)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="notice">
            <span>
              These choices apply on <b>{hubName(activeHub.url)}</b> only.
              {hubs.length > 1 && ' A file can be public on one hub and private on another.'}
            </span>
          </div>
          <AccessTree
            hub={activeHub}
            shares={shares.data.shares.filter((s) => s.hubs.includes(activeHub.id))}
          />
        </section>
      )}
      {adding && <AddShare hubs={hubs} onClose={() => setAdding(false)} />}
    </div>
  );
}

function IndexProgress({
  index,
}: {
  index: { files: number; hashed: number; pending: number; analysed: number; bytes: number };
}) {
  if (index.files === 0) return null;
  const hashing = index.hashed < index.files;
  const analysing = !hashing && index.pending > 0;
  if (!hashing && !analysing)
    return (
      <p className="faint">
        {plural(index.files, 'file')} ready to share, {size(index.bytes)} in all.
      </p>
    );
  return (
    <div className="panel panel-pad" style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <strong style={{ flex: 1 }}>{hashing ? 'Preparing your files' : 'Making previews'}</strong>
        <span className="muted">
          {hashing
            ? `${index.hashed.toLocaleString()} of ${index.files.toLocaleString()}`
            : `${index.analysed.toLocaleString()} of ${(index.analysed + index.pending).toLocaleString()}`}
        </span>
      </div>
      <Progress
        value={
          hashing ? index.hashed / index.files : index.analysed / (index.analysed + index.pending)
        }
      />
      <span className="faint small">
        {hashing
          ? 'Each file can be downloaded by others once it’s prepared.'
          : 'Thumbnails and details are added in the background.'}
      </span>
    </div>
  );
}

function ShareRowView({ share, hubs }: { share: Share; hubs: HubStatus[] }) {
  const [confirm, setConfirm] = useState(false);
  const remove = useAction(() => api.del(`/v1/shares/${encodeURIComponent(share.name)}`), {
    topics: ['index'],
    done: `Stopped sharing ${share.name}`,
  });
  const setHubs = useAction(
    (ids: string[]) => api.put(`/v1/shares/${encodeURIComponent(share.name)}/hubs`, { hubs: ids }),
    {
      topics: ['index'],
    },
  );
  return (
    <div className="panel">
      <div className="row">
        <FolderIcon size={34} />
        <div className="grow">
          <div className="title">{share.name}</div>
          <div className="sub">{share.root}</div>
        </div>
        <div className="end">
          <button
            className="btn small quiet"
            onClick={() => void window.communal.openPath(share.root)}
          >
            Open
          </button>
          <button className="btn small danger" onClick={() => setConfirm(true)}>
            Stop sharing
          </button>
        </div>
      </div>
      {hubs.length > 1 && (
        <div className="row" style={{ flexWrap: 'wrap', gap: '6px 18px' }}>
          <span className="muted small">Listed on</span>
          {hubs.map((h) => (
            <label key={h.id} className="check" style={{ alignItems: 'center' }}>
              <input
                type="checkbox"
                style={{ marginTop: 0 }}
                checked={share.hubs.includes(h.id)}
                disabled={setHubs.busy}
                onChange={(e) =>
                  void setHubs.run(
                    e.target.checked ? [...share.hubs, h.id] : share.hubs.filter((x) => x !== h.id),
                  )
                }
              />
              <span>{hubName(h.url)}</span>
            </label>
          ))}
        </div>
      )}
      <ErrorNote error={setHubs.error ?? remove.error} />
      {confirm && (
        <Dialog title={`Stop sharing “${share.name}”?`} onClose={() => setConfirm(false)}>
          <p className="muted">
            People lose access right away. Nothing is deleted from your computer, and you can share
            the folder again later.
          </p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setConfirm(false)}>
              Keep sharing
            </button>
            <button
              className="btn primary"
              onClick={() => void remove.run().then(() => setConfirm(false))}
            >
              Stop sharing
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function AddShare({ hubs, onClose }: { hubs: HubStatus[]; onClose: () => void }) {
  const [path, setPath] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState(hubs.map((h) => h.id));
  const add = useAction(() => api.post('/v1/shares', { name: name.trim(), path, hubs: selected }), {
    topics: ['index'],
    done: `Sharing ${name.trim()}`,
    onDone: onClose,
  });
  const pick = async () => {
    const p = await window.communal.pickFolder('Choose a folder to share');
    if (p) {
      setPath(p);
      if (!name) setName(baseName(p));
    }
  };
  return (
    <Dialog title="Share a folder" onClose={onClose}>
      <div className="field">
        <span>Folder</span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="muted" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {path ?? 'No folder chosen'}
          </span>
          <button className="btn small" onClick={() => void pick()}>
            Choose…
          </button>
        </div>
      </div>
      <label className="field">
        <span>Name others see</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={255}
        />
        <small>Where the folder is on your computer stays private.</small>
      </label>
      {hubs.length > 1 && (
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, marginBottom: 6 }}>List it on</legend>
          {hubs.map((h) => (
            <label key={h.id} className="check">
              <input
                type="checkbox"
                checked={selected.includes(h.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? [...selected, h.id] : selected.filter((x) => x !== h.id),
                  )
                }
              />
              <span>{hubName(h.url)}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="notice">
        <span>
          <Icon name="lock" size={14} /> Only you can see it at first. Choose who else can under
          “Who can see what”.
        </span>
      </div>
      <ErrorNote error={add.error} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!path || !name.trim() || add.busy}
          onClick={() => void add.run()}
        >
          Share
        </button>
      </div>
    </Dialog>
  );
}

// ── access ──

function useAudienceText(hub: HubStatus) {
  const people = useApi<{ connections: Connection[] }>(
    ['people'],
    hub.ready ? `/v1/people${qs({ hub: hub.id })}` : null,
  );
  const groups = useApi<{ groups: Group[] }>(
    ['people'],
    hub.ready ? `/v1/groups${qs({ hub: hub.id })}` : null,
  );
  return (a: Audience) => {
    if (a === 'me') return 'Only me';
    if (a === 'hub') return `Everyone on ${hubName(hub.url)}`;
    const names = [
      ...(a.users ?? []).map(
        (u) => people.data?.connections.find((c) => c.user_id === u)?.display_name ?? 'someone',
      ),
      ...(a.groups ?? []).map(
        (g) => groups.data?.groups.find((x) => x.group_id === g)?.name ?? 'a group',
      ),
    ];
    if (names.length === 0) return 'Only me';
    return names.length <= 3
      ? names.join(', ')
      : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  };
}

function AccessTree({ hub, shares }: { hub: HubStatus; shares: Share[] }) {
  const me = useStatus().data;
  const rules = useApi<{ rules: Rules }>(['index'], `/v1/acl${qs({ hub: hub.id })}`);
  const [path, setPath] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const list = rules.data?.rules[hub.id] ?? [];
  const label = useAudienceText(hub);
  const listing = useApi<Listing>(
    ['index'],
    hub.ready && me && path ? `/v1/browse${qs({ hub: hub.id, device: me.device_id, path })}` : null,
  );
  if (!hub.ready)
    return (
      <div className="notice warn">
        {hubName(hub.url)} isn’t reachable right now, so its access settings can’t be changed.
      </div>
    );
  if (shares.length === 0)
    return <p className="muted">None of your shares is listed on {hubName(hub.url)}.</p>;

  const segs = path.split('/').filter(Boolean);
  const Row = ({
    p,
    name,
    folder,
    icon,
  }: {
    p: string;
    name: string;
    folder: boolean;
    icon?: string;
  }) => {
    const e = effective(list, p);
    const inherited = e.from !== p;
    return (
      <div
        className={`row${folder ? ' clickable' : ''}`}
        onClick={folder ? () => setPath(p) : undefined}
      >
        {folder ? <FolderIcon size={28} /> : <FileIcon icon={icon ?? 'file'} size={28} />}
        <div className="grow">
          <div className="title">{name}</div>
          <div className="sub">
            <AudienceGlyph audience={e.audience} /> {label(e.audience)}
            {inherited && e.from && <span className="faint"> (same as {baseName(e.from)})</span>}
          </div>
        </div>
        <div className="end">
          <button
            className="btn small"
            onClick={(ev) => {
              ev.stopPropagation();
              setEditing(p);
            }}
          >
            Change
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <nav className="crumbs" aria-label="Folder">
        {segs.length === 0 ? (
          <span className="here">All shares</span>
        ) : (
          <button onClick={() => setPath('')}>All shares</button>
        )}
        {segs.map((s, i) => (
          <span key={i} style={{ display: 'contents' }}>
            <span className="faint">›</span>
            {i === segs.length - 1 ? (
              <span className="here">{s}</span>
            ) : (
              <button onClick={() => setPath(segs.slice(0, i + 1).join('/') + '/')}>{s}</button>
            )}
          </span>
        ))}
      </nav>
      <ErrorNote error={rules.error ?? listing.error} />
      <div className="panel rows">
        {path === '' ? (
          shares.map((s) => <Row key={s.name} p={`${s.name}/`} name={s.name} folder />)
        ) : (
          <>
            {listing.data?.dirs.map((d) => (
              <Row key={d.name} p={`${path}${d.name}/`} name={d.name} folder />
            ))}
            {listing.data?.files.map((f) => (
              <Row key={f.path} p={f.path} name={baseName(f.path)} folder={false} icon={f.icon} />
            ))}
            {listing.data && listing.data.dirs.length + listing.data.files.length === 0 && (
              <div className="row muted">This folder is empty.</div>
            )}
          </>
        )}
      </div>
      {editing && (
        <AudienceDialog
          hub={hub}
          path={editing}
          current={list.find((r) => r.path === editing)?.audience ?? null}
          inheritedFrom={effective(list, editing)}
          label={label}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function AudienceGlyph({ audience }: { audience: Audience }) {
  const name = audience === 'me' ? 'lock' : audience === 'hub' ? 'globe' : 'people';
  return <Icon name={name} size={13} style={{ verticalAlign: '-2px' }} />;
}

/** The audience picker (HANDOFF §11): Only me / People and groups / Everyone on the hub. */
function AudienceDialog({
  hub,
  path,
  current,
  inheritedFrom,
  label,
  onClose,
}: {
  hub: HubStatus;
  path: string;
  current: Audience | null;
  inheritedFrom: { audience: Audience; from: string | null };
  label: (a: Audience) => string;
  onClose: () => void;
}) {
  const start = current ?? inheritedFrom.audience;
  type Choice = 'inherit' | 'me' | 'some' | 'hub';
  const parentRule = inheritedFrom.from !== path;
  const [choice, setChoice] = useState<Choice>(
    current === null && parentRule ? 'inherit' : typeof start === 'string' ? start : 'some',
  );
  const [users, setUsers] = useState<string[]>(
    typeof start === 'object' ? (start.users ?? []) : [],
  );
  const [groups, setGroups] = useState<string[]>(
    typeof start === 'object' ? (start.groups ?? []) : [],
  );
  const people = useApi<{ connections: Connection[] }>(
    ['people'],
    `/v1/people${qs({ hub: hub.id })}`,
  );
  const groupList = useApi<{ groups: Group[] }>(['people'], `/v1/groups${qs({ hub: hub.id })}`);
  const connected = people.data?.connections.filter((c) => c.state === 'accepted') ?? [];
  const save = useAction(
    () => {
      const audience =
        choice === 'inherit'
          ? null
          : choice === 'some'
            ? { ...(users.length ? { users } : {}), ...(groups.length ? { groups } : {}) }
            : choice;
      return api.put('/v1/acl', { hub: hub.id, path, audience });
    },
    { topics: ['index'], done: 'Saved', onDone: onClose },
  );
  const folder = path.endsWith('/');
  const toggle = (list: string[], set: (l: string[]) => void, id: string, on: boolean) =>
    set(on ? [...list, id] : list.filter((x) => x !== id));
  const parentName = inheritedFrom.from ? baseName(inheritedFrom.from) : null;
  return (
    <Dialog title={`Who can see “${baseName(path)}”`} onClose={onClose}>
      <p className="muted small">
        On {hubName(hub.url)}.
        {folder && ' Everything inside follows this choice, unless you choose differently for it.'}
      </p>
      <div style={{ display: 'grid', gap: 10 }}>
        {path.split('/').filter(Boolean).length > 1 && (
          <label className="check">
            <input
              type="radio"
              checked={choice === 'inherit'}
              onChange={() => setChoice('inherit')}
            />
            <span>
              <b>Same as the folder it’s in</b>
              <br />
              <span className="muted small">
                {parentName && parentRule
                  ? `${label(inheritedFrom.audience)}, like ${parentName}`
                  : 'Only me'}
              </span>
            </span>
          </label>
        )}
        <label className="check">
          <input type="radio" checked={choice === 'me'} onChange={() => setChoice('me')} />
          <span>
            <b>Only me</b>
            <br />
            <span className="muted small">Your other computers can still see it.</span>
          </span>
        </label>
        <label className="check">
          <input type="radio" checked={choice === 'some'} onChange={() => setChoice('some')} />
          <span>
            <b>Specific people and groups</b>
            <br />
            <span className="muted small">
              Only people you’re connected with. Nobody sees who else can.
            </span>
          </span>
        </label>
        {choice === 'some' && (
          <div className="panel panel-pad" style={{ display: 'grid', gap: 8, marginLeft: 26 }}>
            {connected.length === 0 && (
              <span className="muted small">You aren’t connected with anyone on this hub yet.</span>
            )}
            {connected.map((c) => (
              <label key={c.user_id} className="check">
                <input
                  type="checkbox"
                  checked={users.includes(c.user_id)}
                  onChange={(e) => toggle(users, setUsers, c.user_id, e.target.checked)}
                />
                <span>{c.display_name}</span>
              </label>
            ))}
            {(groupList.data?.groups.length ?? 0) > 0 && (
              <span className="faint small" style={{ marginTop: 4 }}>
                Groups
              </span>
            )}
            {groupList.data?.groups.map((g) => (
              <label key={g.group_id} className="check">
                <input
                  type="checkbox"
                  checked={groups.includes(g.group_id)}
                  onChange={(e) => toggle(groups, setGroups, g.group_id, e.target.checked)}
                />
                <span>
                  {g.name}{' '}
                  <span className="faint small">
                    ({plural(g.members.length, 'person', 'people')})
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
        <label className="check">
          <input type="radio" checked={choice === 'hub'} onChange={() => setChoice('hub')} />
          <span>
            <b>Everyone on {hubName(hub.url)}</b>
            <br />
            <span className="muted small">
              Anyone signed in to this hub can find and download it.
            </span>
          </span>
        </label>
      </div>
      <ErrorNote error={save.error} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={save.busy || (choice === 'some' && users.length + groups.length === 0)}
          onClick={() => void save.run()}
        >
          Save
        </button>
      </div>
    </Dialog>
  );
}
