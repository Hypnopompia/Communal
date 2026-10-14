# Android spike (experimental)

**Not a product.** A feasibility spike for an Android client: can the TypeScript core run on a
phone, under a Jetpack Compose UI that talks to the local API? Findings and the recommendation
are in [docs/adr/0023-android-client-spike.md](../../docs/adr/0023-android-client-spike.md).

- `node/main.ts`: the phone's core host (like `communal daemon` or the desktop `core-host.ts`).
- `scripts/build.mjs`: bundles it with esbuild and copies the native addons for one target.
- `scripts/ndk-sqlite.sh`: builds better-sqlite3 for Android with the NDK.
- `scripts/prepare-jnilibs.sh`: puts Termux's Node 24 and the bundle into the APK sources.
- `scripts/node-android.Dockerfile`: an attempt at building upstream Node for Android (fails; see the ADR).
- `app/`: the Kotlin/Compose shell (Gradle; AGP 9.3, compileSdk 36, arm64 only).

## Reproducing

Needs JDK 21, the Android SDK (platform-tools, emulator, `platforms;android-36`, NDK 28.2,
`system-images;android-35;google_apis;arm64-v8a`), Gradle and patchelf.

1. Start a dev hub: `COMMUNAL_HUB_PORT=18443 pnpm --filter @communal/hub dev`.
2. Run a headless peer on the host that has joined `wss://127.0.0.1:18443/v1` and shares a folder,
   and give it `COMMUNAL_ADVERTISE_ADDR=<host LAN IP>:<port>`.
3. Unpack Termux's `nodejs-lts` and its dependency `.deb`s (aarch64), then
   `scripts/ndk-sqlite.sh out/better_sqlite3.node` and
   `scripts/prepare-jnilibs.sh <termux>/data/data/com.termux/files/usr out/better_sqlite3.node`.
4. `./gradlew :app:assembleRelease`, install it, then run `communal devices add --yes` on the host
   and type the code into the app. The hub field defaults to `wss://10.0.2.2:18443/v1` (the host,
   seen from the emulator).

The app accepts the dev hub's self-signed certificate (`COMMUNAL_INSECURE_TLS`). That is spike-only.
