# Communal for Android

A download-only client (ADR 0023): search, browse, previews, downloads, folders kept in sync (music from your computer, say), and remote control of your computers. It never shares the phone's own files.

The app is a Kotlin/Compose shell around the unchanged TypeScript core:

- `node/main.ts` is the phone's core host, the counterpart of `communal daemon` and the desktop's `core-host.ts`. It reads the device key and API token on stdin and serves the local API on 127.0.0.1.
- `app/` is the Android app:
  - `CoreHost` runs `libnode.so main.mjs` as a child process. `DeviceKeys` keeps the device key wrapped by the Android Keystore.
  - `CoreService` (foreground, while the app is open or a download moves) and `SyncWorker` (WorkManager, short background catch-up windows) decide when the core runs, through `Keeper`.
  - `Api` is the typed local API client, and `ui/` holds the Compose screens.
- Downloads go to `Download/Communal` on shared storage, and finished files are scanned into the media library. Mirrored deletions go to the app's trash (`Android/data/…/files/trash`), emptied after 30 days.

## Building

Needs JDK 21, the Android SDK (`platforms;android-36`, NDK 28.2) and patchelf.

```sh
sh scripts/fetch-node.sh arm64-v8a      # Termux's Node 24, pinned by SHA-256, into runtime/
sh scripts/prepare-jnilibs.sh arm64-v8a # the runtime into jniLibs/, the core bundle into assets/
./gradlew :app:assembleDebug            # or: pnpm --filter @communal/android package (release)
```

Add `x86_64` to both scripts, and to `communal.abis` in `gradle.properties`, for an emulator on an Intel host.

Debug builds get the `.dev` application id and accept a dev hub's self-signed certificate, so they install next to a release. From the emulator the host is `10.0.2.2`, so a dev hub on port 18443 is `10.0.2.2:18443`.

## Releases

`pnpm release` builds the APK in GitHub Actions (`release.yml`, the `android` job) and attaches `communal-<version>-arm64.apk` to the release. The app checks the latest release once a day and offers the update.

Every release must be signed with the same key, or installed phones can't update. The key lives only in the repository's secrets:

- `ANDROID_KEYSTORE_B64`: the keystore, base64-encoded.
- `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

To make one: `keytool -genkeypair -v -keystore communal-release.jks -alias communal -keyalg RSA -keysize 4096 -validity 36500`, then `base64 -i communal-release.jks`. Keep a copy of the keystore somewhere safe: losing it means every phone has to uninstall and reinstall. Without the secrets, a release goes out without an APK and the job leaves a warning.
