/**
 * Tests for transcript-parser.ts — pure functions, no I/O.
 */

import { describe, it, expect } from 'vitest';

import {
  parseLine,
  parseTranscript,
  extractUserText,
  isRealUserMessage,
  findCorrectionPairs,
} from './transcript-parser.js';
import type { TranscriptEntry } from './types.js';

// -- Helpers -----------------------------------------------------------------------

function makeUserEntry(text: string): TranscriptEntry {
  return { type: 'user', message: { role: 'user', content: text } };
}

function makeToolResultEntry(): TranscriptEntry {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
  };
}

function makeSkillEntry(skillName: string): TranscriptEntry {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Skill', input: { skill: skillName } }],
    },
  };
}

// -- parseLine() ------------------------------------------------------------------

describe('parseLine()', () => {
  it('parses a valid JSON line', () => {
    const result = parseLine('{"type":"user","message":{"content":"hello"}}');
    expect(result).not.toBeNull();
    expect((result as TranscriptEntry).type).toBe('user');
  });

  it('returns null for empty string', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseLine('{bad json')).toBeNull();
  });
});

// -- parseTranscript() ------------------------------------------------------------

describe('parseTranscript()', () => {
  it('parses multi-line JSONL', () => {
    const jsonl = [
      '{"type":"user","message":{"content":"hello"}}',
      '{"type":"assistant","message":{"content":[]}}',
      '',
      '{bad line}',
    ].join('\n');
    const result = parseTranscript(jsonl);
    // 2 valid, 1 empty (skipped), 1 bad (skipped)
    expect(result).toHaveLength(2);
  });

  it('returns empty array for empty string', () => {
    expect(parseTranscript('')).toHaveLength(0);
  });
});

// -- extractUserText() -----------------------------------------------------------

describe('extractUserText()', () => {
  it('extracts text from string content', () => {
    const entry: TranscriptEntry = { type: 'user', message: { content: 'hello world' } };
    expect(extractUserText(entry)).toBe('hello world');
  });

  it('extracts text from content-block array', () => {
    const entry: TranscriptEntry = {
      type: 'user',
      message: { content: [{ type: 'text', text: 'block text' }] },
    };
    expect(extractUserText(entry)).toBe('block text');
  });

  it('returns empty string for missing content', () => {
    const entry: TranscriptEntry = { type: 'user', message: {} };
    expect(extractUserText(entry)).toBe('');
  });
});

// -- isRealUserMessage() ---------------------------------------------------------

describe('isRealUserMessage()', () => {
  it('returns true for a real user message', () => {
    expect(isRealUserMessage(makeUserEntry('hi'))).toBe(true);
  });

  it('returns false for tool_result-only user message', () => {
    expect(isRealUserMessage(makeToolResultEntry())).toBe(false);
  });

  it('returns false for assistant messages', () => {
    const entry: TranscriptEntry = { type: 'assistant', message: { content: [] } };
    expect(isRealUserMessage(entry)).toBe(false);
  });
});

// -- findCorrectionPairs() -------------------------------------------------------

describe('findCorrectionPairs()', () => {
  it('returns empty array when no Skill invocations', () => {
    const entries: TranscriptEntry[] = [
      makeUserEntry('hello'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      makeUserEntry('thanks'),
    ];
    expect(findCorrectionPairs(entries, false)).toHaveLength(0);
  });

  it('detects a correction pair after a Skill invocation', () => {
    const entries: TranscriptEntry[] = [
      makeSkillEntry('my-skill'),
      makeToolResultEntry(), // auto-generated, should be skipped
      makeUserEntry('isso ta errado, refaz'), // correction with score >= 1
    ];
    const pairs = findCorrectionPairs(entries, true);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.skill).toBe('my-skill');
    expect(pairs[0]?.score).toBeGreaterThan(0);
  });

  it('does not detect a pair for a neutral follow-up message', () => {
    const entries: TranscriptEntry[] = [
      makeSkillEntry('my-skill'),
      makeUserEntry('agora faz o mesmo pro endpoint v2'),
    ];
    const pairs = findCorrectionPairs(entries, true);
    expect(pairs).toHaveLength(0);
  });

  it('skips tool_result messages as user turns', () => {
    const entries: TranscriptEntry[] = [
      makeSkillEntry('my-skill'),
      makeToolResultEntry(),
      makeUserEntry('thanks'), // no correction keywords
    ];
    const pairs = findCorrectionPairs(entries, true);
    expect(pairs).toHaveLength(0);
  });

  it('only takes the first user message after a Skill invocation', () => {
    const entries: TranscriptEntry[] = [
      makeSkillEntry('my-skill'),
      makeUserEntry('thanks'), // no keywords — first message
      makeUserEntry('isso ta errado'), // correction — but too late
    ];
    const pairs = findCorrectionPairs(entries, true);
    expect(pairs).toHaveLength(0);
  });

  it('returns pairs for all skills in an assistant turn', () => {
    // Two Skill tool_use blocks in one assistant turn
    const entry: TranscriptEntry = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Skill', input: { skill: 'skill-a' } },
          { type: 'tool_use', name: 'Skill', input: { skill: 'skill-b' } },
        ],
      },
    };
    const entries: TranscriptEntry[] = [entry, makeUserEntry('errado')];
    const pairs = findCorrectionPairs(entries, true);
    expect(pairs).toHaveLength(2);
    const skills = pairs.map((p) => p.skill).sort();
    expect(skills).toEqual(['skill-a', 'skill-b']);
  });
});
