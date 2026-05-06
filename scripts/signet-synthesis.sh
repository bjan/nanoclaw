#!/data/data/com.termux/files/usr/bin/bash
# Daily MEMORY.md synthesis via signet
set -euo pipefail
export PATH="/data/data/com.termux/files/home/.bun/bin:/data/data/com.termux/files/home/.local/bin:/data/data/com.termux/files/usr/bin:$PATH"

NANOCLAW_DIR="${NANOCLAW_DIR:-/data/data/com.termux/files/home/nanoclaw}"
MEMORY_FILE="$NANOCLAW_DIR/.signet/MEMORY.md"
mkdir -p "$NANOCLAW_DIR/.signet"

CONTENT=$(signet hook synthesis --json 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data.get('prompt', ''))
")

if [ -z "$CONTENT" ]; then
  echo "synthesis returned empty content" >&2
  exit 1
fi

echo "$CONTENT" > "$MEMORY_FILE"
signet hook synthesis-complete -c "$CONTENT" 2>/dev/null
echo "MEMORY.md synthesized ($(wc -c < "$MEMORY_FILE") bytes)"
