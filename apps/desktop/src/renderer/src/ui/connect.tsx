/**
 * Connect with someone straight from the Library, where people who share with the whole hub
 * show up before you're connected: the same request People › Find people sends. Connections
 * are per hub, so a person on several of your hubs gets a line per hub.
 */
import { api } from '../api';
import { useConnectionStates, useHubs } from '../hubs';
import { useAction } from './kit';

export function ConnectState({
  userId,
  name,
  hubs,
}: {
  userId: string;
  name: string;
  hubs: string[];
}) {
  const states = useConnectionStates();
  const { hubs: all, name: hubName } = useHubs();
  const act = useAction(
    (action: 'request' | 'accept', hub: string) =>
      api.post(`/v1/people/${action}`, { hub, user_id: userId }),
    { topics: ['people', 'presence'], toastErrors: true },
  );
  const on = (hub: string) => (all.length > 1 ? ` on ${hubName(hub)}` : '');
  const lines = [...new Set(hubs)].flatMap((hub) => {
    const known = states.get(hub);
    // A hub that's offline or still loading: say nothing rather than guess.
    if (!known) return [];
    return [{ hub, state: known.get(userId) }];
  });
  if (lines.length === 0) return null;
  return (
    <div className="connect-state">
      {lines.map(({ hub, state }) =>
        state === 'accepted' ? (
          <span key={hub} className="faint small">
            Connected{on(hub)}
          </span>
        ) : state === 'pending_out' ? (
          <span key={hub} className="faint small">
            Request sent{on(hub)}
          </span>
        ) : state === 'pending_in' ? (
          <span key={hub} className="connect-line">
            <span className="faint small">Wants to connect{on(hub)}</span>
            <button
              className="btn small primary"
              disabled={act.busy}
              onClick={(e) => {
                e.stopPropagation();
                void act.run('accept', hub);
              }}
            >
              Accept
            </button>
          </span>
        ) : (
          <button
            key={hub}
            className="btn small"
            disabled={act.busy}
            title={`Ask ${name} to connect${on(hub)}. They see your request the next time they open Communal.`}
            onClick={(e) => {
              e.stopPropagation();
              void act.run('request', hub);
            }}
          >
            Connect{on(hub)}
          </button>
        ),
      )}
    </div>
  );
}
