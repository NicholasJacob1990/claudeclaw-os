/**
 * quality.ts — Deeper quality checks for SKILL.md.
 *
 * Ported from skill_quality.py (Python ctx project) — ported the 7 most
 * actionable checks; skipped the weighted scoring system which requires
 * telemetry/graph/routing signal pipelines not available here.
 *
 * All functions are pure (no I/O). They receive content as string and
 * return HealthIssue[].
 */

import type { HealthIssue } from './types.js';
import { parseFrontmatter } from './frontmatter.js';

// ── Check 1: Generic description detection ─────────────────────────────────
// Descriptions that are too vague don't help the router find the right skill.
const GENERIC_DESC_PATTERNS = [
  /^this skill/i,
  /^a skill (that|to|for)/i,
  /^skill (that|to|for)/i,
  /^helps (you|the user)/i,
  /^use this/i,
  /^wrapper/i,
  /^utility/i,
];

export function checkGenericDescription(content: string, filePath?: string): HealthIssue[] {
  const [fields] = parseFrontmatter(content);
  const desc = fields['description'];
  if (!desc) return [];

  for (const pat of GENERIC_DESC_PATTERNS) {
    if (pat.test(desc)) {
      return [
        {
          code: 'description-generic',
          severity: 'warn',
          message: `Description appears generic ("${desc.slice(0, 60)}..."). Be specific about what the skill does and when to use it.`,
          file: filePath,
        },
      ];
    }
  }
  return [];
}

// ── Check 2: Missing examples section ──────────────────────────────────────
// Skills without examples are harder to invoke correctly.
const EXAMPLE_HEADER_RE = /^##?\s+(example|usage|how to use|invocation)/im;
const BACKTICK_BLOCK_RE = /```/;

export function checkMissingExamples(content: string, filePath?: string): HealthIssue[] {
  const [, body] = parseFrontmatter(content);
  if (EXAMPLE_HEADER_RE.test(body) || BACKTICK_BLOCK_RE.test(body)) {
    return [];
  }
  return [
    {
      code: 'missing-examples',
      severity: 'info',
      message: 'No examples or code blocks found. Adding usage examples improves skill discoverability.',
      file: filePath,
    },
  ];
}

// ── Check 3: Minimum body length ────────────────────────────────────────────
const MIN_BODY_CHARS = 120;

export function checkThinBody(content: string, filePath?: string): HealthIssue[] {
  const [, body] = parseFrontmatter(content);
  const nonBlank = body.split('\n').filter((l) => l.trim()).join('\n');
  if (nonBlank.length < MIN_BODY_CHARS) {
    return [
      {
        code: 'thin-body',
        severity: 'warn',
        message: `Body has only ${nonBlank.length} non-blank chars (< ${MIN_BODY_CHARS}). Add more context, steps, or examples.`,
        file: filePath,
      },
    ];
  }
  return [];
}

// ── Check 4: Missing trigger hints ──────────────────────────────────────────
// Skills should describe when/why to invoke them.
const TRIGGER_KEYWORDS = ['when', 'trigger', 'use when', 'invoke when', 'call when'];

export function checkMissingTriggers(content: string, filePath?: string): HealthIssue[] {
  const [, body] = parseFrontmatter(content);
  const lower = body.toLowerCase();
  const hasTrigger = TRIGGER_KEYWORDS.some((kw) => lower.includes(kw));
  if (!hasTrigger) {
    return [
      {
        code: 'missing-trigger-hints',
        severity: 'info',
        message: 'No trigger hints found. Consider adding "When to use:" or "Trigger:" section so the router invokes this skill at the right time.',
        file: filePath,
      },
    ];
  }
  return [];
}

// ── Check 5: Duplicate frontmatter keys ─────────────────────────────────────
export function checkDuplicateKeys(content: string, filePath?: string): HealthIssue[] {
  if (!content.startsWith('---')) return [];
  const lines = content.split('\n');
  let closeIdx = -1;
  for (let i = 1; i < Math.min(80, lines.length); i++) {
    if (lines[i].trim() === '---') { closeIdx = i; break; }
  }
  if (closeIdx === -1) return [];

  const seen = new Set<string>();
  const dupes: string[] = [];
  for (let i = 1; i < closeIdx; i++) {
    const colon = lines[i].indexOf(':');
    if (colon === -1) continue;
    const key = lines[i].slice(0, colon).trim().toLowerCase();
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  if (dupes.length === 0) return [];
  return [
    {
      code: 'frontmatter-duplicate-keys',
      severity: 'warn',
      message: `Duplicate frontmatter keys: ${dupes.join(', ')}. Keep only one occurrence.`,
      file: filePath,
    },
  ];
}

// ── Check 6: Body minimum non-blank line count (structural) ─────────────────
const MIN_BODY_LINES = 5;

export function checkMinBodyLines(content: string, filePath?: string): HealthIssue[] {
  const [, body] = parseFrontmatter(content);
  const nonBlank = body.split('\n').filter((l) => l.trim());
  if (nonBlank.length < MIN_BODY_LINES) {
    return [
      {
        code: 'empty-body',
        severity: 'error',
        message: `Body has fewer than ${MIN_BODY_LINES} non-blank lines. SKILL.md appears empty or stub.`,
        file: filePath,
      },
    ];
  }
  return [];
}

// ── Check 7: Missing section headers ────────────────────────────────────────
const SECTION_HEADER_RE = /^##?\s+\S/m;

export function checkMissingSections(content: string, filePath?: string): HealthIssue[] {
  const [, body] = parseFrontmatter(content);
  if (SECTION_HEADER_RE.test(body)) return [];
  return [
    {
      code: 'no-sections',
      severity: 'info',
      message: 'No Markdown section headers (##) found. Structured sections improve readability and routing.',
      file: filePath,
    },
  ];
}

/**
 * Run all quality checks against a SKILL.md content string.
 * Returns aggregated HealthIssue[].
 */
export function runQualityChecks(content: string, filePath?: string): HealthIssue[] {
  return [
    ...checkGenericDescription(content, filePath),
    ...checkMissingExamples(content, filePath),
    ...checkThinBody(content, filePath),
    ...checkMissingTriggers(content, filePath),
    ...checkDuplicateKeys(content, filePath),
    ...checkMinBodyLines(content, filePath),
    ...checkMissingSections(content, filePath),
  ];
}
