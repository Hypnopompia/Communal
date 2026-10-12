#!/bin/sh
# Transfers a file between two clients behind separate NATs and checks it arrived intact.
set -eu
cd "$(dirname "$0")/../.."
F=docker/compose.nat.yml
dc() { docker compose -f "$F" "$@"; }
cleanup() { dc down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker compose -f docker/compose.dev.yml build -q
dc build -q
dc up -d
A() { dc exec -T node-a communal "$@"; }
B() { dc exec -T node-b communal "$@"; }

echo "waiting for both clients to join the hub…"
for i in $(seq 60); do
  if A status 2>/dev/null | grep -q '"ready": true' && B status 2>/dev/null | grep -q '"ready": true'; then break; fi
  sleep 1
done

echo "-- the NATs really separate them:"
if dc exec -T node-b ping -c1 -W1 10.10.1.10 >/dev/null 2>&1; then echo "FAIL: node-b can reach node-a's private address"; exit 1; fi
echo "   node-b cannot reach 10.10.1.10 directly (good)"
echo "-- addresses learned through the hub's probe:"
dc logs --no-log-prefix node-a node-b 2>&1 | grep -o '"public_addr":"[^"]*"' | sort -u

head -c 12000000 /dev/urandom > /tmp/communal-nat-file.bin
docker cp /tmp/communal-nat-file.bin "$(dc ps -q node-a)":/tmp/nat-file.bin
dc exec -T node-a sh -c 'mkdir -p /shares/lab && cp /tmp/nat-file.bin /shares/lab/nat-file.bin && chown -R node /shares/lab'
A share add /shares/lab --name Lab >/dev/null
HUB=$(A hub list | awk '{print $1}')
A acl set Lab/ hub --hub "$HUB" >/dev/null

echo "waiting for the file to be indexed…"
for i in $(seq 60); do
  HASH=$(B search nat-file --json 2>/dev/null | sed -n 's/.*"hash": *"\([0-9a-f]\{64\}\)".*/\1/p' | head -1)
  [ -n "${HASH:-}" ] && break
  sleep 1
done
[ -n "${HASH:-}" ] || { echo "FAIL: file never showed up in search"; exit 1; }
B get "$HASH" >/dev/null

for i in $(seq 60); do
  STATE=$(B transfers | awk 'NR==1 {print $2}')
  [ "$STATE" = done ] && break
  [ "$STATE" = failed ] && { B transfers; echo "FAIL: transfer failed"; exit 1; }
  sleep 1
done
B transfers
WANT=$(sha256sum /tmp/communal-nat-file.bin 2>/dev/null | cut -d' ' -f1 || shasum -a 256 /tmp/communal-nat-file.bin | cut -d' ' -f1)
GOT=$(dc exec -T node-b sha256sum /var/lib/communal/downloads/nat-file.bin | cut -d' ' -f1)
[ "$WANT" = "$GOT" ] || { echo "FAIL: checksum mismatch"; exit 1; }
echo "PASS: 12 MB transferred directly between peers behind two NATs (sha256 $GOT)"
