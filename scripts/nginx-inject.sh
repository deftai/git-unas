#!/bin/sh
# nginx-inject.sh — inject the git-unas proxy location block into
# /data/unifi-core/config/http/site-local-ip.conf.
# Safe to run multiple times (idempotent via markers).
set -e

NGINX_CONF=/data/unifi-core/config/http/site-local-ip.conf
MARKER_BEGIN="    # --- git-unas admin (managed by git-unas) ---"
MARKER_END="    # --- end git-unas admin ---"
BLOCK="${MARKER_BEGIN}
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

# Already present — nothing to do.
if grep -qF "$MARKER_BEGIN" "$NGINX_CONF" 2>/dev/null; then
    echo "[git-unas] nginx block already present"
    exit 0
fi

# Find the closing brace of the listen 443 server block and insert before it.
# We use Python (available on UniFi OS) for reliable multi-line text injection.
python3 - "$NGINX_CONF" "$BLOCK" <<'PYEOF'
import sys, re

conf_path = sys.argv[1]
block     = sys.argv[2]

with open(conf_path, 'r') as f:
    content = f.read()

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
