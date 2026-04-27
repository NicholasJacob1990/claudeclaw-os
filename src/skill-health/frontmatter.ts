/**
 * frontmatter.ts — Parse and validate SKILL.md frontmatter.
 *
 * Ported from skill_health.py `_split_frontmatter` + `_inspect` logic.
 * Pure functions — no I/O.
 */

import type { HealthIssue } from './types.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const ACTION_VERBS = [
  'add', 'aggregate', 'analyze', 'annotate', 'build', 'call', 'check', 'clean',
  'collect', 'compile', 'compute', 'configure', 'convert', 'create', 'debug',
  'deploy', 'detect', 'diff', 'download', 'draft', 'edit', 'emit', 'evaluate',
  'execute', 'export', 'extract', 'fetch', 'find', 'fix', 'generate', 'get',
  'import', 'index', 'inspect', 'install', 'interact', 'invoke', 'lint', 'list',
  'load', 'manage', 'migrate', 'monitor', 'parse', 'patch', 'port', 'post',
  'process', 'publish', 'query', 'read', 'refactor', 'render', 'report', 'reset',
  'resolve', 'review', 'run', 'scan', 'score', 'search', 'send', 'set', 'show',
  'simulate', 'start', 'stop', 'summarize', 'sync', 'test', 'trace', 'transform',
  'translate', 'update', 'upload', 'use', 'validate', 'watch', 'write',
];

/**
 * Minimal YAML frontmatter splitter.
 * Returns [fields, body]. Scans up to first 80 lines for the closing ---.
 */
export function parseFrontmatter(content: string): [Record<string, string>, string] {
  if (!content.startsWith('---')) {
    return [{}, content];
  }
  const lines = content.split('\n');
  let closeIdx = -1;
  for (let i = 1; i < Math.min(80, lines.length); i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return [{}, content];
  }
  const fields: Record<string, string> = {};
  for (let i = 1; i < closeIdx; i++) {
    const colon = lines[i].indexOf(':');
    if (colon === -1) continue;
    const key = lines[i].slice(0, colon).trim();
    const val = lines[i].slice(colon + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) fields[key] = val;
  }
  const body = lines.slice(closeIdx + 1).join('\n');
  return [fields, body];
}

/**
 * Validate that frontmatter has the required fields with correct format.
 * Returns HealthIssue[] — empty array means no issues.
 */
export function validateFrontmatter(content: string, filePath?: string): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const [fields] = parseFrontmatter(content);

  if (Object.keys(fields).length === 0) {
    issues.push({
      code: 'missing-frontmatter',
      severity: 'error',
      message: 'No YAML frontmatter found. SKILL.md must start with --- block.',
      file: filePath,
    });
    return issues;
  }

  const name = fields['name'];
  if (!name) {
    issues.push({
      code: 'frontmatter-missing-name',
      severity: 'error',
      message: "Frontmatter missing required 'name' field.",
      file: filePath,
    });
  } else if (!NAME_RE.test(name)) {
    issues.push({
      code: 'frontmatter-invalid-name',
      severity: 'error',
      message: `'name' must match ^[a-z0-9][a-z0-9-]*$ — got: ${JSON.stringify(name)}`,
      file: filePath,
    });
  }

  const desc = fields['description'];
  if (!desc) {
    issues.push({
      code: 'frontmatter-missing-description',
      severity: 'warn',
      message: "Frontmatter missing 'description' — router relevance suffers.",
      file: filePath,
    });
  }

  return issues;
}

/**
 * Validate the description field: length, starts with action verb, not generic.
 */
export function validateDescription(content: string, filePath?: string): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const [fields] = parseFrontmatter(content);
  const desc = fields['description'];

  if (!desc) return issues; // covered by validateFrontmatter

  if (desc.length > 500) {
    issues.push({
      code: 'description-too-long',
      severity: 'warn',
      message: `Description is ${desc.length} chars (> 500). Consider trimming.`,
      file: filePath,
    });
  }

  if (desc.length > 200) {
    issues.push({
      code: 'description-verbose',
      severity: 'info',
      message: `Description is ${desc.length} chars (> 200). Shorter descriptions route faster.`,
      file: filePath,
    });
  }

  // Check it starts with an action verb (case-insensitive)
  const firstWord = desc.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  if (firstWord && !ACTION_VERBS.includes(firstWord)) {
    issues.push({
      code: 'description-no-action-verb',
      severity: 'warn',
      message: `Description should start with an action verb (e.g. "Analyze...", "Generate..."). Got: "${firstWord}"`,
      file: filePath,
    });
  }

  return issues;
}

export { NAME_RE, ACTION_VERBS };
