#!/bin/sh
# Builds better-sqlite3's addon for Android with the NDK clang
# directly: it's one N-API addon plus the SQLite amalgamation, so no gyp and no host tools.
# better-sqlite3 13 uses N-API (NAPI_VERSION=10), so the result works with any Node >= 22.14.
#
#   scripts/ndk-sqlite.sh <out.node> [arm64|x86_64] [api level]
set -eu
OUT=$1
ARCH=${2:-arm64}
API=${3:-24}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
NDK=${ANDROID_NDK_HOME:-$HOME/Library/Android/sdk/ndk/28.2.13676358}
TC=$NDK/toolchains/llvm/prebuilt/$(uname | tr A-Z a-z)-x86_64
case $ARCH in
  arm64) TRIPLE=aarch64-linux-android ;;
  x86_64) TRIPLE=x86_64-linux-android ;;
esac
CC="$TC/bin/$TRIPLE$API-clang"
CXX="$TC/bin/$TRIPLE$API-clang++"
BS=$(ls -d "$ROOT"/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 | tail -1)
NAA=$(dirname "$BS")/node-addon-api
# node_api.h and js_native_api.h: the headers of the Node we run (any 24.x; N-API is stable).
NODE_INC=${NODE_INCLUDE:-$(dirname "$(dirname "$(command -v node)")")/include/node}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

DEFINES=$(sed -n "s/^ *'\([A-Z0-9_]*\(=[^']*\)\{0,1\}\)',$/-D\1/p" "$BS/deps/defines.gypi" | tr '\n' ' ')
# shellcheck disable=SC2086
"$CC" -c -O2 -fPIC -std=c99 -w $DEFINES -o "$TMP/sqlite3.o" "$BS/deps/sqlite3/sqlite3.c"
"$CXX" -c -O2 -fPIC -std=c++20 -fvisibility=hidden -fvisibility-inlines-hidden \
  -DNAPI_VERSION=10 -DNAPI_DISABLE_CPP_EXCEPTIONS -DNODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS \
  -DBUILDING_NODE_EXTENSION -I"$BS/deps/sqlite3" -I"$NAA" -I"$NODE_INC" \
  -o "$TMP/better_sqlite3.o" "$BS/src/better_sqlite3.cpp"
# N-API symbols come from the node executable at load time.
"$CXX" -shared -static-libstdc++ -Wl,-z,undefs -Wl,--exclude-libs,ALL -Wl,-Bsymbolic \
  -o "$OUT" "$TMP/better_sqlite3.o" "$TMP/sqlite3.o" -ldl -lm
"$TC/bin/llvm-strip" "$OUT"
ls -l "$OUT"
