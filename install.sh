#!/bin/sh
# One-step installer: downloads the latest release for this CPU and installs it.
#   curl -fsSL https://raw.githubusercontent.com/Aras1907/proton-bridge-gnome/main/install.sh | sh
set -eu

REPO="Aras1907/proton-bridge-gnome"
UUID="proton-bridge@aras.local"

command -v gnome-extensions >/dev/null 2>&1 || {
  echo "gnome-extensions not found: this needs GNOME Shell 48 or newer." >&2
  exit 1
}

case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  aarch64 | arm64) arch=aarch64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
zip="$tmp/$UUID.zip"

echo "Downloading Proton Mail Bridge extension ($arch)..."
curl -fL --progress-bar -o "$zip" \
  "https://github.com/$REPO/releases/latest/download/$UUID.$arch.zip"

gnome-extensions install --force "$zip"
gnome-extensions enable "$UUID" 2>/dev/null || true

cat <<MSG

Installed. Next:
  1. Log out and back in (needed the first time on Wayland).
  2. Sign in:  gnome-extensions prefs $UUID
MSG
