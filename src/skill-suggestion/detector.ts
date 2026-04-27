import crypto from 'crypto';

import type { Suggestion, TranscriptMessage, ToolUseBlock } from './types.js';

// ── Thresholds — read from env or fall back to sensible defaults ────────────
const MIN_TOOL_CALLS = parseInt(process.env.SKILL_SUGGESTION_MIN_TOOL_CALLS ?? '10', 10);
const MIN_FILES_EDITED = parseInt(process.env.SKILL_SUGGESTION_MIN_FILES_EDITED ?? '3', 10);
const MIN_DISTINCT_TOOL_TYPES = 4;
const SINGLE_SKILL_DOMINATION_RATIO = 0.70;

const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Patterns that flag a Bash command as potentially dangerous.
const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+-rf?\b/i,
  /\bsudo\b/i,
  /\bcurl\b.*\|\s*(sh|bash|zsh)/i,
  /\beval\s+/i,
  /\bchmod\s+777\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{/,          // fork bomb
  />\s*\/dev\/sd[a-z]/i,
  /\bdrop\s+(table|database)\b/i,
];

function isDangerous(cmd: string): boolean {
  return DANGEROUS_BASH_PATTERNS.some((re) => re.test(cmd));
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (item && typeof item === 'object' && (item as Record<string, unknown>)['type'] === 'text') {
      const text = (item as Record<string, unknown>)['text'];
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

/** True when a user message is a real user turn (not a tool_result wrapper). */
function isRealUserMsg(msg: TranscriptMessage): boolean {
  if (msg.type !== 'user') return false;
  const content = msg.message?.content;
  if (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (x) => x && typeof x === 'object' && (x as Record<string, unknown>)['type'] === 'tool_result',
    )
  ) {
    return false;
  }
  return true;
}

function signature(toolNames: string[], filePaths: string[]): string {
  const payload =
    [...new Set(toolNames)].sort().join('|') +
    '::' +
    [...new Set(filePaths)].sort().join('|');
  return crypto.createHash('sha1').update(payload, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Analyse a session transcript and return a Suggestion when the session
 * crosses the complexity threshold, otherwise null.
 *
 * Pure function: no filesystem, no network, no env reads (except thresholds
 * at module load time). Deterministic for a given input.
 */
export function detect(messages: TranscriptMessage[], sessionId: string): Suggestion | null {
  const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
  const filePaths: string[] = [];
  const dangerHits: string[] = [];
  const userMsgs: string[] = [];

  for (const msg of messages) {
    if (isRealUserMsg(msg)) {
      const text = extractText(msg.message?.content).trim();
      if (text && text.length < 5000) {
        userMsgs.push(text);
      }
      continue;
    }

    if (msg.type !== 'assistant') continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (
        !block ||
        typeof block !== 'object' ||
        (block as Record<string, unknown>)['type'] !== 'tool_use'
      ) {
        continue;
      }
      const tu = block as unknown as ToolUseBlock;
      const name = tu.name ?? '';
      const input = tu.input ?? {};
      toolCalls.push({ name, input });

      if (EDITING_TOOLS.has(name)) {
        const fp = (input['file_path'] as string | undefined) ?? (input['notebook_path'] as string | undefined);
        if (fp) filePaths.push(fp);
      } else if (name === 'Bash') {
        const cmd = (input['command'] as string | undefined) ?? '';
        if (isDangerous(cmd)) {
          dangerHits.push(cmd.slice(0, 160));
        }
      }
    }
  }

  const distinctFiles = [...new Set(filePaths)].sort();
  const distinctToolTypes = [...new Set(toolCalls.map((t) => t.name))].sort();
  const skillInvocations = toolCalls.filter((t) => t.name === 'Skill');

  // Single-skill domination: one big Skill call shouldn't trigger suggestion.
  const dominated =
    toolCalls.length > 0 &&
    skillInvocations.length === 1 &&
    skillInvocations.length / Math.max(1, toolCalls.length) > SINGLE_SKILL_DOMINATION_RATIO;

  if (toolCalls.length < MIN_TOOL_CALLS) return null;
  if (distinctFiles.length < MIN_FILES_EDITED) return null;
  if (distinctToolTypes.length < MIN_DISTINCT_TOOL_TYPES) return null;
  if (dominated) return null;

  const sig = signature(
    toolCalls.map((t) => t.name),
    distinctFiles,
  );

  const firstUser = userMsgs[0]?.slice(0, 300) ?? '';
  const lastUser = userMsgs.length >= 1 ? (userMsgs[userMsgs.length - 1]?.slice(0, 300) ?? '') : '';

  // Tool sequence: unique names in first-seen order, capped at 20.
  const seen = new Set<string>();
  const toolSequence: string[] = [];
  for (const t of toolCalls) {
    if (!seen.has(t.name)) {
      seen.add(t.name);
      toolSequence.push(t.name);
    }
    if (toolSequence.length >= 20) break;
  }

  return {
    signature: sig,
    session_id: sessionId,
    signals: {
      tool_calls: toolCalls.length,
      distinct_files_edited: distinctFiles.length,
      distinct_tool_types: distinctToolTypes.length,
      skill_invocations: skillInvocations.length,
      user_turns: userMsgs.length,
    },
    tool_sequence: toolSequence,
    files_touched: distinctFiles.slice(0, 30),
    first_user_msg: firstUser,
    last_user_msg: lastUser,
    danger_hits: dangerHits,
  };
}
