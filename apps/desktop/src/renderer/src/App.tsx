import { useEffect, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { HostState, UpdateState } from '../../shared/bridge';
import { api, type Connection, type HubStatus, type LinkRequest, type Transfer } from './api';
import { Dialog } from './ui/kit';
import { hubName } from './format';
import { useHubs, useStatus } from './hubs';
import { NavCtx, type Route } from './nav';
import { useApi } from './query';
import { Icon, Mark, type IconName } from './ui/icons';
import { Library } from './screens/Library';
import { Search } from './screens/Search';
import { Shares } from './screens/Shares';
import { People } from './screens/People';
import { Transfers } from './screens/Transfers';
import { Subscriptions } from './screens/Subscriptions';
import { Activity } from './screens/Activity';
import { Settings } from './screens/Settings';
import { ManageHub, useAdminUsers } from './screens/ManageHub';
import { JoinHub, problemText } from './screens/Settings';
import { Welcome } from './screens/Welcome';

export function App() {
  const [host, setHost] = useState<HostState>({ state: 'starting' });
  useEffect(() => {
    void window.communal.hostState().then(setHost);
    return window.communal.onHostState(setHost);
  }, []);
  if (host.state === 'failed')
    return (
      <Centered>
        <h1>Communal couldn’t start</h1>
        <p className="muted">{host.message}</p>
        <p className="muted">
          Quit and open Communal again. If it keeps happening, restart your computer.
        </p>
      </Centered>
    );
  if (host.state === 'starting')
    return (
      <Centered>
        <Mark size={44} />
        <p className="muted">Starting…</p>
      </Centered>
    );
  return <Ready />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="welcome">
      <div className="welcome-card" style={{ justifyItems: 'start' }}>
        {children}
      </div>
    </div>
  );
}

function Ready() {
  const status = useStatus();
  const [route, setRoute] = useState<Route>({ screen: 'library' });
  // An AI agent asked to show a screen (`show_in_app`, ADR 0017).
  useEffect(() => window.communal.onNavigate((r) => setRoute(r as Route)), []);
  // Setting up stays on screen until it's done: joining adds the hub before the account
  // exists, and a link waits for the other computer, so neither can end it by itself.
  const noAccount = !!status.data && !status.data.account.user_id;
  const [settingUp, setSettingUp] = useState(false);
  useEffect(() => {
    if (noAccount) setSettingUp(true);
  }, [noAccount]);
  if (!status.data) return status.error ? <Centered>{status.error.message}</Centered> : null;
  if (noAccount || settingUp)
    return <Welcome deviceId={status.data.device_id} onDone={() => setSettingUp(false)} />;
  if (status.data.hubs.length === 0)
    return (
      <NoHubs
        rootDevice={status.data.account.root_device}
        hasShares={status.data.shares.length > 0}
      />
    );
  return (
    <NavCtx.Provider value={setRoute}>
      {/* macOS draws the window with no title bar: this strip is where it can be dragged. */}
      <div className="titlebar" aria-hidden="true" />
      <div className="shell">
        <Sidebar route={route} go={setRoute} />
        <main className="main">
          <Attention route={route} go={setRoute} />
          <Screen route={route} />
        </main>
      </div>
    </NavCtx.Provider>
  );
}

function Screen({ route }: { route: Route }) {
  switch (route.screen) {
    case 'library':
      return <Library key={`${route.hub}/${route.device}`} route={route} />;
    case 'search':
      // A new query (from an agent's show_in_app) starts a fresh search.
      return <Search key={route.q ?? ''} initial={route.q ?? ''} />;
    case 'shares':
      return <Shares />;
    case 'people':
      return <People />;
    case 'transfers':
      return <Transfers />;
    case 'subscriptions':
      return <Subscriptions />;
    case 'activity':
      return <Activity />;
    case 'settings':
      return <Settings tab={route.tab ?? 'account'} />;
    case 'manage':
      return <ManageHub key={route.hub} hub={route.hub} tab={route.tab ?? 'people'} />;
  }
}

const NAV: { screen: Route['screen']; label: string; icon: IconName }[] = [
  { screen: 'library', label: 'Library', icon: 'library' },
  { screen: 'search', label: 'Search', icon: 'search' },
  { screen: 'shares', label: 'My shares', icon: 'shares' },
  { screen: 'people', label: 'People', icon: 'people' },
  { screen: 'transfers', label: 'Transfers', icon: 'transfers' },
  { screen: 'subscriptions', label: 'Subscriptions', icon: 'subscriptions' },
  { screen: 'activity', label: 'Activity', icon: 'activity' },
  { screen: 'settings', label: 'Settings', icon: 'settings' },
];

