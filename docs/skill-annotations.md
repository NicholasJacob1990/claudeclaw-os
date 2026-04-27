# Skill Annotations (S4)

Auto-annotates skill files when a correction pattern is detected in a Claude Code session transcript.

## How It Works

1. After each session (Stop hook), the transcript JSONL is parsed
2. For each `Skill` tool_use found in assistant turns, the system looks ahead N messages for a real user reply
3. If the reply is within `MAX_USER_TEXT_LEN` characters and passes the keyword gate, the LLM judge is called
4. If the judge returns `verdict=yes`, an annotation note is appended to `~/.claude/skills/<skill>/SKILL.md`

## Architecture

```
scripts/annotate-skills.ts   (CLI entry / Stop hook wrapper)
src/skill-annotations/
  types.ts                   (interfaces)
  keyword-score.ts           (pure heuristic gate — cheap pre-filter)
  transcript-parser.ts       (pure JSONL parser + pair extractor)
  judge.ts                   (Haiku 4.5 binary classifier via Agent SDK)
  annotator.ts               (orchestrator: parse → judge → append)
```

## Two-Stage Filtering

1. **Keyword gate** (cheap): scans for `STRONG_KEYWORDS` (worth 2 pts each) and `WEAK_KEYWORDS` (1 pt each). Only triggers LLM when `score >= 1`.
2. **LLM judge** (Haiku 4.5, fast, cheap via OAuth subscription): classifies `yes/no/ambiguous`. Only `yes` produces an annotation.
3. **Heuristic fallback**: if the LLM is unavailable (no `CLAUDE_CODE_OAUTH_TOKEN`), falls back to pure keyword score `>= 3`.

## Idempotence

- SQLite: `skill_annotations.db` table with UNIQUE constraint on `(skill, session_id, excerpt_hash)`.
- In-file: existing notes carry `<!-- h:XXXXXXXX -->` hash markers; duplicates are skipped.

## Annotation Format

Notes are appended under `## Notas de uso (auto-coletadas)` in the target SKILL.md:

```markdown
## Notas de uso (auto-coletadas)

- 2026-04-27 — sinal de correção pós-invocação. Trecho: "isso ta errado, refaz" Motivo: user explicitly asked to redo. Sessão: abc12345 <!-- h:a1b2c3d4 -->
```

- **Append-only**: never rewrites the skill body, only appends.
- **Hard cap**: max `ANNOTATION_CAP=10` notes per skill to prevent runaway growth.
- **Hermes skills**: read-only (skipped entirely).
- **Plugin skills** (with `:` in name): read-only (skipped).

## Usage

### As a Stop hook
Add to `.claude/settings.json` hooks:
```json
{
  "hooks": {
    "Stop": ["tsx /path/to/scripts/annotate-skills.ts"]
  }
}
```

### Manual run
```bash
npm run annotate-skills -- /path/to/transcript.jsonl [session_id] [--dry-run]
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SKILL_ANNOTATIONS_JUDGE_MODEL` | `claude-haiku-4-5` | LLM model for the judge |
| `SKILL_ANNOTATIONS_JUDGE_TIMEOUT_MS` | `20000` | Judge call timeout |
| `SKILL_ANNOTATIONS_SKILLS_DIR` | `~/.claude/skills` | Path to skills directory |
| `CLAUDECLAW_STORE_DIR` | `~/.claudeclaw/store` | Path to SQLite store |
| `CLAUDE_CODE_OAUTH_TOKEN` | (required) | OAuth token for Agent SDK |
