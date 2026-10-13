# ADR 0016 — Desktop app and packaging

- Status: accepted (M9)
- Date: 2026-10-12

HANDOFF §3, §11 and §12 M9. The desktop app is `apps/desktop`: Electron 44 with a React 19 renderer, built with electron-vite and packaged with electron-builder. The headless client is packaged as a tarball with a systemd unit.

## Processes

- **Main** (`src/main/index.ts`) owns the window, the tray, the keys, the core host and auto-update. It holds no app logic.
- **Core host** (`src/main/core-host.ts`) runs `CommunalCore` and `LocalApi` in an Electron `utilityProcess`, configured the same way as `communal daemon`: router port mapping on (unless `COMMUNAL_UPNP=false`), upload-log pruning. It never imports Electron. If it crashes, main restarts it with backoff and gives up after five quick failures, showing the reason.
- **Renderer** is a sandboxed page (`contextIsolation`, no Node) with a strict CSP. Inline scripts are allowed only by the dev server.

Electron 44 runs Node 24.21. Every native module the core uses ships N-API prebuilds (better-sqlite3 13, udx-native, sharp, @napi-rs/canvas, sodium-native), so nothing is rebuilt for Electron (`npmRebuild: false`). The smoke test proves it in both the dev build and the packaged app.

## Talking to the core

- The local API listens on 127.0.0.1 with a random 32-byte token that only main knows.
- The renderer calls `communal://api/<path>`. That is a privileged custom scheme main serves with `protocol.handle`, adding the token and streaming the response. `<img>` thumbnails and `<video>` streams use the same URLs, ranges included. The token never reaches the renderer, so a compromised page can't hand it to anyone.
- **Events:** the core's local API gained `GET /v1/events` (WebSocket, same token). It sends topic hints only (`hubs`, `presence`, `people`, `devices`, `transfers`, `index`, `subscriptions`), coalesced to at most one message every 250 ms, never data. Main forwards them over IPC, and the renderer invalidates the TanStack Query entries tagged with those topics. Screens therefore refresh when something changes instead of polling. A slow poll stays as a fallback.
- The preload exposes a small bridge (`window.communal`) for what a page can't do itself: folder and file pickers, saving the recovery file, opening paths, update state.

## Keys at rest

- The device key, and on a restored device the root key, are kept in `<userData>/{device,root}.key.enc`, encrypted with `safeStorage` (Keychain, DPAPI, libsecret or kwallet).
- Where `safeStorage` has no backend (Linux with no keyring), they fall back to `*.key` files with mode 0600, like the headless client, and main logs a warning. A plain file is encrypted and removed once encryption is available.
- Main decrypts the keys and passes them to the core host in its init message, never through the environment. A restore that produces a root key sends it back to main to be stored the same way.
- Smoke-test profiles (`COMMUNAL_SMOKE=1`) never touch the OS keychain, so CI can't hang on a prompt.

## Settings that persist

Upload limits and the thumbnail-cache cap changed through the API are now kept in `<data>/settings.json` (`CommunalCore.updateSettings`). They take precedence over what the host passes in: the CLI's environment variables, or the desktop's defaults. Before M9 they were held in memory only and lost on restart.

New API: `GET/PUT /v1/settings/storage` and `POST /v1/settings/storage/clear` (the thumbnail cache).

## Other API additions for the screens

- **`GET /v1/library`** fans the new hub message `library` out to every hub (ADR 0004). It returns every device the account can browse, each with its owner's checked identity (`checkSummary`), `online` and the rounded `seen` (ADR 0015). The Library screen ("people → their computers → folders") had no way to find another person's devices before: presence only covers devices online right now. The hub builds the list from the social graph (own devices, connections, people sharing with the whole hub), and keeps a device only if `Catalog.visible()` shows the viewer something on it.
- **`GET /v1/downloads`** rows carry `sources`: the devices a running download is fetching from, with verified bytes and a rate over the last second or so (HANDOFF §11 "per-source speeds"). A source that stalls reports 0.
- **`status().hubs[].problem`**: why a hub isn't usable when the person must act (waiting for admin approval, banned, hub key changed, link denied).
- **`GET /v1/self-check`** (`selfCheck()` in core; `communal check` in the CLI) loads and runs each platform piece: SQLite, the UDP socket, sharp, canvas, pdf.js, ffmpeg and the trash helper.
- `LocalApi.listen` rejects with a clear message instead of crashing when the socket path is too long or the port is taken.

