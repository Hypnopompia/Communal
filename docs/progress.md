# Progress

## Next up

**M7 — Subscriptions.** HANDOFF §5 "Subscriptions" and §12. Starting points:

- **What already exists:**
  - `watch`, `unwatch` and `watch.event` are in the protocol. The hub answers `not_implemented`, and the `watches` table isn't created yet.
  - Downloads already queue while the owner is offline and resume when they're back.
  - Each watch belongs to one hub (ADR 0007).
- **To do:**
  - Hub: `watch` with an access check, through `Catalog.visible()` like everything else. Then `watch.event` on index deltas for visible paths only, and catch-up from `since_rev`.
  - Client: subscriptions stored locally with a destination folder and `mirror_deletes` (asked at subscribe time, default no), auto-download of new hashes, and deletes to the OS trash.
  - Losing access stops new downloads, and existing files stay.
- **Done when:** adding and deleting files at the source propagates as specified, including after the subscriber was offline.

**Still open from M0:** the 1 GiB transfer between two physical machines on a LAN. It needs the owner's second machine.

**Notes for M9 (desktop):**

- `better-sqlite3` and `udx-native` are native modules. They need an Electron rebuild (or matching prebuilds) and a smoke test inside Electron's `utilityProcess`.
- Settings needs a hub list (ADR 0007).
- The access UI must show which hub each rule applies to.
- Turn on the router port mapper (`RouterPortMapper`) the way the CLI daemon does. Settings → Network shows `GET /v1/network` and re-runs `POST /v1/network/check`. Transfers show `diagnosis.message`, `tips` and `fix` (ADR 0011).

## M6 — File types, metadata, thumbnails, previews (2026-10-12)

**Status: done.** Details and decisions are in ADR 0012.

### What exists

- **Owner side:**
  - The media worker runs after hashing (and only while nothing waits to be hashed). It extracts metadata per HANDOFF §9: image size and capture date, video duration, size and codec, audio tags and duration, PDF pages and title.
  - It makes 320 px WebP thumbnails with EXIF/GPS stripped and auto-rotation applied: a frame at 10 % for video, the cover for audio, page 1 for PDFs, and the embedded EXIF preview for HEIC and RAW.
  - 1600 px previews are rendered on demand.
  - `meta` and `thumb` reach every hub through ordinary index deltas.
- **Peer:** `preview` sessions serve batched `thumb.get` and 64 KB `peek`s. The uploader checks every hash itself, and a refusal looks like "nothing there". The upload log gets one thumbnail-batch row per session.
- **Viewer:**
  - Batched thumbnail fetch: one session and one `thumb.get` per folder of up to 1,000 files.
  - An LRU, size-capped thumbnail cache keyed by hash, which only accepts WebP from peers.
  - Peek.
  - In-order streaming with HTTP ranges and verified chunks, without downloading.
  - MIME → icon ids.
- **API:** `POST /v1/thumbs`, `GET /v1/thumbs/:hash`, `GET /v1/peek`, `GET /v1/stream/:hash`, and `icon` on browse and search.
- **CLI:** `browse` shows icon, metadata and ▣ for a thumbnail. `peek` and `thumbs` are new.
- **Headless image:** ffmpeg (`ffmpeg-static`), sharp and `@napi-rs/canvas` all work inside it, verified in the dev stack.

### Done criteria

- [x] **A mixed folder shows the right icons and metadata** (`test/integration/m6-media.test.ts`). JPEG with EXIF, PNG, MP4, MP3 with tags and cover, PDF, Markdown, Rust, CSV and an unknown binary each get the right kind, icon, metadata and thumbnail flag, through the hub's browse and search.
- [x] **Thumbnails for a 500-image folder load in one batched request:** one brokered connection, one `thumb.get` with 500 hashes, all 500 cached in about 250 ms. A second load comes from the cache with no connection.

### Also tested

- `packages/core/src/media/media.test.ts`, with real fixtures generated on the fly (`@communal/core/testing`):
  - the per-kind metadata, and that thumbnails are never larger than 320 px
  - **no EXIF, XMP, ICC, GPS or camera make in thumbnails** of a photo that has them
  - files pretending to be images, and ffmpeg report parsing
