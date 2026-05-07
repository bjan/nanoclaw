# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Agent processes | Scoped | Per-group tool/path restrictions via containerConfig |
| Incoming messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Per-Group Tool Restrictions (Primary Boundary)

Agents run as native Node.js processes (no container sandbox). The primary security boundary is **per-group tool restrictions** via `containerConfig.allowedTools`:
- **Tool allow-listing** — restrict agents to specific tools (e.g., read-only agents get only Read/Glob/Grep)
- **Filesystem scoping** — each agent's cwd is `groups/{name}/`, with env vars controlling accessible paths
- **MCP server scoping** — custom MCP servers per group, merged with always-present nanoclaw + signet
- **Backend selection** — per-group backend (claude-code or codex) via `containerConfig.backend`

Since agents run natively with full system access, `allowedTools` is the key mechanism for restricting untrusted groups.

### 2. Additional Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Not accessible to agent processes by default
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .gpg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, .pypirc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Path validation (rejects `..` and absolute container paths)
- `nonMainReadOnly` option forces read-only for non-main groups

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Isolation (OneCLI Agent Vault)

Real API credentials are not passed directly to agent processes. NanoClaw uses [OneCLI's Agent Vault](https://github.com/onecli/onecli) to proxy outbound requests and inject credentials at the gateway level.

**How it works:**
1. Credentials are registered once with `onecli secrets create`, stored and managed by OneCLI
2. When NanoClaw spawns an agent, it calls `applyContainerConfig()` to route outbound HTTPS through the OneCLI gateway
3. The gateway matches requests by host and path, injects the real credential, and forwards
4. Agents cannot discover real credentials — not in environment, stdin, or files

**Per-agent policies:**
Each NanoClaw group gets its own OneCLI agent identity. This allows different credential policies per group (e.g. your sales agent vs. support agent). OneCLI supports rate limits, and time-bound access and approval flows are on the roadmap.

**Not accessible to agents:**
- Channel auth sessions (`store/auth/`) — orchestrator only
- Mount allowlist — external, not in agent paths
- Any credentials matching blocked patterns

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | Full (native process) | None |
| Store (SQLite DB) | Via IPC only | Via IPC only |
| Group folder | `groups/{name}/` (rw) | `groups/{name}/` (rw) |
| Global memory | `NANOCLAW_GLOBAL_DIR` | `NANOCLAW_GLOBAL_DIR` (ro) |
| Additional mounts | Configurable via containerConfig | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| Tools | All (default) | Configurable via allowedTools |
| MCP servers | nanoclaw + signet + custom | nanoclaw + signet + custom |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Incoming Messages (potentially malicious)                         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                   ORCHESTRATOR (TRUSTED)                           │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Agent process lifecycle                                        │
│  • Per-group containerConfig (tool restrictions, backend, MCP)    │
│  • OneCLI Agent Vault (injects credentials, enforces policies)   │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Scoped paths, restricted tools
┌──────────────────────────────────────────────────────────────────┐
│              AGENT RUNNER (NATIVE PROCESS, SCOPED)                │
│  • Backend: claude-code (Agent SDK) or codex (OpenAI proxy)      │
│  • Tools restricted by containerConfig.allowedTools               │
│  • File operations scoped to group dir + configured extras        │
│  • MCP: nanoclaw + signet + per-group custom servers              │
│  • API calls routed through OneCLI Agent Vault                   │
└──────────────────────────────────────────────────────────────────┘
```
