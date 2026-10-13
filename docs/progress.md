# Progress

## Backlog

This is the one list of open work. Each item points to where its detail lives. When an item is done, remove it here and log it in a dated section below. The milestone sections further down are history: their "Carried forward" lists were folded in here on 2026-10-13, so add new work here, not there.

`docs/questions.md` holds anything still waiting for an owner decision. Longer plans live in `docs/plans/`: `downloads.md` (the parked rest of downloads) and `agents.md` (MCP ideas).

### Try it on real machines

These need a person or hardware that CI doesn't have.

- **A non-technical person installs, joins, shares a folder and downloads a file** with the release build, without reading docs. This is the only unchecked M9 done criterion.
- **The synced folder over a few days** (ADR 0019): two or three computers, including one that's often asleep.
- **The Windows build** has only been smoke-tested in CI and has never run on a Windows machine.
- **1 GiB between two physical machines on a LAN** (open since M0).
- **The headless tarball on a real systemd host.** Only `systemd-analyze verify` and `sh -n` have checked it so far (M9).
- **A real UPnP/NAT-PMP mapping.** The NAT lab has no UPnP router, so it stops at "no gateway found". A miniupnpd router container could cover this (M5).

### Before a hub is open to strangers

- **Rate-limit account creation** per IP, and requests in general. Today only link codes and subscriptions are limited (M1, `docs/questions.md` "Ban evasion").
- **A limit on index entries per device** (M2).

### App and release polish

- **Windows code signing** (no certificate yet, ADR 0016).
- **An in-app "What's new"** from `apps/desktop/changelog.json` (ADR 0016).
- **Show the access preview in the app.** `POST /v1/acl/preview` already says which files would be seen by whom. The audience picker in My shares could show the same thing before saving.
- **A message to send to the person with the easier fix.** Transfers shows who can fix a failed connection, but there's no ready-made note to send them (M5, HANDOFF §8).

### Decided, ready to build

- **People on several hubs** (ADR 0021): one person per `user_id` in People, named as on the first hub you joined. Actions stay per hub.
- **First-device guidance** (ADR 0021): the guide and recovery-key screens say to keep the first computer and the recovery key safe, and to start a new account if either is stolen.

### Waiting for user feedback

The plan is in `docs/plans/downloads.md`.

- **Download rules by kind** (audio → Music, video → Movies), unless Save to… turns out to be enough.
- **Transfers grouped by folder**, with one progress bar per folder download.
- **New sources during a download.** Re-query sources every ~30 s so a copy that appears mid-download gets used.
- **More agent tools** from `docs/plans/agents.md`, beyond the first step.

### Known limitations

These are fine for now. Fix them if they start to bite.

- **Devices** (ADR 0014):
  - You can't set rules for another of your own devices (a NAS from a laptop). It needs a signed device-to-device channel.
  - Hubs joined later aren't pushed to existing devices.
  - A revocation proof signed by a device that was itself revoked later is refused by a peer that learned the later revocation first.
  - Peer sessions that are already open aren't closed when a device is revoked.
- **Subscriptions** (ADR 0013):
  - Making a folder public reveals the paths, never the content, of files deleted from it earlier.
  - Hubs forget deletions after 180 days.
  - A live rename keeps its hash only when both events land in the same 2 s watcher batch.
  - A visibility change re-announces the whole folder, which could cost too much for very large folders.
- **Media** (ADR 0012):
  - HEIC and RAW get thumbnails only from their embedded preview.
  - A stream uses a single source.
- **Network** (ADR 0001, ADR 0011):
  - CGNAT is detected only through a UPnP router or a 100.64/10 address.
  - Throughput on macOS loopback is bound by the CPU cost of UDP syscalls. Batched sends would help.
- **Size:** the headless image's app layer is 222 MB, and pdf.js ships builds we could prune (ADR 0012).

### After v1

- **Retention for devices not seen for a long time** (ADR 0015), as a hub setting in Manage (ADR 0020).
- **From HANDOFF §15:** hubs caching thumbnails of hub-wide files, and mobile clients.

