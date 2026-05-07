---
name: audit-docs
description: Audit all documentation against the codebase. Spawns parallel agents to verify every claim in every doc file, reports staleness, and optionally applies fixes.
---

# Documentation Audit

Audit all documentation files against the actual codebase state. Spawn parallel agents to verify claims, then compile a report and apply fixes.

## Step 1: Discover documentation files

Find all documentation files in the project. These are the audit targets:

```
CLAUDE.md                    # Main project instructions
README.md                    # Public-facing docs (skip if upstream — check git log for local modifications first)
docs/*.md                    # Spec, security, requirements, integrations
groups/CLAUDE.md             # Global agent memory
CONTRIBUTING.md              # Contributor guide (if exists)
container/agent-runner/*.md  # Agent runner docs (if any)
skills/*/SKILL.md            # Runtime skill docs (if any)
```

Exclude: `node_modules/`, `dist/`, `.git/`, `groups/*/CLAUDE.md` (per-group memories are user content, not project docs).

List all discovered files and their line counts.

## Step 2: Spawn audit agents in parallel

For each documentation file (or logical group of small files), spawn an **Explore agent** (`subagent_type: "Explore"`) with thoroughness `"very thorough"`. Each agent gets a self-contained prompt — it has no context from this conversation.

Each agent's prompt must include:
1. The exact path to the doc file it's auditing
2. Instructions to read the doc file first
3. Instructions to verify every factual claim against the codebase by reading the referenced files, grepping for referenced symbols/tools/env vars, and checking that described behaviors match the code
4. A structured output format (see below)

**What to verify per doc:**
- File paths mentioned — do they exist? Are they at the stated locations?
- Function/class/variable names — do they exist in the stated files?
- Interface definitions and type signatures — do they match the code?
- Architecture descriptions — do they match the actual code flow?
- Tool/command lists — are they complete? Are any missing or removed?
- Configuration fields — do they exist in the types/schemas?
- Environment variables — are they used where described?
- Behavioral claims ("X does Y when Z") — does the code actually do this?
- Cross-references between docs — are they consistent?

**What NOT to flag:**
- README.md claims that are upstream project boilerplate (containers, Docker references) unless the user has locally modified that section
- Aspirational/roadmap items clearly marked as future work
- External links (don't fetch URLs)

**Required output format for each agent:**

```
## [filename]

### Verified Claims (count)
Brief summary of what checks passed.

### Issues Found
For each issue:
- **File**: path:line_number
- **Claim**: what the doc says
- **Reality**: what the code actually shows
- **Severity**: stale (outdated), wrong (incorrect), missing (undocumented feature), orphan (docs reference removed code)
- **Suggested fix**: one-line description

### Summary
X claims verified, Y issues found (Z stale, W wrong, V missing, U orphan)
```

**Parallelization strategy:**
- Large docs (CLAUDE.md, SPEC.md, SECURITY.md): one agent each
- Small related docs: group 2-3 per agent
- Maximum 5 agents concurrently to avoid resource pressure

## Step 3: Compile the report

After all agents complete, compile a single audit report:

1. **Executive summary**: total docs audited, total claims verified, total issues by severity
2. **Issues by severity**: list all issues grouped as `wrong` > `stale` > `orphan` > `missing`
3. **Per-file breakdown**: pass/fail status for each doc

Present the report to the user and ask: "Should I fix all issues, fix only [severity] issues, or let you review first?"

## Step 4: Apply fixes (if approved)

For each issue:
- **stale/wrong**: Edit the doc to match the code. Use the Edit tool — don't rewrite entire files.
- **orphan**: Remove the outdated reference from the doc.
- **missing**: Add documentation for the undocumented feature in the appropriate section of the appropriate doc.

After applying fixes, do a final consistency pass: grep for any remaining references to terms that were updated (e.g., if "container" was replaced with "native process" in one place, check it was updated everywhere).

## Notes

- This skill works with any agent backend (Claude Code, Codex, etc.) — agents only use read-only tools (Read, Grep, Glob).
- If the codebase is very large, prioritize docs that reference the most code paths.
- Don't modify code to match docs — docs should reflect code, not the other way around.
- If a doc references external systems (URLs, services, APIs), note them as "unverifiable" rather than flagging as issues.
