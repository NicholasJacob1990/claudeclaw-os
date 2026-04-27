/**
 * types.ts — shared types for the skill-health validator subsystem.
 *
 * Ported from skill_health.py + skill_quality.py (Python ctx project).
 */

export type Severity = 'error' | 'warn' | 'info';

export interface HealthIssue {
  /** Machine-readable code, e.g. "missing-frontmatter". */
  code: string;
  severity: Severity;
  message: string;
  /** File path where the issue was found (optional). */
  file?: string;
  /** Line number inside the file (1-based, optional). */
  line?: number;
}

export interface SkillHealth {
  /** Skill slug (directory name). */
  slug: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Total line count (0 if missing). */
  lines: number;
  /** Byte size of the file (0 if missing). */
  bytes: number;
  /** Whether frontmatter was successfully parsed. */
  hasFrontmatter: boolean;
  /** Parsed frontmatter fields, or empty object. */
  frontmatter: Record<string, string>;
  issues: HealthIssue[];
  /** Worst severity across all issues, or "ok". */
  severity: Severity | 'ok';
}

export interface HealthSummary {
  total: number;
  ok: number;
  warn: number;
  error: number;
  skills: SkillHealth[];
}

export interface CheckOptions {
  /** Override the skills directory (default: ~/.claude/skills). */
  skillsDir?: string;
  /** Line count threshold before emitting warn:over-threshold. */
  lineThreshold?: number;
  /** Minimum body chars before emitting warn:thin-body. */
  minBodyChars?: number;
}
