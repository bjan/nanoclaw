---
name: create-agent
description: Create a new domain agent — walks through naming, Telegram group setup, CLAUDE.md generation, and containerConfig. Main group only.
---

# /create-agent — New Agent Setup

Interactive workflow to create a fully configured domain agent. Only available from the main group.

## Step 1: Gather Requirements

Ask the user for:
1. **Domain/purpose** — what does this agent do? (e.g., "home automation", "health tracking")
2. **Name** — agent display name and trigger word (e.g., name: "HomeBot", trigger: "@home")
3. **Telegram group** — the user must create a Telegram group, add the bot, then send `/chatid` in that group. The JID will appear in the bot's response.

If the user already provided some of this info in their message, don't re-ask.

## Step 2: Determine Configuration

Based on the domain, decide with the user:

### Tool Access
Default is full access. For restricted agents, specify only what's needed:
- **Read-only agents**: `["Read", "Glob", "Grep", "WebSearch", "WebFetch", "mcp__nanoclaw__send_chat_message", "mcp__nanoclaw__list_agents", "mcp__signet__*"]`
- **Standard agents** (no system modification): `["Bash", "Read", "Glob", "Grep", "WebSearch", "WebFetch", "mcp__nanoclaw__*", "mcp__signet__*"]`
- **Full access**: omit `allowedTools` (uses default list)

### Additional Mounts
If the agent needs access to directories outside its group folder:
```json
{ "hostPath": "~/projects/myrepo", "containerPath": "myrepo", "readonly": true }
```

### MCP Servers
If the agent needs domain-specific tools beyond nanoclaw + signet:
```json
{ "command": "node", "args": ["/path/to/server.js"], "env": { "KEY": "value" } }
```

### Backend
Default: `claude-code`. Can also be `codex` (when implemented).

### Timeout
Default: 300000 (5 minutes). Increase for long-running agents.

## Step 3: Create Group Folder

```bash
FOLDER="telegram_<group-name>"  # lowercase, hyphens
mkdir -p ~/nanoclaw/groups/$FOLDER
```

## Step 4: Generate CLAUDE.md

Write `~/nanoclaw/groups/$FOLDER/CLAUDE.md` tailored to the agent's domain. Include:
- Role and purpose (1-2 sentences)
- What tools/resources are available
- Behavioral guidelines specific to the domain
- Memory instructions: "Use `mcp__signet__memory_store` to save important information. Use `mcp__signet__memory_search` before assuming — check what you already know."

Keep it concise — under 80 lines. The agent gets this as system prompt context.

## Step 5: Register the Group

Call `register_group` with all parameters:

```
register_group({
  jid: "tg:-100XXXXXXXXXX",
  name: "Display Name",
  folder: "telegram_<group-name>",
  trigger: "@trigger",
  requiresTrigger: false,
  containerConfig: {
    allowedTools: [...],           // optional
    mcpServers: { ... },           // optional
    additionalMounts: [ ... ],     // optional
    timeout: 300000,               // optional
    backend: "claude-code"         // optional
  }
})
```

## Step 6: Update agents.json

Add the new agent to `~/nanoclaw/data/agents.json` so other agents can message it:

```bash
# Read current file, add entry, write back
```

New entry format:
```json
{
  "name": "telegram_<group-name>",
  "host": "phone",
  "type": "service"
}
```

## Step 7: Verify

Send a test message in the new Telegram group. Confirm the agent responds. Report the result to the user.

## Notes

- The folder name MUST be channel-prefixed: `telegram_<name>`, `whatsapp_<name>`, etc.
- The group folder name becomes the Signet agent ID for memory isolation.
- Each host has its own Telegram bot — agents registered on phone use the phone bot, nix uses the nix bot.
- If the agent should also exist on nix, tell the user to repeat registration there or use `/sync-fleet`.
