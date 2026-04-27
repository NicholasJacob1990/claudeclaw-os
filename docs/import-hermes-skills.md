# import-hermes-skills

Ports all skills from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) into your local `~/.claude/` tree so Claude Code can discover and invoke them automatically.

## What

1. Shallow-clones `hermes-agent` into a temp directory (`git clone --depth=1 --filter=blob:none`).
2. Walks `skills/` and `optional-skills/` recursively for every `SKILL.md` leaf.
3. Copies each skill to two destinations:
   - **Runtime** `~/.claude/skills/hermes-<cat>--<skill>/` — Claude Code discovers skills at depth 1.
   - **KG index** `~/.claude/skill-wiki/imported-skills/hermes/<cat>--<skill>/` — ingested by the ctx recommender.
4. Writes a SHA-256 manifest to `~/.claude/skills/_hermes_manifest.json` for idempotency — re-runs skip skills whose `SKILL.md` has not changed.
5. Cleans up the temp clone on exit (unless `--no-cleanup`).

## Usage

```bash
# Full import (writes files, updates manifest)
npm run import-hermes-skills

# Preview what would change — no files written
npm run import-hermes-skills -- --dry-run

# Keep the temp clone after import (useful for debugging)
npm run import-hermes-skills -- --no-cleanup
```

## Slug convention

| Path inside `skills/` | Resulting slug |
|---|---|
| `code-tools/my-linter/` | `hermes-code-tools--my-linter` |
| `research/web-search/` | `hermes-research--web-search` |
| `flat-skill/` | `hermes-flat-skill` |
| `a/b/c/` | `hermes-a--b--c` |

Double-dash separators prevent collisions with manually authored skills.

## Idempotency

The manifest at `~/.claude/skills/_hermes_manifest.json` stores the SHA-256 of each skill's `SKILL.md`. A re-run only copies skills whose SHA has changed. Skills removed upstream are reported but **never auto-deleted** (safety against transient upstream issues).

## Architecture

```
npm run import-hermes-skills
        │
        ▼
scripts/import-hermes-skills.ts   CLI entry point (parses flags)
        │
        ▼
src/skill-import/hermes-importer.ts
  ├── shallowClone()              git clone --depth=1 --filter=blob:none
  ├── discoverSkills()            walk skills/ + optional-skills/ → slug list
  ├── importFromClone()           SHA check → copyTree × 2 → manifest update
  └── runHermesImport()           mkdtemp → clone → import → cleanup
        │
        ▼
src/skill-import/types.ts         DiscoveredSkill, ManifestEntry, SkillManifest, ImportOptions, ImportResult
```

## Source

Ported from `~/.claude/scripts/hermes-import/hermes_import.py` (Python original by Nicholas Jacob).
No LLM calls — pure git + filesystem utility.
