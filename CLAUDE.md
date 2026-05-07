# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running as native Node.js processes (no containers). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns native agent processes with env-based path config |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `skills/` | Global skills synced into agent session dirs at runtime |
| `container/agent-runner/` | Agent runner: receives input via stdin, runs agent backend, outputs via IPC |
| `container/agent-runner/src/backend.ts` | Backend abstraction: AgentBackend interface, createBackend() factory |
| `container/agent-runner/src/backends/` | Backend implementations (claude-code, codex) |
| `scripts/codex_proxy/` | Codex proxy: translates OpenAI Chat Completions to ChatGPT Responses API |
| `src/models.ts` | Model registry for /model command (Anthropic, local, codex models) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which provides credentials via `getContainerConfig()` injected as env vars into agent processes. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw:

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Runtime skills** — synced into agent session dirs at runtime (`skills/`, `groups/{name}/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Agent issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/create-agent` | Create a new domain agent from Telegram (guided workflow) |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
node node_modules/typescript/bin/tsc  # Build main project (tsc not on PATH in Termux)
# Agent runner (container/agent-runner/) must be built separately:
cd container/agent-runner && npm install && node ../../node_modules/typescript/bin/tsc
```

Service management:
```bash
# Termux (runit) — this installation
sv status nanoclaw
sv restart nanoclaw
sv up nanoclaw      # start
sv down nanoclaw    # stop
# Logs: tail -f $PREFIX/var/log/sv/nanoclaw/current
```

Quick rebuild shortcut: `./rebuild` (runs tsc + sv restart nanoclaw)

## Git & Fleet Sync

Two hosts run NanoClaw: **phone** (Termux, runit) and **nix** (NixOS, systemd). Both track `main`.

**Before committing:**
- Run `node node_modules/typescript/bin/tsc --noEmit` to type-check
- Group related changes into logical commits (e.g., separate refactor from feat from docs)
- Use conventional commit prefixes: `feat:`, `fix:`, `refactor:`, `docs:`

**Syncing to nix after push:**
```bash
ssh nix "cd ~/nanoclaw && git pull --ff-only && node node_modules/typescript/bin/tsc && cd container/agent-runner && node ../../node_modules/typescript/bin/tsc && echo '--- BUILD OK ---'"
```
If the service needs restarting on nix: `ssh nix "systemctl --user restart nanoclaw"`

**Common type pitfall:** `TelegramChannelOpts` in `src/channels/telegram.ts` is a separate interface from `ChannelOpts` in `src/channels/registry.ts`. When adding fields to `ChannelOpts`, also add them to `TelegramChannelOpts` if the Telegram channel uses them.

## Native Execution (no Docker)

Agents run as native Node.js processes — no containers, no Docker. The agent-runner
(`container/agent-runner/dist/index.js`) is spawned directly with workspace paths
passed via env vars (`NANOCLAW_IPC_DIR`, `NANOCLAW_GROUP_DIR`, `NANOCLAW_GLOBAL_DIR`,
`NANOCLAW_EXTRA_DIR`). Agents have full system access.

`src/container-runtime.ts` is a no-op stub (no runtime checks or orphan cleanup needed).

## Telegram Commands

Built-in bot commands handled directly by the Telegram channel (no agent invocation):
- `/model` — switch AI model per-group (registry in `src/models.ts`)
- `/new` — clear session, start fresh
- `/effort` — set reasoning effort (low/medium/high)
- `/plan` — toggle plan-before-execute mode
- `/skills` — list available commands and skills
- `/tools` — list available agent MCP tools
- `/compact` — handled by session-commands at orchestrator level (SDK compaction)
- `/chatid`, `/ping` — utility commands

Commands and skills auto-register in Telegram's autocomplete menu via `setMyCommands` on bot start. Skills are discovered from `skills/` and `groups/*/skills/` SKILL.md frontmatter.

Code: `TelegramChannel.connect()` in `src/channels/telegram.ts`, `discoverSkillCommands()`.

## MCP Tools

All MCP tools are defined in `container/agent-runner/src/ipc-mcp-stdio.ts` and available as `mcp__nanoclaw__*`:
- `send_chat_message` — send a message to the user/group chat (with optional `sender` for swarm bots)
- `send_agent_message` — send a message to another agent (local or remote via SSH)
- `list_agents` — list all known agents across instances
- `screenshot` — capture phone screen (root screencap + resize). Also `~/bin/screenshot` CLI.
- `read_pdf` — extract text from local PDFs or URLs (pdftotext). Also `~/bin/pdf-reader` CLI.
- `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `update_task` — task scheduling
- `register_group` — register new chat groups with optional `containerConfig` (main only)

## Cross-Instance Communication

Agents across hosts (phone + nix) communicate via `send_agent_message` MCP tool or `scripts/remote-message` CLI.
All paths deliver messages with full session context and trigger an immediate response.

- **Service agents** (telegram_main): orchestrator receives an `inject` IPC message, pipes it into the active session or wakes a new one if the agent is idle
- **Dev agents** (Claude Code sessions): `claude -c -p` via SSH resumes the most recent session; response is returned to the sender
- Remote hosts use SSH; local agents use direct filesystem writes
- Config: `data/agents.json` (per-instance, not in git — has `"self"` field for sender identity like `dev@phone`, `dev@nix`)
- CLI wrappers on Termux in `~/bin/` (set `NANOCLAW_DIR`); on nix symlinked directly
- Code: `send_agent_message`, `list_agents` in `container/agent-runner/src/ipc-mcp-stdio.ts`; `inject` handler in `src/ipc.ts`; wake-up logic in `src/index.ts`

## Model Switching

Users can switch models per-group via `/model` in Telegram. Model registry is in `src/models.ts`.
- Anthropic models (opus, sonnet, haiku): use Claude Code SDK via OAuth (`claude-code` backend)
- Local models (via Claude Code Router): use `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL` env vars
- Model IDs for local models use `llama-swap,<alias>` format to bypass CCR default routing
- Codex models (gpt-5.5, gpt-5.4, gpt-5.4-mini): use `codex` backend via codex-proxy service

When a codex model is selected, `container-runner.ts` sets `CODEX_MODEL` and `NANOCLAW_BACKEND=codex` env vars. The agent-runner's backend factory (`createBackend()` in `container/agent-runner/src/backend.ts`) selects the appropriate backend implementation.

## Telegram Bot Pool (Agent Swarm)

`TELEGRAM_BOT_POOL` in `.env` contains comma-separated tokens for send-only pool bots.
Pool bots are used when agents call `send_chat_message` with a `sender` parameter on `tg:` JIDs.
Each sender gets a stable pool bot assignment (round-robin), renamed via `setMyName`.
Code: `initBotPool()` and `sendPoolMessage()` in `src/channels/telegram.ts`, IPC routing in `src/ipc.ts`.

## SignetAI Memory

SignetAI runs as a daemon on `localhost:3850`, providing persistent memory across sessions.

- **Config**: `~/.agents/agent.yaml`
- **Database**: `~/.agents/memory/memories.db`
- **CLI**: `signet status`, `signet daemon restart`
- **Dashboard**: `http://localhost:3850`
- **Embeddings**: OpenAI `text-embedding-3-large` (API key in signet secrets)
- **Extraction/Synthesis**: `codex` provider, `gpt-5.4-mini` model

Two agents share the daemon:
- `default` — Claude Code dev sessions (hooks in `~/.claude/settings.json`)
- `telegram_main` (and other groups) — NanoClaw service agents (MCP server in agent-runner, `SIGNET_AGENT_ID` set dynamically to group folder name)

Agent-runner mounts `signet-mcp` alongside `nanoclaw` MCP in `container/agent-runner/src/index.ts`. Tools are `mcp__signet__*` (memory_store, memory_recall, memory_search, knowledge graph, etc.).

Service agents get **SessionStart injection** — before each fresh query, the agent-runner calls `POST http://127.0.0.1:3850/api/hooks/session-start` and injects recalled memories into the system prompt. This bridges the gap between dev sessions (full hooks) and service agents (previously MCP-only).

Proactively store anything significant to memory — user preferences, decisions, project context, corrections. When recalling, search before assuming. Memory is cheap; forgetting is expensive.

## Per-Group Agent Configuration (ContainerConfig)

Groups can be configured with per-agent restrictions and capabilities via `containerConfig` (stored as JSON in the `container_config` SQLite column). Fields:

- `allowedTools` — override default tool list (e.g., restrict an agent to read-only tools)
- `mcpServers` — additional MCP servers merged with the always-present `nanoclaw` + `signet`
- `additionalMounts` — extra directories symlinked into `groups/{folder}/extra/`
- `timeout` — custom agent timeout in milliseconds
- `backend` — agent backend (`claude-code` or `codex`)

Set via `register_group` MCP tool or direct SQLite. The agent-runner reads `container_config.json` from `NANOCLAW_IPC_DIR` at startup.

## Platform Quirks (Termux/Android)

- `tsc` is not on PATH — use `node node_modules/typescript/bin/tsc`
- The Grep tool fails (vendored rg binary ENOENT) — use `rg` via Bash instead
- `/tmp` is not writable — use `$HOME` or `$PREFIX/tmp` for temp files
- Root-owned files (e.g. from `su -c screencap`) need `su -c "rm ..."` to clean up
- Telegram Markdown v1 is fragile — use plain text for bot command responses to avoid parse errors
