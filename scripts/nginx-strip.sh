#!/bin/sh
# nginx-strip.sh — remove the git-unas proxy location block from
# /data/unifi-core/config/http/site-local-ip.conf on uninstall.
set -e

NGINX_CONF=/data/unifi-core/config/http/site-local-ip.conf
MARKER_BEGIN="    # --- git-unas admin (managed by git-unas) ---"
MARKER_END="    # --- end git-unas admin ---"

if [ ! -f "$NGINX_CONF" ]; then
    exit 0
fi

if ! grep -qF "$MARKER_BEGIN" "$NGINX_CONF" 2>/dev/null; then
    echo "[git-unas] nginx block not present — nothing to strip"
    exit 0
fi

python3 - "$NGINX_CONF" "$MARKER_BEGIN" "$MARKER_END" <<'PYEOF'
import sys

conf_path    = sys.argv[1]
marker_begin = sys.argv[2]
marker_end   = sys.argv[3]

with open(conf_path, 'r') as f:
    content = f.read()

start = content.find(marker_begin)
if start == -1:
    sys.exit(0)

end = content.find(marker_end, start)
if end == -1:
    print('[git-unas] end marker not found — leaving config unchanged', file=sys.stderr)
    sys.exit(0)

end += len(marker_end)
# Also consume the trailing newline if present.
if end < len(content) and content[end] == '\n':
    end += 1

new_content = content[:start] + content[end:]
with open(conf_path, 'w') as f:
    f.write(new_content)

print('[git-unas] nginx block stripped')
PYEOF

nginx -s reload 2>/dev/null || true
echo "[git-unas] nginx reloaded"
