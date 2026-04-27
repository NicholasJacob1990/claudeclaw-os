/**
 * types.ts — Shared types for the skill dashboard (S6).
 */

export interface DashboardStats {
  totalSkills: number;
  pendingSuggestions: number;
  recentAnnotations: number;
  healthSummary: {
    ok: number;
    warn: number;
    error: number;
  };
}

export interface SuggestionRow {
  id: number;
  session_id: string;
  signature: string;
  status: string;
  skill_name: string | null;
  model: string | null;
  duration_ms: number | null;
  cost_usd: number | null;
  created_at: number;
}

export interface AnnotationRow {
  id: number;
  skill: string;
  session_id: string;
  verdict: string;
  reason: string | null;
  model: string | null;
  cost_usd: number | null;
  created_at: number;
}

export interface SkillListEntry {
  slug: string;
  path: string;
  severity: 'ok' | 'warn' | 'error' | 'info';
  issueCount: number;
  lines: number;
  frontmatterName: string | null;
  description: string | null;
}

export interface DashboardDeps {
  skillsDir?: string;
  storeDir?: string;
}
