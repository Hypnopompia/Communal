# ADR 0006 — Hub sessions, presence, TLS and dev-only switches

- Status: accepted (M1)
- Date: 2026-10-12

## Sign-in

1. On connect the hub sends `challenge {nonce (32 B), hub_id, hub_pubkey}`.
2. The device signs `lp(nonce) ‖ lp(hub_id)` under the `communal/auth/v1` domain (`authPayload` in `@communal/crypto`). Binding `hub_id` stops a response from being replayed to a different hub.
3. **`account.create`** carries the same signature as proof of possession. The client then sends `auth` on the same session. A new account's `user_id` and `device_id` both derive from the first device's key, since that key is the account root.
4. **`auth` failures all look alike** to the caller. Unknown device, revoked device, wrong key and missing user all return `forbidden "sign-in rejected"`. A pending account gets `pending_approval`. The client treats `forbidden` as fatal, and treats `pending_approval` as "retry with backoff".
5. **Only these types are allowed before `auth`:** `account.create`, `link.claim`, `account.restore`, `ping`, `pong`. Anything else gets `unauthenticated`. Sessions that don't authenticate within 30 s are closed with code 4001.
6. **A device signing in again replaces its older session**, which is closed with code 4000. Because the device was never offline, no presence event is sent.

## Presence and timeouts

- **Pings.** The client pings every 30 s. Any frame counts as activity. Both sides drop the connection after 90 s of silence.
- **Offline grace period.** HANDOFF says presence goes offline "only after the 90 s timeout". The hub therefore publishes `offline` at **last contact + 90 s**, even when the socket closed earlier. A reconnect inside that window cancels the pending event, so short network drops never cause an offline/online flicker. The trade-off is that a cleanly quit device shows as online for up to 90 s.
- **Who receives presence.** For now, the owner's other devices and **accepted connections**. Pending connections don't count. M3 extends this to owners who share something with the viewer (`canSee` / `publishPresence` in `apps/hub/src/server.ts`).
- **Snapshot.** On sign-in, the hub sends one `presence {online:true}` for each device the user can see that is currently online, including devices still inside their grace period.

## Reconnect backoff (client)

`delay = base/2 + random·base/2`, where `base = min(60 s, 1 s·2^attempt)`. The attempt counter resets after a successful sign-in.

**Hub key pinning:** the hub key is pinned on first contact. A later mismatch is fatal and is never retried.

## TLS

The hub picks its TLS mode in this order:

1. `COMMUNAL_TLS_CERT` + `COMMUNAL_TLS_KEY`: PEM files.
2. `COMMUNAL_DEV_TLS=self-signed`: generates a P-256 certificate for `localhost`, `hub` and `127.0.0.1`. It's stored in the data directory and reused. **Dev builds only.**
3. `COMMUNAL_TLS=off`: plain `ws`, for when a reverse proxy terminates TLS.
4. Otherwise, refuse to start.

Dev clients with `COMMUNAL_DEV_TLS=self-signed` skip certificate verification. The hub key pin still authenticates the hub, which is why this is acceptable in dev.

## Dev-only switches

HANDOFF says `COMMUNAL_AUTO_INIT` and `COMMUNAL_DEV_TLS` are "ignored in production builds". A build is a dev build when **`COMMUNAL_BUILD=dev`**.

- Docker images bake this in from a build arg that defaults to `release`. Only `compose.dev.yml` passes `dev`.
- `pnpm --filter @communal/hub dev` sets it for source runs.
- A release image that receives `COMMUNAL_DEV_TLS` refuses to start rather than silently running without TLS.

## Storage

- The hub uses **`better-sqlite3`**, as HANDOFF suggests. Node 24's built-in `node:sqlite` supports FTS5 but still prints an experimental warning, so it isn't used yet. It would remove the native dependency from the hub image, so it's worth reconsidering when it becomes stable.
- Migrations are forward-only SQL strings, tracked with `PRAGMA user_version`. WAL mode lets the `communal-hub` admin commands run against a live hub's database.

## join_mode

- `COMMUNAL_JOIN_MODE` sets the initial value only on first start. After that, `communal-hub set join_mode open|approval` controls it.
- Approval is checked at `auth`, so `communal-hub approve <user>` takes effect on the client's next retry, with no hub restart.
