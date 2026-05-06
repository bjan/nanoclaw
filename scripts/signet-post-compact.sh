#!/data/data/com.termux/files/usr/bin/bash
# PostCompact hook: save compaction summary + re-inject signet context
set -euo pipefail
export PATH="/data/data/com.termux/files/home/.bun/bin:/data/data/com.termux/files/home/.local/bin:/data/data/com.termux/files/usr/bin:$PATH"

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# --- Step 1: Save compaction summary to signet ---
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  SUMMARY=$(python3 -c "
import json, sys
summary = ''
with open('$TRANSCRIPT_PATH') as f:
    for line in f:
        d = json.loads(line)
        if d.get('type') != 'user':
            continue
        content = d.get('message', {}).get('content', '')
        if isinstance(content, list):
            content = ' '.join(b.get('text','') for b in content if isinstance(b, dict))
        if 'continued from a previous conversation' in content[:200]:
            summary = content
print(summary)
" 2>/dev/null)

  if [ -n "$SUMMARY" ]; then
    SUMMARY_TRUNCATED=$(echo "$SUMMARY" | head -c 8000)
    signet hook compaction-complete \
      -H claude-code \
      --agent-id dev@phone \
      --project "$CWD" \
      -s "$SUMMARY_TRUNCATED" >/dev/null 2>&1 || true
  fi
fi

# --- Step 2: Re-inject signet context (like a mini session-start) ---
signet hook session-start -H claude-code --agent-id dev@phone --project "$CWD" 2>/dev/null || true
