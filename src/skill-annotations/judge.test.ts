/**
 * Tests for judge.ts — focuses on pure/testable functions.
 * The actual SDK call is not tested here (requires live auth).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { parseJudgeOutput, buildJudgePrompt, SYSTEM_PROMPT } from './judge.js';

// -- parseJudgeOutput() ----------------------------------------------------------

describe('parseJudgeOutput()', () => {
  it('parses well-formed VERDICT=yes REASON=...', () => {
    const raw = 'VERDICT=yes\nREASON=user explicitly said the output was wrong';
    const result = parseJudgeOutput(raw);
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe('yes');
    expect(result?.reason).toContain('wrong');
  });

  it('parses VERDICT=no', () => {
    const raw = 'VERDICT=no\nREASON=user is asking for an extension';
    const result = parseJudgeOutput(raw);
    expect(result?.verdict).toBe('no');
  });

  it('parses VERDICT=ambiguous', () => {
    const raw = 'VERDICT=ambiguous\nREASON=unclear';
    const result = parseJudgeOutput(raw);
    expect(result?.verdict).toBe('ambiguous');
  });

  it('is case-insensitive for VERDICT', () => {
    const raw = 'verdict=YES\nreason=user said it was wrong';
    const result = parseJudgeOutput(raw);
    expect(result?.verdict).toBe('yes');
  });

  it('uses tolerant fallback when format is missing', () => {
    // Model dropped structure but said "yes"
    const raw = 'yes, the user clearly said the output was wrong';
    const result = parseJudgeOutput(raw);
    expect(result?.verdict).toBe('yes');
  });

  it('uses tolerant fallback for ambiguous', () => {
    const raw = 'This is ambiguous because the user might mean either thing';
    const result = parseJudgeOutput(raw);
    expect(result?.verdict).toBe('ambiguous');
  });

  it('returns null when both yes and no appear (ambiguous fallback)', () => {
    // "yes" and "no" both present, no "ambiguous" -> null
    const raw = 'yes or no, hard to say';
    const result = parseJudgeOutput(raw);
    // Both "yes" and "no" present with no clear winner -> null
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseJudgeOutput('')).toBeNull();
  });

  it('truncates reason to 160 chars', () => {
    const longReason = 'a'.repeat(300);
    const raw = `VERDICT=yes\nREASON=${longReason}`;
    const result = parseJudgeOutput(raw);
    expect(result?.reason.length).toBeLessThanOrEqual(160);
  });
});

// -- buildJudgePrompt() ----------------------------------------------------------

describe('buildJudgePrompt()', () => {
  it('includes skill name', () => {
    const p = buildJudgePrompt('my-skill', 'errado');
    expect(p).toContain('my-skill');
  });

  it('includes user message', () => {
    const p = buildJudgePrompt('my-skill', 'errado, refaz isso');
    expect(p).toContain('errado, refaz isso');
  });

  it('includes context when provided', () => {
    const p = buildJudgePrompt('my-skill', 'errado', 'skill produced: foo bar');
    expect(p).toContain('foo bar');
  });

  it('does not include context section when context is empty', () => {
    const p = buildJudgePrompt('my-skill', 'errado', '');
    expect(p).not.toContain('Context (what skill produced)');
  });

  it('truncates user message to 400 chars', () => {
    const longMsg = 'x'.repeat(500);
    const p = buildJudgePrompt('my-skill', longMsg);
    // The message in the prompt should be at most 400 chars
    const idx = p.indexOf("User's next message:\n");
    const afterLabel = p.slice(idx + "User's next message:\n".length);
    expect(afterLabel.length).toBeLessThanOrEqual(400);
  });
});

// -- SYSTEM_PROMPT ---------------------------------------------------------------

describe('SYSTEM_PROMPT', () => {
  it('includes VERDICT= format instructions', () => {
    expect(SYSTEM_PROMPT).toContain('VERDICT=');
    expect(SYSTEM_PROMPT).toContain('REASON=');
  });

  it('defines yes, no, and ambiguous categories', () => {
    expect(SYSTEM_PROMPT).toContain('yes');
    expect(SYSTEM_PROMPT).toContain('no');
    expect(SYSTEM_PROMPT).toContain('ambiguous');
  });
});

// -- judge() with no token -------------------------------------------------------

describe('judge() — no OAuth token', () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
    }
    vi.restoreAllMocks();
  });

  it('returns null when CLAUDE_CODE_OAUTH_TOKEN is not set', async () => {
    const { judge } = await import('./judge.js');
    const result = await judge('my-skill', 'errado');
    expect(result).toBeNull();
  });
});
