# Skill Health

SKILL.md validator — runs structural and quality checks on every skill in `~/.claude/skills/`. Ported from `skill_health.py` and `skill_quality.py` in the ctx project.

## How to run

```bash
npm run skill-health
# custom skills directory:
npm run skill-health -- --dir /path/to/skills
# exit 1 on warnings too:
npm run skill-health -- --strict
```

Exit code:
- `0` — no errors (may have warnings / info)
- `1` — one or more `error`-severity issues (or any issue if `--strict`)

## Example output

```
Skill health check — /Users/you/.claude/skills/

SKILL                         LINES SEV    ISSUES
────────────────────────────────────────────────────────────────────────────────────────────────────
my-good-skill                 42    ✓ ok   ok
my-broken-skill               3     ✗ error missing-frontmatter, empty-body
my-verbose-skill              210   ⚠ warn over-threshold
────────────────────────────────────────────────────────────────────────────────────────────────────

Total: 3  OK: 1  Warn: 1  Error: 1
```

## Checks

### Structural (health)

| Code | Severity | Description |
|---|---|---|
| `missing-file` | error | Skill directory has no `SKILL.md` |
| `unreadable` | error | File could not be read as UTF-8 |
| `missing-frontmatter` | error | No `---` YAML block at top of file |
| `frontmatter-missing-name` | error | `name` field absent from frontmatter |
| `frontmatter-invalid-name` | error | `name` doesn't match `^[a-z0-9][a-z0-9-]*$` |
| `frontmatter-missing-description` | warn | `description` field absent |
| `description-no-action-verb` | warn | Description doesn't start with an action verb |
| `description-too-long` | warn | Description > 500 chars |
| `description-verbose` | info | Description > 200 chars |
| `broken-ref` | warn | Relative Markdown link points to non-existent file |
| `file-too-large` | warn | SKILL.md > 50 KB |
| `file-too-small` | error | SKILL.md < 100 bytes (stub/empty) |
| `over-threshold` | warn | > 180 lines — consider splitting |

### Quality (deeper checks)

| Code | Severity | Description |
|---|---|---|
| `description-generic` | warn | Description starts with generic phrase ("this skill", "a skill that", etc.) |
| `missing-examples` | info | No code blocks or `## Examples` section |
| `thin-body` | warn | Body < 120 non-blank chars |
| `missing-trigger-hints` | info | No "when" / "trigger" / "use when" keywords |
| `frontmatter-duplicate-keys` | warn | Same key appears twice in frontmatter |
| `empty-body` | error | Fewer than 5 non-blank lines in body |
| `no-sections` | info | No `##` section headers |

## Architecture

- Files:
  - `src/skill-health/types.ts` — `HealthIssue`, `SkillHealth`, `HealthSummary`
  - `src/skill-health/frontmatter.ts` — frontmatter parsing + validation
  - `src/skill-health/refs.ts` — broken-ref detection + size validation
  - `src/skill-health/quality.ts` — 7 quality checks
  - `src/skill-health/index.ts` — `runChecks`, `runHealthChecks`, `runAllChecksForSkill`
  - `scripts/skill-health.ts` — CLI entry
  - `src/skill-health/tests/health.test.ts` — vitest suite
  - `src/skill-health/tests/fixtures/good-skill/` — fixture: no errors
  - `src/skill-health/tests/fixtures/bad-skill/` — fixture: multiple errors

All functions are pure (no global I/O except `validateBrokenRefs`/`validateSize` which take content strings and resolved paths).
