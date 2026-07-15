#!/bin/sh
# nginx-inject.sh — inject/update the git-unas proxy location block into
# /data/unifi-core/config/http/site-local-ip.conf.
# Safe to run multiple times: it replaces any existing managed block with the
# current version (idempotent and self-healing across upgrades).
set -e

NGINX_CONF=/data/unifi-core/config/http/site-local-ip.conf
# Bump BLOCK_VERSION whenever the block body changes so upgrades replace a
# stale block instead of leaving it in place (the markers stay stable).
BLOCK_VERSION=2
MARKER_BEGIN="    # --- git-unas admin (managed by git-unas) ---"
MARKER_END="    # --- end git-unas admin ---"
VERSION_TAG="    # git-unas-nginx-block-version: ${BLOCK_VERSION}"
BLOCK="${MARKER_BEGIN}
${VERSION_TAG}
    location = /git-unas {
        return 301 /git-unas/;
    }
    location /git-unas/ {
        proxy_pass         http://127.0.0.1:7892/;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_read_timeout 300s;
    }
${MARKER_END}"

if [ ! -f "$NGINX_CONF" ]; then
    echo "[git-unas] nginx config not found at $NGINX_CONF — skipping proxy setup" >&2
    exit 0
fi

# Current version already present — nothing to do.
if grep -qF "$VERSION_TAG" "$NGINX_CONF" 2>/dev/null; then
    echo "[git-unas] nginx block already present (v${BLOCK_VERSION})"
    exit 0
fi

# Remove any existing managed block (any version), then insert the current one
# before the closing brace of the `listen 443` server block. Python (available
# on UniFi OS) handles the multi-line edit reliably and atomically.
python3 - "$NGINX_CONF" "$BLOCK" "$MARKER_BEGIN" "$MARKER_END" <<'PYEOF'
import sys, re

conf_path    = sys.argv[1]
block        = sys.argv[2]
marker_begin = sys.argv[3]
marker_end   = sys.argv[4]

with open(conf_path, 'r') as f:
    content = f.read()

# Strip a pre-existing managed block so we never duplicate it.
start = content.find(marker_begin)
if start != -1:
    end = content.find(marker_end, start)
    if end != -1:
        end += len(marker_end)
        if end < len(content) and content[end] == '\n':
            end += 1
        content = content[:start] + content[end:]

# Locate the listen 443 server block closing brace by counting braces.
m = re.search(r'listen 443', content)
if not m:
    print('[git-unas] cannot find listen 443 in nginx config', file=sys.stderr)
    sys.exit(1)

depth = 1
pos   = m.start()
while pos < len(content) and depth > 0:
    if content[pos] == '{':
        depth += 1
    elif content[pos] == '}':
        depth -= 1
    if depth > 0:
        pos += 1

if depth != 0:
    print('[git-unas] unbalanced braces in nginx config', file=sys.stderr)
    sys.exit(1)

new_content = content[:pos] + block + '\n' + content[pos:]
with open(conf_path, 'w') as f:
    f.write(new_content)

print('[git-unas] nginx block injected')
PYEOF

nginx -s reload 2>/dev/null || true
echo "[git-unas] nginx reloaded"
