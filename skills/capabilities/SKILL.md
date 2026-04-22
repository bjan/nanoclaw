---
name: capabilities
description: Show what this NanoClaw instance can do — installed skills, available tools, and system info. Read-only. Use when the user asks what the bot can do, what's installed, or runs /capabilities.
---

# /capabilities — System Capabilities Report

Generate a structured read-only report of what this NanoClaw instance can do.

## How to gather the information

Run these commands and compile the results into the report format below.

### 1. Installed skills

List skill directories available to you:

```bash
ls -1 ~/.claude/skills/ 2>/dev/null || echo "No skills found"
```

Each directory is an installed skill. The directory name is the skill name (e.g., `agent-browser` → `/agent-browser`).

### 2. Available tools

Read the allowed tools from your SDK configuration. You always have access to:
- **Core:** Bash, Read, Write, Edit, Glob, Grep
- **Web:** WebSearch, WebFetch
- **Orchestration:** Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage
- **Other:** TodoWrite, ToolSearch, Skill, NotebookEdit
- **MCP:** mcp__nanoclaw__* (messaging, tasks, group management)

### 3. MCP server tools

The NanoClaw MCP server exposes these tools (via `mcp__nanoclaw__*` prefix):
- `send_chat_message` — send a message to the user/group chat
- `send_agent_message` — send a message to another agent
- `schedule_task` — schedule a recurring or one-time task
- `list_tasks` — list scheduled tasks
- `pause_task` — pause a scheduled task
- `resume_task` — resume a paused task
- `cancel_task` — cancel and delete a task
- `update_task` — update an existing task
- `register_group` — register a new chat/group (main only)

### 4. Bash tools

Check for executable tools available to the agent:

```bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not found"
```

### 5. Group info

```bash
echo "Group folder: $NANOCLAW_GROUP_FOLDER"
test -f CLAUDE.md && echo "Group memory: yes" || echo "Group memory: no"
test -d extra && ls extra/ 2>/dev/null | head -5 && echo "Extra dirs: $(ls extra/ 2>/dev/null | wc -l | tr -d ' ')" || echo "Extra dirs: none"
```

## Report format

Present the report as a clean, readable message. Example:

```
*NanoClaw Capabilities*

*Installed Skills:*
• /agent-browser — Browse the web, fill forms, extract data
• /capabilities — This report
• /status — Quick health check
(list all found skills)

*Tools:*
• Core: Bash, Read, Write, Edit, Glob, Grep
• Web: WebSearch, WebFetch
• Orchestration: Task, TeamCreate, SendMessage
• MCP: send_chat_message, send_agent_message, list_agents, schedule_task, list_tasks, pause/resume/cancel/update_task, register_group

*Bash Tools:*
• agent-browser: available/not found

*System:*
• Group: telegram_main
• Group memory: yes/no
• Extra dirs: N directories
```

Adapt the output based on what you actually find — don't list things that aren't installed.

**See also:** `/status` for a quick health check of session, workspace, and tasks.