- The uploader's own check: a preview session brokered for a public file can't get a private file's thumbnail or peek, or a nonexistent one's. Peek truncates at 64 KB.
- The 1600 px preview on demand, never enlarged.
- Streaming: a range (206), a suffix range, the whole file, an out-of-range request (416), and nothing written to disk.
- The thumbnail cache evicts least recently used entries and refuses non-WebP bytes.
- The 100k-file test still hashes and syncs in about 22 s, because the media worker waits for hashing. The full suite has 236 tests, including the 100k one.

### Demo (dev stack)

```bash
A share add /shares/alice --name Alice; A acl set Alice/ hub
A status                          # index: hashed, analysed, thumbs
B browse <hub> <alice_device> Alice/   # [image] tiny.png 69 B 1×1 ▣ …
B thumbs <hub> <alice_device> Alice/   # 1/1 thumbnails cached in 181 ms
B peek <hub> <alice_device> <hash>     # first 64 KB of a text file
```

### Carried forward

- **Desktop `<img>` and `<video>` can't send the API bearer token** for `/v1/thumbs` and `/v1/stream`. M9 needs signed short-lived URLs or an Electron protocol handler.
- **The headless image's app layer is 222 MB** (ffmpeg 49 MB, pdf.js 35 MB, canvas 29 MB, libvips 18 MB). Prune pdf.js at deploy, and revisit with M9 packaging.
- **HEIC and RAW get thumbnails only via their embedded preview.** sharp's prebuilt libvips has no HEVC decoder.
- **A stream uses one source,** and an in-progress response ends if that source goes away.

## M5 — Diagnostics with no relay (2026-10-12)

**Status: done.** Details and decisions are in ADR 0011.

### What exists

- **Network check (core):**
  - The NAT probe sends from the peer socket to both hub probe ports, giving `none`, `endpoint_independent`, `symmetric`, `blocked` or `unknown`.
  - UPnP/NAT-PMP port mapping through `@achingbrain/nat-port-mapper`. The mapping becomes a `mapped` candidate, is refreshed, and is removed on shutdown.
  - Global IPv6 and CGNAT (100.64.0.0/10) detection.
  - `network.profile` is sent to every hub on sign-in.
- **Hub:**
  - Stores `network.profile` per session (memory only).
  - Takes `connect.failed` from both parties of a brokered session and answers the downloader with one diagnosis: `cause`, `easier_fix`, `you`, `them`.
  - `diagnose()` is a pure function covering the HANDOFF §8 table.
  - It waits up to 3 s for the owner's report, then falls back to the owner's profile. An unanswered offer means `peer_offline`.
- **Core:**
  - Both sides report `no_path` and `handshake_failed` with punch stats.
  - Transfers keep the most useful diagnosis until they complete, and keep retrying.
  - `explain()` holds the user-facing message, tips and whose side to fix.
- **CLI and API:**
  - `communal transfers` shows cause, message, tips and both sides' NAT.
  - `communal netcheck` is new, backed by `GET /v1/network` and `POST /v1/network/check`.
  - `GET /v1/downloads` includes the explained diagnosis.
  - `COMMUNAL_UPNP=false` turns the router mapping off.
- **NAT lab:** router modes `cone`, `symmetric` (`MASQUERADE --random-fully`) and `udp_blocked`, with scripted scenarios in `docker/nat/test.sh`.

### Done criteria

- [x] **Symmetric NAT** (`cone / symmetric`): `both_restrictive_nat`, easier fix on the owner's (cone) side. The network check reported `endpoint_independent` and `symmetric`, with two different ports seen by the hub.
- [x] **Blocked UDP** (`cone / udp_blocked`): `udp_blocked`, easier fix `you`. The network check reported `blocked`.
- [x] **Offline peer** (`cone / cone`, owner stopped): `peer_offline`, easier fix `none`, and the download stays queued.
- [x] **Plus the M4 baseline,** now genuine: 12 MB between two cone NATs via hole punching, sha256 match. The whole lab takes about 2 minutes.

**The M4 lab didn't actually test hole punching.** Traffic leaked between the private networks through Docker's LAN-side gateway, and once that was closed, punching hit a conntrack port clash on the routers. Both are fixed in the lab routers, and the correction is recorded in ADR 0010. The transport code didn't need changes.

