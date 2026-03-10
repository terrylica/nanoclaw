# Evolution Subsystem

Autonomous self-improvement loop. Runs during idle periods to research SOTA techniques, queue improvement goals, and implement them in isolated git worktrees with full validation.

## 7-Step Evolution Cycle (`engine.ts`)

Steps run in priority order each idle cycle:

1. **Goal execution** — implement the next queued goal (highest priority)
2. **Self-scan** — discover issues via agentic Pi-powered code sweep
3. **Research** — curiosity-driven exploration with 4-strategy rotation
4. **Prompt refinement** — optimize worst-performing prompts from usage data
5. **Rule expansion** — import community ast-grep / OpenGrep rules
6. **Issue landscape** — check open GitHub issues for new relevance
7. **Repo hygiene** — clean stale worktrees, drop stashes, reset dirty files

**Safety guards**: RPM budget via `canCallMiniMax()`, stagnation pause after consecutive failures, protected-file list enforced at both execution and validation.

## Key Files

| File | Purpose |
|------|---------|
| `engine.ts` | Main loop: priority dispatch, RPM gating, stagnation tracking, autonomous restart after src/ changes |
| `state.ts` | Goal queue (ring buffer max 100), completed goals, research topics (ring buffer max 50) |
| `goal-executor.ts` | Isolated goal implementation: worktree → Claude Code → validate → merge |
| `goal-validator.ts` | 4-gate validation pipeline (returns typed `GateResult[]`) |
| `goal-worktree.ts` | Git worktree lifecycle: create / diff / commit / merge / cleanup |
| `research.ts` | Curiosity-driven research: 4-strategy rotation, exploration map, MiniMax synthesis |
| `git-safety.ts` | Allowlist of files that Claude Code may modify during goal execution |
| `rpm-tracker.ts` | Token-bucket RPM limiter for MiniMax API calls |
| `telegram-presenter.ts` | Format and send evolution status to Telegram |
| `telegram-feedback.ts` | Parse Telegram replies to accept/reject pending goals |
| `reflection-store.ts` | Persist goal outcomes for reflexion-agent learning |
| `reflexion-agent.ts` | Generate better goal descriptions from past failures |
| `validator.ts` | Top-level evolution state validator (distinct from goal-validator) |

## Goal Execution Flow (`goal-executor.ts`)

```
create worktree (goal/<id> branch in /tmp)
  → invoke Claude Code (protected file list, $USD budget, 5-min timeout)
  → extract diff from worktree
  → run 4-gate validation
  → commit in worktree
  → fast-forward merge to main
  → cleanup worktree
```

Worktrees always cleaned up on exit, even on failure. No node_modules symlink in worktree — validation uses absolute paths to main repo's `tsc`.

## 4-Gate Validation (`goal-validator.ts`)

Gates run in order; any hard-fail aborts the merge.

| Gate | Type | Check |
|------|------|-------|
| Protected file | Hard | Rejects changes to `engine.ts`, `validator.ts`, `state.ts`, `node_modules`, `bun.lock`, `package.json` |
| Build | Hard | `tsc --noEmit` must pass (120s timeout) |
| Test | Advisory | `bun test` (180s timeout, 157 pre-existing failures — non-blocking) |
| MiniMax review | Soft | LLM diff review; fails open if MiniMax unavailable |

Each gate returns `GateResult { gate, pass, detail, durationMs }`.

## Research Strategies (`research.ts`)

Rotates through 4 strategies per cycle:

| Strategy | Behavior |
|----------|----------|
| Exploit | Deep-dive high-yield domains already in exploration map |
| Explore | Discover new domains, lesser-known tools, academic papers |
| Serendipity | Cross-pollinate from adjacent fields (game AI, biology, NLP) |
| Contrarian | Challenge assumptions, seek failure cases, find alternatives |

**Research flow**: MiniMax picks 2 topics → Claude multi-turn agent investigates (WebSearch + WebFetch, $1.50 budget, 3-min timeout) → MiniMax synthesizes into 5 actionable items → relevance filter (threshold ≥ 0.7) → goals queued.

Exploration map (domain → `{ searches, goals, successCount }`) steers strategy selection and prevents duplicate domains (ring buffer max 50 topics).
