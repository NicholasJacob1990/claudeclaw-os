# Skill Dashboard

A dark-themed local HTTP dashboard for monitoring your Claude Code skills, auto-suggestions, and annotations. Ported from `ctx_monitor.py` in the ctx project.

## How to run

```bash
npm run skill-dashboard
# or with custom port:
npm run skill-dashboard -- --port 8080
# or via env:
CLAUDECLAW_DASHBOARD_PORT=8080 npm run skill-dashboard
```

Default port: **7777**. Open `http://localhost:7777` in your browser.

## Endpoints

| Route | Description |
|---|---|
| `GET /` | Overview — cards: total skills, pending suggestions, annotations (7d), health summary |
| `GET /skills` | List of all skills in `~/.claude/skills/` with health badge |
| `GET /skills/:slug` | Skill detail — SKILL.md preview, health issues |
| `GET /suggestions` | Suggestions consolidated from S5/S2 SQLite (`skill-suggestions.db`) |
| `GET /annotations` | Recent annotations from S4 SQLite (`skill-annotations.db`) |
| `GET /health` | JSON status — skills count, DB connectivity |

## Data sources

- **Skills directory**: `~/.claude/skills/` (override with `CLAUDECLAW_SKILLS_DIR`)
- **SQLite store**: `~/.claudeclaw/store/` (override with `CLAUDECLAW_STORE_DIR`)
  - `skill-suggestions.db` — table `skill_suggestions` (created by S5)
  - `skill-annotations.db` — table `skill_annotations` (created by S4)

## Architecture

- Stack: **Hono** (`@hono/node-server`) — already a project dependency
- HTML: server-side rendered TypeScript template strings, no frontend framework
- HTMX: loaded from CDN for lightweight interactivity
- Theme: dark monospaced (`#0d1117` background, `SF Mono` / `Fira Code`)
- Files:
  - `src/skill-dashboard/server.ts` — Hono app factory (`createApp`) + `startDashboard`
  - `src/skill-dashboard/routes.ts` — route handlers
  - `src/skill-dashboard/views.ts` — pure HTML rendering functions
  - `src/skill-dashboard/types.ts` — shared interfaces
  - `scripts/skill-dashboard.ts` — CLI entry point

## DI / Testing

`createApp(deps?)` accepts optional `{ skillsDir, storeDir }` for test overrides. No mocking needed — pass fixture paths directly.