### Also tested

- `apps/hub/src/diagnosis.test.ts`: every row of the diagnosis table, including ties, CGNAT on either or both sides, one-way reachability, and a missing owner report.
- `apps/hub/src/broker.test.ts`, access control:
  - `network.profile` needs a session.
  - Only the two parties of a live session may report.
  - Only the downloader gets the diagnosis, and it carries no punch stats.
  - Late owner reports are waited for, and finished sessions can't be reported again.
- `packages/core/src/peer/netcheck.test.ts`: NAT classification, the exact CGNAT range, and the messages and tips for every cause.
- `test/integration/m5-diagnostics.test.ts` (real hubs and cores; bad networks simulated by dropping punches and overriding the measured profile):
  - profiles per hub (with and without probe responders)
  - a mapped candidate with CGNAT, and the mapping removed on stop
  - `both_restrictive_nat` shown with tips over the local API, then finishing once the network is fixed
  - `udp_blocked`, `os_firewall` on the owner's side, and `peer_offline`
- The full suite (223 tests, including the 100k-file scale test) passes.

### Fixed along the way

- **Hub search was quadratic in the number of matching entries.** "Newest copy per hash" was a correlated subquery over an unindexed CTE. A prefix query over 20k files took 8 s, and over 50k files it took 49 s. That blocked the hub past its silence window, so the 100k-file M2 test had been failing since at least M4, hidden because quick runs use `M2_FILES`. It's now a grouped CTE joined once, and the 100k test takes 31 s again. Run the full `pnpm check` (no `M2_FILES`) before closing a milestone.

### Demo

```bash
docker/nat/test.sh                      # all scenarios; or: docker/nat/test.sh symmetric
B netcheck                              # nat=… per hub, router mapping, advice
B transfers                             # waiting downloads show cause, message and tips
```

### Carried forward

- **CGNAT is only detected through a UPnP/NAT-PMP router** (its external address), or when the hub sees a 100.64/10 address. Otherwise it's reported as `both_restrictive_nat`, whose tips still apply.
- **A hub whose UDP probe ports aren't reachable** (for example behind a TCP-only proxy) makes clients look `blocked`. Hub setup docs (M9) must say to publish 3478/3479 UDP.
- **The lab has no UPnP router,** so the real mapping path is only exercised up to "no gateway found". A miniupnpd router container could cover it later.
- **The help link** HANDOFF suggests sending to the person with the easier fix is UI work for M9. `explain()` already provides the text.

## M4 — Direct transfers (2026-10-12)

**Status: done.** Details and decisions are in ADR 0010.

### What exists

