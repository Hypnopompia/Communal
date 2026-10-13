#!/bin/sh
# Installs the Communal headless client from this unpacked release (run as root):
#   sudo ./install.sh
# Needs Node.js 24 or later on PATH. Puts the app in /opt/communal, the CLI in
# /usr/local/bin/communal, data in /var/lib/communal, and starts the systemd service.
set -eu
here=$(cd "$(dirname "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "install.sh: Node.js 24 or later is required (https://nodejs.org)" >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 24 ]; then
  echo "install.sh: Node.js 24 or later is required (found $(node -v))" >&2
  exit 1
fi

id communal >/dev/null 2>&1 || useradd --system --home-dir /var/lib/communal --shell /usr/sbin/nologin communal
mkdir -p /opt/communal /etc/communal
rm -rf /opt/communal/lib /opt/communal/bin
cp -R "$here/lib" "$here/bin" /opt/communal/
ln -sf /opt/communal/bin/communal /usr/local/bin/communal
[ -f /etc/communal/communal.env ] || cp "$here/communal.env.example" /etc/communal/communal.env
cp "$here/communal.service" /etc/systemd/system/communal.service
systemctl daemon-reload
systemctl enable --now communal

cat <<MSG
Communal is running. Next:
  sudo -u communal communal hub add <hub address> --name <your name>
  sudo -u communal communal share add /path/to/folder --name Photos
  sudo -u communal communal status
MSG