function Sidebar({ route, go }: { route: Route; go: (r: Route) => void }) {
  const counts = useBadges();
  const { hubs } = useHubs();
  const [update, setUpdate] = useState<UpdateState>({ state: 'idle' });
  useEffect(() => window.communal.onUpdate(setUpdate), []);
  const down = hubs.filter((h) => !h.ready);
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand">
        <Mark />
        <span className="label">Communal</span>
      </div>
      {NAV.map((n) => (
        <button
          key={n.screen}
          className="nav-item"
          aria-current={
            route.screen === n.screen || (route.screen === 'manage' && n.screen === 'settings')
              ? 'page'
              : undefined
          }
          onClick={() => go({ screen: n.screen } as Route)}
          title={n.label}
        >
          <Icon name={n.icon} />
          <span className="label">{n.label}</span>
          {counts[n.screen] ? <span className="count">{counts[n.screen]}</span> : null}
        </button>
      ))}
      <div className="sidebar-foot">
        {update.state === 'downloaded' && (
          <button
            className="btn small primary"
            onClick={() => void window.communal.installUpdate()}
          >
            Restart to update
          </button>
        )}
        {hubs.length > 0 &&
          (down.length === 0 ? (
            <span className="status on">Connected</span>
          ) : (
            <button
              className="status warn"
              style={{
                border: 0,
                background: 'none',
                padding: 0,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onClick={() => go({ screen: 'settings', tab: 'hubs' })}
            >
              {down.some((h) => h.problem)
                ? 'A hub needs attention'
                : down.length === hubs.length
                  ? 'Connecting…'
                  : 'Some hubs unreachable'}
            </button>
          ))}
      </div>
    </nav>
  );
}

/**
 * Things that stop Communal from working until someone acts, shown above every screen: a hub
 * whose admin hasn't let us in (or that refuses us), and computers waiting for this one to
 * approve them joining the account.
 */
function Attention({ route, go }: { route: Route; go: (r: Route) => void }) {
  const { hubs } = useHubs();
  const account = useStatus().data?.account;
  // Removed from the account: we hold the proof, or every hub refuses our key. (The first
  // computer can't be removed; a hub refusing it is something else.)
  const removed =
    !!account?.user_id &&
    (account.revoked ||
      (!account.root_device &&
        hubs.length > 0 &&
        hubs.every((h) => h.problem?.reason === 'rejected')));
  if (removed) return <Removed revoked={account.revoked} />;
  return <HubAttention route={route} go={go} hubs={hubs} />;
}

function HubAttention({
  route,
  go,
  hubs,
}: {
  route: Route;
  go: (r: Route) => void;
  hubs: HubStatus[];
}) {
  const links = useApi<{ requests: LinkRequest[] }>(['devices'], '/v1/link/requests', {
    refetchInterval: 15_000,
  });
  const requests = links.data?.requests ?? [];
  const waiting = hubs.filter((h) => h.problem?.reason === 'pending_approval');
  const refused = hubs.filter((h) => h.problem && h.problem.reason !== 'pending_approval');
  const onDevices = route.screen === 'settings' && route.tab === 'devices';
  const onHubs = route.screen === 'settings' && route.tab === 'hubs';
  const managed = hubs.filter((h) => h.admin && h.ready);
  if (!requests.length && !waiting.length && !refused.length && !managed.length) return null;
  return (
    <div className="attention">
      {managed.map((h) => (
        <JoinRequests key={h.id} hub={h} route={route} go={go} />
      ))}
      {!onDevices &&
        requests.map((r) => (
          <div key={r.request_id} className="notice attention-row">
            <span>
              <b>{r.device_name}</b> wants to join your account. Approve it here to finish adding
              that computer.
            </span>
            <button
              className="btn small primary"
              onClick={() => go({ screen: 'settings', tab: 'devices' })}
            >
              Review
            </button>
          </div>
        ))}
      {!onHubs &&
        waiting.map((h) => (
          <div key={h.id} className="notice warn attention-row">
            <span>
              <b>{hubName(h)}</b> lets people in by hand, and its admin hasn’t approved you yet.
              Until then you can’t search or see people there. Communal checks again by itself.
            </span>
          </div>
        ))}
      {!onHubs &&
        refused.map((h) => (
          <div key={h.id} className="notice bad attention-row">
            <span>
              Can’t connect to <b>{hubName(h)}</b>:{' '}
              {problemText(h.problem!.reason, h.problem!.message)}
            </span>
            <button className="btn small" onClick={() => go({ screen: 'settings', tab: 'hubs' })}>
              Details
            </button>
          </div>
        ))}
    </div>
  );
}

/** People waiting to join a hub this account administers (ADR 0020). */
function JoinRequests({
  hub,
  route,
  go,
}: {
  hub: HubStatus;
  route: Route;
  go: (r: Route) => void;
}) {
  const users = useAdminUsers(hub.id);
  const waiting = users.data?.users.filter((u) => u.status === 'pending' && !u.banned_at) ?? [];
  if (waiting.length === 0 || (route.screen === 'manage' && route.hub === hub.id)) return null;
  return (
    <div className="notice attention-row">
      <span>
        {waiting.length === 1 ? (
          <>
            <b>{waiting[0]!.display_name}</b> is
          </>
        ) : (
          <>
            <b>{waiting.length} people</b> are
          </>
        )}{' '}
        waiting to join <b>{hubName(hub)}</b>.
      </span>
      <button
        className="btn small primary"
        onClick={() => go({ screen: 'manage', hub: hub.id, tab: 'people' })}
      >
        Review
      </button>
    </div>
  );
}

/**
 * The account is still here but this computer left its last hub: nothing works until it joins
 * one again. A computer added with a code can also start over and be added afresh.
 */
function NoHubs({ rootDevice, hasShares }: { rootDevice: boolean; hasShares: boolean }) {
  const [joining, setJoining] = useState(false);
  const [startingOver, setStartingOver] = useState(false);
  return (
    <Centered>
      <Mark size={44} />
      <div style={{ display: 'grid', gap: 8 }}>
        <h1>This computer isn’t on any hub</h1>
        <p className="muted">
          A hub is where you find people and files, so Communal can’t do anything until this
          computer joins one. Your account is still here: join a hub you were on, or a new one.
        </p>
      </div>
      <div style={{ display: 'grid', gap: 10, justifySelf: 'stretch' }}>
        <button className="choice" onClick={() => setJoining(true)}>
          <strong>Join a hub</strong>
          <span>Type the hub’s address. You stay the same person you were.</span>
        </button>
        {!rootDevice && (
          <button className="choice" onClick={() => setStartingOver(true)}>
            <strong>Start over and add this computer with a code</strong>
            <span>If it was removed from your account, or you want to set it up again.</span>
          </button>
        )}
      </div>
      {joining && (
        <JoinHub title="Join a hub" hasShares={hasShares} onClose={() => setJoining(false)} />
      )}
      {startingOver && <StartOverDialog onClose={() => setStartingOver(false)} />}
    </Centered>
  );
}

/**
 * This computer was removed from its account, so its key can never sign in again. Starting
 * over gives it a new identity; the old one is set aside, not deleted.
 */
function Removed({ revoked }: { revoked: boolean }) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="attention">
      <div className="notice bad attention-row">
        <span>
          {revoked ? (
            <>
              <b>This computer was removed from your account</b> on another of your computers, so
              your hubs no longer let it sign in.
            </>
          ) : (
            <>
              <b>None of your hubs will let this computer sign in.</b> That happens when it was
              removed from your account on another of your computers.
            </>
          )}{' '}
          To use it again, start over and add it to your account with a new code.
        </span>
        <button className="btn small primary" onClick={() => setAsking(true)}>
          Start over…
        </button>
      </div>
      {asking && <StartOverDialog onClose={() => setAsking(false)} />}
    </div>
  );
}

