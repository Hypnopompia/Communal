# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Communal is a private, Napster-style file-sharing app: a self-hosted **hub** keeps the directory and index, and files move **directly between peers**. The authoritative spec is [HANDOFF.md](HANDOFF.md). Read the relevant section of it before working on any feature. Open work lives in one place: the **Backlog** at the top of [docs/progress.md](docs/progress.md). Add new to-dos there, not in milestone sections or ADRs. Below the backlog, progress.md logs what was done. Decisions are in `docs/adr/`, and questions waiting on the owner are in `docs/questions.md`. Check the backlog and the ADRs before starting work.

## Owner decisions that override HANDOFF

These came from the owner during development. Don't revert them to the spec's wording.

- **Multiple hubs per client, one identity** (ADR 0007). A search goes to every joined hub at once. The desktop Settings will need a hub list, not a single "Hub address".
- **Access rules are per hub** (ADR 0007/0009). The same file can be public on one hub and private on another. A rule on one hub never grants access through another. The UI must make the per-hub scope obvious.
- **Hub admins can ban and unban accounts** (ADR 0006).
- **Hub admin lives in the clients** (ADR 0020), not a web UI: the first account on a hub is its admin, and `communal-hub admin` adds or removes admins (shell only). Settings › Hubs › Manage covers settings, users, devices, the connection graph (admins only, no groups or rules) and an audit log, and MCP gets admin tools. Keep admin actions as `HubDb` methods so a second front end can reuse them.

## Commands

