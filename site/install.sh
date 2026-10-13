#!/bin/sh
# Installs or upgrades Communal on Linux from the latest GitHub release.
#
#   curl -fsSL https://hypnopompia.github.io/Communal/install.sh | sh
#   curl -fsSL https://hypnopompia.github.io/Communal/install.sh | sh -s -- headless
#
# What to install (the default is "desktop" when there's a graphical session, else "headless"):
#   desktop   the app with its window (.deb on Debian/Ubuntu, otherwise an AppImage; x86-64 only)
#   headless  the background service and `communal` command, for servers (needs Node.js 24+)
#   hub       the hub, for whoever runs one (needs Node.js 24+); backs up its data first
#
# Pass --version vX.Y.Z to install a particular release instead of the latest.
set -eu

REPO=Hypnopompia/Communal
what=""
tag=""
while [ $# -gt 0 ]; do
  case "$1" in
    desktop | headless | hub) what=$1 ;;
    --version) tag=${2:?--version needs a value like v0.1.4}; shift ;;
    -h | --help) echo "usage: install.sh [desktop|headless|hub] [--version vX.Y.Z]"; exit 0 ;;
    *) echo "install.sh: unknown argument: $1 (desktop, headless, hub or --version vX.Y.Z)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "this script is for Linux. On a Mac or Windows, download the app from https://hypnopompia.github.io/Communal/"
command -v curl >/dev/null 2>&1 || die "curl is required"

if [ -z "$what" ]; then
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then what=desktop; else what=headless; fi
fi

# Root for installing; sudo when we aren't root already.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO=sudo
else
  die "run this as root, or install sudo"
fi

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported processor: $(uname -m)" ;;
esac

# The latest release's tag, from where GitHub redirects /releases/latest (no API token needed).
if [ -z "$tag" ]; then
  url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") ||
    die "couldn't reach GitHub"
  tag=${url##*/}
fi
case "$tag" in v[0-9]*) ;; *) die "couldn't tell the latest version (got \"$tag\")" ;; esac
version=${tag#v}

need_node() {
  command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] ||
    die "the $what install needs Node.js 24 or later (https://nodejs.org/en/download)"
}

installed_version() {
  # The version an earlier install left behind, if any.
  f=$1
  [ -f "$f" ] && sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$f" | head -n 1 || true
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
fetch() {
  say "Downloading $1"
  curl -fL --progress-bar -o "$tmp/$1" "https://github.com/$REPO/releases/download/$tag/$1" ||
    die "couldn't download $1 (is $tag published?)"
}

case "$what" in
  desktop)
    [ "$arch" = x64 ] || die "the desktop app is only built for x86-64 Linux; use \"headless\" on this computer"
    if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
      have=$(dpkg-query -W -f='${Version}' communal 2>/dev/null || true)
      [ "$have" = "$version" ] && { say "Communal $version is already installed."; exit 0; }
      fetch "communal-$version-amd64.deb"
      # apt reads the file as its own user: keep it somewhere that user can read.
      chmod 755 "$tmp" && chmod 644 "$tmp/communal-$version-amd64.deb"
      $SUDO apt-get install -y "$tmp/communal-$version-amd64.deb"
      say "Communal $version is installed. Open it from your applications menu. It updates itself from now on."
    else
      dest="$HOME/Applications"
      mkdir -p "$dest"
      fetch "communal-$version-x86_64.AppImage"
      install -m 755 "$tmp/communal-$version-x86_64.AppImage" "$dest/Communal.AppImage"
      say "Communal $version is in $dest/Communal.AppImage. It updates itself from now on."
    fi
    ;;

  headless)
    need_node
    have=$(installed_version /opt/communal/lib/package.json)
    [ "$have" = "$version" ] && { say "Communal $version is already installed."; exit 0; }
    name="communal-$version-linux-$arch"
    fetch "$name.tar.gz"
    tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
    $SUDO "$tmp/$name/install.sh"
    [ -n "$have" ] && say "Upgraded from $have to $version."
    ;;

  hub)
    need_node
    have=$(installed_version /opt/communal-hub/lib/package.json)
    [ "$have" = "$version" ] && { say "The hub is already at $version."; exit 0; }
    name="communal-hub-$version"
    fetch "$name.tar.gz"
    tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
    if [ -d /var/lib/communal-hub ]; then
      # Migrations run when the new version starts: keep a copy of the data from before.
      backup="/var/lib/communal-hub-before-$version-$(date +%Y%m%d%H%M).tar.gz"
      say "Backing up the hub's data to $backup"
      $SUDO systemctl stop communal-hub 2>/dev/null || true
      $SUDO tar -czf "$backup" -C /var/lib communal-hub
    fi
    $SUDO "$tmp/$name/install.sh"
    [ -n "$have" ] && say "Upgraded the hub from $have to $version."
    ;;
esac
