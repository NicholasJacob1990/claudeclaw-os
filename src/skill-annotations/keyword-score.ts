/**
 * keyword-score.ts — Pure function for heuristic correction detection.
 *
 * Scans a user message for signals that they are correcting a Skill's output.
 * Used as a cheap gate BEFORE calling the LLM judge.
 *
 * Pure function: no I/O, no side-effects. Deterministic for a given input.
 * Ported from annotate_skills.py (Python) in the learning-loop.
 */

/** Keywords that strongly indicate a correction (each worth STRONG_PTS). */
export const STRONG_KEYWORDS = [
  'errado',
  'errei',
  'erro de',
  'fix this',
  'wrong',
  'incorrect',
  "doesn't work",
  'does not work',
  'não funciona',
  'nao funciona',
  'isso não',
  'isso nao',
  'ruim',
  'péssimo',
  'pessimo',
  'terrible',
  'broken',
  'quebrou',
  'buggy',
] as const;

/** Keywords that weakly indicate a correction (each worth WEAK_PTS). */
export const WEAK_KEYWORDS = [
  'não',
  'nao ',
  ' no,',
  'refaz',
  'refaca',
  'corrige',
  'corrija',
  'retry',
  'redo',
  'esquece',
  'esqueça',
  'na verdade',
  'actually',
  'tente de novo',
  'try again',
  'ajusta',
  'ajuste',
] as const;

export const STRONG_PTS = 2;
export const WEAK_PTS = 1;

/**
 * Minimum score to pass the keyword gate (before LLM judge).
 * 1 strong + 1 weak = 3, OR 2 strong = 4, OR 3 weak = 3. Default gate is >= 1.
 * The Python code uses >= 1 to call the LLM judge (cheap_score >= 1) and >= 3 when
 * LLM is unavailable. We replicate both here.
 */
export const LLM_GATE_THRESHOLD = 1;
export const HEURISTIC_ONLY_THRESHOLD = 3;

/**
 * Maximum user text length to consider. Messages longer than this are typically
 * harness-injected skill content, tool results, or system reminders — not real corrections.
 */
export const MAX_USER_TEXT_LEN = 500;

/**
 * Compute the keyword-based correction score for a user message.
 *
 * @param text - The raw user message text (any case).
 * @returns A non-negative integer score.
 */
export function correctionScore(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of STRONG_KEYWORDS) {
    if (lower.includes(kw)) score += STRONG_PTS;
  }
  for (const kw of WEAK_KEYWORDS) {
    if (lower.includes(kw)) score += WEAK_PTS;
  }
  return score;
}

/**
 * Returns true when the text passes the LLM gate (worth calling the judge).
 * Returns false for texts that are obviously not corrections or too long.
 */
export function passesLlmGate(text: string): boolean {
  if (text.length > MAX_USER_TEXT_LEN) return false;
  return correctionScore(text) >= LLM_GATE_THRESHOLD;
}

/**
 * Returns true when the text passes the heuristic-only threshold.
 * Used as fallback when the LLM judge is unavailable.
 */
export function passesHeuristicOnly(text: string): boolean {
  if (text.length > MAX_USER_TEXT_LEN) return false;
  return correctionScore(text) >= HEURISTIC_ONLY_THRESHOLD;
}
