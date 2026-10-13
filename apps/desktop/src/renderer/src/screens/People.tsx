/**
 * People (HANDOFF §11): connections, requests both ways, user search, safety-code
 * verification and the groups editor. Connections and groups live on each hub.
 */
import { useState } from 'react';
import { api, qs, type Connection, type Group, type HubStatus, type Person } from '../api';
import { ago, hubName, plural, seenLabel } from '../format';
import { useHubs } from '../hubs';
import { useApi } from '../query';
import { Disc } from '../ui/Disc';
import { Icon } from '../ui/icons';
import { Dialog, Empty, ErrorNote, useAction } from '../ui/kit';
import { VerifiedMark } from '../ui/VerifiedMark';

export function People() {
  const { hubs } = useHubs();
  const [hubId, setHubId] = useState<string | null>(null);
  const hub = hubs.find((h) => h.id === hubId) ?? hubs.find((h) => h.ready) ?? hubs[0];
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>People</h1>
          <p className="lede">
            Connect with people you know to share with them. Either of you can disconnect at any
            time.
          </p>
        </div>
        {hubs.length > 1 && (
          <div className="actions">
            <div className="segmented" role="group" aria-label="Hub">
              {hubs.map((h) => (
                <button key={h.id} aria-pressed={h.id === hub?.id} onClick={() => setHubId(h.id)}>
                  {hubName(h)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {!hub ? null : !hub.ready ? (
        <div className="notice warn">{hubName(hub)} isn’t reachable right now.</div>
      ) : (
        <HubPeople key={hub.id} hub={hub} />
      )}
    </div>
  );
}

function HubPeople({ hub }: { hub: HubStatus }) {
  const conns = useApi<{ connections: Connection[] }>(
    ['people', 'presence'],
    `/v1/people${qs({ hub: hub.id })}`,
  );
  const [verifying, setVerifying] = useState<Connection | null>(null);
  const act = useAction(
    (action: 'accept' | 'remove' | 'request', user_id: string) =>
      api.post(`/v1/people/${action}`, { hub: hub.id, user_id }),
    { topics: ['people', 'presence'] },
  );
  // Presence changes come as `presence` hints: they move connections' online state.
  const all = conns.data?.connections ?? [];
  const incoming = all.filter((c) => c.state === 'pending_in');
  const accepted = all.filter((c) => c.state === 'accepted');
  const outgoing = all.filter((c) => c.state === 'pending_out');
  const many = useHubs().hubs.length > 1;

  return (
    <>
      <ErrorNote error={conns.error ?? act.error} />
      {incoming.length > 0 && (
        <section className="section">
          <h2>Want to connect with you</h2>
          <div className="panel rows">
            {incoming.map((c) => (
              <PersonRow key={c.user_id} p={c} sub={`Asked ${ago(c.since)}`}>
                <button
                  className="btn small quiet"
                  onClick={() => void act.run('remove', c.user_id)}
                >
                  Decline
                </button>
                <button
                  className="btn small primary"
                  onClick={() => void act.run('accept', c.user_id)}
                >
                  Accept
                </button>
              </PersonRow>
            ))}
          </div>
        </section>
      )}

      <FindPeople
        hub={hub}
        known={new Set(all.map((c) => c.user_id))}
        onRequest={(id) => act.run('request', id)}
      />

      <section className="section">
        <div className="section-head">
          <h2>Connections</h2>
          {many && <span className="hint">on {hubName(hub)}</span>}
        </div>
        {conns.data && accepted.length === 0 ? (
          <Empty title="No connections yet">
            Search for someone above and send them a request. They’ll see it the next time they open
            Communal.
          </Empty>
        ) : (
          <div className="panel rows">
            {accepted.map((c) => (
              <PersonRow
                key={c.user_id}
                p={c}
                online={c.online}
                sub={
                  c.seen
                    ? `${seenLabel(c.seen)} · connected ${ago(c.since)}`
                    : `Connected ${ago(c.since)}`
                }
              >
                <button className="btn small quiet" onClick={() => setVerifying(c)}>
                  {c.verified ? 'Safety code' : 'Verify'}
                </button>
                <RemoveButton name={c.display_name} onRemove={() => act.run('remove', c.user_id)} />
              </PersonRow>
            ))}
          </div>
        )}
      </section>

      {outgoing.length > 0 && (
        <section className="section">
          <h2>Waiting for an answer</h2>
          <div className="panel rows">
            {outgoing.map((c) => (
              <PersonRow key={c.user_id} p={c} sub={`Asked ${ago(c.since)}`}>
                <button
                  className="btn small quiet"
                  onClick={() => void act.run('remove', c.user_id)}
                >
                  Cancel request
                </button>
              </PersonRow>
            ))}
          </div>
        </section>
      )}

      <Groups hub={hub} connections={accepted} />
      {verifying && (
        <VerifyDialog hub={hub} person={verifying} onClose={() => setVerifying(null)} />
      )}
    </>
  );
}

function PersonRow({
  p,
  sub,
  online,
  children,
}: {
  p: Person;
  sub: string;
  online?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="row">
      <Disc name={p.display_name} seed={p.fingerprint} online={online} />
      <div className="grow">
        <div className="title">
          {p.display_name}
          <VerifiedMark on={p.verified} />
        </div>
        <div className="sub">{sub}</div>
      </div>
      <div className="end">{children}</div>
    </div>
  );
}

function RemoveButton({ name, onRemove }: { name: string; onRemove: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn small quiet" onClick={() => setOpen(true)}>
        Disconnect
      </button>
      {open && (
        <Dialog title={`Disconnect from ${name}?`} onClose={() => setOpen(false)}>
          <p className="muted">
            You stop seeing what {name} shares with you, and {name} stops seeing what you shared
            with them, right away. You can connect again later.
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
  hub,
  known,
  onRequest,
}: {
  hub: HubStatus;
  known: Set<string>;
  onRequest: (id: string) => Promise<unknown>;
}) {
  const [q, setQ] = useState('');
  const [sent, setSent] = useState<Set<string>>(new Set());
  const results = useApi<{ users: Person[] }>(
    [],
    q.trim() ? `/v1/people/search${qs({ hub: hub.id, q: q.trim() })}` : null,
  );
  return (
    <section className="section">
      <h2>Find people</h2>
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
  person: Connection;
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

function Groups({ hub, connections }: { hub: HubStatus; connections: Connection[] }) {
  const groups = useApi<{ groups: Group[] }>(['people'], `/v1/groups${qs({ hub: hub.id })}`);
  const [editing, setEditing] = useState<Group | 'new' | null>(null);
  const name = (id: string) => connections.find((c) => c.user_id === id)?.display_name ?? 'someone';
  return (
    <section className="section">
      <div className="section-head">
        <h2>Groups</h2>
        <span className="hint">
          Only you see your groups. Use them to share with several people at once.
        </span>
      </div>
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
