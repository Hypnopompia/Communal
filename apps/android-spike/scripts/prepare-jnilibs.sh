#!/bin/sh
# EXPERIMENTAL (Android spike). Puts a Node 24 runtime and the core bundle into the APK sources.
#
# Node: Termux's nodejs-lts build and the shared libraries it needs (upstream Node's Android
# cross-build doesn't work without Termux's patches; see the ADR). An APK only extracts files named
# lib*.so, so the executable becomes libnode.so and versioned sonames (libssl.so.3…) are renamed
# with patchelf. Kotlin runs nativeLibraryDir/libnode.so as a child process: apps may exec files
# from nativeLibraryDir, not from their writable data dir.
#
#   scripts/prepare-jnilibs.sh <termux usr dir> <better_sqlite3.node for android-arm64>
set -eu
USR=$1
SQLITE=$2
HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT=$HERE/app/src/main/jniLibs/arm64-v8a
ASSETS=$HERE/app/src/main/assets
STRIP=${ANDROID_NDK_HOME:-$HOME/Library/Android/sdk/ndk/28.2.13676358}/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-strip
rm -rf "$OUT" && mkdir -p "$OUT"

# soname -> APK-safe file name
cat > /tmp/communal-sonames.$$ <<'EOF'
libz.so.1 libz1.so
libcares.so libcares.so
libsqlite3.so libsqlite3.so
libcrypto.so.3 libcrypto3.so
libssl.so.3 libssl3.so
libicui18n.so.78 libicui18n78.so
libicuuc.so.78 libicuuc78.so
libicudata.so.78 libicudata78.so
libc++_shared.so libc++_shared.so
EOF
renames() {
  while read -r from to; do
    [ "$from" != "$to" ] && patchelf --replace-needed "$from" "$to" "$1"
  done < /tmp/communal-sonames.$$
  patchelf --remove-rpath "$1"
}
while read -r from to; do
  cp "$USR/lib/$from" "$OUT/$to"
  chmod u+w "$OUT/$to"
  patchelf --set-soname "$to" "$OUT/$to"
  renames "$OUT/$to"
done < /tmp/communal-sonames.$$
cp "$USR/bin/node" "$OUT/libnode.so"
chmod u+w "$OUT/libnode.so"
renames "$OUT/libnode.so"
"$STRIP" "$OUT"/*.so 2>/dev/null || true
rm /tmp/communal-sonames.$$

# The core bundle, unpacked by the app into filesDir on first start.
(cd "$HERE" && node scripts/build.mjs --target android-arm64 --sqlite "$SQLITE")
rm -rf "$ASSETS/core" && mkdir -p "$ASSETS"
cp -R "$HERE/dist/node" "$ASSETS/core"
# AAPT drops asset files and dirs starting with "_" or "."; none here, but keep an index for copying.
(cd "$ASSETS/core" && find . -type f | sed 's#^\./##' | sort > ../core-files.txt)
du -sh "$OUT" "$ASSETS/core"
