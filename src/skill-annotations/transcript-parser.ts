/**
 * transcript-parser.ts — Parse Claude Code JSONL transcripts and extract
 * (Skill invocation → next user message) pairs for annotation.
 *
 * Ported from annotate_skills.py / find_pairs() in the Python learning-loop.
 * Pure function: receives transcript lines, returns pairs. No I/O.
 */

import type { CorrectionPair, TranscriptEntry } from './types.js';
import {
  correctionScore,
  passesLlmGate,
  MAX_USER_TEXT_LEN,
} from './keyword-score.js';

/**
 * How many messages to look ahead after a Skill invocation before giving up.
 * Same as Python WINDOW = 5.
 */
export const LOOK_AHEAD_WINDOW = 5;

/**
 * Parse a single JSONL line. Returns null on parse errors (fail-safe).
 */
export function parseLine(line: string): TranscriptEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as TranscriptEntry;
  } catch {
    return null;
  }
}

/**
 * Parse a full JSONL transcript string into an array of TranscriptEntry objects.
 * Silently drops lines that fail to parse.
 */
export function parseTranscript(jsonl: string): TranscriptEntry[] {
  return jsonl
    .split('\n')
    .map(parseLine)
    .filter((e): e is TranscriptEntry => e !== null);
}

/**
 * Extract the plain text from a message content (string or content-block array).
 * Returns empty string for any unrecognised shape.
 */
export function extractUserText(entry: TranscriptEntry): string {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const c of content) {
    if (typeof c === 'string') {
      parts.push(c);
    } else if (c && typeof c === 'object') {
      const block = c as Record<string, unknown>;
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        parts.push(block['text']);
      }
    }
  }
  return parts.join('\n');
}

/**
 * Returns true when a user-role message is a real user turn (not the auto-generated
 * tool_result wrapper emitted by the harness).
 */
export function isRealUserMessage(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user') return false;
  const content = entry.message?.content;
  if (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (x) =>
        x &&
        typeof x === 'object' &&
        (x as Record<string, unknown>)['type'] === 'tool_result',
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Extract a tool-use block's skill name from an assistant message entry.
 * Returns null if the entry is not an assistant Skill tool_use.
 */
function extractSkillNames(entry: TranscriptEntry): string[] {
  if (entry.type !== 'assistant') return [];
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];

  const names: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b['type'] !== 'tool_use' || b['name'] !== 'Skill') continue;
    const input = b['input'] as Record<string, unknown> | undefined;
    const skillName = input?.['skill'];
    if (typeof skillName === 'string' && skillName) {
      names.push(skillName);
    }
  }
  return names;
}

/**
 * Scan a list of transcript entries and return (Skill invocation → next user message)
 * pairs that pass the correction keyword gate.
 *
 * Only the FIRST real user message after a Skill invocation is considered.
 * Messages longer than MAX_USER_TEXT_LEN are skipped (harness-injected content).
 *
 * @param entries - Parsed transcript entries in order.
 * @param requireLlmGate - When true (default), only pairs that pass the LLM gate are returned.
 *   Set to false to return all keyword-scored pairs (for testing).
 */
export function findCorrectionPairs(
  entries: TranscriptEntry[],
  requireLlmGate = true,
): CorrectionPair[] {
  const pairs: CorrectionPair[] = [];

  for (let i = 0; i < entries.length; i++) {
    const skillNames = extractSkillNames(entries[i]);
    if (skillNames.length === 0) continue;

    // Look ahead for the first real user message within WINDOW messages.
    for (let j = i + 1; j < Math.min(i + 1 + LOOK_AHEAD_WINDOW, entries.length); j++) {
      const nxt = entries[j];
      if (!isRealUserMessage(nxt)) continue;

      const text = extractUserText(nxt);
      if (!text.trim()) continue;

      // Long messages are harness-injected content, not real corrections.
      if (text.length > MAX_USER_TEXT_LEN) break;

      const score = correctionScore(text);
      if (requireLlmGate && !passesLlmGate(text)) break;
      if (!requireLlmGate && score === 0) break;

      const ts =
        (entries[i]['timestamp'] as string | undefined) ??
        (nxt['timestamp'] as string | undefined) ??
        new Date().toISOString();

      // Emit one pair per skill name found in this assistant turn.
      for (const skill of skillNames) {
        pairs.push({
          skill,
          excerpt: text.trim().slice(0, 200),
          score,
          reason: '', // filled in by judge or heuristic fallback
          ts,
        });
      }
      break; // only first user msg after the skill counts
    }
  }

  return pairs;
}
