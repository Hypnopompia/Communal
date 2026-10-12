#!/bin/sh
set -eu
# Send everything via the lab's NAT router instead of Docker's gateway.
ip route replace default via "$GATEWAY"
exec communal daemon
