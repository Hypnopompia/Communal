#!/bin/sh
set -eu
# NAT_MODE picks the kind of router (M5 scenarios):
#   cone         masquerade keeping one mapping per source port (endpoint-independent mapping),
#                inbound only for replies: a typical home router; hole punching works
#   symmetric    a fresh random external port for every destination: what the hub's probe
#                sees is useless to peers, so punching fails
#   udp_blocked  cone, but every forwarded UDP packet is dropped (TCP, so the hub, still works)
MODE="${NAT_MODE:-cone}"
# The interface on the public network (172.30.0.0/24).
PUB_IF=$(ip -o -4 addr show | awk '/ 172\.30\.0\./ {print $2; exit}')
[ -n "$PUB_IF" ] || { echo "no public interface"; exit 1; }
case "$MODE" in
  cone | udp_blocked)
    iptables -t nat -A POSTROUTING -o "$PUB_IF" -j MASQUERADE ;;
  symmetric)
    iptables -t nat -A POSTROUTING -o "$PUB_IF" -j MASQUERADE --random-fully 2>/dev/null ||
      iptables -t nat -A POSTROUTING -o "$PUB_IF" -j MASQUERADE --random ;;
  *) echo "unknown NAT_MODE: $MODE"; exit 1 ;;
esac
if [ "$MODE" = udp_blocked ]; then iptables -A FORWARD -p udp -j DROP; fi
# Replies to traffic the inside started are allowed back in; anything else from outside is not.
iptables -A FORWARD -i "$PUB_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A FORWARD -i "$PUB_IF" -j DROP
iptables -A FORWARD -o "$PUB_IF" -j ACCEPT
# Like a home router's WAN side, drop unsolicited packets addressed to the router itself. An
# accepted one would leave a conntrack entry on the public port, and the inside client's own
# punch to that peer would then be NATed to a different port, so holes would never line up.
iptables -A INPUT -i "$PUB_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -i "$PUB_IF" -j DROP
# No default route: Docker's gateway on the LAN side would forward a peer's private address
# straight to the other LAN, around both NATs. The router reaches only the public network.
ip route del default 2>/dev/null || true
echo "router up ($MODE): masquerading via $PUB_IF"
exec sleep infinity
