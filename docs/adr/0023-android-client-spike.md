# ADR 0023 — Android client: embed the TypeScript core (spike)

- Status: **proposed** (draft for the owner). HANDOFF §2 lists mobile as out of scope, so this is a proposal, not a decision.
- Date: 2026-10-14
- Spike code: `apps/android-spike/` (experimental, not shipped, not built by CI beyond typecheck and lint)

## Question

Can an Android app run the existing `@communal/core` in-process (or next to the app), with a native Jetpack Compose UI on top of the local API? Or do we have to port the core to Kotlin?

The app we'd build is **download-only**: search, browse, previews (thumbnails come from the sharing peer), downloads and subscriptions (the main use: mp3s from your computer into the phone's Music collection). Later, a phone remote-controlling one of your desktops. No sharing, no indexer, no media worker, no ffmpeg. Kotlin would own the foreground service, WorkManager and MediaStore.

## Short answer

**Yes: embed the core with Node 24.** On an Android 15 arm64 emulator, the unmodified core linked as a device of an existing account, signed in to a dev hub, searched, downloaded 50 MiB directly from a headless peer on the host over udx + Noise (hash verified), and followed a subscription: a new file and a mirrored deletion both reached the phone. Then the same core ran inside a 45.6 MB APK, started by Kotlin as a child process, and a Compose screen did the link, search and download through the local API.

Nothing in `packages/core` had to change. The work is in the runtime build, packaging and Android lifecycle, not in the core.

## What ran

Host: M4 MacBook Pro. Emulator: `system-images;android-35;google_apis;arm64-v8a` (Pixel 7 profile). NDK r28c (28.2.13676358). Dev hub from `pnpm --filter @communal/hub dev` on port 18443; "desktop" peer: a headless `communal daemon` on the host with a 50 MiB and a 4 MB file shared as `Music`.

| Step                                                                                 | Result                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Node 24 on the emulator                                                              | ✅ Termux `nodejs-lts` 24.18.0: `v24.18.0 android arm64 napi 10`                           |
| Core bundle starts (SQLite store, udx socket, local API)                             | ✅ unmodified core, 1.34 MB esbuild bundle + 4.8 MB native addons                          |
| Link the phone to an existing account (ADR 0014) via `POST /v1/account/link`         | ✅ approved on the desktop, phone signed in to the hub                                     |
| Search                                                                               | ✅ both files, with the desktop as source                                                  |
| Direct download, peer transport (udx-native + secret-stream)                         | ✅ 50 MiB in ~6.5 s through the emulator's user-mode NAT, SHA-256 identical                |
| Subscription to the desktop's `Music`, then a file added on the desktop              | ✅ existing files arrived, the new one followed within seconds                             |
| Mirrored deletion                                                                    | ❌ then ✅: `trash` isn't shipped; with a `subscriptions.trash` handler it worked          |
| APK: Kotlin starts `libnode.so` from `nativeLibraryDir`, Compose calls the local API | ✅ link, search and download from the UI (screenshot: `apps/android-spike/screenshot.png`) |
| Native addons inside the APK's sandbox (better-sqlite3, udx-native, sodium-native)   | ✅ loaded from `filesDir` by the app's uid                                                 |

Throughput through the emulator's NAT says nothing about real phones and wasn't a goal. The transport itself is the same code as desktop (ADR 0001).

## The three runtimes

### nodejs-mobile: dead for us

Its newest release is **v18.20.4 (2024-10-07)**, two years without a release, and Node 18 has been end-of-life since April 2025. Our dependency tree requires newer Node: `better-sqlite3` 13 and `file-type` 22 declare `node >=22`, `chokidar` 5 needs `>=20.19`, and the repo itself says `>=24`. Downgrading those would fork our dependency set for one client. Not run on a device; the version gap settles it.

### Node 24: works, but we need our own build eventually

