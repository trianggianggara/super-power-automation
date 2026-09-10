#!/usr/bin/env bash
set -euo pipefail

# Ensure ~/.local/bin is in PATH
export PATH="$HOME/.local/bin:$PATH"

# Auto-install cloudflared if not found
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found. Downloading official binary to $HOME/.local/bin/cloudflared..."
  mkdir -p "$HOME/.local/bin"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)        CF_ARCH="amd64" ;;
    aarch64|arm64) CF_ARCH="arm64" ;;
    armv7l)        CF_ARCH="arm" ;;
    386|i386|i686) CF_ARCH="386" ;;
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
  esac

  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o "$HOME/.local/bin/cloudflared"
  chmod +x "$HOME/.local/bin/cloudflared"
  echo "cloudflared successfully installed: $(cloudflared --version)"
fi

CONFIG="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"
TUNNEL="${CLOUDFLARED_TUNNEL:-tempmail-webhook}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

WEBHOOK_PORT="${TEMPMAIL_WEBHOOK_PORT:-8788}"
WEBHOOK_STORE="${TEMPMAIL_WEBHOOK_STORE:-$ROOT/.tempmail-webhook-8788.json}"

if ! curl -fsS "http://127.0.0.1:${WEBHOOK_PORT}/health" >/dev/null 2>&1; then
  setsid env \
    TEMPMAIL_WEBHOOK_PORT="$WEBHOOK_PORT" \
    TEMPMAIL_WEBHOOK_STORE="$WEBHOOK_STORE" \
    node "$([ -f "$ROOT/services/tempmail/tempmail-webhook.js" ] && echo "$ROOT/services/tempmail/tempmail-webhook.js" || echo "$ROOT/tempmail-webhook.js")" \
    </dev/null >/tmp/tempmail-webhook-${WEBHOOK_PORT}.log 2>&1 &
  sleep 1
fi

pgrep -f "^cloudflared tunnel .* run ${TUNNEL}$" | xargs -r kill 2>/dev/null || true

exec cloudflared tunnel \
  --config "$CONFIG" \
  --protocol http2 \
  --edge-ip-version 4 \
  --ha-connections 1 \
  run "$TUNNEL"
