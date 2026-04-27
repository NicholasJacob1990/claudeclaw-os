/**
 * health.test.ts — Tests for the skill-health validator subsystem (S7).
 *
 * Uses fixtures in tests/fixtures/ — no real filesystem interaction
 * beyond reading those committed fixture files.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

import { validateFrontmatter, validateDescription } from '../frontmatter.js';
import { validateBrokenRefs, validateSize } from '../refs.js';
import {
  checkGenericDescription,
  checkMissingExamples,
  checkThinBody,
  checkMissingTriggers,
  checkDuplicateKeys,
  checkMinBodyLines,
  checkMissingSections,
} from '../quality.js';
import { runHealthChecks, runChecks } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const GOOD_SKILL = path.join(FIXTURES, 'good-skill');
const BAD_SKILL = path.join(FIXTURES, 'bad-skill');

// ── validateFrontmatter ───────────────────────────────────────────────────────

describe('validateFrontmatter', () => {
  it('returns no issues for valid frontmatter', () => {
    const content = `---\nname: my-skill\ndescription: Analyze stuff\n---\n\nbody\n`;
    expect(validateFrontmatter(content)).toHaveLength(0);
  });

  it('returns error when frontmatter is missing', () => {
    const issues = validateFrontmatter('# Just a heading\n\nsome body');
    expect(issues.some((i) => i.code === 'missing-frontmatter')).toBe(true);
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('returns error when name is missing', () => {
    const content = `---\ndescription: Something\n---\n\nbody\n`;
    const issues = validateFrontmatter(content);
    expect(issues.some((i) => i.code === 'frontmatter-missing-name')).toBe(true);
  });

  it('returns error when name contains uppercase', () => {
    const content = `---\nname: My-Skill\ndescription: Something\n---\n\nbody\n`;
    const issues = validateFrontmatter(content);
    expect(issues.some((i) => i.code === 'frontmatter-invalid-name')).toBe(true);
  });

  it('returns error when name starts with digit... actually allowed by regex', () => {
    // ^[a-z0-9][a-z0-9-]* allows leading digit
    const content = `---\nname: 1skill\ndescription: Something\n---\n\nbody\n`;
    const issues = validateFrontmatter(content);
    expect(issues.filter((i) => i.code === 'frontmatter-invalid-name')).toHaveLength(0);
  });

  it('returns warn when description is missing', () => {
    const content = `---\nname: my-skill\n---\n\nbody\n`;
    const issues = validateFrontmatter(content);
    expect(issues.some((i) => i.code === 'frontmatter-missing-description' && i.severity === 'warn')).toBe(true);
  });
});

// ── validateDescription ───────────────────────────────────────────────────────

describe('validateDescription', () => {
  it('no issues for a clean description starting with verb', () => {
    const content = `---\nname: my-skill\ndescription: Analyze TypeScript code for quality issues\n---\nbody\n`;
    expect(validateDescription(content)).toHaveLength(0);
  });

  it('warns when description does not start with action verb', () => {
    const content = `---\nname: my-skill\ndescription: This is a thing\n---\nbody\n`;
    const issues = validateDescription(content);
    expect(issues.some((i) => i.code === 'description-no-action-verb')).toBe(true);
  });

  it('warns for very long description (> 500)', () => {
    const longDesc = 'A'.repeat(501);
    const content = `---\nname: my-skill\ndescription: ${longDesc}\n---\nbody\n`;
    const issues = validateDescription(content);
    expect(issues.some((i) => i.code === 'description-too-long')).toBe(true);
  });
});

// ── validateSize ─────────────────────────────────────────────────────────────

describe('validateSize', () => {
  it('no issues for normal sized content', () => {
    // Must be >= 100 bytes and <= 50KB and <= 180 lines
    const content = `---\nname: my-skill\ndescription: Analyze stuff\n---\n${'some content line here\n'.repeat(10)}`;
    expect(validateSize(content)).toHaveLength(0);
  });

  it('errors on content < 100 bytes', () => {
    const issues = validateSize('tiny');
    expect(issues.some((i) => i.code === 'file-too-small')).toBe(true);
  });

  it('warns on content > 50 KB', () => {
    const big = 'x'.repeat(51_000);
    const issues = validateSize(big);
    expect(issues.some((i) => i.code === 'file-too-large')).toBe(true);
  });

  it('warns on > 180 lines', () => {
    const content = 'line\n'.repeat(185);
    const issues = validateSize(content);
    expect(issues.some((i) => i.code === 'over-threshold')).toBe(true);
  });
});

// ── validateBrokenRefs ───────────────────────────────────────────────────────

describe('validateBrokenRefs', () => {
  it('no issues for external links', () => {
    const content = `[link](https://example.com) and [anchor](#section)`;
    expect(validateBrokenRefs(content, '/some/dir')).toHaveLength(0);
  });

  it('warns for broken local ref', () => {
    const content = `[see](./missing-file.md)`;
    const issues = validateBrokenRefs(content, '/nonexistent/dir');
    expect(issues.some((i) => i.code === 'broken-ref')).toBe(true);
  });

  it('no issues for existing local file', () => {
    const content = `[see](./SKILL.md)`;
    // Good skill dir has SKILL.md
    const issues = validateBrokenRefs(content, GOOD_SKILL);
    expect(issues).toHaveLength(0);
  });
});

// ── Quality checks ───────────────────────────────────────────────────────────

describe('quality checks', () => {
  const goodContent = `---\nname: my-skill\ndescription: Analyze stuff properly\n---\n\n## When to use\n\nUse when you want analysis.\n\n## Examples\n\n\`\`\`bash\nrun it\n\`\`\`\n\nsome more content here to fill up the body and make it long enough for all checks\n`;

  it('no generic description issues for good content', () => {
    expect(checkGenericDescription(goodContent)).toHaveLength(0);
  });

  it('flags generic description', () => {
    const content = `---\nname: x\ndescription: This skill helps you do stuff\n---\nbody\n`;
    expect(checkGenericDescription(content).some((i) => i.code === 'description-generic')).toBe(true);
  });

  it('no missing examples when code block present', () => {
    expect(checkMissingExamples(goodContent)).toHaveLength(0);
  });

  it('flags missing examples', () => {
    const content = `---\nname: x\ndescription: Analyze code\n---\n\nsome body text here\n`;
    expect(checkMissingExamples(content).some((i) => i.code === 'missing-examples')).toBe(true);
  });

  it('flags thin body', () => {
    const content = `---\nname: x\ndescription: Analyze code\n---\nshort\n`;
    expect(checkThinBody(content).some((i) => i.code === 'thin-body')).toBe(true);
  });

  it('no thin body for good content', () => {
    expect(checkThinBody(goodContent)).toHaveLength(0);
  });

  it('no trigger hint issue when "when" appears', () => {
    expect(checkMissingTriggers(goodContent)).toHaveLength(0);
  });

  it('flags missing trigger hints', () => {
    const content = `---\nname: x\ndescription: Analyze code\n---\n\nDoes stuff here.\n`;
    expect(checkMissingTriggers(content).some((i) => i.code === 'missing-trigger-hints')).toBe(true);
  });

  it('flags duplicate frontmatter keys', () => {
    const content = `---\nname: x\nname: y\ndescription: d\n---\nbody\n`;
    expect(checkDuplicateKeys(content).some((i) => i.code === 'frontmatter-duplicate-keys')).toBe(true);
  });

  it('flags empty body', () => {
    const content = `---\nname: x\n---\n\none\n`;
    expect(checkMinBodyLines(content).some((i) => i.code === 'empty-body')).toBe(true);
  });

  it('flags no sections', () => {
    const content = `---\nname: x\n---\n\njust a paragraph with no headings.\n`;
    expect(checkMissingSections(content).some((i) => i.code === 'no-sections')).toBe(true);
  });
});

// ── runHealthChecks (integration with fixtures) ───────────────────────────────

describe('runHealthChecks (fixtures)', () => {
  it('good-skill has no errors', () => {
    const result = runHealthChecks(GOOD_SKILL);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.hasFrontmatter).toBe(true);
    expect(result.slug).toBe('good-skill');
  });

  it('bad-skill has errors (no frontmatter)', () => {
    const result = runHealthChecks(BAD_SKILL);
    expect(result.issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('missing-skill-dir reports missing-file error', () => {
    const result = runHealthChecks(path.join(FIXTURES, 'nonexistent-skill'));
    expect(result.issues.some((i) => i.code === 'missing-file')).toBe(true);
  });
});

// ── runChecks (summary) ──────────────────────────────────────────────────────

describe('runChecks', () => {
  it('returns summary for fixtures dir', () => {
    const summary = runChecks(FIXTURES);
    expect(summary.total).toBe(2);
    expect(summary.error).toBeGreaterThanOrEqual(1); // bad-skill
  });

  it('returns empty summary for nonexistent dir', () => {
    const summary = runChecks('/nonexistent/path/xyz');
    expect(summary.total).toBe(0);
    expect(summary.skills).toHaveLength(0);
  });
});
