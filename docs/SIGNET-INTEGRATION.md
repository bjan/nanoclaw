# Signet Memory System — Full Integration Overview

*Last updated: 2026-05-07*

## Architecture

Signet runs as a daemon on `localhost:3850`, backed by SQLite (`~/.agents/memory/memories.db`) with OpenAI `text-embedding-3-large` for vector search. Memory processing uses a multi-stage pipeline (pipelineV2) with extraction and synthesis via `gpt-5-codex-mini` (codex provider). A knowledge graph (entities → aspects → groups → claims → attributes) provides structured relationships between memories.

**Scoring**: Hybrid search (vector + FTS keyword, `alpha=0.7`), `top_k=20`, `min_score=0.3`, with `decay_rate=0.95` for recency. A predictor sidecar does Reciprocal Rank Fusion for re-ranking.

**Multi-agent**: Each host (phone, nix) runs its own Signet daemon with two agents:
- `dev@phone` / `dev@nix` — Claude Code dev sessions
- `telegram_main` — NanoClaw service agent

That's four agents total across two daemons. Memories are scoped by `agent_id`; `read_policy: isolated` prevents cross-agent memory bleed within each daemon. The two daemons do not share a database.

## Dev Sessions (Claude Code)

Hooks defined in `~/nanoclaw/.claude/settings.json`. All use `--agent-id dev@phone` (or `dev@nix`).

| Hook | Trigger | What Happens | Output to Claude |
|------|---------|--------------|------------------|
| **SessionStart** (17s) | Session opens | Hybrid recall (FTS + vector), knowledge graph traversal, dedup guard. Budget: 15 memories, 8000 tokens | Full injection: Working Memory + relevant memories + secrets + constraints + recovery context |
| **UserPromptSubmit** (7s) | Each user turn | Match memories against prompt, dedup against recent injections, accumulate feedback, periodic checkpoint | Timestamp + matched memories (or "no match") |
| **PreCompact** (3s) | Before compaction | Flush accumulated state to checkpoint, generate summary prompt with recent memories as reference | "Store durable memories now" prompt + 5 recent memories |
| **PostCompact** (20s) | After compaction | 1) Extract summary from transcript → save via `compaction-complete` 2) Re-run `session-start` to re-inject full signet context | Full session-start injection (memory recovery after compaction) |
| **SessionEnd** (15s) | Session closes | Final checkpoint, aspect weight decay, transcript archival, enqueue async summary extraction job | Async — extraction runs in background |

**Synthesis**: `signet hook synthesis` → renders `renderMemoryProjection()` → writes `.signet/MEMORY.md`. Daemon reads this on next session-start. Schedule externally (e.g., cron or systemd timer).

## NanoClaw Service Agents (telegram_main)

Signet is mounted as an **MCP tool provider** via a filtering proxy (`scripts/mcp/signet-filtered.mjs`), and service agents now also get **SessionStart injection**.

| Aspect | What They Get | What They Don't Get |
|--------|---------------|---------------------|
| **Tools** | `memory_store`, `memory_search`, `memory_get`, `memory_list`, `memory_modify`, `memory_forget`, `memory_feedback`, full knowledge graph tools (`knowledge_expand`, `knowledge_tree`, entity/aspect/claim/attribute CRUD) | `agent_peers`, `agent_message_send`, `agent_message_inbox` (blocked by proxy) |
| **Hooks** | SessionStart (via agent-runner HTTP call), PreCompact (archives transcript to `groups/{name}/conversations/`) | No UserPromptSubmit matching, no PostCompact recovery, no SessionEnd extraction |
| **Agent ID** | `SIGNET_AGENT_ID` = group folder name (e.g., `telegram_main`) | — |
| **Memory scope** | Isolated — can only see own memories | Cannot read dev session memories |

**SessionStart injection**: Before each fresh query, the agent-runner calls `POST http://127.0.0.1:3850/api/hooks/session-start` with `harness: "nanoclaw"`, `agentId: groupFolder`, and `project: WORKSPACE_GROUP`. The response's `inject` field is appended to the system prompt, giving service agents automatic memory recall at session start — the same quality as dev sessions.

Service agents still benefit from proactive `memory_search`/`memory_store` calls for mid-session recall and storage, but the cold-start gap is closed.

## Data Flow Diagram

```
┌─────────────────────────────────────────────────┐
│                  Signet Daemon (:3850)           │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ memories │  │embeddings│  │knowledge graph│  │
│  │  (SQLite) │  │ (OpenAI) │  │  (entities)   │  │
│  └─────┬────┘  └─────┬────┘  └───────┬───────┘  │
│        └──────┬──────┘               │          │
│               ▼                      ▼          │
│        ┌─────────────┐     ┌──────────────┐     │
│        │hybrid recall│◄───►│graph traverse│     │
│        └──────┬──────┘     └──────────────┘     │
│               │                                  │
│    ┌──────────┼──────────┐                       │
│    ▼          ▼          ▼                       │
│  /session  /user-prompt  /pre-compaction         │
│  -start    -submit       /compaction-complete    │
│                          /session-end            │
│                          /synthesis              │
└──────────┬──────────────────────┬────────────────┘
           │                      │
    ┌──────▼──────┐      ┌───────▼────────┐
    │  Dev Agent   │      │ NanoClaw Agent │
    │(Claude Code) │      │(agent-runner)  │
    │              │      │                │
    │ 5 hooks:     │      │ MCP tools:     │
    │ SessionStart │      │ memory_store   │
    │ PromptSubmit │      │ memory_search  │
    │ PreCompact   │      │ knowledge_*    │
    │ PostCompact  │      │ memory_feedback│
    │ SessionEnd   │      │                │
    │              │      │ 2 hooks:       │
    │ Auto inject  │      │ SessionStart   │
    │ Auto extract │      │ (HTTP, inject) │
    │ Auto recover │      │ PreCompact     │
    │              │      │ (transcript)   │
    └──────────────┘      └────────────────┘
```

## Config Knobs (agent.yaml)

| Setting | Value | Controls |
|---------|-------|----------|
| `hooks.sessionStart.recallLimit` | 15 | Max memories in session-start injection |
| `hooks.sessionStart.maxInjectTokens` | 8000 | Token budget for injection |
| `memory.decay_rate` | 0.95 | Daily importance decay |
| `memory.session_budget` | 2000 | Per-session memory token budget |
| `search.alpha` | 0.7 | Vector vs FTS weight (0=pure FTS, 1=pure vector) |
| `search.top_k` | 20 | Max candidates from hybrid search |
| `search.min_score` | 0.3 | Minimum relevance threshold |
| `pipelineV2.autonomous.maintenanceMode` | execute | Auto-merge/supersede conflicting memories |
