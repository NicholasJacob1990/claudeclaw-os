#!/usr/bin/env tsx
/**
 * skill-health.ts — Run SKILL.md health checks and print a table.
 *
 * Usage:
 *   npx tsx scripts/skill-health.ts
 *   npx tsx scripts/skill-health.ts --dir /path/to/skills
 *   npx tsx scripts/skill-health.ts --strict
 *
 * Exit code:
 *   0 — all checks passed (or only warnings / info)
 *   1 — one or more ERROR-level issues found
 */

import os from 'os';
import path from 'path';

import { runChecks } from '../src/skill-health/index.js';
import type { SkillHealth } from '../src/skill-health/types.js';

// ── Parse args ─────────────────────────────────────────────────────────────

let skillsDir = path.join(os.homedir(), '.claude', 'skills');
let strictMode = false;

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--dir' && process.argv[i + 1]) {
    skillsDir = path.resolve(process.argv[i + 1].replace(/^~/, os.homedir()));
    i++;
  } else if (process.argv[i] === '--strict') {
    strictMode = true;
  }
}

// ── Run ────────────────────────────────────────────────────────────────────

const summary = runChecks(skillsDir);

// ── Render table ──────────────────────────────────────────────────────────

const SEV_ICONS: Record<string, string> = {
  ok: '✓',
  info: 'ℹ',
  warn: '⚠',
  error: '✗',
};

const COL_W = [30, 6, 6, 50];

function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function header(): string {
  return (
    padEnd('SKILL', COL_W[0]) +
    padEnd('LINES', COL_W[1]) +
    padEnd('SEV', COL_W[2]) +
    'ISSUES'
  );
}

function row(s: SkillHealth): string {
  const icon = SEV_ICONS[s.severity] ?? '?';
  const issuesSummary =
    s.issues.length === 0
      ? 'ok'
      : s.issues
          .slice(0, 3)
          .map((i) => i.code)
          .join(', ') + (s.issues.length > 3 ? ` +${s.issues.length - 3}` : '');

  return (
    padEnd(s.slug, COL_W[0]) +
    padEnd(String(s.lines), COL_W[1]) +
    padEnd(`${icon} ${s.severity}`, COL_W[2] + 2) +
    issuesSummary
  );
}

console.log(`\nSkill health check — ${skillsDir}\n`);
console.log(header());
console.log('─'.repeat(100));
for (const s of summary.skills) {
  console.log(row(s));
}
console.log('─'.repeat(100));
console.log(
  `\nTotal: ${summary.total}  OK: ${summary.ok}  Warn: ${summary.warn}  Error: ${summary.error}\n`,
);

// Print error details
if (summary.error > 0) {
  console.error('ERROR details:');
  for (const s of summary.skills) {
    for (const issue of s.issues) {
      if (issue.severity === 'error') {
        console.error(`  [${s.slug}] ${issue.code}: ${issue.message}`);
      }
    }
  }
  console.error('');
}

// Exit code
if (summary.error > 0) {
  process.exit(1);
}
if (strictMode && summary.warn > 0) {
  process.exit(1);
}
