/**
 * refs.ts — Validate broken Markdown links/images in SKILL.md.
 *
 * Ported from skill_health.py concept (broken reference detection).
 * Pure functions that take content + dir; no global I/O.
 */

import fs from 'fs';
import path from 'path';
import type { HealthIssue } from './types.js';

// Matches: [text](./path) or ![alt](./path) — relative paths only (skip http/https/anchors)
const MD_LINK_RE = /!?\[(?:[^\]]*)\]\(([^)]+)\)/g;

function isRelativePath(href: string): boolean {
  return (
    !href.startsWith('http://') &&
    !href.startsWith('https://') &&
    !href.startsWith('#') &&
    !href.startsWith('mailto:')
  );
}

/**
 * Scan content for Markdown links/images pointing at local files and check
 * whether those files exist in `skillDir`.
 *
 * @param content - Full SKILL.md content.
 * @param skillDir - Directory containing the SKILL.md (for resolving relative paths).
 * @param filePath - Path to report in issues.
 */
export function validateBrokenRefs(
  content: string,
  skillDir: string,
  filePath?: string,
): HealthIssue[] {
  const issues: HealthIssue[] = [];
  let match: RegExpExecArray | null;

  MD_LINK_RE.lastIndex = 0;

  const lines = content.split('\n');

  while ((match = MD_LINK_RE.exec(content)) !== null) {
    const href = match[1].split('#')[0].trim(); // strip fragments
    if (!href || !isRelativePath(href)) continue;

    const absTarget = path.resolve(skillDir, href);
    if (!fs.existsSync(absTarget)) {
      // Find line number
      const offset = match.index;
      let lineNo = 1;
      let acc = 0;
      for (const line of lines) {
        acc += line.length + 1;
        if (acc > offset) break;
        lineNo++;
      }
      issues.push({
        code: 'broken-ref',
        severity: 'warn',
        message: `Broken reference: ${JSON.stringify(href)} not found in ${skillDir}`,
        file: filePath,
        line: lineNo,
      });
    }
  }

  return issues;
}

/**
 * Validate file size constraints.
 *
 * @param content - Full SKILL.md content.
 * @param filePath - File path for reporting.
 */
export function validateSize(content: string, filePath?: string): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const bytes = Buffer.byteLength(content, 'utf8');
  const lines = content.split('\n').length;

  if (bytes > 50_000) {
    issues.push({
      code: 'file-too-large',
      severity: 'warn',
      message: `SKILL.md is ${(bytes / 1024).toFixed(1)} KB (> 50 KB). Consider splitting into sub-skills.`,
      file: filePath,
    });
  }

  if (bytes < 100) {
    issues.push({
      code: 'file-too-small',
      severity: 'error',
      message: `SKILL.md is only ${bytes} bytes (< 100). File appears empty or stub.`,
      file: filePath,
    });
  }

  if (lines > 180) {
    issues.push({
      code: 'over-threshold',
      severity: 'warn',
      message: `${lines} lines exceeds threshold 180. Consider moving reference material to a /references page.`,
      file: filePath,
    });
  }

  return issues;
}
