/**
 * Managing a hub this account administers (ADR 0020): its people and their computers, the
 * connections between them, the log of admin actions, and the hub's settings. Reached from
 * Settings › Hubs. Everything goes through `/v1/hubs/:id/admin/...`, and the hub checks again.
 */
import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  api,
  type AdminGraph,
  type AdminLogEntry,
  type AdminSettings,
  type HubLimitKey,
  type AdminUser,
} from '../api';
import { ago, date, hubName, plural, size } from '../format';
import { useHubs, useStatus } from '../hubs';
import { useNav, type ManageTab } from '../nav';
import { useApi } from '../query';
import { Icon } from '../ui/icons';
import { Dialog, Empty, ErrorNote, useAction } from '../ui/kit';
import { VerifiedMark } from '../ui/VerifiedMark';
import { layoutGraph } from '../graph-layout';

const TABS: { tab: ManageTab; label: string }[] = [
  { tab: 'people', label: 'People' },
  { tab: 'connections', label: 'Connections' },
  { tab: 'log', label: 'Admin log' },
  { tab: 'settings', label: 'Settings' },
];

const adminPath = (hub: string, path: string) => `/v1/hubs/${encodeURIComponent(hub)}/admin${path}`;

/** Everyone on the hub, shared by every tab (names in the log, the graph's labels). */
export function useAdminUsers(hub: string | null) {
  return useApi<{ users: AdminUser[] }>(
    ['admin', 'hubs', 'presence'],
    hub ? adminPath(hub, '/users') : null,
  );
}

export function ManageHub({ hub, tab }: { hub: string; tab: ManageTab }) {
  const go = useNav();
  const { hubs } = useHubs();
  const h = hubs.find((x) => x.id === hub);
  const users = useAdminUsers(h?.admin && h.ready ? hub : null);
  const waiting = users.data?.users.filter((u) => u.status === 'pending' && !u.banned_at).length;
  const back = (
    <button className="btn quiet" onClick={() => go({ screen: 'settings', tab: 'hubs' })}>
      <Icon name="back" size={16} /> Hubs
    </button>
  );
  if (!h || !h.admin)
    return (
      <div className="page">
        <div className="page-head">{back}</div>
        <Empty title="You don’t manage this hub">
          Only a hub’s admins can manage it. Its owner can make you one with{' '}
          <code>communal-hub admin add</code> on the server.
        </Empty>
      </div>
    );
  return (
    <div className="page">
      <div className="page-head" style={{ display: 'grid', gap: 6, justifyItems: 'start' }}>
        {back}
        <h1>Manage {hubName(h)}</h1>
        <p className="muted" style={{ margin: 0, maxWidth: '64ch' }}>
          You’re an admin of this hub. What you do here applies to this hub only, and the hub keeps
          a record of it in the admin log.
        </p>
      </div>
      {!h.ready && (
        <div className="notice warn">
          Not connected to {hubName(h)} right now. This page fills in once it reconnects.
        </div>
      )}
      <div
        className="segmented"
        role="tablist"
        aria-label="Manage hub"
        style={{ justifySelf: 'start' }}
      >
        {TABS.map((t) => (
          <button
            key={t.tab}
            role="tab"
            aria-pressed={t.tab === tab}
            aria-selected={t.tab === tab}
            onClick={() => go({ screen: 'manage', hub, tab: t.tab })}
          >
            {t.label}
            {t.tab === 'people' && waiting ? ` (${waiting} waiting)` : ''}
          </button>
        ))}
      </div>
      {h.ready && tab === 'people' && <PeopleTab hub={hub} />}
      {h.ready && tab === 'connections' && <ConnectionsTab hub={hub} />}
      {h.ready && tab === 'log' && <LogTab hub={hub} />}
      {h.ready && tab === 'settings' && <SettingsTab hub={hub} />}
    </div>
  );
}

// ── people ──

type Filter = 'all' | 'waiting' | 'banned';

