#!/usr/bin/env bash
set -euo pipefail

install_dir="${BRAVE_INSTALL_DIR:-$HOME/.local/share/brave-bin}"
profile_dirs=(
  "$HOME/.config/BraveSoftware"
  "$HOME/.cache/BraveSoftware"
  "$HOME/.local/share/BraveSoftware"
  "$HOME/.config/brave"
  "$HOME/.cache/brave"
)
app_files=(
  "$HOME/.local/share/applications/brave-browser.desktop"
  "$HOME/.local/share/applications/brave.desktop"
)

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<HELP
Usage: npm run browser:reinstall

Clean Brave install/profile/cache, reinstall latest stable Brave locally, and
update .env BROWSER_EXECUTABLE_PATH.

Env:
  BRAVE_INSTALL_DIR=$install_dir
  KEEP_PROFILE=1          skip deleting Brave profile/cache
HELP
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

killall brave brave-browser chrome_crashpad_handler 2>/dev/null || true

backup=".env.bak-browser-cleanup-$(date +%Y%m%d-%H%M%S)"
[[ -f .env ]] && cp .env "$backup"

rm -rf "$install_dir" "${app_files[@]}"
if [[ "${KEEP_PROFILE:-}" != "1" ]]; then
  rm -rf "${profile_dirs[@]}"
fi
find "$HOME/.local/share/icons" -path '*apps*' -iname 'brave*.png' -delete 2>/dev/null || true

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
case "$arch" in
  amd64|x86_64) deb_arch=amd64 ;;
  arm64|aarch64) deb_arch=arm64 ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac

base="https://brave-browser-apt-release.s3.brave.com"
curl -fsSL "$base/dists/stable/main/binary-$deb_arch/Packages" -o Packages
filename="$(awk '/^Filename: / {print $2; exit}' Packages)"
version="$(awk '/^Version: / {print $2; exit}' Packages)"

echo "Installing Brave $version to $install_dir"
curl -fL "$base/$filename" -o brave.deb
dpkg-deb -x brave.deb brave-root
mkdir -p "$install_dir"
cp -a brave-root/* "$install_dir/"

browser_path="$install_dir/opt/brave.com/brave/brave-browser"
if [[ -f "$repo_root/.env" ]]; then
  if grep -q '^BROWSER_EXECUTABLE_PATH=' "$repo_root/.env"; then
    perl -0pi -e "s|^BROWSER_EXECUTABLE_PATH=.*$|BROWSER_EXECUTABLE_PATH=$browser_path|m" "$repo_root/.env"
  else
    printf '\nBROWSER_EXECUTABLE_PATH=%s\n' "$browser_path" >> "$repo_root/.env"
  fi
fi

"$browser_path" --version
echo "Done. .env backup: ${backup:-none}"
