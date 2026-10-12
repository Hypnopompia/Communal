#!/bin/sh
set -eu
# The interface on the public network (172.30.0.0/24).
PUB_IF=$(ip -o -4 addr show | awk '/ 172\.30\.0\./ {print $2; exit}')
[ -n "$PUB_IF" ] || { echo "no public interface"; exit 1; }
iptables -t nat -A POSTROUTING -o "$PUB_IF" -j MASQUERADE
# Replies to traffic the inside started are allowed back in; anything else from outside is not.
iptables -A FORWARD -i "$PUB_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A FORWARD -i "$PUB_IF" -j DROP
iptables -A FORWARD -o "$PUB_IF" -j ACCEPT
echo "router up: masquerading via $PUB_IF"
exec sleep infinity