- **Upstream's `android-configure` doesn't build out of the box.** On a macOS host, gyp builds the host tools (`node_js2c` → host libuv) with `OS=android` and fails on Linux headers. In a Linux x86_64 container (Node's supported host), it fails in host `v8_libbase` (`backtrace` undeclared). Both are the same class of bug: host targets inherit the Android defines. Even `--without-node-snapshot` didn't help.
- **Termux does build it** with 13 source patches (gyp, libuv, V8 trap handler, `child_process`, `os`, getaddrinfo…) and a Chromium clang for host tools. Their maintainer notes each update takes about two hours per architecture plus patch upkeep. That's the realistic cost of owning a Node build for Android.
- **For the spike we used Termux's prebuilt `nodejs-lts` 24.18.0** with its shared libraries (OpenSSL 3, ICU 78, c-ares, zlib, SQLite, libc++). APKs only extract files named `lib*.so`, so `scripts/prepare-jnilibs.sh` renames the executable to `libnode.so` and rewrites versioned sonames (`libssl.so.3` → `libssl3.so`) with patchelf. Fine for a spike. For a product we'd build Node ourselves from Termux's patch set, with bundled OpenSSL and small-icu, ideally as a shared library loaded over JNI (see "Process model").

### Bare (Holepunch): close, not there

Bare 1.35.1 with `bare-node-runtime` 1.5.1 maps every Node builtin core uses. Our transport libraries are native there (`.bare` prebuilds), and **better-sqlite3's N-API addon loads in Bare too**. On the Mac, the core started under Bare and served its local API after these fixes:

1. An import map has to be added to every package's `package.json`, including the copied native packages. The map passed on a dynamic `import()` didn't reach dependencies.
2. `fs.watchFile` / `fs.unwatchFile` are missing (chokidar). Shimmed.
3. `crypto.randomInt` is missing. Shimmed.
4. The ESM bundle's `createRequire` resolved to npm `bare-module` 6.4, whose addon protocol doesn't match the 1.35 runtime (`defaultProtocol.postresolve is not a function`). We switched to a CommonJS bundle.
5. `delete process.env.X` throws (the `debug` package does it). Fixed by swapping in a plain object.
6. **The hub connection never came up:** `CERTIFICATE_VERIFY_FAILED`. `ws` → `bare-https` drops the TLS options, so `rejectUnauthorized: false` for the dev hub's self-signed certificate never reaches `bare-tls`. We stopped there. We also didn't learn whether real certificates verify against Android's CA store under Bare.

Each gap was small, but they keep coming, they sit in someone else's compatibility layer, and two of them were version skew inside Holepunch's own packages. Node runs the same code paths that desktop and CI test. The Bare runtime npm package for android-arm64 is 85 MB unpacked, so it isn't an obvious size win either (not measured stripped).

## Making core loadable without the sharing stack

Core already loads the heavy parts lazily. `sharp`, `@napi-rs/canvas`, `pdfjs-dist`, `music-metadata` and `exifr` are behind `await import()` in `media/analyze.ts` and `selfcheck.ts`. `ffmpeg-static` sits behind `createRequire` in `media/ffmpeg.ts`, `trash` behind `osTrash`, and `@achingbrain/nat-port-mapper` inside `RouterPortMapper`. The eager imports that remain (`chokidar`, `file-type`, `hash-wasm`) are pure JS and load fine on Android. The esbuild bundle (`scripts/build.mjs`) marks the heavy packages external and doesn't ship them. A stray import would fail loudly, and none happened in the slice.

What the Android host has to supply, all through options that already exist:

- `network: {}`: no UPnP mapper. A phone doesn't own its router.
- `subscriptions.trash`: mirrored deletions. The spike moves files to `<data>/trash/`. The app would use `MediaStore.createTrashRequest` for files in the Music collection.
- Downloads land in a plain directory. Adding them to MediaStore is the Kotlin side's job.

So **no core changes were needed and none are committed**. Two small follow-ups belong in the real app:

- `Platform` in `packages/protocol/src/common.ts` is `darwin | win32 | linux`, so a phone shows up as "linux" in link requests and device lists. Add `android` (protocol change, ADR 0004).
- The media-only `createRequire(import.meta.url)` calls are empty in a CommonJS bundle. That only matters if we ever go the Bare route.

## better-sqlite3

No swap needed. better-sqlite3 13 is an **N-API addon** (`NAPI_VERSION=10`), so one build works with any Node 24.x. `scripts/ndk-sqlite.sh` compiles the SQLite amalgamation (FTS5 and the package's other defines included) plus the addon with the NDK clang directly, with no gyp, in **15 s**. The result is a 2.1 MB stripped `.node` that loaded and ran the store on the emulator. Fallback if it ever breaks: Node 24's built-in `node:sqlite`. Core uses a small slice of the better-sqlite3 API (`prepare/run/get/all/iterate`, `pluck`, `pragma`, `transaction`, `exec`), which a thin adapter could cover.

## Size and memory

| What                                   | Measured                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| APK (arm64-v8a only, release)          | **45.6 MB**                                                                                         |
| Native libs extracted on install       | 101 MB: `libnode.so` 55 MB, ICU data 33 MB, OpenSSL 6.4 MB, ICU code 7.6 MB, rest ~3 MB             |
| Installed total                        | ~152 MB (101 MB libs + 43 MB APK + 7.7 MB core unpacked into `filesDir`)                            |
| Core bundle                            | 1.34 MB JS (51 packages) + 4.8 MB addons (better-sqlite3 2.1 MB, sodium 1.8 MB, udx 0.6 MB)         |
| Core process, idle after sign-in       | RSS 70–88 MB, V8 heap 14–17 MB                                                                      |
| Core process, during a 50 MiB download | RSS peak 103.5 MB (VmHWM); PSS 94 MB                                                                |
| Compose UI process                     | PSS 48 MB                                                                                           |
| Start                                  | 605 ms from app start to API ready on first launch (includes unpacking 7.7 MB); 38–181 ms in-script |

Two things would shrink this a lot:

- Our own Node build with **small-icu** saves about 30 MB of ICU data (core shows no sign of needing locale data, but that needs checking).
- **Loading Node as a shared library over JNI**, instead of executing it, lets the APK keep its libraries compressed and unextracted. The installed size then roughly equals the APK.

A realistic target is a 25–30 MB APK and about 60 MB installed.

## Process model

The spike runs the core as a **child process** of the app, the way Electron runs it in a `utilityProcess` (ADR 0016). Kotlin reads the `API <url>` line and keeps the bearer token. That proved the Compose-over-local-API seam with no glue code. For a product it has two Android-specific risks:

- **Phantom process killer** (Android 12+): the system kills child processes of apps, especially busy ones in the background. That's exactly when a subscription would be syncing.
- **Foreground-service limits:** a `dataSync` foreground service is capped at 6 hours a day on Android 15. Subscriptions should run in short WorkManager windows ("check every few hours, or on Wi-Fi + charging"), with a foreground service only while a user-started download is running.

So the real app should embed Node **in-process** (`libnode.so` built with `--shared`, started on a JNI thread, the nodejs-mobile approach). The local API stays the seam either way: loopback HTTP with a token, or a Unix socket in the app's private directory.

## Not covered by the spike

- A physical phone, cellular data, x86_64 emulators, and Android versions below 15.
- Carrier-grade NAT. A phone on mobile data is often behind symmetric NAT or CGNAT, so with no relay (HANDOFF invariant) many phone ↔ home-desktop transfers will fail with `connect.failed`. ADR 0011 diagnostics will explain why, but the success rate on cellular is the biggest product risk, and it's the same for any runtime. Wi-Fi at home or on the same LAN is the case that works.
- Doze and app-standby behaviour, network changes mid-transfer, battery.
- Previews (thumbnails, peek, streaming). They use the same peer protocol as the download that worked, but weren't exercised.
- Remote control (see "Remote control (later)").

## Remote control (later)

The phone asks one of your desktops to download something. Not built and not part of the spike. These are the decisions so far, including the owner's: "we can do a sealed fallback through the hub".

**Primary path: a direct peer session.**

- The phone opens a session with the new peer purpose `hello.purpose: 'control'`, over the normal udx + Noise transport (ADR 0001, 0010).
- The desktop accepts it only when the peer's cert chain belongs to **the same account** and no device in it is revoked (`Revocations.revokedFor`).
- The hub brokers it with a `connect.request` variant that it allows only between devices of the same account.

**Commands are an allowlist:** download a file, download a folder, subscribe, list transfers, cancel.

- Never devices, recovery, linking, sharing, access rules or hub admin. That's narrower than the MCP tool set (ADR 0017).
- The phone does its own search and browse, so control doesn't need them.

**The desktop opts in.** A setting, "Let my phone start downloads", is off by default. Every remote request shows in Activity with the phone as the requester.

**Fallback (owner decision): sealed messages through the hub.** When no direct path exists (`connect.failed`), the phone sends the same command through the hub instead.

- **Sealing:**
  - The target device's Ed25519 key is converted to X25519 (`edwardsToMontgomery` in `@noble/curves`, already a dependency).
  - The phone seals to it with an ephemeral X25519 key. The shared secret goes through HKDF-SHA256 into XChaCha20-Poly1305, the AEAD the recovery file already uses.
  - A sealed box hides the sender, so the plaintext carries the phone's device id and cert chain, plus an Ed25519 signature over the command, its nonce and the target's device id. The desktop checks the chain against the account root and `Revocations.revokedFor`, exactly as for a peer session.
- **Hub:** it forwards the opaque blob only between devices of the same account. A banned sender, or a revoked sender or target, is refused.
- **Replies and status:** they come back the same way, sealed to the phone.
- **Limits:** a small size cap, plus per-account rate and queue limits under ADR 0022. Messages for an offline device wait only briefly.
- **Replay protection:** a random nonce and a timestamp. The desktop refuses anything older than a short expiry, and keeps a seen-set of nonces for that window.
- **No file data ever goes through the hub.** Only commands and status do. The hub learns only that your devices exchanged messages, and when.
- It needs new hub messages (record them in ADR 0004 when built) and hub tests: same account only, banned or revoked senders rejected.

**A pending invariant change.** When this is built, "No relay, ever" in CLAUDE.md and HANDOFF becomes "no file data is ever relayed; only sealed control messages between your own devices". It isn't changed now.

**Estimate:** about 3–5 weeks including the fallback, on top of the table below.

## Recommendation

1. **Build the Android client on the embedded TypeScript core with Node 24 LTS, not Bare, and don't port to Kotlin.** The core worked unchanged. A Kotlin port would re-implement the hub protocol, Noise/udx framing, the downloader, subscriptions and account linking, and then keep them in sync forever.
2. Own the runtime build: Node LTS for android-arm64 (plus x86_64 for emulators) from Termux's patch set, with bundled OpenSSL, small-icu and `--shared`, built in a CI job and pinned. Refresh it once or twice a year, not every Node minor. Until that job exists, Termux's `.deb`s (pinned by version and hash) are a working stopgap.
3. Keep Bare as the fallback if the Node build becomes too costly to maintain. Its remaining gaps looked fixable upstream, but nobody has shown a hub session over TLS on it yet.

## Revised estimate (one person)

| Piece                                                                                                    | Estimate      |
| -------------------------------------------------------------------------------------------------------- | ------------- |
| Node 24 Android build in CI (Termux patches, `--shared`, small-icu, arm64 + x86_64), JNI start/stop      | 1.5–2 wk      |
| Core host on Android: asset unpacking and versioning, addons, local API over a private socket, lifecycle | 1 wk          |
| Small core/protocol changes: `android` platform, MediaStore trash and placement hooks, mobile defaults   | 0.5–1 wk      |
| Compose UI: linking (QR), search, browse, previews, transfers, subscriptions, settings                   | 3–4 wk        |
| Background: WorkManager sync windows, foreground service for active downloads, network/Doze handling     | 1–1.5 wk      |
| Release: signing, update channel (Play or direct APK), real-device testing on Wi-Fi and cellular         | 1 wk          |
| **Total**                                                                                                | **8–10.5 wk** |

A Kotlin port would add the earlier 4–8 weeks on top, plus the ongoing cost of keeping two implementations in sync. Remote control would add about 3–5 weeks to either (see "Remote control (later)").
