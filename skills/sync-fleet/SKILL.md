---
name: sync-fleet
description: Pull, build, and restart signetai + nanoclaw on phone and nix. Run after pushing changes to either repo.
---

# /sync-fleet — Fleet Sync

Pull latest code, rebuild, and restart services on both phone and nix hosts.

## Usage

Run the sync script:

```bash
~/bin/sync-fleet
```

Options:
- `--signet-only` — only sync the signetai fork
- `--nanoclaw-only` — only sync nanoclaw
- `--local-only` — skip SSH to the other host

## What it does

For each repo (signetai, nanoclaw) on each host (phone, nix):
1. Checks for uncommitted changes to tracked files (aborts that repo if dirty)
2. `git pull --ff-only origin main` (aborts if non-fast-forward)
3. Rebuilds (bun build for signetai, tsc for nanoclaw)
4. Restarts services (signet daemon, nanoclaw)

Phone triggers nix via SSH. Nix-specific files (groups/*/CLAUDE.md, .env, data/) are gitignored and never touched.

## When to use

- After pushing code changes to `bjan/signetai` or `bjan/nanoclaw`
- After editing signetai daemon/MCP code locally and pushing
- When told "sync" or "deploy" by the user

## Report format

Stream the script output directly to the user. No reformatting needed — the script uses ✓/✗/→ indicators.
