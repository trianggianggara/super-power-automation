#!/usr/bin/env bash
set -euo pipefail

# Script to reinstall Camoufox easily, handling GitHub API rate limits via proxies from .env

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

venv_dir="$repo_root/.venv-camoufox"
python_bin="$venv_dir/bin/python"

if [[ ! -x "$python_bin" ]]; then
  echo "Error: Python virtual environment not found or python executable not found at $python_bin" >&2
  exit 1
fi

echo "=== Camoufox Reinstallation Script ==="

# Check for proxies in .env to bypass GitHub rate limits
proxies=()
if [[ -f .env ]]; then
  # Extract any lines starting with PROXY or #PROXY
  proxy_lines=$(grep -i '^#\?PROXY=' .env || true)
  if [[ -n "$proxy_lines" ]]; then
    # Parse all proxies, splitting by comma
    while read -r line; do
      # strip leading '#PROXY=' or 'PROXY=' and leading whitespace
      clean_line=$(echo "$line" | sed -e 's/^#\?PROXY=//I' -e 's/^[[:space:]]*//')
      IFS=',' read -ra ADDR <<< "$clean_line"
      for p in "${ADDR[@]}"; do
        # strip whitespace and quotes
        p_clean=$(echo "$p" | xargs)
        if [[ -n "$p_clean" ]]; then
          proxies+=("$p_clean")
        fi
      done
    done <<< "$proxy_lines"
  fi
fi

# Find a working proxy or run directly
working_proxy=""
echo "Checking GitHub API rate limit..."

# Test direct connection
rate_limit_status=$(curl -s -o /dev/null -w "%{http_code}" https://api.github.com/repos/daijro/camoufox/releases || true)
if [[ "$rate_limit_status" == "403" ]]; then
  echo "GitHub API rate limit exceeded for direct connection (HTTP 403)."
  echo "Attempting to find a working proxy from .env..."
  
  for proxy in "${proxies[@]}"; do
    # Mask username/password in output for security if present
    masked_proxy=$(echo "$proxy" | sed -E 's/:\/\/[^:]+:[^@]+@/:\/\/*****:*****@/')
    echo "Testing proxy: $masked_proxy"
    
    proxy_status=$(curl -s -o /dev/null -w "%{http_code}" --proxy "$proxy" --connect-timeout 5 https://api.github.com/repos/daijro/camoufox/releases || true)
    if [[ "$proxy_status" == "200" ]]; then
      echo "Proxy $masked_proxy is working (HTTP 200)!"
      working_proxy="$proxy"
      break
    fi
  done
  
  if [[ -z "$working_proxy" ]]; then
    echo "Warning: No working proxy found in .env. We will proceed directly, but the installation might fail if the rate limit is still active."
  fi
else
  echo "GitHub API rate limit is fine. Running directly."
fi

# Export proxy variables if found
if [[ -n "$working_proxy" ]]; then
  export HTTP_PROXY="$working_proxy"
  export HTTPS_PROXY="$working_proxy"
fi

echo "Removing existing Camoufox cache..."
"$python_bin" -m camoufox remove || true

echo "Fetching and installing latest Camoufox browser..."
"$python_bin" -m camoufox fetch

echo "Verifying installation..."
if "$python_bin" -c "from camoufox import Camoufox; with Camoufox() as b: print('Camoufox is working!')" 2>/dev/null; then
  echo "Camoufox reinstalled successfully!"
else
  echo "Warning: Camoufox was installed, but verification command failed. It might require non-headless support or other environment dependencies to run."
fi
