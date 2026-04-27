# Skill Suggestion

Auto-detects complex Claude Code sessions and generates a SKILL.md draft via Sonnet 4.6, stored in `~/.claude/skills/auto-suggested/_pending/` for human review.

## What

When a session crosses all four complexity thresholds, the subsystem writes a draft SKILL.md to the pending directory. A human reviews it and decides whether to promote it to an active skill.

Two output modes:
- **Enriched** (default when `CLAUDE_CODE_OAUTH_TOKEN` is set): calls Sonnet 4.6 via the Claude Agent SDK to generate a real, structured SKILL.md with frontmatter, use cases, and concrete tool/file references.
- **Template fallback**: writes a structured Markdown summary of the session signals (tool counts, file paths, tool sequence) when OAuth token is absent or enrichment fails.

## Why

Sessions that require 10+ tool calls across 4+ different tools and 3+ files usually encode a reusable workflow. Capturing it automatically closes the loop between "doing" and "encoding knowledge".

Inspired by NousResearch/hermes-agent's `skill_manager_tool.py`, split into a free deterministic detector and an optional LLM enrichment stage.

## Architecture

```
TranscriptMessage[]
      │
      ▼
  detector.ts          Pure function. No I/O. Returns Suggestion | null.
      │ (null → stop)
      ▼
  service.ts           Idempotency check (DB + filesystem).
      │ (dup → stop)
      ▼
  enrichment.ts        Calls Sonnet via claude-agent-sdk. Returns EnrichedSuggestion | null.
      │
      ▼
  Write draft to _pending/
  Persist record to SQLite (skill-suggestions.db)
```

### Files

| File | Role |
|------|------|
| `src/skill-suggestion/types.ts` | Shared TypeScript interfaces |
| `src/skill-suggestion/detector.ts` | Pure heuristic detector |
| `src/skill-suggestion/enrichment.ts` | LLM enrichment via claude-agent-sdk |
| `src/skill-suggestion/service.ts` | Orchestrator + SQLite persistence |
| `src/skill-suggestion/detector.test.ts` | Vitest tests for detector |
| `src/skill-suggestion/enrichment.test.ts` | Vitest tests for enrichment (SDK mocked) |
| `src/skill-suggestion/service.test.ts` | Vitest integration tests for service |

## Complexity thresholds

All four must be met to trigger:

| Signal | Default | Env var |
|--------|---------|---------|
| Tool calls | >= 10 | `SKILL_SUGGESTION_MIN_TOOL_CALLS` |
| Distinct files edited | >= 3 | `SKILL_SUGGESTION_MIN_FILES_EDITED` |
| Distinct tool types | >= 4 | (hardcoded) |
| Not dominated by a single Skill | < 70% Skill ratio | (hardcoded) |

## Idempotency

Deduplication runs in two layers:

1. **SQLite** — `UNIQUE INDEX` on `signature`. Fast path.
2. **Filesystem** — scans `_pending/` for filename match or `session_id:` in frontmatter. Handles cases where the DB was wiped or the bot was reinstalled.

Signature: `sha1(sorted(tool_names) + sorted(file_paths))[:8]`

This means two sessions that touched the same files with the same tools produce the same signature — only the first generates a draft.

## Environment variables

All are optional (sensible defaults apply):

```bash
# Heuristic thresholds
SKILL_SUGGESTION_MIN_TOOL_CALLS=10
SKILL_SUGGESTION_MIN_FILES_EDITED=3

# Enrichment model (subscription auth, $0 real cost)
SKILL_SUGGESTION_MODEL=claude-sonnet-4-6

# Output directory for pending drafts
SKILL_SUGGESTION_OUTPUT_DIR=~/.claude/skills/auto-suggested/_pending
```

Enrichment only runs when `CLAUDE_CODE_OAUTH_TOKEN` is set (or already in the environment via `claude login`). Without it, the template fallback is used — no API call, no cost.

## Usage

### Programmatic (from a post-session hook)

```typescript
import { processSession } from './src/skill-suggestion/service.js';

const result = await processSession(transcriptMessages, sessionId);
if (result.triggered) {
  console.log(`Draft written to: ${result.draftPath}`);
  console.log(`Enriched by Sonnet: ${result.enriched}`);
}
```

### From a JSONL transcript file

```typescript
import { processTranscriptFile } from './src/skill-suggestion/service.js';

const result = await processTranscriptFile('/path/to/transcript.jsonl', sessionId);
```

### Reviewing pending drafts

```bash
ls ~/.claude/skills/auto-suggested/_pending/
# SUGGESTION-2026-04-26T12-30-00-ab3f1c2e-my-skill-name.md  (enriched)
# SUGGESTION-2026-04-26T13-00-00-cd9e2a4b.md                (template)
```

Enriched drafts include an HTML comment at the bottom with audit metadata (session_id, model, duration, estimated cost).

To promote a draft to an active skill: invoke `/skill-creator` with the draft as input, then move the output to `~/.claude/skills/auto-suggested/<slug>/SKILL.md`.

## Security flag

Bash commands matching any of these patterns are flagged in the draft:

- `rm -rf`, `sudo`, `curl|sh`, `eval`, `chmod 777`, `mkfs`, `dd if=`, fork bomb, `/dev/sdX`, `DROP TABLE/DATABASE`

Flagged drafts include a `## Security flag` section listing the matched commands. The detector does not block anything — it only annotates.