function PeopleTab({ hub }: { hub: string }) {
  const users = useAdminUsers(hub);
  const me = useStatus().data?.account.user_id;
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [banning, setBanning] = useState<AdminUser | null>(null);
  const act = useAction(
    (user: string, action: 'approve' | 'unban') =>
      api.post(adminPath(hub, `/users/${encodeURIComponent(user)}/${action}`), {}),
    { topics: ['admin'], done: (_r) => 'Done' },
  );
  const all = users.data?.users ?? [];
  const waiting = all.filter((u) => u.status === 'pending' && !u.banned_at);
  const banned = all.filter((u) => u.banned_at);
  const needle = q.trim().toLowerCase();
  const shown = (filter === 'waiting' ? waiting : filter === 'banned' ? banned : all).filter(
    (u) => !needle || u.display_name.toLowerCase().includes(needle) || u.user_id.includes(needle),
  );
  return (
    <section className="section">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="segmented" role="group" aria-label="Show">
          <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            Everyone ({all.length})
          </button>
          <button aria-pressed={filter === 'waiting'} onClick={() => setFilter('waiting')}>
            Waiting ({waiting.length})
          </button>
          <button aria-pressed={filter === 'banned'} onClick={() => setFilter('banned')}>
            Banned ({banned.length})
          </button>
        </div>
        <div className="search-box" style={{ maxWidth: 320 }}>
          <Icon name="search" />
          <input
            className="input"
            type="search"
            placeholder="Name"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Find people on this hub"
          />
        </div>
      </div>
      <ErrorNote error={users.error ?? act.error} />
      {users.data && shown.length === 0 ? (
        <p className="muted">
          {filter === 'waiting'
            ? 'Nobody is waiting to join.'
            : filter === 'banned'
              ? 'Nobody is banned.'
              : 'Nobody matches.'}
        </p>
      ) : (
        <div className="panel rows">
          {shown.map((u) => (
            <PersonRow
              key={u.user_id}
              u={u}
              me={u.user_id === me}
              open={open === u.user_id}
              toggle={() => setOpen(open === u.user_id ? null : u.user_id)}
              busy={act.busy}
              onApprove={() => void act.run(u.user_id, 'approve')}
              onUnban={() => void act.run(u.user_id, 'unban')}
              onBan={() => setBanning(u)}
            />
          ))}
        </div>
      )}
      {banning && <BanDialog hub={hub} u={banning} onClose={() => setBanning(null)} />}
    </section>
  );
}

function lastSeen(u: AdminUser): { online: boolean; seen: number } {
  const live = u.devices.filter((d) => !d.revoked_at);
  return {
    online: live.some((d) => d.online),
    seen: Math.max(0, ...live.map((d) => d.last_seen ?? 0)),
  };
}

function PersonRow({
  u,
  me,
  open,
  toggle,
  busy,
  onApprove,
  onUnban,
  onBan,
}: {
  u: AdminUser;
  me: boolean;
  open: boolean;
  toggle: () => void;
  busy: boolean;
  onApprove: () => void;
  onUnban: () => void;
  onBan: () => void;
}) {
  const { online, seen } = lastSeen(u);
  const live = u.devices.filter((d) => !d.revoked_at);
  const files = live.reduce((n, d) => n + d.files, 0);
  const bytes = live.reduce((n, d) => n + d.bytes, 0);
  return (
    <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <Icon name="user" size={22} />
      <div className="grow" style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        <div className="title">
          {u.display_name}
          <VerifiedMark on={u.verified} />
          {me && (
            <span className="tag accent" style={{ marginLeft: 8 }}>
              You
            </span>
          )}
          {u.admin && (
            <span className="tag" style={{ marginLeft: 8 }}>
              Admin
            </span>
          )}
        </div>
        <div className="sub">
          {u.status === 'pending' && !u.banned_at
            ? `Asked to join ${ago(u.created_at)}`
            : `Joined ${date(u.created_at)}`}{' '}
          · {plural(live.length, 'computer')}
          {files > 0 ? ` · sharing ${plural(files, 'file')}, ${size(bytes)}` : ''}
        </div>
        {u.banned_at && (
          <div className="small" style={{ color: 'var(--danger)' }}>
            Banned {ago(u.banned_at)}
            {u.ban_reason ? `: ${u.ban_reason}` : ''}
          </div>
        )}
        <div>
          <button className="btn small quiet" onClick={toggle} aria-expanded={open}>
            {open ? 'Hide details' : 'Details'}
          </button>
        </div>
        {open && <PersonDetails u={u} />}
      </div>
      <div className="end">
        {u.banned_at ? (
          <span className="status bad">Banned</span>
        ) : u.status === 'pending' ? (
          <span className="status warn">Waiting to join</span>
        ) : (
          <span className={`status${online ? ' on' : ''}`}>
            {online ? 'Online' : seen ? `Seen ${ago(seen)}` : 'Never signed in'}
          </span>
        )}
        {u.status === 'pending' && !u.banned_at && (
          <button className="btn small primary" disabled={busy} onClick={onApprove}>
            Let in
          </button>
        )}
        {u.banned_at ? (
          <button className="btn small" disabled={busy} onClick={onUnban}>
            Unban
          </button>
        ) : (
          !me &&
          !u.admin && (
            <button className="btn small quiet" onClick={onBan}>
              Ban…
            </button>
          )
        )}
      </div>
    </div>
  );
}