- `pnpm check`: runs format check, lint, typecheck (all packages) and tests. CI runs the same thing. `M2_FILES=5000 pnpm check` is the quick local variant (CI runs the full 100k).
- `pnpm test`: runs Vitest across the repo, including the multi-node tests in `test/integration` (a workspace package of its own). The M2 scale test indexes 100k files (about 35 s); `M2_FILES=2000 pnpm test` makes it quick while iterating. For a single file use `pnpm exec vitest run packages/crypto/src/crypto.test.ts`, and for a single test add `-t "<name>"`.
- `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm build` (compiles every package to `dist/`).
- `pnpm spike:transport`: the M0 transport benchmark (1 GiB over loopback; `--bytes 64M` for a quick run). The real transport now lives in core `peer/transport.ts`. The spike stays as a benchmark.
- `docker/nat/test.sh [cone|symmetric|udp_blocked…]`: the NAT lab. Each scenario puts two clients behind their own routers (`NAT_A`/`NAT_B` modes in `docker/nat/router.sh`), then checks a direct transfer (and `peer_offline` after the owner stops), or the right `connect.failed` cause. It tears down afterwards. A full run takes a few minutes.
- `pnpm dev:stack`: builds and starts the hub plus `node-a` (alice) and `node-b` (bob) via `docker/compose.dev.yml`. `pnpm dev:stack:reset` wipes the volumes. Docker Desktop's CLI lives in `~/.docker/bin` and may not be on PATH.
- Inside a dev container: `docker compose -f docker/compose.dev.yml exec node-a communal <cmd>` (`share add /shares/alice --name Alice`, `search <words>`, `status`), or `communal-spike peer …` for the transport benchmark between containers.
- Running an app from source: `pnpm --filter @communal/hub dev` (a dev build with self-signed TLS, data in `apps/hub/hub-data`), `pnpm --filter @communal/cli dev -- status`.
- People and access (per hub, `--hub` needed when on several): `communal people search|request|accept|remove|verify`, `communal group set|list|delete`, `communal acl set <path> me|hub|users:<ids>|groups:<ids>`.
- Previews: `communal browse` (icon, metadata, ▣ = has thumbnail), `communal thumbs <hub> <device> <folder>` (batch into the cache), `communal peek <hub> <device> <hash>`.
- Transfers: `communal get <hash> [--dest]`, `communal get-folder <device> <path> [--dest]`, `communal download-dir [dir|--reset]`, `communal transfers` (shows the diagnosis and tips when a source can't be reached), `communal cancel <id>`, `communal log` (who downloaded what from this device).
- Subscriptions: `communal subscribe <device> <path> [--mirror-deletes|--no-mirror-deletes] [--dest]`, `communal subscriptions [list|set|remove]`.
- Synced folder: `communal sync [status|on [folder]|off]`.
- Devices (M8): `communal devices [list|add|requests|approve|deny|revoke]`, `communal link <code> --hub <url>` (fresh device), `communal restore <file>|--words [--hub]`, `communal recovery export --out <file>|--words`. `link`, `restore` and `recovery export` also work with the daemon stopped. Passphrases come from the terminal or `COMMUNAL_RECOVERY_PASSPHRASE`.
- Network: `communal netcheck` (NAT type per hub, UPnP/NAT-PMP mapping, IPv6, CGNAT). The daemon maps its UDP port on the router unless `COMMUNAL_UPNP=false`.
- Desktop (M9): `pnpm --filter @communal/desktop... run build`, then `COMMUNAL_BUILD=dev COMMUNAL_DEV_TLS=self-signed pnpm --filter @communal/desktop start` against a dev hub.
  - The app loads `@communal/core` from its compiled `dist/`, so rebuild core after changing it.
  - `COMMUNAL_USER_DATA` gives a separate profile, so two instances can run side by side. `COMMUNAL_DOWNLOADS` keeps test downloads out of `~/Downloads`.
  - `pnpm --filter @communal/desktop smoke` starts it with no window and checks the core.
  - `pnpm --filter @communal/desktop package` builds installers and smoke-tests them. Use `-- --dir` for the unpacked app only. `CSC_IDENTITY_AUTO_DISCOVERY=false` keeps a local signing identity out of the build.
- Linux installer: `site/install.sh` (published at https://hypnopompia.github.io/Communal/install.sh) installs or upgrades `desktop` (.deb or AppImage), `headless` or `hub` from the latest GitHub release, and backs up hub data before an upgrade.
- Headless release: `pnpm --filter @communal/cli package` (a tarball with `install.sh` and `communal.service`). `communal check` runs the install self-check. Hub: `pnpm --filter @communal/hub package`.
- Desktop packaging per CPU: `pnpm --filter @communal/desktop package -- --arch x64|arm64 [--dir]`. Output goes to `apps/desktop/release/<arch>/`.
- **Releases: `pnpm release`** (scripts/release.mjs). The steps:
  1. Add the version's notes to `apps/desktop/changelog.json`.
  2. Bump the version in every `package.json`.
  3. Commit and push `main`, then run it.
  - It needs `gh` logged in, the Developer ID certificate in the keychain, and the App Store Connect API key in `.env` (see `.env.example`).
  - It signs and notarizes both Mac apps locally. GitHub Actions (`release.yml`) adds Windows, Linux and the tarballs to the draft, then the script publishes.
- AI agents: `communal mcp` (stdio MCP server). The desktop app serves its local socket only while Settings › AI agents allows it.
- Site: `site/` (static HTML, deployed by `.github/workflows/pages.yml` to https://hypnopompia.github.io/Communal/). Screenshots in `site/screenshots/` come from two app profiles with generated demo data, never real files.
- Hub admin: `communal-hub users | approve <user_id> | ban <user_id> [--reason] | unban <user_id> | set join_mode open|approval | set name "<readable name>" | admin [list|add|remove <user_id>] | log [-n N]`. These commands work directly on the SQLite database, so they run alongside a live hub. Every change goes in the audit log (`admin_log`) with `cli` as the actor.

Shell notes for this machine:

- Docker Desktop's CLI is at `~/.docker/bin`. Prepend it to `PATH` in each Bash call.
- The shell is zsh, which doesn't split `$VAR` into words: `C="docker compose -f x"; $C up` fails. Use a function instead: `dc() { docker compose -f docker/compose.dev.yml "$@"; }`.

Workspace packages export a custom `@communal/source` condition that points at `src/`. Vitest, tsc and `tsx --conditions=@communal/source` resolve to TypeScript sources, so nothing needs building for tests or dev runs. Only the Docker images use `dist/`. New packages should copy that `exports` shape and the `tsconfig.json`/`tsconfig.build.json` pair (the build config excludes `*.test.ts`).

## Architecture

The repo is a monorepo:

- `packages/protocol`: zod schemas for every hub and peer message, plus the envelope, error codes and protocol version.
  - Hub message bodies are split by direction: `clientBodies` and `hubBodies` in `hub.ts`.
  - Every type needs a sample in `fixtures.ts`; the round-trip test fails otherwise.
  - Messages added beyond the HANDOFF catalog are recorded in ADR 0004.
- `packages/crypto`: device keys, certificates, safety codes and the recovery-key format.
- `packages/core`: the client engine and its local API.
- `apps/hub`, `apps/desktop`, `apps/cli`: the hub server and the two clients.

How the pieces connect:

- **Hub** (Node, `ws`, better-sqlite3 + FTS5) handles accounts, connections, groups, ACLs, the file index, search, presence and brokering of peer connections. It **never** stores file data, thumbnails or download history. It also listens on two UDP ports for NAT probing.
- **Core** is a single client engine shared by both clients. It does indexing, hashing (BLAKE3), thumbnails, the hub session, peer transport, transfers, subscriptions and the upload log. It exposes a **local API** (HTTP + WebSocket on localhost with a bearer token, or a Unix socket).
  - Electron hosts the core in a `utilityProcess`, and the React renderer talks to the local API.
  - The headless `communal` CLI talks to the same API.
  - **Core must never depend on Electron.**
- **Core layout** (`packages/core`):
  - `CommunalCore` (`core.ts`) owns `HubManager`, `HubAdmin` (`hub-admin.ts`, managing hubs this account administers), `IndexStore` (local SQLite: shares, files, change log, per-hub sync state), `Indexer` (scan, watch, rescan, hash) and `IndexSync` (per-hub snapshot/delta).
  - `LocalApi` (`api/server.ts`) wraps the core for the CLI and desktop. The CLI never touches core internals while the daemon runs.
  - Never iterate a better-sqlite3 statement across an `await`: other statements on the same connection throw. Page with keyset queries instead (`filesPage`).
- **Transfers** (ADR 0010):
  - Core `peer/transport.ts` does hole punching plus udx and Noise, with one UDP socket per device. `transfer/broker.ts` handles hub brokering and peer identity checks in both directions. `transfer/uploader.ts` does the `hello` checks, its own access re-check via `AccessOracle`, limits and the upload log. `transfer/downloader.ts` does multi-source, verification and `.part`/`.partmap` resume.
  - Read peer frames with `PeerChannel.next()` / `subscribe()`, never a bare `on('frame')`, or frames that arrive early are lost.
- **NAT lab:** `docker/nat/test.sh` runs a transfer between two clients behind separate NAT routers (`docker/compose.nat.yml`), plus the M5 failure scenarios.
- **Media** (ADR 0012):
  - Core `media/worker.ts` analyses hashed files in the background, only while nothing waits to be hashed. It records `files.meta`, `files.thumb` and `media_at`, and writes 320 px WebP thumbnails by hash into `<data>/thumbs`.
  - `analyze.ts` covers sharp/exifr, ffmpeg (`ffmpeg-static`, no ffprobe), music-metadata and pdf.js with `@napi-rs/canvas`.
  - Peer `preview` sessions (`hello.purpose`) serve `thumb.get` and `peek`, and **the uploader checks every hash**. The viewer side is `media/previews.ts` (batched fetch, `ThumbCache` LRU) and `transfer/stream.ts` (ranged, verified streaming).
  - Real media fixtures for tests come from `@communal/core/testing` (`mixedFolder`, `png`, `makePdf`).
- **Diagnostics** (ADR 0011):
  - Core `peer/netcheck.ts` probes both hub probe ports from the peer socket, classifies the NAT, maps the port with UPnP/NAT-PMP, and sends `network.profile` to each hub.
  - On `no_path` or `handshake_failed`, both sides send `connect.failed` with their observations. The downloader's report is a request, and the hub answers it with the diagnosis from `diagnose()` in `apps/hub/src/diagnosis.ts`, a pure function covering the §8 table.
  - The transfer row keeps the diagnosis, and `explain()` in core `transfer/diagnosis.ts` holds the user-facing text.
  - `CommunalCore` leaves the router mapper off unless given one, so tests never touch a real router. Simulate bad networks with `peer.testDropPunches` and `network.override`.
- **Subscriptions** (ADR 0013):
  - Hub entries carry `rev` (the rev at which their content last changed), and removed paths leave `tombstones`, so `watch` can catch up from `since_rev`. Events go through `Catalog.watchChanges()` → `visible()`.
  - **Losing access must never look like a deletion.** Hidden files simply stop being mentioned.
  - Core `subscriptions.ts` applies events one at a time per subscription and only moves the cursor once an event is fully applied. Deleted files go to the OS trash (`trash`), never `rm`. Local copies the user changed are never touched.
  - Tests inject `subscriptions.trash` so they never touch the real trash.
- **Synced folder** (ADR 0019):
  - It's the share named `Communal` on each of your computers. `sync-folder.ts` finds your other computers that share one and follows each with a `sync` subscription into yours, a full mesh.
  - `sync` subscriptions share one queue and stage files in `.communal-incoming/`. `placeSync` decides at placing time: same content, replace a synced version, ignore a late echo (`stale`), or a conflict. In a conflict the newer version keeps the name and the other gets `conflictName()`, which must stay deterministic, or two computers' copies never converge.
  - `.communal-sync` (`SYNC_MARKER`) is the one shared dotfile. It keeps an empty synced folder visible on the hub. Removals from a computer that stopped sharing its folder are ignored (`stillShared`).
- **Downloads** (ADR 0018): the downloads folder is a setting (`downloads_dir`), read on every download. `transfer/folder.ts` downloads a folder through a `browse` walk (10,000 files at most) and copies or clones content already in your shares.
- **Desktop** (ADR 0016):
  - `apps/desktop/src/main` is the Electron main process: window, tray, `safeStorage` keys, updater. `core-host.ts` runs the core in a `utilityProcess` and must never import Electron.
  - The renderer (`src/renderer`, React + TanStack Query) reaches the API only through `communal://api/...`. Main adds the token, and the renderer never sees it.
  - Queries are tagged with API topics. `/v1/events` hints invalidate them, so prefer topics over polling.
  - Renderer wire types live in `src/renderer/src/api.ts`. Keep them in step with `packages/core/src/api/server.ts`.
  - The page CSP allows only bundled scripts. Fonts are bundled (`@fontsource-variable/...`).
  - No asar: the core spawns ffmpeg and the trash helper by path.
- **Agents** (ADR 0017): `packages/mcp` is an MCP server over the local API. It must never get tools for the recovery key, device linking or revoking, or verifying people. `discoverApi()` finds a running core (daemon, then the desktop app's control socket). `POST /v1/ui/show` moves the desktop window and is `not_found` when headless.
- **Hub admins** (ADR 0020): `users.admin_at`, checked by `HubDb.isAdmin()` on every `admin.*` message (a ban overrides it). The first account on a hub is its admin. Admin `HubDb` methods take an `actor` and write `admin_log` in the same transaction, so every front end is audited.
- **Hub visibility** is decided in exactly one place, `Catalog.visible()` in `apps/hub/src/catalog.ts`. Never filter access in individual queries. Each entry carries its governing rule (`entries.rule_path`), which `HubDb` re-tags whenever rules change (ADR 0009).
- **Access rules are per hub, and the client's copy is authoritative** (core `index.db` table `acl`). It's pushed whole with `acl.replace` on every sign-in. List grants only work while the two users are connected.
- **Clients never trust a hub's claims about identity:** run `checkSummary` on every `UserSummary` (core `people.ts`).
- **Hub protocol**: `wss://<hub>/v1`, JSON envelope `{v, id, re, t, body}` (§5). **Peer protocol**: length-prefixed msgpack frames over **udx-native + Noise XX (`@hyperswarm/secret-stream`)**, using device keys as the Noise static keys (ADR 0001).
  - After the handshake, the peer must match the hub-named `device_id`, and its cert chain must verify to the account root.
  - udx accepts IP literals only, so candidates must be IPs.
  - Never add `hyperdht`/`hyperswarm` as dependencies: they bring a DHT and relaying.
- **Multiple hubs per client** (ADR 0007, changes HANDOFF): core's `HubManager` runs one `HubClient` per hub with a single identity, so `user_id` and device keys are the same on every hub.
  - Hub-facing state is per hub: pinned key, index revs, access rules, groups and watches.
  - Searches fan out with `requestAll` and merge by hash.
  - Transfer tokens are accepted from any joined hub, checked against that hub's rules.
- **Identity**: an Ed25519 device key. The first device's key is the account root. Each later device carries a certificate signed by an existing device, so peers verify the cert chain back to the root and reject revoked devices.
- **Devices** (ADR 0014):
  - Core keeps the account in `<data>/account.json` (root key, user id, this device's chain). `account.ts` has `joinHub` / `linkDevice` / `restoreAccount`, and `HubClient`'s `enroll` is `create | link | restore`.
  - Revocations travel as proofs (`{revocation, chain}`). They are kept in both `index.db` and the hub's `revocations` table, and gossiped to every hub on sign-in.
  - Peers check chains against every proof they have ever seen (`Revocations.revokedFor`), so a hub forgetting one changes nothing.
  - The first device can't be revoked.
  - Only a device holding the root secret can export recovery: the first device, or a restored one (`root.key`).

## Testing patterns

- `@communal/hub/testing` provides:
  - `startTestHub()`: an in-process hub on a random port, with a temp database and short timeouts.
  - `RawClient`: sends arbitrary frames, for access-control tests.
  - `signUp` / `signIn` helpers.
- Every hub handler needs access-control cases. They're grouped by area in `apps/hub/src/`:
  - `server.test.ts`: session, accounts, bans
  - `catalog.test.ts`: index, search, browse, sources
  - `access.test.ts`: the audience × viewer matrix, connections, groups, rules
  - `broker.test.ts`: `connect.*`
  - `devices.test.ts`: `link.*`, `account.restore`, `device.list`, `device.revoke`
  - `admin.test.ts`: `admin.*` (admin, non-admin and banned admin), the first account becoming admin, and the migration
  - `watch.test.ts`: `watch` / `unwatch` / `watch.event`
- Integration tests in `test/integration/` are named per milestone (`m1-…`, `m4-transfers…`). `CommunalCore` takes `peer: { loopback: true }` and short `downloads`/`indexer` timers for tests, plus `testHooks` for fault injection (e.g. corrupt chunks).
- Social state for later milestones (connections etc.) can be seeded directly with `HubDb` methods such as `putConnection`.
- Integration tests run the real hub and `HubClient`s, with timers shortened through constructor options. Never use real 30 s / 90 s waits.
- **Keep clients alive inside a test hub's silence window.** A test hub with `silenceMs: 600` drops a client that pings every 30 s, and events sent while it's reconnecting are lost. Two flaky tests came from this. Give clients `pingIntervalMs` well under the hub's `silenceMs`, and call `RawClient.keepAlive()` for raw clients in long tests.
- **Close a milestone with the full `pnpm check`** (no `M2_FILES`). A quadratic hub search query once hid behind the quick variant for two milestones.
- **The NAT lab must prove punching, not routing.** Routers have no default route and drop unsolicited WAN input (ADR 0010 correction). Keep the both-direction isolation check.
- **Wait for conditions, not fixed sleeps.** Use the `until(cond)` helpers in the integration tests. Several tests were rewritten from sleeps to polling.

## Invariants that span multiple components

- **No relay, ever.** If a library adds a relay fallback (DERP or similar), disable it. When no direct path exists, the hub sends back `connect.failed` with a `cause` and an `easier_fix` (§8).
- **Access control is enforced twice.** The hub filters search, browse, sources, watch and `connect.request`. The uploader checks again on `hello`, `thumb.get` and `get`.
  - The effective rule is the file's own rule, else the nearest ancestor's rule, else `"me"`.
  - The user's own devices always see everything.
  - Banned users (`users.banned_at`) must be excluded from search, browse, sources, `user.search` and presence.
  - Never reveal a file's audience to anyone but its owner, or reveal inaccessible files, not even as counts.
  - Every hub handler needs an access-control unit test.
- Local filesystem paths never leave the device. The hub only sees `ShareName/relative/path`. Downloads are offered only for entries that have a hash.
- The upload log is local SQLite on the uploader and is never sent to the hub. Thumbnails must have all EXIF/GPS data stripped.
- Never log file contents, keys, tokens or full local paths at info level. Use structured pino logs carrying `session_id` / `transfer_id`.

## Working rules from the spec

- Don't revisit the decisions table in HANDOFF.md §2 without asking the user.
- Where the spec says "decide", make the call and record it in `docs/adr/`. The same applies to swapping any suggested library.
- If a requirement is impossible or a bad idea, write it up in `docs/questions.md` instead of silently changing course.
- Each milestone ends with passing tests and a demo note in `docs/progress.md`.
- Dev-only switches (`COMMUNAL_AUTO_INIT`, `COMMUNAL_DEV_TLS`) take effect only when `COMMUNAL_BUILD=dev`. Docker images bake that value from a build arg, and only `compose.dev.yml` passes `dev` (ADR 0006).
- Keep the Docker dev stack (`docker/hub.Dockerfile`, `docker/headless.Dockerfile`, `docker/compose.dev.yml`) working from M0 onward. `COMMUNAL_AUTO_INIT` and `COMMUNAL_DEV_TLS` are dev-only. Dev clients use `COMMUNAL_ADVERTISE_ADDR` so the desktop app on the host can reach them.
