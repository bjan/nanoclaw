---
name: context
description: Load a project directory's CLAUDE.md and latest Claude Code session summary so you're up to speed and ready to work on that project.
---

# /context — Load Project Context

Ingest a project's CLAUDE.md and summarize its most recent Claude Code session so you're fully up to date and ready to work.

## Usage

```
/context <directory>
```

Examples:
- `/context ~/workspace/pct`
- `/context ~/nanoclaw`
- `/context ~/tools/printer`

## Steps

### 1. Resolve the directory

Expand `~` and validate the directory exists:

```bash
TARGET_DIR="$(eval echo "<directory>")"
[ -d "$TARGET_DIR" ] && echo "OK: $TARGET_DIR" || echo "ERROR: directory not found"
```

If not found, tell the user and stop.

### 2. Read CLAUDE.md

Look for the project's CLAUDE.md (check both `CLAUDE.md` and `.claude/CLAUDE.md`):

```bash
for f in "$TARGET_DIR/CLAUDE.md" "$TARGET_DIR/.claude/CLAUDE.md"; do
  [ -f "$f" ] && echo "Found: $f"
done
```

Read and ingest the CLAUDE.md contents. This gives you the project's conventions, architecture, and key context.

If no CLAUDE.md exists, note this but continue — the session summary is still valuable.

### 3. Find the most recent session

Claude Code stores sessions as JSONL files in `~/.claude/projects/`. The directory path is encoded with dashes replacing slashes:

```bash
# Convert directory path to Claude's project folder name
PROJECT_KEY=$(echo "$TARGET_DIR" | sed 's|^/||; s|/|-|g; s|^|/-|; s|^/-|-|')
PROJECT_DIR="$HOME/.claude/projects/$PROJECT_KEY"

# Find the most recently modified .jsonl file
ls -t "$PROJECT_DIR"/*.jsonl 2>/dev/null | head -5
```

If no sessions found, tell the user and stop after the CLAUDE.md.

### 4. Extract conversation from the session

Extract user prompts and assistant text responses from the most recent session JSONL. Skip tool use blocks — focus on the human-readable conversation:

```bash
python3 << 'PYEOF'
import json, sys, os

target_dir = sys.argv[1] if len(sys.argv) > 1 else ""
project_key = "-" + target_dir.lstrip("/").replace("/", "-")
project_dir = os.path.expanduser(f"~/.claude/projects/{project_key}")

# Find most recent session
jsonl_files = []
if os.path.isdir(project_dir):
    for f in os.listdir(project_dir):
        if f.endswith(".jsonl"):
            full = os.path.join(project_dir, f)
            jsonl_files.append((os.path.getmtime(full), full))

if not jsonl_files:
    print("NO_SESSIONS")
    sys.exit(0)

jsonl_files.sort(reverse=True)
session_file = jsonl_files[0][1]
print(f"SESSION: {session_file}")
print(f"SIZE: {os.path.getsize(session_file)} bytes")

# Extract user and assistant text messages
messages = []
with open(session_file) as fh:
    for line in fh:
        try:
            d = json.loads(line.strip())
        except:
            continue
        
        entry_type = d.get("type")
        
        if entry_type == "user" and "message" in d and not d.get("toolUseResult"):
            msg = d["message"]
            text = ""
            if isinstance(msg, dict):
                for c in msg.get("content", []):
                    if isinstance(c, dict) and c.get("type") == "text":
                        text = c["text"]
                        break
            elif isinstance(msg, str):
                text = msg
            if text and not text.startswith("[Request interrupted"):
                messages.append(("USER", d.get("timestamp", ""), text))
        
        elif entry_type == "assistant" and "message" in d:
            msg = d["message"]
            texts = []
            if isinstance(msg, dict):
                for c in msg.get("content", []):
                    if isinstance(c, dict) and c.get("type") == "text" and c.get("text", "").strip():
                        texts.append(c["text"])
            if texts:
                messages.append(("ASSISTANT", d.get("timestamp", ""), "\n".join(texts)))

# Print last N exchanges (cap to avoid huge output)
recent = messages[-40:]
for role, ts, text in recent:
    # Truncate very long messages
    display = text[:500] + "..." if len(text) > 500 else text
    print(f"\n[{ts}] {role}:")
    print(display)

PYEOF
```

Pass the resolved `$TARGET_DIR` as the argument to the python script.

### 5. Summarize with claude -p

If the session is large, pipe the extracted conversation through `claude -p` for a concise summary. Use `--bare` to skip hooks and keep it fast:

```bash
echo "<extracted conversation>" | claude -p --bare --model haiku "Summarize this Claude Code session. What was being worked on? What was accomplished? What's the current state? What are any open issues or next steps? Be concise but thorough."
```

Only do this if the extracted conversation is longer than ~4000 characters. For shorter sessions, you can summarize it yourself.

### 6. Present the context

Report back to the user with:

```
*Project Context Loaded*

*Directory:* /path/to/project
*CLAUDE.md:* loaded / not found

*Latest Session Summary:*
<summary of what was being worked on, current state, and next steps>

*Ready to work on this project.* What would you like to do?
```

Keep the summary concise (5-15 bullet points). Focus on:
- What the project is
- What was most recently being worked on
- Current state (working? broken? in-progress?)
- Any open issues or next steps mentioned

## Important Notes

- The session JSONL can be very large (50MB+). Never try to read the whole file into your context — always use the python extraction script.
- If multiple sessions exist, use the most recently modified one.
- The `claude -p` summarization step uses the `haiku` model to be fast and cheap. If it fails, summarize the extracted messages yourself.
- After loading context, you should be ready to answer questions about the project and do work in that directory.
- You can `cd` to the target directory if the user wants to start working there.
