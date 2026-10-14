#!/bin/sh
# Link-quality lab (ADR 0024). For each condition, shapes both clients' links with tc netem
# (applied on each side's egress, so a "delay 2ms" condition is a 4 ms round trip), then
# measures a real download (node-b downloads a file node-a shares) and the bare transport
# (communal-spike, one udx stream with Noise) between the same two containers.
#
# Usage: docker/netem/test.sh [-s SIZE_MB] ["<netem args>" …]
#   docker/netem/test.sh                                  (the default set of conditions)
#   docker/netem/test.sh -s 256 "delay 3ms 1ms loss 0.5%"
# NETEM_UDX=<udx-native.node> swaps in another linux-arm64 udx-native build (both nodes, CLI
# and spike) to A/B a libudx change. NETEM_NO_BUILD=1 skips rebuilding the images.
set -eu
cd "$(dirname "$0")/../.."
F=docker/compose.netem.yml
dc() { docker compose -f "$F" "$@"; }
cleanup() { dc down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT
A() { dc exec -T node-a communal "$@"; }
B() { dc exec -T node-b communal "$@"; }

MB=512
if [ "${1:-}" = -s ]; then
  MB=$2
  shift 2
fi
if [ $# -eq 0 ]; then
  set -- none "delay 2ms" "delay 2ms loss 0.5%" "delay 2ms 1ms" "delay 2ms reorder 1%" \
    "slot 2ms 4ms" "delay 3ms 1ms loss 1%"
fi

if [ -z "${NETEM_NO_BUILD:-}" ]; then
  docker compose -f docker/compose.dev.yml build -q
  docker compose -f docker/compose.nat.yml build -q node-a
fi
cleanup
dc up -d >/dev/null 2>&1
if [ -n "${NETEM_UDX:-}" ]; then
  for n in node-a node-b; do
    for app in cli spike; do
      docker cp "$NETEM_UDX" "$(dc ps -q $n):/app/$app/node_modules/.pnpm/udx-native@1.21.3/node_modules/udx-native/prebuilds/linux-arm64/udx-native.node"
    done
  done
  dc restart node-a node-b >/dev/null 2>&1
fi
for _ in $(seq 60); do
  if A status 2>/dev/null | grep -q '"ready": true' && B status 2>/dev/null | grep -q '"ready": true'; then break; fi
  sleep 1
done
dc exec -T node-a sh -c "mkdir -p /shares/lab && head -c $((MB * 1048576)) /dev/urandom >/shares/lab/netem-file.bin"
A share add /shares/lab --name Lab >/dev/null
A acl set Lab/ hub --hub "$(A hub list | awk '{print $1}')" >/dev/null
HASH=
for _ in $(seq 120); do
  HASH=$(B search netem-file --json 2>/dev/null | sed -n 's/.*"hash": *"\([0-9a-f]\{64\}\)".*/\1/p' | head -1)
  [ -n "$HASH" ] && break
  sleep 1
done
[ -n "$HASH" ] || { echo "FAIL: file never showed up in search"; exit 1; }

shape() {
  for n in node-a node-b; do
    dc exec -T "$n" tc qdisc del dev eth0 root 2>/dev/null || true
    [ "$1" = none ] || dc exec -T "$n" tc qdisc add dev eth0 root netem $1
  done
}

# Downloads the file on node-b and prints MB/s (timed inside the container, polling).
download() {
  dc exec -T node-b sh -c "rm -rf /var/lib/communal/downloads/*; communal transfers --clear >/dev/null
    t0=\$(date +%s.%N); communal get $HASH >/dev/null
    for _ in \$(seq 1200); do
      s=\$(communal transfers | awk 'NR==1 {print \$2}')
      [ \"\$s\" = done ] && break
      [ \"\$s\" = failed ] && { echo failed; exit 1; }
      sleep 0.2
    done
    t1=\$(date +%s.%N)
    [ \"\$s\" = done ] || { echo timeout; exit 1; }
    echo \"\$t0 \$t1\" | awk -v b=$((MB * 1048576)) '{printf \"%.1f MB/s (%.1f s)\", b / 1e6 / (\$2 - \$1), \$2 - \$1}'"
}

spike() {
  dc exec -T node-a timeout 120 communal-spike peer --me alice --peer bob --role up --port 41700 \
    --peer-addr 172.31.0.30:41700 --bytes "${MB}M" >/dev/null 2>&1 &
  dc exec -T node-b timeout 120 communal-spike peer --me bob --peer alice --role down --port 41700 \
    --peer-addr 172.31.0.20:41700 --bytes "${MB}M" 2>/dev/null |
    sed -n 's/.*"seconds":\([0-9.]*\),"MBps":\([0-9.]*\).*/\2 MB\/s (\1 s)/p'
  wait
}

printf '%-32s %-24s %s\n' "netem (each side)" "download (${MB} MiB)" "spike (1 stream)"
for C in "$@"; do
  shape "$C"
  D=$(download || echo "failed")
  S=$(spike || echo "failed")
  printf '%-32s %-24s %s\n' "$C" "$D" "${S:-failed}"
done
