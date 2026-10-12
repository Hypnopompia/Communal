# Progress

## M1 — Hub + accounts (2026-10-12)

**Status: done.**

### What exists

- **Hub** (`apps/hub`): sessions run on `HubServer` with SQLite storage through better-sqlite3 (`HubDb`, versioned migrations). It handles:
  - `challenge`, then `auth` or `account.create`, with proof of key possession
  - join_mode (open or approval)
  - presence with a 90 s offline grace period and a snapshot on sign-in
  - a 90 s silence timeout and a 30 s timeout for unauthenticated sessions
  - session replacement when a device signs in again
  - TLS: PEM files, dev self-signed, or off behind a proxy
  - the UDP NAT-probe responders
- **Hub CLI:** `communal-hub serve` (the default), `users`, `approve <user>`, `ban <user> [--reason]`, `unban <user>`, `set join_mode open|approval`, `get`.
- **Bans** (owner request, beyond HANDOFF): sign-in is refused, live sessions end within about 2 s, and the device goes offline immediately. Search, browse etc. must exclude banned users from M2/M3 on.
- **Core** (`packages/core`): `HubClient` pins the hub key on first contact, creates the account on first connect, pings, detects silence, reconnects with jittered exponential backoff (1 s → 60 s), matches replies to requests, retries while approval is pending, and stops on fatal errors.
- **Headless CLI:**
  - `communal init --hub <url> --name <name>` creates an account.
  - `communal daemon` stays signed in.
  - `communal status` shows the device and hub.
  - `COMMUNAL_AUTO_INIT` creates the account automatically, in dev builds only.
- **Dev stack:** both images build with `COMMUNAL_BUILD=dev`. The hub serves `wss://` with a self-signed certificate. Clients wait for the hub healthcheck, then create accounts and sign in.
- **Decisions:** ADR 0006.

### Tests

- `apps/hub/src/server.test.ts` (18 tests): access-control cases for every M1 handler:
  - pre-auth types refused
  - `account.create`: wrong key, challenge replay, duplicate device, approval mode
  - `auth`: unknown device, wrong key, revoked device, pending user, double auth, session replacement
  - presence reaches only the owner's devices and accepted connections
  - timeouts
- `test/integration/m1-hub-accounts.test.ts` (5 tests, real TLS hub + real `HubClient`s):
  - 3 accounts created; the hub key is pinned
  - presence: no flicker on a quick reconnect, offline only after the silence window, online on return, nothing sent to an unconnected user
  - hub restart: the backoff delays are checked against the jitter bounds, then all clients reconnect and presence comes back
  - a changed hub key is refused
  - approval mode: the client keeps retrying until the admin approves it
- The whole suite ran 5 times in a row with no flaky failures (119 tests).

### Demo

```bash
pnpm dev:stack:reset && pnpm dev:stack
docker compose -f docker/compose.dev.yml exec hub communal-hub users      # alice, bob: active
docker compose -f docker/compose.dev.yml exec node-a communal status       # registered, hub key pinned
docker compose -f docker/compose.dev.yml restart                          # same accounts, clients sign back in
docker compose -f docker/compose.dev.yml exec hub communal-hub set join_mode approval
```

### Carried forward

- Presence visibility is based only on connections. M3 adds "shares something with you".
- `network.profile` is accepted by the protocol, but the hub returns `not_implemented` (M5). Every other non-M1 type does the same until its milestone lands.
- Web admin UI and remaining multi-hub details are in `docs/questions.md`.
- No rate limiting on the hub yet. Revisit before any public deployment (M9).

## M0 — Foundations (2026-10-12)

**Status: done, except the two-host LAN transport run, which needs a second machine.**

### What exists

- **Monorepo:** pnpm workspaces, strict TypeScript, ESLint, Prettier, Vitest, and CI (`.github/workflows/ci.yml`). CI runs `pnpm check` on Linux, macOS and Windows, a loopback transport run, and a Docker job that builds the stack and moves 1 GiB between containers.
- **`@communal/protocol`:** zod schemas for every hub message (both directions) and every peer frame, the JSON envelope with version/unknown-type/direction handling, and the msgpack peer frame codec with a streaming decoder. Additions to the HANDOFF catalog are in ADR 0004.
- **`@communal/crypto`:**
  - device keys, `device_id`, `user_id` and fingerprints
  - domain-separated signatures
  - device certs, chain verification and revocation
  - safety codes
  - recovery keys (Argon2id + XChaCha20-Poly1305 file, and 24-word BIP39)
  - hub transfer tokens
- **Transport test build** (`spike/transport`): udx-native + Noise XX with device keys and cert-chain verification (ADR 0001).
- **Docker:** `docker/hub.Dockerfile`, `docker/headless.Dockerfile`, `docker/compose.dev.yml`. The hub and CLI are skeletons. The hub sends `challenge`, answers `ping`, serves `/healthz` and runs the two UDP NAT-probe responders. The CLI's `communal daemon` and `status` commands create and show the device key.

### Demo

```bash
pnpm install && pnpm check                       # 96 tests
pnpm spike:transport                              # 1 GiB over loopback
pnpm dev:stack                                    # hub + alice + bob
docker compose -f docker/compose.dev.yml exec node-a communal status
# 1 GiB between containers (start both; order doesn't matter):
docker compose -f docker/compose.dev.yml exec node-a communal-spike peer --me alice --peer bob --role up --port 41641 --peer-addr node-b:41642
docker compose -f docker/compose.dev.yml exec node-b communal-spike peer --me bob --peer alice --role down --port 41642 --peer-addr node-a:41641
```

### Done criteria

- [x] Schemas round-trip in tests (every type has a fixture; the test fails if one is missing).
- [x] 1 GiB between two processes on localhost with mutual key auth: ~125 MB/s, integrity check passed.
- [x] 1 GiB between two containers in the dev stack: ~287 MB/s, integrity check passed.
- [ ] 1 GiB across two hosts on a LAN. **Needs a second machine.** Run `communal-spike peer …` on each host, or `pnpm --filter @communal/spike-transport exec tsx --conditions=@communal/source src/bench.ts peer …` from a checkout, with `--peer-addr <other-host-ip>:<port>`.

### Known gaps, carried forward

- ~~Hub TLS~~: done in M1.
- **Image sizes:** 370 MB (hub) and 406 MB (headless) uncompressed, against the ~300 MB target. Most of that is the `node:24-bookworm-slim` base. Revisit when ffmpeg/sharp are added (M6). A distroless or Alpine base depends on prebuilds for udx-native and sharp.
- **Images built and tested only for linux/arm64** (Apple Silicon). The CI docker job builds amd64. Multi-arch publishing comes with M9 packaging.
- **The headless image doesn't include ffmpeg yet.** That comes with the thumbnail pipeline (M6).
- **`apps/desktop` is an empty placeholder.** `packages/core` gained its first code in M1.