- **Hub brokering:** `connect.request` (with an access check), a 5-minute signed token, `connect.offer` to the owner, and `connect.answer` back with the owner's identity and the token. `peer_offline` when the owner is away. There is no relay.
- **Peer transport (core):** one UDP socket; candidates from LAN, IPv6, advertised and public addresses (learned via the hub's UDP probe); hole punching; udx + Noise on device keys; identity and cert-chain checks both ways; keepalives.
- **Uploader:** the full `hello` check (token from the brokering hub, issued for this session), LAN-only, its own per-hub access re-check, unchanged-file check, concurrency limit (`busy`), bandwidth cap, and the local upload log with retention.
- **Downloader:** multi-source with windows of ~32 chunks, manifest and per-chunk verification with re-fetch from other peers, `.part` + `.partmap` resume, waiting/retry (also on presence), slow-peer reassignment, safe file names.
- **CLI and API:** `communal get <hash>`, `transfers`, `cancel`, `log`. Settings through environment variables: `COMMUNAL_PEER_PORT`, `COMMUNAL_ADVERTISE_ADDR`, `COMMUNAL_MAX_UPLOADS`, `COMMUNAL_UPLOAD_KBPS`, `COMMUNAL_LAN_ONLY`, `COMMUNAL_DOWNLOADS`, `COMMUNAL_LOG_RETENTION_DAYS`.
- **NAT test lab:** `docker/compose.nat.yml` + `docker/nat/test.sh` (also a CI job).

### Done criteria

- [x] **Files transfer between peers on a LAN:** integration tests, plus the Docker dev stack (a 30 MB file between containers, sha256 match).
- [x] **Across NATs in a test lab:** `docker/nat/test.sh`. Two clients behind separate masquerading routers; 12 MB transferred, sha256 match. _Corrected in M5: the lab leaked traffic between its private networks, so this run proved less than it claimed. Genuine hole punching was verified in M5 (ADR 0010)._
- [x] **A killed transfer resumes:** the restarted download had 10 of 40 chunks and fetched exactly the missing 30.
- [x] **A corrupted chunk is detected and re-fetched,** both from a different honest source and from a source that corrupted it once.
- [x] **Forged and expired tokens are rejected:** not signed by the hub (`bad_token`), expired (`expired`), another session's genuine token (`bad_token`), a token issued to someone else (`wrong_sender`).

### Also tested

- multi-source (both sources contribute)
- the uploader refusing despite a stale or malicious hub allowing it (logged `denied`)
- `busy` at the limit, then queueing while the owner is offline and finishing when they return
- hub broker access control: hidden files look missing, only the addressed device may answer, session ids can't be reused
- the helpers: ranges, safe names, LAN classification
- 190 tests, passing 3 times in a row

### Demo (dev stack)

```bash
A acl set Alice/ hub
B search big                 # → hash
B get <hash>; B transfers     # done 100% → /var/lib/communal/downloads/…
A log                         # who downloaded what (local only)
docker/nat/test.sh            # the NAT lab
```

### Carried forward

- **Diagnosing failed connections** (`connect.failed` causes, `easier_fix`), NAT classification, UPnP/NAT-PMP, CGNAT: M5. Today a failed punch shows up as "could not connect to any source".
- **Revocation lists** in peer cert-chain checks: M8.
- **Streaming** (in-order ranges for previews), thumbnails and `peek`: M6.
- **Throughput on macOS loopback** is CPU-bound in UDP syscalls (ADR 0001). Fine for LAN speeds; batched sends would help.

## M3 — Social graph + access control (2026-10-12)

**Status: done.** Details and decisions are in ADR 0009. Rules are per hub (ADR 0007, owner decision).

### What exists

- **Hub:**
  - `user.search`
  - connections: request, accept, remove and list, with notifications to the other side (crossing requests count as accept)
  - owner-only groups built from connections
  - `acl.set` and the new `acl.replace`, with inheritance: the file's own rule, then the nearest folder's, then "only me"
  - `Catalog.visible()` decides every search, browse and sources result: own devices, `hub`, or listed users and groups _while connected_
  - presence follows visibility
- **Core:** per-hub rules stored locally (the authoritative copy) and pushed to each hub on sign-in and on every change. `People` covers search, connections, groups, safety codes and verification, and rejects user records a hub has tampered with.
- **CLI:** `acl set|clear|list`, `people search|list|request|accept|remove|verify`, `group list|set|delete`. Per-hub commands require `--hub` when the device is on several hubs.

### Tests

- `apps/hub/src/access.test.ts`: **the done-when matrix.**
  - Every audience type (default, `me`, `hub`, inherited `hub`, file override, users, groups) × own device / connected-and-granted / connected-not-granted / listed-but-unconnected / stranger.
  - Each combination is checked through search, sources _and_ browse, which must all agree.
  - Also: removing a connection revokes immediately (and a reconnect doesn't restore group membership), rule changes and new files apply at once, banned owners are hidden, rules can't be set for another device, and foreign groups are rejected.
- **Connection, group, user-search and presence handler tests:** crossing requests, unreachable users (self, unknown, pending, banned), notifications, literal LIKE wildcards, group privacy.
- `test/integration/m3-access.test.ts` (real clients):
  - the same folder public on hub A and private on hub B
  - a connection on B grants nothing on A
  - rules re-sent after a hub loses them
  - identical safety codes on both sides
  - a hub that swaps someone's key is refused
- The full suite (175 tests) passes repeatedly.

### Demo (dev stack)

```bash
A() { docker compose -f docker/compose.dev.yml exec node-a communal "$@"; }
B() { docker compose -f docker/compose.dev.yml exec node-b communal "$@"; }
A share add /shares/alice --name Alice
A people search bob                 # → bob's user id
A people request <bob_id>; B people accept <alice_id>
A people verify <bob_id>            # same code on both sides
A acl set Alice/ users:<bob_id>     # or: hub, groups:<id>
B search holiday                     # alice's files appear
```

### Carried forward

- **Rules for another of your own devices** (managing a NAS from a laptop) wait for device-to-device sync in M8.
- **The uploader's own re-check** of rules, connections and groups lands with transfers in M4. The core already holds the authoritative rules.
- **The desktop UI must make the per-hub scope of every rule obvious** (M9).

## M2 — Indexing + search/browse (2026-10-12)

**Status: done.** Details and decisions are in ADR 0008.

### What exists

- **Core engine** (`CommunalCore`): shares published to chosen hubs, a local SQLite index, scanning with magic-byte and extension type detection, a file watcher (2 s batches), a periodic full rescan, background BLAKE3 hashing (1 MiB chunks, hash over the chunk hashes, 4 files in parallel), and index sync per hub (snapshot, delta, resync).
- **Hub:** an `entries` table with FTS5 search on file names, the `index.snapshot` / `index.delta` handlers (staged snapshots, rev checks, `index.resync`), and search (grouped by hash, ranked, paged, kind and size filters), browse and sources. Everything goes through one access filter, `Catalog.visible()`: owner only until M3, and banned owners hidden.
- **Cross-hub search:** one query goes to every hub, results are merged by hash, each source is tagged with its hub, and partial results are returned when a hub is down.
- **Local API:** HTTP+JSON over a 0600 Unix socket, or over localhost with a bearer token for desktop.
- **CLI:** `share add|remove|list|hubs`, `search`, `browse`. `status` shows indexing progress. The daemon serves the API.

### Tests

- `packages/core/src/index/index.test.ts` (14): type detection, the hash definition, the indexer (ignore rules, symlinks, edits/deletes/new folders, rescan diffs, periodic rescan).
- `apps/hub/src/catalog.test.ts` (12):
  - index sync (deltas, stale-rev resync, multi-page snapshots, out-of-order pages)
  - access control: index messages only affect your own device, nothing works before sign-in, search/sources/browse never show other users' files, and a hidden device looks the same as a nonexistent one
  - paging, and FTS input that tries to inject syntax
- `test/integration/m2-index-search.test.ts` (5):
  - **100,000 files:** scan 5 s, hash and sync 21 s, search 10 ms
  - deltas for adds, edits, deletes and removed folders
  - recovery from a forced rev mismatch and from a hub that lost its index
  - per-hub publishing with merged cross-hub search and one hub down
  - the local API over a 0600 socket and with a token over TCP
- The full suite (158 tests) passed 3 times in a row.

### Demo (dev stack)

```bash
pnpm dev:stack
docker compose -f docker/compose.dev.yml exec node-a communal share add /shares/alice --name Alice
docker compose -f docker/compose.dev.yml exec node-a communal search holiday
docker compose -f docker/compose.dev.yml exec node-a communal status       # index: files/hashed
```

### Carried forward

- ~~Visibility is owner-only~~: access rules landed in M3.
- **Metadata (`meta`) and thumbnails are empty** until M6.
- **No limit on entries per device** at the hub yet. Add one before public deployment (with rate limiting, M9).
- **Only hashed files appear in search** (browse shows all). A large first index is searchable progressively as hashing proceeds.

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
- **Multi-hub client** (owner decision, ADR 0007): `HubManager` runs one `HubClient` per hub with the same identity, tags events by hub, and fans requests out with `requestAll`. `account.create` accepts `root_pubkey` + `chain`, so a linked device keeps the account's `user_id` on a new hub.
- **Headless CLI:**
  - `communal init --hub <url> --name <name>` and `communal hub add|list|remove` join and manage hubs, stored in `hubs.json`. An old `hub.json` is migrated.
  - `communal daemon` connects to every configured hub.
  - `communal status` shows the device and all its hubs.
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
- `test/integration/multi-hub.test.ts` (3 tests): one identity on two hubs, per-hub pinning, fan-out keeps working when one hub is down, presence tagged by hub, restart from saved state, removing a hub.
- `test/integration/m1-hub-accounts.test.ts` (6 tests, real TLS hub + real `HubClient`s):
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