## Re-share warning (2026-10-13)

- **ADR 0021:** a download that lands inside one of your shares is shared like the rest of that folder. Communal now says so first.
  - Core `exposure()` (`GET /v1/exposure`) answers who would see files saved into a folder. It works for folders that don't exist yet and follows symlinks like share roots do. Dot-folders count as unshared.
  - Download, folder download and subscribe replies carry `reshared`, and the CLI prints it.
- **App:**
  - Save to… asks first.
  - The folder download and Subscribe dialogs show the note, and the button reads "Download and share".
  - Settings › Downloads shows it when the downloads folder is inside a share.
  - A new `useConfirm()` (`ConfirmProvider` in `ui/kit.tsx`) asks yes or no from an action.
- **MCP:** `check_destination`, and the download and subscribe tools tell agents to pass `reshared` on.
- **Fix:** long folder paths in Settings › Downloads and the download dialogs pushed the buttons out of view (`.field > * { min-width: 0 }`).
- **Test:** `m12-agent-tools` covers a not-yet-existing subfolder through the macOS `/var` symlink, a private subfolder, a dot-folder, an unrelated folder, `reshared` on a real download (and its absence elsewhere), and `check_destination`. The app's notice was checked in the running app.

## Agents: thumbnails and the access preview (2026-10-13)

- **`view_thumbnails`** (MCP, ADR 0021): up to 12 small (320 px) or 2 large (1600 px) thumbnails at once, returned as MCP image content, each labelled with its hash. Files without one are listed by hash. It fetches through the existing preview path, so the owner's computer checks access for every hash, and a refusal looks like "no thumbnail". `LocalApiClient.bytes()` reads binary responses.
- **`preview_access`** (MCP), backed by `POST /v1/acl/preview` and core `previewRule` (`access-preview.ts`). For a proposed rule it lists which files would change audience, grouped from → to, with files, bytes, examples, named and counted people, whether anyone new could see them (`widens`) and a one-paragraph summary. It uses only this device's own rules, files, connections and groups, and changes nothing. `set_access` and the server instructions say to run it, show the summary, and still ask.
- **Fix:** the media worker could write an analysis result after the core closed its store, an unhandled rejection in tests. It now checks `stopped` right before each write.
- **Tests:** `access-preview.test.ts` covers widening and narrowing, nearer rules, groups and connections, nothing changing, a single file, and a share not listed on the hub. `m12-agent-tools` checks a public image (a real WebP), a private one (left out), the owner seeing its own private file, and the size limit.

## Hub admin (2026-10-13)

- **Admins (ADR 0020):** `users.admin_at`. The first account on a hub is its admin and is let in even in approval mode. On upgrade, an existing hub's oldest unbanned account becomes its admin. `communal-hub admin list|add|remove` changes admins, and only the shell can.
- **Audit log:** an `admin_log` table. `approve`, `ban`, `unban`, `changeSettings` and `setAdmin` take an actor and log in the same transaction. `communal-hub log` prints the log.
- **Protocol:** `admin.users`, `admin.approve`, `admin.ban`, `admin.unban`, `admin.settings.get`/`admin.settings.set`, `admin.graph` and `admin.log`, plus the `admin.changed` hint and `welcome.admin` (ADR 0004). Non-admins get the same `bad_request` as an older hub. A ban from a client signs the account out at once. Admins can't be banned from a client.
- **Tests:** `apps/hub/src/admin.test.ts` covers every admin message for admins, non-admins and before sign-in, the first account, removing an admin mid-session, banned admins, no paths or addresses in listings, no groups in the graph, log paging, and the migration.
- **Docs:** `hub.html` and the hub install script say to join a new hub first.
- **Desktop:**
  - Settings › Hubs tags hubs you administer and shows **Manage**.
  - The Manage screen (`screens/ManageHub.tsx`) has four tabs:
    - **People:** everyone, waiting or banned, with search. Let in, Ban… (with a reason) and Unban. Details show the fingerprint and each computer's share counts and NAT.
    - **Connections:** a force-laid-out graph (`graph-layout.ts`, unit-tested), with pending requests dashed, click to highlight, and the most connected people.
    - **Admin log:** in plain words, paged.
    - **Settings:** name, join mode, and the admins.
  - A banner says when people are waiting to join. Screens refresh on the `admin` topic.
  - `show_in_app` accepts `{screen: 'manage', hub, tab}`.
  - Checked in the running app against a dev hub with five headless clients: approval, ban, rename, graph, log, light and dark themes.
