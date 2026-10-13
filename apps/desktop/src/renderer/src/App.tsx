import { useEffect, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { HostState, UpdateState } from '../../shared/bridge';
import { api, type Connection, type LinkRequest, type Transfer } from './api';
import { hubName } from './format';
import { useHubs, useStatus } from './hubs';
import { problemText } from './screens/Settings';
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
          aria-current={route.screen === n.screen ? 'page' : undefined}
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
  const links = useApi<{ requests: LinkRequest[] }>(['devices'], '/v1/link/requests', {
    refetchInterval: 15_000,
  });
  const requests = links.data?.requests ?? [];
  const waiting = hubs.filter((h) => h.problem?.reason === 'pending_approval');
  const refused = hubs.filter((h) => h.problem && h.problem.reason !== 'pending_approval');
  const onDevices = route.screen === 'settings' && route.tab === 'devices';
  const onHubs = route.screen === 'settings' && route.tab === 'hubs';
  if (!requests.length && !waiting.length && !refused.length) return null;
  return (
    <div className="attention">
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
              <b>{hubName(h.url)}</b> lets people in by hand, and its admin hasn’t approved you yet.
              Until then you can’t search or see people there. Communal checks again by itself.
            </span>
          </div>
        ))}
      {!onHubs &&
        refused.map((h) => (
          <div key={h.id} className="notice bad attention-row">
            <span>
              Can’t connect to <b>{hubName(h.url)}</b>:{' '}
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
    people: people.reduce(
      (n, q) => n + (q.data?.connections.filter((c) => c.state === 'pending_in').length ?? 0),
      0,
    ),
    settings: links.data?.requests.length ?? 0,
    transfers:
      transfers.data?.downloads.filter((d) => d.state === 'active' || d.state === 'queued')
        .length ?? 0,
  };
}
