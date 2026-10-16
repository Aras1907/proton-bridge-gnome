#!/bin/sh
# End-to-end test in an isolated session: private D-Bus, keyring, GOA and a
# headless GNOME Shell running the extension against tests/fake-bridge.
# Screenshots go to $1. Needs tests/.venv with grpcio + grpcio-tools.
set -u
root=$(realpath "$(dirname "$0")/..")
out=$(realpath "${1:-.}")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home" XDG_DATA_HOME="$tmp/data" XDG_CONFIG_HOME="$tmp/config" XDG_CACHE_HOME="$tmp/cache"
mkdir -p "$HOME" "$XDG_DATA_HOME/keyrings"
# An unlocked, unencrypted default keyring so GOA can store credentials without a prompt.
printf '[keyring]\ndisplay-name=login\nctime=0\nmtime=0\nlock-on-idle=false\nlock-after=false\n' \
    > "$XDG_DATA_HOME/keyrings/login.keyring"
printf 'login' > "$XDG_DATA_HOME/keyrings/default"
ext="$XDG_DATA_HOME/gnome-shell/extensions/proton-bridge@aras.local"
mkdir -p "$ext"
cp -r "$root/src/." "$ext/"
# The fake stands in for the bundled Bridge binary.
mkdir -p "$ext/bin"
ln -sf "$root/tests/fake-bridge" "$ext/bin/proton-bridge"

# The login window, runnable outside the shell's prefs host.
mkdir -p "$tmp/prefs"
cp -r "$root/src/." "$tmp/prefs/"
cp "$root/tests/e2e.js" "$tmp/prefs/"
printf 'export class ExtensionPreferences {}\nexport const gettext = s => s;\n' > "$tmp/prefs/stub.js"
sed -i "s|resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js|./stub.js|" "$tmp/prefs/prefs.js"
export ROOT="$root" OUT="$out" TMP="$tmp"

dbus-run-session -- sh -c '
  printf "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  gsettings set org.gnome.shell enabled-extensions "[\"proton-bridge@aras.local\"]"
  gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
  gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 --wayland-display pbtest-0 \
      > "$TMP/shell.log" 2>&1 &
  shell=$!
  WAYLAND_DISPLAY=pbtest-0 timeout 120 gjs -m "$TMP/prefs/e2e.js" "$OUT"
  kill $shell; wait $shell 2>/dev/null
  grep -E "FAKEBRIDGE|JS ERROR|JS WARNING|Proton Bridge" "$TMP/shell.log"
'
