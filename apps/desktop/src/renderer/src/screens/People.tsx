/**
 * People (HANDOFF §11): connections, requests both ways, user search, safety-code
 * verification and the groups editor. Connections and groups live on each hub.
 */
import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api, qs, type Connection, type Group, type HubStatus, type Person } from '../api';
import { mergePeople, type HubLink, type MergedPerson } from '../people-merge';
import { ago, hubName, plural, seenLabel } from '../format';
import { useHubs } from '../hubs';
import { useApi } from '../query';
import { Disc } from '../ui/Disc';
import { Icon } from '../ui/icons';
import { Dialog, Empty, ErrorNote, useAction } from '../ui/kit';
import { VerifiedMark } from '../ui/VerifiedMark';

export function People() {
  const { hubs } = useHubs();
  const ready = hubs.filter((h) => h.ready);
  const away = hubs.filter((h) => !h.ready);
  const many = hubs.length > 1;
  // Same keys as useApi, so `people` and `presence` hints refresh these too.
  const lists = useQueries({
    queries: ready.map((h) => {
      const path = `/v1/people${qs({ hub: h.id })}`;
      return {
        queryKey: ['api', ['people', 'presence'], path],
        queryFn: () => api.get<{ connections: Connection[] }>(path),
      };
    }),
  });
  const people = mergePeople(
    ready.map((h, i) => ({ hub: h.id, connections: lists[i]?.data?.connections ?? [] })),
  );
  const loaded = lists.length > 0 && lists.every((q) => q.data);
  const error = lists.find((q) => q.error)?.error ?? null;
  const [verifying, setVerifying] = useState<{ hub: string; person: Person } | null>(null);
  const act = useAction(
    (action: 'accept' | 'remove' | 'request', hub: string, user_id: string) =>
      api.post(`/v1/people/${action}`, { hub, user_id }),
    { topics: ['people', 'presence'] },
  );
  const hubById = (id: string) => hubs.find((h) => h.id === id)!;
  const on = (id: string) => (many ? `on ${hubName(hubById(id))}` : '');
  const incoming = people.filter((p) => p.hubs.some((l) => l.state === 'pending_in'));
  const accepted = people.filter((p) => p.hubs.some((l) => l.state === 'accepted'));
  const outgoing = people.filter((p) => p.hubs.some((l) => l.state === 'pending_out'));
  const lines = (p: MergedPerson, state: HubLink['state']) =>
    p.hubs.filter((l) => l.state === state);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>People</h1>
          <p className="lede">
            Connect with people you know to share with them. Either of you can disconnect at any
            time.
            {many && ' You connect on each hub separately; someone on several hubs is shown once.'}
          </p>
        </div>
      </div>
      {away.length > 0 && (
        <div className="notice warn">
          {away.map((h) => hubName(h)).join(', ')} {away.length === 1 ? 'isn’t' : 'aren’t'}{' '}
          reachable right now, so people there aren’t shown.
        </div>
      )}
      <ErrorNote error={error ?? act.error} />

      {incoming.length > 0 && (
        <section className="section">
          <h2>Want to connect with you</h2>
          <div className="panel rows">
            {incoming.map((p) => (
              <PersonRow
                key={p.user_id}
                p={p}
                lines={lines(p, 'pending_in').map((l) => ({
                  key: l.hub,
                  text: `Asked ${ago(l.since)} ${on(l.hub)}`.trim(),
                  actions: (
                    <>
                      <button
                        className="btn small quiet"
                        onClick={() => void act.run('remove', l.hub, p.user_id)}
                      >
                        Decline
                      </button>
                      <button
                        className="btn small primary"
                        onClick={() => void act.run('accept', l.hub, p.user_id)}
                      >
                        Accept
                      </button>
                    </>
                  ),
                }))}
              />
            ))}
          </div>
        </section>
      )}

      {ready.length > 0 && (
        <FindPeople
          hubs={ready}
          known={(hub) =>
            new Set(people.filter((p) => p.hubs.some((l) => l.hub === hub)).map((p) => p.user_id))
          }
          onRequest={(hub, id) => act.run('request', hub, id)}
        />
      )}

      <section className="section">
        <h2>Connections</h2>
        {loaded && accepted.length === 0 ? (
          <Empty title="No connections yet">
            Search for someone above and send them a request. They’ll see it the next time they open
            Communal.
          </Empty>
        ) : (
          <div className="panel rows">
            {accepted.map((p) => {
              const links = lines(p, 'accepted');
              return (
                <PersonRow
                  key={p.user_id}
                  p={p}
                  online={p.online}
                  sub={p.seen ? seenLabel(p.seen) : undefined}
                  extra={
                    <button
                      className="btn small quiet"
                      onClick={() => setVerifying({ hub: links[0]!.hub, person: p })}
                    >
                      {p.verified ? 'Safety code' : 'Verify'}
                    </button>
                  }
                  lines={links.map((l) => ({
                    key: l.hub,
                    text: `Connected ${ago(l.since)} ${on(l.hub)}`.trim(),
                    actions: (
                      <RemoveButton
                        name={p.display_name}
                        where={many ? hubName(hubById(l.hub)) : undefined}
                        onRemove={() => act.run('remove', l.hub, p.user_id)}
                      />
                    ),
                  }))}
                />
              );
            })}
          </div>
        )}
      </section>

      {outgoing.length > 0 && (
        <section className="section">
          <h2>Waiting for an answer</h2>
          <div className="panel rows">
            {outgoing.map((p) => (
              <PersonRow
                key={p.user_id}
                p={p}
                lines={lines(p, 'pending_out').map((l) => ({
                  key: l.hub,
                  text: `Asked ${ago(l.since)} ${on(l.hub)}`.trim(),
                  actions: (
                    <button
                      className="btn small quiet"
                      onClick={() => void act.run('remove', l.hub, p.user_id)}
                    >
                      Cancel request
                    </button>
                  ),
                }))}
              />
            ))}
          </div>
        </section>
      )}

      {ready.length > 0 && <GroupsOnHubs hubs={ready} people={people} />}
      {verifying && (
        <VerifyDialog
          hub={hubById(verifying.hub)}
          person={verifying.person}
          onClose={() => setVerifying(null)}
        />
      )}
    </div>
  );
}

