#!/bin/sh
# Installs or upgrades the Communal hub from this unpacked release (run as root):
#   sudo ./install.sh
# Needs Node.js 24 or later. Installs to /opt/communal-hub, keeps data in
# /var/lib/communal-hub and settings in /etc/communal-hub/communal-hub.env.
set -eu
here=$(cd "$(dirname "$0")" && pwd)

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  echo "install.sh: Node.js 24 or later is required (https://nodejs.org)" >&2
  exit 1
fi

id communal-hub >/dev/null 2>&1 || useradd --system --home-dir /var/lib/communal-hub --shell /usr/sbin/nologin communal-hub
mkdir -p /opt/communal-hub /etc/communal-hub/tls
rm -rf /opt/communal-hub/lib /opt/communal-hub/bin
cp -R "$here/lib" "$here/bin" /opt/communal-hub/
ln -sf /opt/communal-hub/bin/communal-hub /usr/local/bin/communal-hub
[ -f /etc/communal-hub/communal-hub.env ] || cp "$here/communal-hub.env.example" /etc/communal-hub/communal-hub.env
cp "$here/communal-hub.service" /etc/systemd/system/communal-hub.service
systemctl daemon-reload
systemctl enable communal-hub
systemctl restart communal-hub || true

cat <<MSG
Installed. Put the TLS certificate in /etc/communal-hub/tls (see the .env file), then:
  systemctl restart communal-hub && systemctl status communal-hub
MSG