function StartOverDialog({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Start over on this computer?" onClose={onClose}>
      <p className="muted">
        Communal restarts as if newly installed. Then choose <b>Add this computer to my account</b>{' '}
        and type a code from <b>Settings → Devices</b> on your other computer.
      </p>
      <p className="muted">
        Your files aren’t touched. After you’re back in, choose your shared folders and
        subscriptions again. This computer’s old identity and Communal data are kept in a backup
        folder, not deleted.
      </p>
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void window.communal.startOver();
          }}
        >
          {busy ? 'Restarting…' : 'Start over'}
        </button>
      </div>
    </Dialog>
  );
}

/** Counts that need the person: requests to answer, computers to approve, active downloads. */
function useBadges(): Partial<Record<Route['screen'], number>> {
  const { hubs } = useHubs();
  const ready = hubs.filter((h) => h.ready);
  const people = useQueries({
    queries: ready.map((h) => ({
      queryKey: ['api', ['people'], `/v1/people?hub=${h.id}`],
      queryFn: () =>
        api.get<{ connections: Connection[] }>(`/v1/people?hub=${encodeURIComponent(h.id)}`),
    })),
  });
  const links = useApi<{ requests: LinkRequest[] }>(['devices'], '/v1/link/requests', {
    refetchInterval: 15_000,
  });
  const transfers = useApi<{ downloads: Transfer[] }>(['transfers'], '/v1/downloads');
  return {
    // People asking to connect, once each however many hubs they asked on (ADR 0021).
    people: new Set(
      people.flatMap(
        (q) =>
          q.data?.connections.filter((c) => c.state === 'pending_in').map((c) => c.user_id) ?? [],
      ),
    ).size,
    settings: links.data?.requests.length ?? 0,
    transfers:
      transfers.data?.downloads.filter((d) => d.state === 'active' || d.state === 'queued')
        .length ?? 0,
  };
}