/** Groups live on one hub and hold that hub's connections: pick the hub when there are several. */
function GroupsOnHubs({ hubs, people }: { hubs: HubStatus[]; people: MergedPerson[] }) {
  const [hubId, setHubId] = useState(hubs[0]!.id);
  const hub = hubs.find((h) => h.id === hubId) ?? hubs[0]!;
  const connections: Connection[] = people.flatMap((p) =>
    p.hubs
      .filter((l) => l.hub === hub.id && l.state === 'accepted')
      .map((l) => ({ ...p, state: l.state, since: l.since })),
  );
  return (
    <Groups
      key={hub.id}
      hub={hub}
      connections={connections}
      picker={hubs.length > 1 ? <HubPicker hubs={hubs} value={hub.id} onChange={setHubId} /> : null}
    />
  );
}

function HubPicker({
  hubs,
  value,
  onChange,
}: {
  hubs: HubStatus[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label="Hub" style={{ justifySelf: 'start' }}>
      {hubs.map((h) => (
        <button key={h.id} aria-pressed={h.id === value} onClick={() => onChange(h.id)}>
          {hubName(h)}
        </button>
      ))}
    </div>
  );
}

/**
 * One person. `lines` are what's going on with them on each hub, with that hub's actions: with
 * a single line they read like one row, with several each hub gets its own line.
 */
function PersonRow({
  p,
  sub,
  online,
  extra,
  lines = [],
  children,
}: {
  p: Person;
  sub?: string;
  online?: boolean;
  /** Actions about the person rather than one hub (verifying). */
  extra?: React.ReactNode;
  lines?: { key: string; text: string; actions: React.ReactNode }[];
  children?: React.ReactNode;
}) {
  const single = lines.length === 1 ? lines[0]! : null;
  const subText = single ? [sub, single.text].filter(Boolean).join(' · ') : sub;
  return (
    <div className="row" style={{ alignItems: lines.length > 1 ? 'flex-start' : undefined }}>
      <Disc name={p.display_name} seed={p.fingerprint} online={online} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="title">
          {p.display_name}
          <VerifiedMark on={p.verified} />
        </div>
        {subText && <div className="sub">{subText}</div>}
        {lines.length > 1 && (
          <div className="hub-lines">
            {lines.map((l) => (
              <div key={l.key} className="hub-line">
                <span>{l.text}</span>
                {l.actions}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="end">
        {extra}
        {single?.actions}
        {children}
      </div>
    </div>
  );
}

function RemoveButton({
  name,
  where,
  onRemove,
}: {
  name: string;
  /** The hub, when you're on several: disconnecting is per hub. */
  where?: string;
  onRemove: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn small quiet" onClick={() => setOpen(true)}>
        Disconnect
      </button>
      {open && (
        <Dialog
          title={where ? `Disconnect from ${name} on ${where}?` : `Disconnect from ${name}?`}
          onClose={() => setOpen(false)}
        >
          <p className="muted">
            You stop seeing what {name} shares with you{where ? ` on ${where}` : ''}, and {name}{' '}
            stops seeing what you shared with them there, right away. You can connect again later.
            {where ? ' Other hubs you’re both on aren’t affected.' : ''}
          </p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setOpen(false)}>
              Stay connected
            </button>
            <button
              className="btn primary"
              onClick={() => void onRemove().then(() => setOpen(false))}
            >
              Disconnect
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function FindPeople({
  hubs,
  known: knownOn,
  onRequest: requestOn,
}: {
  hubs: HubStatus[];
  /** Who you're already connected with, or have a request with, on a hub. */
  known: (hub: string) => Set<string>;
  onRequest: (hub: string, id: string) => Promise<unknown>;
}) {
  const [hubId, setHubId] = useState(hubs[0]!.id);
  const hub = hubs.find((h) => h.id === hubId) ?? hubs[0]!;
  const known = knownOn(hub.id);
  const onRequest = (id: string) => requestOn(hub.id, id);
  const [q, setQ] = useState('');
  const [sent, setSent] = useState<Set<string>>(new Set());
  const results = useApi<{ users: Person[] }>(
    [],
    q.trim() ? `/v1/people/search${qs({ hub: hub.id, q: q.trim() })}` : null,
  );
  return (
    <section className="section">
      <h2>Find people</h2>
      {hubs.length > 1 && (
        <HubPicker
          hubs={hubs}
          value={hub.id}
          onChange={(id) => {
            setHubId(id);
            setSent(new Set());
          }}
        />
      )}
      <div className="search-box" style={{ maxWidth: 480 }}>
        <Icon name="search" />
        <input
          className="input"
          type="search"
          placeholder="Name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Find people by name"
        />
      </div>
      {q.trim() &&
        results.data &&
        (results.data.users.length === 0 ? (
          <p className="muted">Nobody on {hubName(hub)} goes by that name.</p>
        ) : (
          <div className="panel rows">
            {results.data.users.map((u) => (
              <PersonRow key={u.user_id} p={u} sub={`Key ${u.fingerprint.slice(0, 19)}`}>
                {known.has(u.user_id) || sent.has(u.user_id) ? (
                  <span className="faint small">
                    {sent.has(u.user_id) ? 'Request sent' : 'Already connected or asked'}
                  </span>
                ) : (
                  <button
                    className="btn small primary"
                    onClick={() =>
                      void onRequest(u.user_id).then(() => setSent(new Set([...sent, u.user_id])))
                    }
                  >
                    Connect
                  </button>
                )}
              </PersonRow>
            ))}
          </div>
        ))}
    </section>
  );
}

/** Safety codes (HANDOFF §2): compared out of band, then marked as verified here. */
function VerifyDialog({
  hub,
  person,
  onClose,
}: {
  hub: HubStatus;
  person: Person;
  onClose: () => void;
}) {
  const code = useApi<{ code: string }>(
    [],
    `/v1/people/safety-code${qs({ hub: hub.id, user: person.user_id })}`,
  );
  const verify = useAction(
    (verified: boolean) =>
      api.post('/v1/people/verify', { hub: hub.id, user_id: person.user_id, verified }),
    {
      topics: ['people'],
      done: (_r) => (person.verified ? 'Verification removed' : `${person.display_name} verified`),
      onDone: onClose,
    },
  );
  return (
    <Dialog title={`Verify ${person.display_name}`} onClose={onClose}>
      <p className="muted">
        Compare this code with the one {person.display_name} sees, in person or on a call. If they
        match, nobody is pretending to be either of you.
      </p>
      <ErrorNote error={code.error} />
      {code.data && <div className="code-big">{code.data.code}</div>}
      <ErrorNote error={verify.error} />
      <div className="dialog-actions">
        {person.verified ? (
          <button className="btn" onClick={() => void verify.run(false)}>
            Remove verification
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Not now
            </button>
            <button
              className="btn primary"
              disabled={!code.data}
              onClick={() => void verify.run(true)}
            >
              The codes match
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}

function Groups({
  hub,
  connections,
  picker,
}: {
  hub: HubStatus;
  connections: Connection[];
  /** Which hub's groups, when you're on several. */
  picker?: React.ReactNode;
}) {
  const groups = useApi<{ groups: Group[] }>(['people'], `/v1/groups${qs({ hub: hub.id })}`);
  const [editing, setEditing] = useState<Group | 'new' | null>(null);
  const name = (id: string) => connections.find((c) => c.user_id === id)?.display_name ?? 'someone';
  return (
    <section className="section">
      <div className="section-head">
        <h2>Groups</h2>
        <span className="hint">
          Only you see your groups. Use them to share with several people at once.
          {picker ? ' Each hub has its own.' : ''}
        </span>
      </div>
      {picker}
      <ErrorNote error={groups.error} />
      {(groups.data?.groups.length ?? 0) > 0 && (
        <div className="panel rows">
          {groups.data!.groups.map((g) => (
            <div key={g.group_id} className="row clickable" onClick={() => setEditing(g)}>
              <Icon name="people" size={22} />
              <div className="grow">
                <div className="title">{g.name}</div>
                <div className="sub">
                  {g.members.length ? g.members.map(name).join(', ') : 'Nobody yet'}
                </div>
              </div>
              <span className="faint small">{plural(g.members.length, 'person', 'people')}</span>
            </div>
          ))}
        </div>
      )}
      <div>
        <button
          className="btn"
          onClick={() => setEditing('new')}
          disabled={connections.length === 0}
        >
          <Icon name="plus" size={16} /> New group
        </button>
      </div>
      {editing && (
        <GroupDialog
          hub={hub}
          group={editing === 'new' ? null : editing}
          connections={connections}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function GroupDialog({
  hub,
  group,
  connections,
  onClose,
}: {
  hub: HubStatus;
  group: Group | null;
  connections: Connection[];
  onClose: () => void;
}) {
  const [name, setName] = useState(group?.name ?? '');
  const [members, setMembers] = useState<string[]>(group?.members ?? []);
  const save = useAction(
    () =>
      api.post('/v1/groups', {
        hub: hub.id,
        ...(group ? { group_id: group.group_id } : {}),
        name: name.trim(),
        members,
      }),
    { topics: ['people'], done: 'Group saved', onDone: onClose },
  );
  const del = useAction(() => api.del(`/v1/groups/${group!.group_id}${qs({ hub: hub.id })}`), {
    topics: ['people'],
    done: 'Group deleted',
    onDone: onClose,
  });
  return (
    <Dialog title={group ? `Edit ${group.name}` : 'New group'} onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
          placeholder="Family"
        />
      </label>
      <div className="field">
        <span>People</span>
        <div
          className="panel panel-pad"
          style={{ display: 'grid', gap: 8, maxHeight: 280, overflowY: 'auto' }}
        >
          {connections.map((c) => (
            <label key={c.user_id} className="check">
              <input
                type="checkbox"
                checked={members.includes(c.user_id)}
                onChange={(e) =>
                  setMembers(
                    e.target.checked
                      ? [...members, c.user_id]
                      : members.filter((m) => m !== c.user_id),
                  )
                }
              />
              <span>
                {c.display_name}
                <VerifiedMark on={c.verified} />
              </span>
            </label>
          ))}
        </div>
        <small>Members don’t see the group, or each other through it.</small>
      </div>
      <ErrorNote error={save.error ?? del.error} />
      <div className="dialog-actions">
        {group && (
          <button
            className="btn danger"
            style={{ marginRight: 'auto' }}
            onClick={() => void del.run()}
          >
            Delete group
          </button>
        )}
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!name.trim() || save.busy}
          onClick={() => void save.run()}
        >
          Save
        </button>
      </div>
    </Dialog>
  );
}
