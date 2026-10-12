#!/bin/sh
# NAT lab (M4 transfers, M5 diagnostics). Each scenario starts two clients behind their own
# routers (docker/nat/router.sh modes), shares a file from node-a and downloads it on node-b:
#   cone / cone           transfers intact via hole punching; then node-a stops → peer_offline
#   cone / symmetric      no direct path → both_restrictive_nat (easier fix: the cone side)
#   cone / udp_blocked    node-b's network drops UDP → udp_blocked (easier fix: node-b)
# Usage: docker/nat/test.sh [scenario…]   (default: all; names: cone symmetric udp_blocked)
set -eu
cd "$(dirname "$0")/../.."
F=docker/compose.nat.yml
dc() { docker compose -f "$F" "$@"; }
cleanup() { dc down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT
A() { dc exec -T node-a communal "$@"; }
B() { dc exec -T node-b communal "$@"; }
fail() {
  echo "FAIL: $*"
  B transfers || true
  exit 1
}

docker compose -f docker/compose.dev.yml build -q
dc build -q
FILE=$(mktemp)
head -c 12000000 /dev/urandom >"$FILE"
WANT=$(sha256sum "$FILE" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$FILE" | cut -d' ' -f1)

# Fresh lab with router modes $1 (node-a) and $2 (node-b); node-a shares the file → $HASH.
up() {
  cleanup
  echo
  echo "== node-a behind a $1 router, node-b behind a $2 router"
  NAT_A=$1 NAT_B=$2 dc up -d >/dev/null 2>&1
  for _ in $(seq 60); do
    if A status 2>/dev/null | grep -q '"ready": true' && B status 2>/dev/null | grep -q '"ready": true'; then break; fi
    sleep 1
  done
  # The private networks must only be joined through the NATs (both directions).
  if dc exec -T node-b ping -c2 -W1 10.10.1.10 >/dev/null 2>&1; then fail "node-b can reach node-a's private address"; fi
  if dc exec -T node-a ping -c2 -W1 10.10.2.10 >/dev/null 2>&1; then fail "node-a can reach node-b's private address"; fi
  docker cp "$FILE" "$(dc ps -q node-a)":/tmp/nat-file.bin
  dc exec -T node-a sh -c 'mkdir -p /shares/lab && cp /tmp/nat-file.bin /shares/lab/nat-file.bin && chown -R node /shares/lab'
  A share add /shares/lab --name Lab >/dev/null
  A acl set Lab/ hub --hub "$(A hub list | awk '{print $1}')" >/dev/null
  HASH=
  for _ in $(seq 60); do
    HASH=$(B search nat-file --json 2>/dev/null | sed -n 's/.*"hash": *"\([0-9a-f]\{64\}\)".*/\1/p' | head -1)
    [ -n "$HASH" ] && break
    sleep 1
  done
  [ -n "$HASH" ] || fail "file never showed up in search"
}

# What each side's network check found (NAT type per hub, UPnP, CGNAT).
netcheck() {
  echo "-- node-a: $(A netcheck | sed -n 's/^h_[^:]*: //p' | head -1)"
  echo "-- node-b: $(B netcheck | sed -n 's/^h_[^:]*: //p' | head -1)"
  A netcheck --json | grep -q "\"nat\": \"$1\"" || fail "node-a should see a $1 NAT"
  B netcheck --json | grep -q "\"nat\": \"$2\"" || fail "node-b should see a $2 NAT"
}

# Downloads on node-b and waits for the newest transfer to finish, or to be diagnosed as $1.
get_expect() {
  B get "$HASH" >/dev/null
  for _ in $(seq 90); do
    OUT=$(B transfers)
    STATE=$(echo "$OUT" | awk 'NR==1 {print $2}')
    if [ "$1" = done ]; then
      [ "$STATE" = done ] && break
      [ "$STATE" = failed ] && fail "transfer failed"
    elif echo "$OUT" | grep -q "cause: "; then
      echo "$OUT" | grep -q "cause: $1 " || fail "expected cause $1"
      break
    fi
    sleep 1
  done
  echo "$OUT" | sed -n '1,9p'
  if [ "$1" = done ]; then
    [ "$STATE" = done ] || fail "transfer did not finish"
  else
    echo "$OUT" | grep -q "cause: $1 " || fail "no diagnosis (expected $1)"
    [ -z "${2:-}" ] || echo "$OUT" | grep -q "easier fix: $2)" || fail "expected easier fix: $2"
  fi
}

SCENARIOS=${*:-cone symmetric udp_blocked}
for S in $SCENARIOS; do
  case "$S" in
    cone)
      up cone cone
      netcheck endpoint_independent endpoint_independent
      get_expect done
      GOT=$(dc exec -T node-b sha256sum /var/lib/communal/downloads/nat-file.bin | cut -d' ' -f1)
      [ "$WANT" = "$GOT" ] || fail "checksum mismatch"
      echo "PASS: 12 MB transferred directly between peers behind two NATs (sha256 $GOT)"
      dc stop node-a >/dev/null 2>&1
      get_expect peer_offline none
      echo "PASS: owner offline → peer_offline"
      ;;
    symmetric)
      up cone symmetric
      netcheck endpoint_independent symmetric
      get_expect both_restrictive_nat them
      echo "PASS: symmetric NAT → both_restrictive_nat, easier to fix on the owner's side"
      ;;
    udp_blocked)
      up cone udp_blocked
      netcheck endpoint_independent blocked
      get_expect udp_blocked you
      echo "PASS: UDP blocked → udp_blocked, on the downloader's side"
      ;;
    *) fail "unknown scenario $S" ;;
  esac
done
rm -f "$FILE"
echo
echo "PASS: all NAT lab scenarios ($SCENARIOS)"