- **CLI:** `communal admin users [--waiting|--banned] | approve | ban [--reason] | unban | settings [--join-mode] [--name|--clear-name] | graph | log [-n] [--before]`. It picks the one hub you administer when there's no `--hub`. Checked by hand against a dev hub.
- **MCP** (amends ADR 0017): `list_hub_users`, `approve_hub_user`, `ban_hub_user`, `unban_hub_user`, `get_hub_settings`, `set_hub_settings`, `get_hub_graph` and `get_hub_admin_log`. Ban and settings tools are destructive, and the instructions say to confirm with the user. `show_in_app` opens Manage. `m11-hub-admin` drives them through an MCP client. The M9 test still forbids device approval and any admin-granting tool.
- **Core:** `HubAdmin` (`core.admin`) and the `/v1/hubs/:id/admin/...` routes, `admin` in hub status, and an `admin` event topic. Renaming the hub updates the admin's own app at once. `m11-hub-admin` drives it all through the local API: only the first account can manage the hub, approval, the graph, a ban that signs someone out, the log, and removal by the shell mid-session.

## People, shares and a Linux installer (0.1.5, 2026-10-13)

- **Downloads:** an uploader at its limit answers `busy`. The download is queued and starts as soon as a download from that computer ends, instead of retrying every 30 s.
- **My shares:** one card per folder shows who can see it on each hub, and a "Files inside…" window holds per-file settings. The synced folder is no longer listed among the shares.
- **People:** accepted connections show whether they're online (`connection.listing` carries `online`/`seen` for accepted connections only). The verified shield follows a person's name everywhere.
- **Search:** a "From" filter (anyone, my connections, people I've verified). The core applies it, so the hub never learns who you verified. It's also in `communal search --from` and the agent search tool.
- **Hub names:** `communal-hub set name "…"`. The name travels in `challenge` and replaces the address throughout the app.
- **Installer:** `site/install.sh` installs or upgrades the desktop app, headless service or hub from the latest release, and backs up hub data first.

## Synced folder and downloads (2026-10-13)

- **Synced folder (ADR 0019):** one switch per computer (My shares › Synced folder, `communal sync on`) keeps a `Communal` folder the same on all your computers. It's private to you, and deletions go to the trash. Conflicting edits keep both versions under a `conflicted copy` name that every computer picks alike. It builds on subscriptions (two-way, through a staging folder, one queue) plus a marker file so empty folders still show. The owner's hand-made setup is taken over as it is.
- **Downloads (ADR 0018):**
  - A downloads folder you choose (Settings › Downloads, `communal download-dir`).
  - **Save to…** next to every Download.
  - **Download folder** in the Library (`communal get-folder`), which keeps the structure and copies or clones what you already have instead of fetching it.
- **Indexer fix:** files in a folder moved into a share in one step were never hashed until something else changed.
- **Tests:** `m10-downloads` and `m10-sync-folder` (three computers, a conflict while one is offline, taking over hand-made subscriptions, turning off). The full `pnpm check` passes.

### Demo

```bash
communal sync on                   # on each computer; ~/Communal by default
echo hi > ~/Communal/note.txt      # appears on the others
communal sync                      # which computers it's in step with
communal get-folder <device_id> "Music/Albums/Blue" --dest ~/Music
communal download-dir ~/Downloads
```

## After M9 — agents, releases, site (2026-10-12)

- **AI agents (ADR 0017):**
  - `packages/mcp`: an MCP server over the local API. It has every tool except secrets and trust: no recovery key, no device linking or revoking, no verifying people.
  - It runs as `communal mcp`, as `communal-mcp`, or inside the desktop app (`ELECTRON_RUN_AS_NODE`).
  - The desktop app serves a local control socket only while Settings › AI agents allows it, switching on and off live. `show_in_app` moves the open window to a screen.
  - The CLI falls back to the open app when no daemon runs.
  - Checked end to end: an MCP client launched the app's own binary as the server, found the open app, read its status, and moved its window to Search.
- **Releases (ADR 0016):**
  - `pnpm release` signs and notarizes the Mac apps (Apple Silicon and Intel) locally, like ListenSync, and uploads them with a merged `latest-mac.yml` to a draft GitHub release.
  - GitHub Actions adds Windows, Linux and the headless and hub tarballs, then the script publishes.
  - electron-updater reads GitHub Releases.
  - The Intel build is made on Apple Silicon, then CPU-checked with `lipo` and smoke-tested under Rosetta.
- **Packaging fixes:** executables get their own Mach-O UUIDs (macOS Local Network permission, Apple TN3179), and the Info.plist explains the Local Network prompt. The staging copy moved outside the repo.
- **Hub packaging:** `pnpm --filter @communal/hub package` makes a tarball with a systemd unit (it can bind 443 without root) and an install script.
- **Site:** `site/` (overview, app guide, CLI, AI agents, running a hub), with screenshots of demo data. It's deployed to GitHub Pages by `.github/workflows/pages.yml`.
- **App fixes:**
  - The window can be dragged anywhere along the top edge on macOS.
  - "Maya’s Maya’s iMac" no longer happens (`computerName()`).
  - Small thumbnails in search results and list views are scaled, not cropped.
  - Dialogs focus the chosen option.
  - A new search from an agent replaces the current one.
- **Indexer fix:** the file watcher can drop a sibling's event when a folder changes several times at once. The indexer now compares each touched folder's files by name with the index, so a missed file is picked up in the same batch rather than at the 15-minute rescan. This was the cause of the occasional M7 subscription test failure.
- **CI on GitHub** (first runs): pnpm is set up before setup-node's package-manager cache, the container transport spike moved off the daemons' ports, Windows checkouts keep LF line endings, and scripts work out their own paths with `fileURLToPath`. The test hook timeout went up to 60 s for the cleanup after the 100k-file test.
- MIT license, README, versions 0.1.0.

## M9 — Desktop app + packaging (2026-10-12)

**Status: done, pending the owner's hands-on test.** Details and decisions are in ADR 0015 (source availability) and ADR 0016 (desktop app and packaging).

### What exists

- **Source availability in search (ADR 0015):**
  - Every source in `search.results` and `sources.list` carries a rounded `seen` (`now | today | week | month | older`), not a timestamp.
  - `search.available` filters on the same buckets. It sits inside the SQL (online device ids are passed as JSON), so paging still works.
  - Ranking is availability tier, then relevance. The client keeps the tiers when it merges results from several hubs.
  - CLI: `communal search --online | --seen today|week|month`.
- **Hub:** `library` / `library.listing` lists the devices a viewer can browse, through `Catalog.visible()`, with access-control tests.
- **Core / local API:**
  - `GET /v1/events`: a WebSocket of topic hints.
  - `GET /v1/library`.
  - Per-source speeds in `GET /v1/downloads`.
  - `status().hubs[].problem`.
  - Settings persisted in `settings.json`, plus thumbnail-cache controls (`/v1/settings/storage`).
  - `GET /v1/self-check` (`communal check`).
  - `listen()` fails with a clear error instead of crashing.
- **Desktop app (`apps/desktop`):**
  - Electron 44 with a React 19 renderer. The core runs in a `utilityProcess`.
  - Keys are stored with `safeStorage`. The API is proxied through `communal://api`, so the renderer never sees the token.
  - Every §11 screen, a tray icon, auto-update, and light and dark themes.
- **Packaging:**
  - `pnpm --filter @communal/desktop package`: electron-builder (dmg/zip, NSIS, AppImage/deb) with signing and notarizing hooks, followed by a smoke test of the packaged app.
  - `pnpm --filter @communal/cli package`: a tarball with `install.sh` and a hardened `communal.service`.
  - `.github/workflows/release.yml` on `v*` tags.
  - The CI `desktop` job smoke-tests Electron on all three OSes.

### Done criteria

- [x] **All §11 screens.** They were checked in the running app with two instances (alice, bob) against a dev hub, driven over the DevTools protocol with screenshots:
  1. First launch: join.
  2. People: search, request; the other side sees it live with a badge, and accepts.
  3. My shares: an audience picker scoped to one hub.
  4. Library: people → computer → folders, with video, photo and PDF thumbnails, a text preview, and download.
  5. Search, with the availability state shown.
  6. Transfers, Subscriptions (the mirror-deletes question with "No" preselected) and Activity (names resolved).
  7. Settings: link code, network.
  8. Light and dark themes, and a narrow window.
- [x] **electron-builder for each OS, with code-signing hooks and auto-update.** The macOS dmg and zip were built and the packaged app passed its smoke test: SQLite, UDP transport, sharp, canvas, pdf.js, ffmpeg and trash all work in the packaged utility process. In a Debian (arm64) container, the dev-build smoke test passed, the AppImage and deb (`Package: communal`) were built, and the packaged app passed its smoke test. Windows will only run in CI.
- [x] **Headless packaging and systemd unit.** The tarball was built on macOS and Linux (arm64), and its daemon passed the self-check on macOS. `systemd-analyze verify` accepts the unit, and `install.sh` passes `sh -n`. Neither has been run on a real systemd host.
- [x] **Hub Docker image:** unchanged since M1, still built in CI.
- [ ] **A non-technical user can install, join, share a folder and download a file without reading docs.** This needs a person (see Next up).

### Demo

```sh
pnpm --filter @communal/hub dev                 # a hub on wss://localhost:8443/v1
pnpm --filter @communal/desktop... run build
COMMUNAL_BUILD=dev COMMUNAL_DEV_TLS=self-signed pnpm --filter @communal/desktop start
# A second instance: COMMUNAL_USER_DATA=/tmp/bob … pnpm --filter @communal/desktop start
pnpm --filter @communal/desktop package         # installers in apps/desktop/release
```

## M8 — Devices and recovery (2026-10-12)

**Status: done.** Details and decisions are in ADR 0014. Protocol changes are listed in ADR 0004.

### What exists

- **Hub:**
  - **Link codes:** `link.code.create` → `link.claim` → `link.request` → `link.approve` / `link.deny` → `link.done` / `link.denied`.
    - Codes are `XXXX-XXXX` in Crockford base32, single use, 10 minutes, and held in memory by the session that made them.
    - The approver must sign the claimed key for its own account, with a chain that isn't revoked.
    - A pending claim survives the auth timeout. 5 wrong codes close the session.
  - **`account.restore`** registers a device with a cert signed by the root key.
  - **`account.create` with a chain** now adds the device to an account that already exists on that hub (ADR 0007 said `conflict`).
  - **`device.list`** (with a `root` flag) and **`device.revoke`** with a revocation proof. The proof carries the signer's chain, and any device of the account may submit it.
    - Revoking marks the device and every device certified through it.
    - It closes their sessions (4004), publishes them offline, drops their entries, rules and watches (without tombstones), and tells the account's other devices.
    - Proofs are kept in a `revocations` table, including for devices the hub has never seen, and are re-sent after every `welcome`.
    - The first device can't be revoked.
  - `connect.offer` / `connect.answer` carry the peer account's revocation proofs.
- **Crypto:** a sealed box to an Ed25519 device key (`sealTo` / `openSealed`), and an optional `hubs` list in the recovery file.
- **Core:**
  - `account.json` holds the account identity (root key, user id, this device's chain). Pre-M8 installs are migrated as root devices.
  - `account.ts` holds `joinHub`, `linkDevice` and `restoreAccount`. The CLI uses them directly while the daemon is stopped.
  - `HubClient` registers a device in one of three ways (`enroll`: create, link or restore). It checks the chain in `link.done` itself before trusting it.
  - The approving device seals its hub list (URLs + pinned keys) to the new device, which joins them all. The hub can't read the list.
  - Revocations are verified, kept in `index.db`, and gossiped: pushed to every hub on each sign-in, and passed on when learned from a hub.
  - **Peers refuse revoked chains** using every proof they have seen, so a hub that forgets a revocation can't bring a device back.
  - Recovery export (file or words) works only on a device holding the root key. A restored device keeps the root key (`root.key`, 0600).
- **API:** `GET /v1/account`, `POST /v1/account/link`, `POST /v1/account/restore`, `POST /v1/recovery`, `POST /v1/link/codes`, `GET /v1/link/requests`, `POST /v1/link/requests/:id/approve|deny`, `GET /v1/devices`, `POST /v1/devices/:id/revoke`.
- **CLI:**
  - `communal link <code> --hub <url>` (spaces and any case are accepted in the code)
  - `communal restore <file> | --words [--hub …]`
  - `communal recovery export --out <file> | --words`
  - `communal devices [list] | add [--yes] | requests | approve <id> | deny <id> | revoke <id> [--yes]`
  - Passphrases and words are read without echo, or from `COMMUNAL_RECOVERY_PASSPHRASE` / `COMMUNAL_RECOVERY_WORDS`.

### Done criteria

- [x] **Link a second desktop and a headless node; both see all own files** (`test/integration/m8-devices.test.ts`, two hubs):
  - The desktop links through a running core. The headless node links the way `communal link` does with the daemon stopped, then its core starts from the same data dir.
  - Both end up on both hubs, with alice's hub keys pinned from the sealed bundle.
  - Both browse and search alice's "only me" files on each hub.
- [x] **A revoked device is refused by peers:**
  - Revoking from the headless node reaches both hubs. Alice's device learns of it, and the hubs refuse the laptop.
  - Then hub 1's database is made to forget the revocation and the laptop gets back in. Alice's device still refuses its cert chain (`peer cert chain refused`), and a session it could open before now fails.
  - The next device to sign in pushes the proof back to the hub.
- [x] **Restore from a recovery key with every device wiped:**
  - Export (file and words) from the first device, then wipe both devices' data dirs.
  - A fresh device restores onto both hubs with the pinned keys from the file. It has the same user id, and bob is still a connection.
  - It lists the old devices, revokes the lost node, and can export the same words again.
  - A wrong key restores nothing.

### Also tested

- `apps/hub/src/devices.test.ts` (16), each with access-control cases:
  - **Linking:**
    - only the session that made a code can approve or deny it, and only for the claimed key with its own signature
    - codes are single use, expire, and accept O/I/L for 0/1
    - 5 wrong codes close the session
    - a claim needs proof of possession
    - denial, and the approver disconnecting, both reach the new device
    - a pending claim outlives the auth timeout
    - chains through linked devices work
  - **Restore:** a bad root signature and an unknown account are refused.
  - **Revoke:**
    - sessions are closed, sign-in is refused, files disappear from search, and other devices are told (also after a later sign-in)
    - the chain cascades
    - other accounts' proofs, a stranger's signature, the root device, and a proof from an already-revoked signer are all refused
    - a proof for a device the hub has never seen keeps that device out
- `server.test.ts`: `account.create` with a chain into an existing account, and with a stranger's chain.
- `crypto.test.ts`: the sealed box, and recovery files carrying hubs.
- The full `pnpm check` passes (279 tests, including the 100k-file run). On the first full run, the M7 live-rename indexer test (`index.test.ts`) failed once under the 100k test's load. It passed 5 times alone and on the re-run. It's the known same-batch rename timing, not M8.

### Demo

From source, against `pnpm --filter @communal/hub dev`, with three CLI data dirs:

```bash
communal init --hub wss://127.0.0.1:8443/v1 --name alice   # A, then `communal daemon`
communal devices add --yes                                 # A: prints a code, waits
communal link QM3P 3B7P --hub wss://127.0.0.1:8443/v1      # B, daemon stopped: "Linked to account u_…"
communal devices revoke d_zlwx… --yes                      # A: B shows REVOKED; B's daemon logs "sign-in rejected"
communal recovery export --out alice.recovery              # A
communal restore alice.recovery                            # C: restored onto the hub from the file's list
communal devices revoke d_qzfw… --yes                      # C: "the account's first device can't be revoked"
```

The dev stack was run too:

- alice's pre-M8 volume was migrated to a root account
- a fresh `nas` container linked with `communal link … && communal daemon`, saw alice's "only me" `diary.txt` (bob didn't), and was refused by the hub once revoked from node-a

### Carried forward

- **Rules for another of your own devices** (managing a NAS's rules from a laptop) still needs a signed device-to-device command channel. Otherwise the hub could rewrite the uploader's rules (ADR 0014).
- **The first device can't be revoked**, and there's no account key rotation. A stolen first device or a leaked recovery key means a lost account (`docs/questions.md`).
- **Hubs joined later aren't pushed to existing devices.** `hub add` on each device joins with its chain, and no new link is needed.
- **Peer revocation order:** a proof signed by a device that's revoked later is refused by a peer that learned of the later revocation first. Hubs still have the earlier proof, so they enforce it.
- Already-open peer sessions with a device aren't closed when it's revoked. New sessions are refused.
- Desktop first-launch and Devices screens: M9.

## M7 — Subscriptions (2026-10-12)

**Status: done.** Details and decisions are in ADR 0013. No protocol changes.

### What exists

- **Hub:**
  - `entries.rev` (the rev at which content last changed) and `tombstones` for removed paths, so the hub can say what changed since any rev. Snapshots now produce the same changes as deltas.
  - `watch` with the same access check as browse. A folder you can't see looks like one that doesn't exist. Replies `ok`, then catches up from `since_rev`.
  - Live `watch.event`s after every index change, filtered through `Catalog.visible()`, deletions included.
  - Paged events, where only the last page advances the cursor.
  - A full re-announcement when visibility widens: rules changed, a connection accepted, a group edited. Losing access is never reported as a deletion.
  - `unwatch`, and the `watches` table (HANDOFF §10).
- **Core** (`Subscriptions`):
  - Subscriptions and their files are stored locally, with a cursor per subscription. Every subscription re-watches on sign-in, and refused ones are retried every 10 minutes.
  - New files are downloaded, or copied when the content is already local. A move at the source becomes a local move.
  - Changed files replace the old version, which goes to the trash.
  - With `mirror_deletes`, deletions go to the **OS trash** (`trash` package), and emptied folders are removed.
  - A local copy the user changed is never trashed or replaced.
  - Downloads that no hub offers any more fail as "no longer available" instead of waiting forever. This applies to all downloads.
- **Indexer:** a renamed or moved file keeps its hash, matched by identical size and millisecond mtime in the same batch, so a move reaches hubs as one delta.
- **API:** `GET/POST /v1/subscriptions`, `PUT/DELETE /v1/subscriptions/:id`. `mirror_deletes` is required at creation.
- **CLI:**
  - `communal subscribe <device> <path> [--dest] [--mirror-deletes | --no-mirror-deletes] [--flat] [--hub]`. On a terminal it asks whether to mirror deletions, default no.
  - `communal subscriptions [list]`, `subscriptions set <id> --mirror-deletes on|off | --pause | --resume`, `subscriptions remove <id>`.

### Done criteria

- [x] **Adding and deleting files at the source propagates as specified** (`test/integration/m7-subscriptions.test.ts`, real hub and cores):
  - adds and deletes arrive live
  - a deleted folder empties locally and is removed
  - duplicates aren't downloaded twice
- [x] **Including after the subscriber was offline:** with the subscriber stopped, an add, an edit and a delete at the source all arrive on restart, through catch-up from the stored cursor. Old versions and deleted files are in the trash.
- [x] **Offline queueing:** a file announced while its owner is offline waits, and lands when the owner returns.
- [x] **The mirror-deletes prompt plus trash:** asked at subscribe time and required by the API. Without it deleted files stay, with it they go to the trash. It can be changed later.
- [x] **Access-loss behaviour:**
  - nothing new is downloaded and nothing is deleted
  - a pending download of a file no longer offered fails as "no longer available"
  - the subscription shows `no_access`
  - when access returns, it catches up, including the deletion it missed

### Also tested

- `apps/hub/src/watch.test.ts` (14), access control:
  - no session
  - invisible, missing and foreign folders get identical answers
  - your own devices may watch private folders
  - hidden files and their deletions are never sent
  - a removed connection stops events with no deletions, and reconnecting re-announces the folder
  - banned owners are hidden
- `apps/hub/src/watch.test.ts`, catch-up and live events:
  - catch-up from `since_rev`
  - a cursor ahead of the hub
  - snapshots as deltas
  - non-recursive watches
  - re-announcement only when rules really change
  - `unwatch`
  - paging
  - tombstone retention
- Also in `m7-subscriptions.test.ts`:
  - moves become local moves with no new transfer
  - locally edited files are never trashed
  - the local API
- `packages/core/src/index/index.test.ts`: renames keep their hash, through the watcher and through a scan, and ambiguous ones are hashed afresh.
- The full suite (257 tests, including the 100k-file test: hashed and synced in 23 s) passes. The M4, M7 and watch tests passed 3 times in a row.

### Demo (dev stack)

```bash
A sh -c 'mkdir -p /tmp/m7/trip && echo one > /tmp/m7/one.txt && echo two > /tmp/m7/trip/two.txt'
A share add /tmp/m7 --name M7; A acl set M7/ hub
B subscribe <alice_device> M7/ --mirror-deletes --dest /var/lib/communal/sub-m7
B subscriptions                          # 2 here, 0 downloading; deletions: mirrored to the trash
A sh -c 'mkdir /tmp/m7/later && mv /tmp/m7/one.txt /tmp/m7/later/'   # bob moves his copy, no download
docker compose -f docker/compose.dev.yml stop node-b
A sh -c 'echo four > /tmp/m7/four.txt && rm /tmp/m7/trip/two.txt'
docker compose -f docker/compose.dev.yml start node-b                # catches up: four.txt here, two.txt in ~/.local/share/Trash
```

The same steps, with other file names, were run against the dev stack. A first try that moved one 4-byte file while deleting another written in the same millisecond was correctly treated as ambiguous: download plus trash instead of a local move.

### Carried forward

- **A tombstone's visibility follows the current rules.** Making a folder public reveals the _paths_ of files deleted from it earlier, to watchers who were away. It never reveals content (ADR 0013).
- **Deletions older than 180 days** are forgotten by the hub. A subscriber away longer gets all current files back, but keeps copies of files deleted before the window.
- **A live rename only keeps its hash when its unlink and add land in the same watcher batch** (2 s). Otherwise the subscriber trashes and re-downloads, which is correct, just slower.
- **macOS can drop folder watcher events under heavy disk load** (FSEvents). While the M2 test wrote 100k files, a rename's `add` never arrived, even after 60 s, so only the periodic rescan (15 min) would notice it. The indexer test now feeds the rename's events in by hand with `Indexer.touch()`, so it no longer depends on OS event delivery.
- **Full re-announcements** after a visibility change send the whole visible folder. That's fine for thousands of files. Very large subscribed folders on hubs where rules change often may want a cheaper diff later.
- **Desktop UI** (Subscriptions screen, HANDOFF §11): M9.

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
- ~~**Revocation lists** in peer cert-chain checks~~: done in M8.
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

- **Rules for another of your own devices** (managing a NAS from a laptop): still open after M8 (ADR 0014).
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
