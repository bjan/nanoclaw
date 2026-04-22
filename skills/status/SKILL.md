---
name: status
description: Quick read-only health check — session context, workspace, tool availability, and task snapshot. Use when the user asks for system status or runs /status.
---

# /status — System Status Check

Generate a quick read-only status report of the current agent environment.

## How to gather the information

Run the checks below and compile results into the report format.

### 1. Session context

```bash
echo "Timestamp: $(date)"
echo "Working dir: $(pwd)"
echo "Group: $NANOCLAW_GROUP_FOLDER"
echo "Chat: $NANOCLAW_CHAT_JID"
```

### 2. Workspace

```bash
echo "=== Group folder ==="
ls | head -20
echo "=== Extra dirs ==="
ls extra/ 2>/dev/null || echo "none"
echo "=== IPC ==="
ls $NANOCLAW_IPC_DIR/ 2>/dev/null
```

### 3. Tool availability

Confirm which tool families are available to you:

- **Core:** Bash, Read, Write, Edit, Glob, Grep
- **Web:** WebSearch, WebFetch
- **Orchestration:** Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage
- **MCP:** mcp__nanoclaw__* (send_chat_message, send_agent_message, list_agents, schedule_task, list_tasks, pause_task, resume_task, cancel_task, update_task, register_group)

### 4. Runtime

```bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not installed"
node --version 2>/dev/null
claude --version 2>/dev/null
```

### 5. Task snapshot

Use the MCP tool to list tasks:

```
Call mcp__nanoclaw__list_tasks to get scheduled tasks.
```

If no tasks exist, report "No scheduled tasks."

## Report format

Present as a clean, readable message:

```
*NanoClaw Status*

*Session:*
• Group: telegram_main
• Chat: tg:6716918930
• Time: 2026-03-14 09:30 UTC

*Workspace:*
• Group folder: N files
• Extra dirs: none / N directories
• IPC: messages, tasks, input

*Tools:*
• Core: ok  Web: ok  Orchestration: ok  MCP: ok

*Runtime:*
• agent-browser: available / not installed
• Node: vXX.X.X
• Claude Code: vX.X.X

*Scheduled Tasks:*
• N active tasks / No scheduled tasks
```

Adapt based on what you actually find. Keep it concise — this is a quick health check, not a deep diagnostic.

**See also:** `/capabilities` for a full list of installed skills and tools.