const NAT_TEXT: Record<string, string> = {
  none: 'no NAT (a public address)',
  endpoint_independent: 'a friendly NAT',
  symmetric: 'a strict (symmetric) NAT',
  blocked: 'UDP blocked',
  unknown: 'unknown',
};

function PersonDetails({ u }: { u: AdminUser }) {
  return (
    <div className="panel panel-pad" style={{ display: 'grid', gap: 10, marginTop: 4 }}>
      <dl className="kv small">
        <dt>Fingerprint</dt>
        <dd className="mono">{u.fingerprint}</dd>
        <dt>Account ID</dt>
        <dd className="mono">{u.user_id}</dd>
      </dl>
      <div className="rows">
        {u.devices.map((d) => (
          <div key={d.device_id} className="row" style={{ padding: '8px 0' }}>
            <Icon name="device" size={18} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="title">{d.name}</div>
              <div className="sub">
                {d.platform === 'darwin' ? 'Mac' : d.platform === 'win32' ? 'Windows' : 'Linux'}
                {' · '}
                {d.files > 0 ? `${plural(d.files, 'file')}, ${size(d.bytes)}` : 'shares nothing'}
                {d.nat
                  ? ` · network: ${NAT_TEXT[d.nat.nat] ?? d.nat.nat}${d.nat.upnp ? ', port mapped' : ''}${d.nat.cgnat ? ', carrier NAT' : ''}`
                  : ''}
              </div>
            </div>
            <div className="end">
              {d.revoked_at ? (
                <span className="status bad">Removed</span>
              ) : (
                <span className={`status${d.online ? ' on' : ''}`}>
                  {d.online ? 'Online' : d.last_seen ? `Seen ${ago(d.last_seen)}` : 'Never'}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="faint small" style={{ margin: 0 }}>
        Admins see how much each computer shares, never what. File names, groups and who can see
        what stay private.
      </p>
    </div>
  );
}

function BanDialog({ hub, u, onClose }: { hub: string; u: AdminUser; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const ban = useAction(
    () =>
      api.post(adminPath(hub, `/users/${encodeURIComponent(u.user_id)}/ban`), {
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    { topics: ['admin'], done: `${u.display_name} is banned`, onDone: onClose },
  );
  return (
    <Dialog title={`Ban ${u.display_name}?`} onClose={onClose}>
      <p className="muted">
        Their computers are signed out of this hub at once and can’t come back. Their files
        disappear from search and browsing here. You can unban them later.
      </p>
      <label className="field">
        <span>Reason (optional)</span>
        <input
          className="input"
          value={reason}
          maxLength={200}
          onChange={(e) => setReason(e.target.value)}
        />
        <small>Kept in the hub’s activity log for admins. It isn’t sent to them.</small>
      </label>
      <ErrorNote error={ban.error} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={ban.busy} onClick={() => void ban.run()}>
          Ban
        </button>
      </div>
    </Dialog>
  );
}

// ── connections ──

function ConnectionsTab({ hub }: { hub: string }) {
  const graph = useApi<AdminGraph>(['admin', 'people'], adminPath(hub, '/graph'));
  const [picked, setPicked] = useState<string | null>(null);
  const [showPending, setShowPending] = useState(true);
  const W = 760;
  const H = 460;
  const data = graph.data;
  const edges = useMemo(
    () => (data?.connections ?? []).filter((c) => showPending || c.state === 'accepted'),
    [data, showPending],
  );
  const placed = useMemo(
    () =>
      data
        ? layoutGraph(
            data.people.map((p) => p.user_id),
            data.connections.map((c) => [c.a, c.b]),
            { w: W, h: H, margin: 40 },
          )
        : [],
    [data],
  );
  if (!data) return <ErrorNote error={graph.error} />;
  const at = new Map(placed.map((p) => [p.id, p]));
  const person = new Map(data.people.map((p) => [p.user_id, p]));
  const degree = new Map<string, number>();
  for (const c of data.connections)
    if (c.state === 'accepted')
      for (const id of [c.a, c.b]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const accepted = data.connections.filter((c) => c.state === 'accepted').length;
  const alone = data.people.filter((p) => !degree.get(p.user_id) && !p.banned).length;
  const near = (id: string) =>
    picked === null ||
    id === picked ||
    edges.some((c) => (c.a === picked && c.b === id) || (c.b === picked && c.a === id));
  const ranked = data.people
    .filter((p) => degree.get(p.user_id))
    .sort(
      (a, b) =>
        (degree.get(b.user_id) ?? 0) - (degree.get(a.user_id) ?? 0) ||
        a.display_name.localeCompare(b.display_name),
    );
  return (
    <section className="section">
      <p className="muted" style={{ margin: 0, maxWidth: '64ch' }}>
        {plural(data.people.length, 'person', 'people')} and {plural(accepted, 'connection')}
        {alone ? `; ${alone} with nobody yet` : ''}. Groups, and who can see which files, aren’t
        shown: they stay private to each person.
      </p>
      <label className="check small">
        <input
          type="checkbox"
          checked={showPending}
          onChange={(e) => setShowPending(e.target.checked)}
        />
        <span>Show requests that haven’t been accepted (dashed)</span>
      </label>
      {data.people.length === 0 ? (
        <p className="muted">Nobody here yet.</p>
      ) : (
        <div className="panel" style={{ overflow: 'hidden' }}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Connections between ${data.people.length} people on this hub`}
            style={{ width: '100%', height: 'auto', display: 'block' }}
            onClick={() => setPicked(null)}
          >
            {edges.map((c) => {
              const a = at.get(c.a);
              const b = at.get(c.b);
              if (!a || !b) return null;
              const lit = picked === null || c.a === picked || c.b === picked;
              return (
                <line
                  key={`${c.a}-${c.b}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={lit && picked ? 'var(--accent)' : 'var(--ink-3)'}
                  strokeOpacity={lit ? 0.75 : 0.15}
                  strokeWidth={lit && picked ? 2 : 1.25}
                  strokeDasharray={c.state === 'pending' ? '4 4' : undefined}
                />
              );
            })}
            {placed.map((p) => {
              const who = person.get(p.id)!;
              const lit = near(p.id);
              const fill = who.banned
                ? 'var(--danger)'
                : who.status === 'pending'
                  ? 'var(--warn)'
                  : who.admin
                    ? 'var(--accent)'
                    : 'var(--ink-2)';
              return (
                <g
                  key={p.id}
                  opacity={lit ? 1 : 0.25}
                  style={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPicked(picked === p.id ? null : p.id);
                  }}
                >
                  <title>
                    {who.display_name}: {plural(degree.get(p.id) ?? 0, 'connection')}
                  </title>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={picked === p.id ? 9 : 7}
                    fill={fill}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                  <text
                    x={p.x}
                    y={p.y - 13}
                    textAnchor="middle"
                    fontSize={12}
                    fill="var(--ink)"
                    style={{ paintOrder: 'stroke', stroke: 'var(--surface)', strokeWidth: 3 }}
                  >
                    {who.display_name}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      <div className="small muted" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Legend color="var(--accent)" label="Admin" />
        <Legend color="var(--ink-2)" label="Member" />
        <Legend color="var(--warn)" label="Waiting to join" />
        <Legend color="var(--danger)" label="Banned" />
        <span>Click someone to see who they’re connected to.</span>
      </div>
      {ranked.length > 0 && <h2 style={{ marginTop: 8 }}>Most connected</h2>}
      <div className="panel rows" hidden={ranked.length === 0}>
        {ranked.slice(0, 12).map((p) => (
          <button
            key={p.user_id}
            className="row"
            style={{ textAlign: 'left', width: '100%', background: 'none', border: 0 }}
            aria-pressed={picked === p.user_id}
            onClick={() => setPicked(picked === p.user_id ? null : p.user_id)}
          >
            <Icon name="user" size={18} />
            <div className="grow title">{p.display_name}</div>
            <div className="end small muted">
              {plural(degree.get(p.user_id) ?? 0, 'connection')}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 10, height: 10, borderRadius: '50%', background: color }} />
      {label}
    </span>
  );
}

// ── activity log ──

function LogTab({ hub }: { hub: string }) {
  const users = useAdminUsers(hub);
  const log = useInfiniteQuery({
    queryKey: ['api', ['admin'], adminPath(hub, '/log')],
    queryFn: ({ pageParam }) =>
      api.get<{ entries: AdminLogEntry[]; more: boolean }>(
        adminPath(hub, `/log?limit=50${pageParam ? `&before=${pageParam}` : ''}`),
      ),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.more ? last.entries.at(-1)?.id : undefined),
  });
  const names = new Map(users.data?.users.map((u) => [u.user_id, u.display_name]));
  const name = (id: string | null) => (id ? (names.get(id) ?? 'someone who left') : '');
  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <section className="section">
      <ErrorNote error={log.error} />
      {log.data && entries.length === 0 ? (
        <p className="muted">No admin actions yet.</p>
      ) : (
        <div className="panel rows">
          {entries.map((e) => (
            <div key={e.id} className="row">
              <div className="grow" style={{ minWidth: 0 }}>
                <div>
                  <b>
                    {e.actor === 'cli'
                      ? 'The hub’s command line'
                      : e.actor === 'hub'
                        ? 'The hub'
                        : name(e.actor)}
                  </b>{' '}
                  {describe(e, name)}
                </div>
              </div>
              <div className="end small faint" title={new Date(e.at * 1000).toLocaleString()}>
                {ago(e.at)}
              </div>
            </div>
          ))}
        </div>
      )}
      {log.hasNextPage && (
        <div>
          <button
            className="btn"
            disabled={log.isFetchingNextPage}
            onClick={() => void log.fetchNextPage()}
          >
            Show older
          </button>
        </div>
      )}
    </section>
  );
}

function describe(e: AdminLogEntry, name: (id: string | null) => string): string {
  const who = name(e.target);
  switch (e.action) {
    case 'approve':
      return `let ${who} in`;
    case 'ban':
      return `banned ${who}${e.details ? ` (“${e.details}”)` : ''}`;
    case 'unban':
      return `unbanned ${who}`;
    case 'admin.add':
      return e.details === 'first account'
        ? `made ${who} its admin: the first account to join`
        : e.actor === 'hub'
          ? `made ${who} its admin as the oldest account`
          : `made ${who} an admin`;
    case 'admin.remove':
      return `stopped ${who} being an admin`;
    case 'set':
      if (e.target === 'join_mode')
        return e.details === 'approval'
          ? 'made new accounts wait for approval'
          : 'let anyone with the address join';
      if (e.target === 'name')
        return e.details ? `named the hub “${e.details}”` : 'cleared the hub’s name';
      return `changed ${e.target} to ${e.details ?? 'nothing'}`;
    default:
      return `${e.action} ${who || e.target || ''}`.trim();
  }
}

// ── settings ──

const LIMITS: { key: HubLimitKey; label: string; help: string; max: number }[] = [
  {
    key: 'signups_per_hour',
    label: 'New accounts per hour',
    help: 'From one internet address, counting new devices too. A household shares one address.',
    max: 10_000,
  },
  {
    key: 'max_files_per_device',
    label: 'Files per device',
    help: 'How many files one computer can share on this hub.',
    max: 100_000_000,
  },
  {
    key: 'max_devices_per_account',
    label: 'Devices per account',
    help: 'Computers one person can have on this hub, not counting removed ones.',
    max: 1_000,
  },
];

function LimitsPanel({
  settings,
  busy,
  save,
}: {
  settings: AdminSettings;
  busy: boolean;
  save: (change: Partial<AdminSettings>) => void;
}) {
  const [draft, setDraft] = useState<Partial<Record<HubLimitKey, string>>>({});
  const value = (k: HubLimitKey) => draft[k] ?? String(settings[k] ?? 0);
  const valid = LIMITS.every(({ key, max }) => {
    const v = value(key);
    return /^\d+$/.test(v) && Number(v) <= max;
  });
  const changed = LIMITS.some(({ key }) => Number(value(key)) !== settings[key]);
  return (
    <div className="panel panel-pad section">
      <h2>Limits</h2>
      <p className="muted" style={{ margin: 0 }}>
        These keep one person or script from swamping the hub. 0 means no limit.
      </p>
      {LIMITS.map(({ key, label, help }) => (
        <label key={key} style={{ display: 'grid', gap: 2 }}>
          <span>
            <b>{label}</b>
          </span>
          <input
            className="input"
            style={{ maxWidth: 160 }}
            inputMode="numeric"
            value={value(key)}
            aria-label={label}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value.trim() })}
          />
          <span className="muted small">{help}</span>
        </label>
      ))}
      <div>
        <button
          className="btn primary"
          disabled={busy || !valid || !changed}
          onClick={() => {
            save(Object.fromEntries(LIMITS.map(({ key }) => [key, Number(value(key))])));
            setDraft({});
          }}
        >
          Save limits
        </button>
      </div>
    </div>
  );
}

function SettingsTab({ hub }: { hub: string }) {
  const settings = useApi<AdminSettings>(['admin'], adminPath(hub, '/settings'));
  const users = useAdminUsers(hub);
  const [name, setName] = useState<string | null>(null);
  const save = useAction(
    (change: Partial<AdminSettings>) => api.put<AdminSettings>(adminPath(hub, '/settings'), change),
    { topics: ['admin', 'hubs'], done: 'Saved', onDone: () => setName(null) },
  );
  const s = settings.data;
  if (!s) return <ErrorNote error={settings.error} />;
  const draft = name ?? s.name ?? '';
  const admins = users.data?.users.filter((u) => u.admin) ?? [];
  return (
    <>
      <div className="panel panel-pad section">
        <h2>Name</h2>
        <p className="muted" style={{ margin: 0 }}>
          What people see instead of the hub’s address. They pick up a new name the next time they
          connect.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ maxWidth: 320 }}
            value={draft}
            maxLength={64}
            placeholder="No name: people see the address"
            aria-label="Hub name"
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="btn primary"
            disabled={save.busy || draft.trim() === (s.name ?? '')}
            onClick={() => void save.run({ name: draft.trim() || null })}
          >
            Save
          </button>
        </div>
      </div>
      <div className="panel panel-pad section">
        <h2>Who can join</h2>
        <label className="check">
          <input
            type="radio"
            checked={s.join_mode === 'approval'}
            disabled={save.busy}
            onChange={() => void save.run({ join_mode: 'approval' })}
          />
          <span>
            <b>People wait until an admin lets them in</b>
            <br />
            <span className="muted small">
              New accounts show under People › Waiting. Best for a hub whose address gets around.
            </span>
          </span>
        </label>
        <label className="check">
          <input
            type="radio"
            checked={s.join_mode === 'open'}
            disabled={save.busy}
            onChange={() => void save.run({ join_mode: 'open' })}
          />
          <span>
            <b>Anyone with the address can join</b>
            <br />
            <span className="muted small">
              Simplest for family and friends. Someone you ban could come back with a new account.
            </span>
          </span>
        </label>
      </div>
      {s.signups_per_hour !== undefined && (
        <LimitsPanel settings={s} busy={save.busy} save={(c) => void save.run(c)} />
      )}
      <div className="panel panel-pad section">
        <h2>Admins</h2>
        <p className="muted" style={{ margin: 0 }}>
          {admins.map((a) => a.display_name).join(', ') || '…'}
        </p>
        <p className="faint small" style={{ margin: 0 }}>
          Admins are added and removed on the server, with{' '}
          <code>communal-hub admin add|remove</code>, so nobody can take a hub over from the app.
        </p>
      </div>
      <ErrorNote error={save.error} />
    </>
  );
}
