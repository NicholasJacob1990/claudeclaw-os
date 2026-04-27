/**
 * index.ts — Orchestrator for skill health checks.
 *
 * Ported from skill_health.py scan_skills() / _inspect() flow.
 *
 * Entry points:
 *   runChecks(skillsDir, opts)  — full health + quality checks for all skills
 *   runHealthChecks(skillDir)   — structural checks only for one skill dir
 *   runQualityChecks re-exported from quality.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { validateFrontmatter, validateDescription, parseFrontmatter } from './frontmatter.js';
import { validateBrokenRefs, validateSize } from './refs.js';
import { runQualityChecks } from './quality.js';
import type { CheckOptions, HealthIssue, HealthSummary, SkillHealth, Severity } from './types.js';

export type { CheckOptions, HealthIssue, HealthSummary, SkillHealth, Severity };
export { runQualityChecks };

const SEVERITY_RANK: Record<string, number> = { ok: 0, info: 1, warn: 2, error: 3 };

function worstSeverity(issues: HealthIssue[]): Severity | 'ok' {
  let worst: Severity | 'ok' = 'ok';
  for (const issue of issues) {
    if ((SEVERITY_RANK[issue.severity] ?? 0) > (SEVERITY_RANK[worst] ?? 0)) {
      worst = issue.severity;
    }
  }
  return worst;
}

function defaultSkillsDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

/**
 * Run all structural health checks for a single skill directory.
 * Returns SkillHealth for that skill.
 */
export function runHealthChecks(skillDir: string, opts: CheckOptions = {}): SkillHealth {
  const slug = path.basename(skillDir);
  const skillMdPath = path.join(skillDir, 'SKILL.md');

  // Missing file
  if (!fs.existsSync(skillMdPath)) {
    return {
      slug,
      path: skillMdPath,
      lines: 0,
      bytes: 0,
      hasFrontmatter: false,
      frontmatter: {},
      issues: [
        {
          code: 'missing-file',
          severity: 'error',
          message: 'Skill directory has no SKILL.md.',
          file: skillMdPath,
        },
      ],
      severity: 'error',
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(skillMdPath, 'utf-8');
  } catch (err) {
    return {
      slug,
      path: skillMdPath,
      lines: 0,
      bytes: 0,
      hasFrontmatter: false,
      frontmatter: {},
      issues: [
        {
          code: 'unreadable',
          severity: 'error',
          message: `Could not read SKILL.md: ${(err as Error).message}`,
          file: skillMdPath,
        },
      ],
      severity: 'error',
    };
  }

  const lines = content.split('\n').length;
  const bytes = Buffer.byteLength(content, 'utf8');
  const [frontmatter] = parseFrontmatter(content);
  const hasFrontmatter = Object.keys(frontmatter).length > 0;

  const issues: HealthIssue[] = [
    ...validateFrontmatter(content, skillMdPath),
    ...validateDescription(content, skillMdPath),
    ...validateBrokenRefs(content, skillDir, skillMdPath),
    ...validateSize(content, skillMdPath),
  ];

  return {
    slug,
    path: skillMdPath,
    lines,
    bytes,
    hasFrontmatter,
    frontmatter,
    issues,
    severity: worstSeverity(issues),
  };
}

/**
 * Run health checks + quality checks for a single skill directory.
 */
export function runAllChecksForSkill(skillDir: string, opts: CheckOptions = {}): SkillHealth {
  const health = runHealthChecks(skillDir, opts);
  const skillMdPath = health.path;

  if (health.severity === 'error' && !fs.existsSync(skillMdPath)) {
    return health; // can't run quality checks on missing file
  }

  let content = '';
  try {
    content = fs.readFileSync(skillMdPath, 'utf-8');
  } catch {
    return health;
  }

  const qualityIssues = runQualityChecks(content, skillMdPath);
  const allIssues = [...health.issues, ...qualityIssues];

  return {
    ...health,
    issues: allIssues,
    severity: worstSeverity(allIssues),
  };
}

/**
 * Run checks for all skills in a directory.
 *
 * @param skillsDir - Root skills directory (default: ~/.claude/skills).
 * @param opts - Check options.
 */
export function runChecks(
  skillsDir?: string,
  opts: CheckOptions = {},
): HealthSummary {
  const dir = skillsDir ?? opts.skillsDir ?? defaultSkillsDir();

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist — return empty summary
    return { total: 0, ok: 0, warn: 0, error: 0, skills: [] };
  }

  const skillDirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name))
    .sort();

  const skills = skillDirs.map((sd) => runAllChecksForSkill(sd, opts));

  let ok = 0, warn = 0, error = 0;
  for (const s of skills) {
    if (s.severity === 'ok' || s.severity === 'info') ok++;
    else if (s.severity === 'warn') warn++;
    else error++;
  }

  return { total: skills.length, ok, warn, error, skills };
}
