# Orchestrator

Runs autonomously alongside the message server. Idle-time background loop that self-scans NanoClaw's codebase, executes improvement goals, and triages GitHub issues.

## Module Map

| File | Purpose |
|------|---------|
| `index.ts` | Entry point — wires up all orchestrator loops |
| `state.ts` | Persist cycle count, issue quotas, heartbeat to `/tmp/orchestrator-state.json` |
| `types.ts` | Shared types (`OrchestratorState`, `Finding`, constants) |
| `pipeline.ts` | Scan → validate → deduplicate → create-issue pipeline |
| `scanning.ts` | Agentic code sweep via Claude Code (Pi-powered) |
| `triage.ts` | Filter findings, check relevance, rate-limit issue creation |
| `self-validation.ts` | Re-scan own findings to reduce false positives |
| `static-analysis.ts` | Fast deterministic checks (no LLM) |
| `maintenance.ts` | Repo hygiene: stale worktrees, stash, dirty files |
| `git-ops.ts` | Low-level git utilities (pull, diff, log, file list) |
| `github-issues.ts` | Create / list / close GitHub issues via `gh` CLI |
| `minimax-client.ts` | MiniMax LLM client (RPM-gated) for eval and summarization |
| `auto-resolve.ts` | Auto-close resolved issues after re-verification |
| `telegram.ts` | Send orchestrator status notifications via Telegram |

## Nested Subsystems

- **`evolution/`** — [CLAUDE.md](evolution/CLAUDE.md): goal queue, worktree-isolated execution, curiosity-driven research
