/**
 * Tests for keyword-score.ts — pure functions, no I/O.
 */

import { describe, it, expect } from 'vitest';

import {
  correctionScore,
  passesLlmGate,
  passesHeuristicOnly,
  STRONG_PTS,
  WEAK_PTS,
  LLM_GATE_THRESHOLD,
  HEURISTIC_ONLY_THRESHOLD,
  MAX_USER_TEXT_LEN,
} from './keyword-score.js';

describe('correctionScore()', () => {
  it('returns 0 for empty string', () => {
    expect(correctionScore('')).toBe(0);
  });

  it('returns 0 for a neutral message', () => {
    expect(correctionScore('agora faz o mesmo pro endpoint v2')).toBe(0);
  });

  it('scores STRONG_PTS for a strong keyword', () => {
    const score = correctionScore('isso ta errado, preciso que funcione');
    expect(score).toBeGreaterThanOrEqual(STRONG_PTS);
  });

  it('scores WEAK_PTS for a weak keyword', () => {
    const score = correctionScore('refaz por favor');
    expect(score).toBeGreaterThanOrEqual(WEAK_PTS);
  });

  it('accumulates score for multiple keywords', () => {
    // "errado" (strong) + "refaz" (weak)
    const score = correctionScore('isso esta errado, refaz');
    expect(score).toBe(STRONG_PTS + WEAK_PTS);
  });

  it('is case-insensitive', () => {
    const lower = correctionScore('errado');
    const upper = correctionScore('ERRADO');
    expect(lower).toBe(upper);
    expect(lower).toBeGreaterThan(0);
  });

  it('scores "broken" as a strong keyword', () => {
    expect(correctionScore('the output is broken')).toBeGreaterThanOrEqual(STRONG_PTS);
  });

  it('scores "nao funciona" as a strong keyword', () => {
    expect(correctionScore('isso nao funciona aqui')).toBeGreaterThanOrEqual(STRONG_PTS);
  });

  it('scores "na verdade" as a weak keyword', () => {
    expect(correctionScore('na verdade quero isso assim')).toBeGreaterThanOrEqual(WEAK_PTS);
  });
});

describe('passesLlmGate()', () => {
  it('returns false for empty string', () => {
    expect(passesLlmGate('')).toBe(false);
  });

  it('returns false for a neutral message', () => {
    expect(passesLlmGate('agora faz o mesmo pro endpoint v2')).toBe(false);
  });

  it('returns true when correction score >= LLM_GATE_THRESHOLD', () => {
    expect(passesLlmGate('isso ta errado')).toBe(true);
  });

  it('returns false when text is longer than MAX_USER_TEXT_LEN', () => {
    const longText = 'errado '.repeat(MAX_USER_TEXT_LEN);
    expect(passesLlmGate(longText)).toBe(false);
  });
});

describe('passesHeuristicOnly()', () => {
  it('returns false for a message with only 1 weak keyword', () => {
    // "refaz" = 1 WEAK_PTS = 1, threshold = 3
    expect(passesHeuristicOnly('refaz isso')).toBe(false);
  });

  it('returns true for a message with a strong + weak keyword', () => {
    // "errado" = 2 + "refaz" = 1 = 3, which meets HEURISTIC_ONLY_THRESHOLD=3
    expect(passesHeuristicOnly('isso esta errado, refaz')).toBe(true);
  });

  it('returns true for a message with 2 strong keywords', () => {
    // "errado" + "broken" = 4
    expect(passesHeuristicOnly('errado e broken')).toBe(true);
  });

  it('returns false when text is longer than MAX_USER_TEXT_LEN', () => {
    const longText = 'errado '.repeat(MAX_USER_TEXT_LEN);
    expect(passesHeuristicOnly(longText)).toBe(false);
  });

  it('LLM_GATE_THRESHOLD is less than HEURISTIC_ONLY_THRESHOLD', () => {
    expect(LLM_GATE_THRESHOLD).toBeLessThan(HEURISTIC_ONLY_THRESHOLD);
  });
});
