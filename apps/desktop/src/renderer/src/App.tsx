import { useEffect, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { HostState, UpdateState } from '../../shared/bridge';
import { api, type Connection, type LinkRequest, type Transfer } from './api';
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
  if (!status.data) return status.error ? <Centered>{status.error.message}</Centered> : null;
  if (status.data.hubs.length === 0 && !status.data.account.user_id)
    return <Welcome deviceId={status.data.device_id} />;
  return (
    <NavCtx.Provider value={setRoute}>
      {/* macOS draws the window with no title bar: this strip is where it can be dragged. */}
      <div className="titlebar" aria-hidden="true" />
      <div className="shell">
        <Sidebar route={route} go={setRoute} />
        <main className="main">
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
