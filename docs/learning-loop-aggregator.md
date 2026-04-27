# Learning Loop Aggregator (S2)

Multi-session learning loop that detects recurring complex patterns across multiple Claude Code sessions and emits consolidated skill suggestions.

## Why S2 Differs from S5

S5 (`src/skill-suggestion/service.ts`) operates on a **single session**: at Stop hook time, it detects complexity in the current session and writes a pending draft.

S2 operates **across sessions**: it scans the accumulated pending drafts in SQLite, clusters them by tool-use similarity (Jaccard distance), and when a cluster reaches a threshold, emits a **consolidated suggestion** — a stronger signal that this workflow pattern genuinely recurs.

## Design Decision

The Python `learning-loop/skill_suggestion/hook.py` has no distinct S2 code. The multi-session layer was implied by the `_pending/` directory accumulation pattern. This TypeScript implementation makes the aggregation explicit:

- Uses the **same SQLite DB** as S5 (`skill_suggestions.db`) — no separate DB needed
- Adds a `clustered_at` column (migration-safe `ALTER TABLE IF NOT EXISTS`) to track which rows have been processed
- Jaccard similarity over `tool_sequence` token sets — capturing workflow similarity, not exact session match

## Architecture

```
scripts/aggregate-suggestions.ts    (CLI entry point)
src/skill-suggestion/
  aggregator.ts                      (S2 implementation)
  service.ts                         (S5 — feeds rows into the DB)
```

## Algorithm

1. Load all `pending` rows from `skill_suggestions` where `clustered_at IS NULL`
2. Compute tool-sequence token sets for each row
3. Greedy single-linkage clustering with `JACCARD_MIN=0.40` similarity threshold
4. Any cluster with `>= CLUSTER_THRESHOLD (3)` members → emit consolidated draft
5. Write `SUGGESTION-consolidated-<ts>-<cluster_id>.md` to `_pending/` directory
6. Mark contributing rows as `clustered_at = now()` (idempotent)

## Clustering Algorithm

Greedy single-linkage:
- Each row is tested against existing clusters in order
- If ANY member of an existing cluster has `Jaccard(new_row, member) >= 0.40`, the row joins that cluster
- Otherwise a new singleton cluster is created
- At end: only clusters with `count >= CLUSTER_THRESHOLD` produce output

This is `O(n²)` but suitable for the expected volume (tens to hundreds of suggestions).

## Consolidated Draft Format

```markdown
---
type: skill-suggestion-consolidated
generated: 2026-04-27T...
cluster_id: a1b2c3d4
session_count: 3
most_recent_at: 2026-04-26T...
representative_signature: b2c3d4e5
status: pending
---

# Consolidated skill suggestion (3 sessions)
> 3 sessions matched a similar tool-use pattern. Strong signal for a reusable skill.
...
```

## Usage

```bash
# Run aggregation
npm run aggregate-suggestions

# Dry run (compute but don't write)
npm run aggregate-suggestions -- --dry-run

# JSON output for scripting
npm run aggregate-suggestions -- --json
```

## Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `SKILL_AGGREGATOR_CLUSTER_THRESHOLD` | `3` | Minimum cluster size to emit consolidated suggestion |
| `SKILL_AGGREGATOR_JACCARD_MIN` | `0.40` | Minimum similarity to join a cluster |
| `SKILL_SUGGESTION_OUTPUT_DIR` | `~/.claude/skills/auto-suggested/_pending` | Output directory |
| `CLAUDECLAW_STORE_DIR` | `~/.claudeclaw/store` | SQLite store directory |