## Screens

All of HANDOFF §11, and nothing reaches past the local API:

- **First launch:** New / Add this computer / Restore. While a link waits for approval, the new device's ID is shown so it can be compared on the approving device.
- **Library:** people → computers → folders. Grid or list, with batched thumbnails, preview (pictures, PDF pages, text peek, streamed video and audio), Download and Subscribe.
- **Search:** one row per file content, filters by kind and size, and "Show only available files" (`available=week`, ADR 0015).
- **My shares:** add and remove folders, list a share per hub, hashing and preview progress, and the access picker. It works on one hub at a time and says so ("These choices apply on X only").
- **People:** requests, connections, user search, safety-code verification, groups.
- **Transfers:** progress, speed per source, the diagnosis with tips and who can fix it.
- **Subscriptions:** asks about mirroring deletions every time, with "No" preselected.
- **Activity:** the upload log.
- **Settings:** account and recovery key, devices (link codes, approvals showing the requesting device ID, revoke), hubs (a list, ADR 0007), network check, sharing speed, storage.

**Visual direction:** a cool sage-grey workspace in light and dark. Each person's identity disc, coloured from their fingerprint, is the one saturated element. Type is Atkinson Hyperlegible Next (bundled, since the CSP allows no remote fonts). Copy is written for people who have never heard of a hub.

Closing the window keeps the app sharing in the background. It quits from the tray or the app menu, and quitting stops the core cleanly.

## Packaging

- **Desktop:** `pnpm --filter @communal/desktop package`.
  - It builds, makes a flat production copy with `pnpm deploy --config.node-linker=hoisted`, runs electron-builder on that copy, then smoke-tests the unpacked app.
  - Targets: macOS dmg + zip, Windows NSIS, Linux AppImage + deb. Each platform builds its own, since the native prebuilds are per platform.
  - **No asar.** The core spawns ffmpeg by path (Electron only redirects `execFile`, not `spawn`, into `app.asar.unpacked`, and that's unclear inside a `utilityProcess`). The `trash` package execs its bundled helper. pdf.js reads font files from disk. Unpacking everything that matters would leave almost nothing in the archive, and the archive isn't a security boundary. Sources and builds nothing loads (better-sqlite3's C sources, unused pdf.js builds) are excluded. The macOS app is about 175 MB.
  - **Signing hooks:**
    - macOS uses `CSC_LINK` / `CSC_KEY_PASSWORD` or a keychain identity, with hardened runtime and `build/entitlements.mac.plist`. `scripts/notarize.mjs` notarizes and staples when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are set.
    - Windows uses `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`.
    - Without these, builds are unsigned. Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to stop electron-builder from picking up a local identity.
  - **Auto-update:** electron-updater with a generic HTTPS feed. Building with `COMMUNAL_UPDATE_URL` writes `app-update.yml`. The app checks at start and every 6 hours, downloads in the background, installs on quit or on "Restart to update". Without a feed the updater stays off.
  - `.github/workflows/release.yml` packages every platform on a `v*` tag and uploads the artifacts. Uploading them to the feed is manual for now.
- **Smoke test:** `COMMUNAL_SMOKE=1` starts the app with no window. The core must start and `/v1/self-check` must pass. It runs in CI on all three OSes (`desktop` job) and at the end of every package build.
- **Headless:** `pnpm --filter @communal/cli package` makes `communal-<version>-<os>-<arch>.tar.gz`. It contains the CLI with production dependencies, `bin/communal`, `communal.service`, `communal.env.example` and `install.sh`. The installer needs Node 24, creates a `communal` system user, installs to `/opt/communal`, and enables the service. The service is hardened: read-only system and home, writable `/var/lib/communal` only. The Docker image (`docker/headless.Dockerfile`) remains the other route. The hub image is unchanged.

## Not done

- Uploading release artifacts to the update feed, and choosing where the feed lives (owner decision).
- Code-signing certificates: the hooks are in place, the certificates are the owner's.
- Release versions: every package is still `0.0.0`.
- A project homepage. The deb format requires one, so `apps/desktop/package.json` has the reserved placeholder `https://communal.invalid`.
