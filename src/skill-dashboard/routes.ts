/**
 * routes.ts — Route handlers for the skill dashboard.
 *
 * Uses Hono (already a dependency). Handlers are kept thin — data fetching
 * lives in data helpers, rendering in views.ts.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Hono } from 'hono';
import Database from 'better-sqlite3';

import { runChecks, runAllChecksForSkill } from '../skill-health/index.js';
import {
  renderHome,
  renderSkillsList,
  renderSkillDetail,
  renderSuggestions,
  renderAnnotations,
} from './views.js';
import type {
  AnnotationRow,
  DashboardDeps,
  DashboardStats,
  SkillListEntry,
  SuggestionRow,
} from './types.js';

// ── DB helpers ──────────────────────────────────────────────────────────────

function getStoreDir(deps?: DashboardDeps): string {
  if (deps?.storeDir) return deps.storeDir;
  return process.env.CLAUDECLAW_STORE_DIR
    ? path.resolve(process.env.CLAUDECLAW_STORE_DIR)
    : path.join(os.homedir(), '.claudeclaw', 'store');
}

function getSkillsDir(deps?: DashboardDeps): string {
  if (deps?.skillsDir) return deps.skillsDir;
  return process.env.CLAUDECLAW_SKILLS_DIR
    ? path.resolve(process.env.CLAUDECLAW_SKILLS_DIR)
    : path.join(os.homedir(), '.claude', 'skills');
}

let _suggestionsDb: Database.Database | null = null;
let _annotationsDb: Database.Database | null = null;

function getSuggestionsDb(storeDir: string): Database.Database | null {
  const dbPath = path.join(storeDir, 'skill-suggestions.db');
  if (!fs.existsSync(dbPath)) return null;
  if (_suggestionsDb) return _suggestionsDb;
  _suggestionsDb = new Database(dbPath, { readonly: true });
  return _suggestionsDb;
}

function getAnnotationsDb(storeDir: string): Database.Database | null {
  const dbPath = path.join(storeDir, 'skill-annotations.db');
  if (!fs.existsSync(dbPath)) return null;
  if (_annotationsDb) return _annotationsDb;
  _annotationsDb = new Database(dbPath, { readonly: true });
  return _annotationsDb;
}

/** Allow tests to reset DB connections. */
export function _resetDbConnections(): void {
  try { _suggestionsDb?.close(); } catch { /* ignore */ }
  try { _annotationsDb?.close(); } catch { /* ignore */ }
  _suggestionsDb = null;
  _annotationsDb = null;
}

// ── Data helpers ─────────────────────────────────────────────────────────────

function fetchSuggestions(storeDir: string, limit = 100): SuggestionRow[] {
  const db = getSuggestionsDb(storeDir);
  if (!db) return [];
  try {
    return db
      .prepare(
        `SELECT id, session_id, signature, status, skill_name, model, duration_ms, cost_usd, created_at
         FROM skill_suggestions ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as SuggestionRow[];
  } catch {
    return [];
  }
}

function fetchPendingCount(storeDir: string): number {
  const db = getSuggestionsDb(storeDir);
  if (!db) return 0;
  try {
    const row = db
      .prepare(`SELECT COUNT(*) as cnt FROM skill_suggestions WHERE status = 'pending'`)
      .get() as { cnt: number };
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

function fetchAnnotations(storeDir: string, limit = 100): AnnotationRow[] {
  const db = getAnnotationsDb(storeDir);
  if (!db) return [];
  try {
    return db
      .prepare(
        `SELECT id, skill, session_id, verdict, reason, model, cost_usd, created_at
         FROM skill_annotations ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as AnnotationRow[];
  } catch {
    return [];
  }
}

function fetchRecentAnnotationCount(storeDir: string): number {
  const db = getAnnotationsDb(storeDir);
  if (!db) return 0;
  try {
    const since = Math.floor(Date.now() / 1000) - 7 * 86400;
    const row = db
      .prepare(`SELECT COUNT(*) as cnt FROM skill_annotations WHERE created_at >= ?`)
      .get(since) as { cnt: number };
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerRoutes(app: Hono, deps?: DashboardDeps): void {
  const skillsDir = getSkillsDir(deps);
  const storeDir = getStoreDir(deps);

  // GET / — overview
  app.get('/', (c) => {
    const summary = runChecks(skillsDir);
    const stats: DashboardStats = {
      totalSkills: summary.total,
      pendingSuggestions: fetchPendingCount(storeDir),
      recentAnnotations: fetchRecentAnnotationCount(storeDir),
      healthSummary: {
        ok: summary.ok,
        warn: summary.warn,
        error: summary.error,
      },
    };
    return c.html(renderHome(stats));
  });

  // GET /skills — list all skills with health badge
  app.get('/skills', (c) => {
    const summary = runChecks(skillsDir);
    const entries: SkillListEntry[] = summary.skills.map((s) => ({
      slug: s.slug,
      path: s.path,
      severity: s.severity === 'info' ? 'ok' : (s.severity as 'ok' | 'warn' | 'error'),
      issueCount: s.issues.length,
      lines: s.lines,
      frontmatterName: s.frontmatter['name'] ?? null,
      description: s.frontmatter['description'] ?? null,
    }));
    return c.html(renderSkillsList(entries));
  });

  // GET /skills/:slug — detail page
  app.get('/skills/:slug', (c) => {
    const slug = c.req.param('slug');
    // Validate slug to prevent path traversal
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return c.text('Invalid slug', 400);
    }
    const skillDir = path.join(skillsDir, slug);
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    let content: string | null = null;
    try {
      content = fs.readFileSync(skillMdPath, 'utf-8');
    } catch {
      // not found — show as null
    }

    const health = runAllChecksForSkill(skillDir);
    return c.html(renderSkillDetail(slug, content, health));
  });

  // GET /suggestions
  app.get('/suggestions', (c) => {
    const rows = fetchSuggestions(storeDir);
    return c.html(renderSuggestions(rows));
  });

  // GET /annotations
  app.get('/annotations', (c) => {
    const rows = fetchAnnotations(storeDir);
    return c.html(renderAnnotations(rows));
  });

  // GET /health — JSON status
  app.get('/health', (c) => {
    const summary = runChecks(skillsDir);
    return c.json({
      status: 'ok',
      skills_count: summary.total,
      health: {
        ok: summary.ok,
        warn: summary.warn,
        error: summary.error,
      },
      db: {
        suggestions: fs.existsSync(path.join(storeDir, 'skill-suggestions.db')),
        annotations: fs.existsSync(path.join(storeDir, 'skill-annotations.db')),
      },
    });
  });
}
