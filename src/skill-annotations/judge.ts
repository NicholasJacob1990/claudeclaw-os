/**
 * judge.ts - LLM binary classifier for skill correction detection.
 *
 * Uses claude-haiku-4-5 (cheap) via the Claude Agent SDK with OAuth subscription auth.
 * Ported from judge_correction.py in the Python learning-loop.
 *
 * Public API:
 *   judge(skillName, userMsg, context?) - JudgeResult | null
 *   parseJudgeOutput(text) - JudgeResult | null  (pure, exported for testing)
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

import { logger } from '../logger.js';
import type { JudgeResult } from './types.js';

const MODEL = process.env.SKILL_ANNOTATIONS_JUDGE_MODEL ?? 'claude-haiku-4-5';
const JUDGE_TIMEOUT_MS = parseInt(process.env.SKILL_ANNOTATIONS_JUDGE_TIMEOUT_MS ?? '20000', 10);

export const SYSTEM_PROMPT = `You are a binary classifier. Given a user message that follows a Skill invocation,
classify whether it is a CORRECTION of that Skill's output.

OUTPUT FORMAT - exactly one line, no preamble, no explanation before the verdict:

VERDICT=<yes|no|ambiguous>
REASON=<one short sentence>

Definitions:
- yes = user explicitly says the output was wrong, broken, off-target, asks for redo, expresses dissatisfaction
- no = user is satisfied, asks unrelated, requests an extension/follow-up (not a fix)
- ambiguous = genuinely unclear

Examples:
Input: "isso ta errado, refaz"
VERDICT=yes
REASON=user explicitly says the output is wrong and asks for redo

Input: "agora faz o mesmo pro endpoint v2"
VERDICT=no
REASON=user requests an extension to a new endpoint, not a correction

Input: "hmm, sera?"
VERDICT=ambiguous
REASON=user questions the result without clearly stating it is wrong

Be strict. False positives pollute the skill's annotation history.`;

/**
 * Parse the structured VERDICT=/REASON= output from the judge LLM.
 *
 * Tolerant: handles LLM that dropped the format. Returns null when verdict
 * cannot be determined. Exported for unit testing without SDK calls.
 */
export function parseJudgeOutput(raw: string): JudgeResult | null {
  const trimmed = raw.trim();

  // Primary parse: structured VERDICT=<x> REASON=<y>
  const mVerdict = /VERDICT\s*=\s*(yes|no|ambiguous)/i.exec(trimmed);
  const mReason = /REASON\s*=\s*(.+?)(?:\n|$)/is.exec(trimmed);
  if (mVerdict) {
    const verdict = mVerdict[1].toLowerCase() as 'yes' | 'no' | 'ambiguous';
    const reason = mReason ? mReason[1].trim().slice(0, 160) : '';
    return { verdict, reason, model: MODEL };
  }

  // Tolerant fallback: scan for yes/no/ambiguous keywords in first 300 chars.
  const lower = trimmed.toLowerCase().slice(0, 300);
  const hasAmbiguous = lower.includes('ambiguous');
  const hasYes = /\byes\b/.test(lower);
  const hasNo = /\bno\b/.test(lower);

  let verdict: 'yes' | 'no' | 'ambiguous';
  if (hasAmbiguous) {
    verdict = 'ambiguous';
  } else if (hasYes && !hasNo) {
    verdict = 'yes';
  } else if (hasNo && !hasYes) {
    verdict = 'no';
  } else {
    return null;
  }

  const reason = trimmed.split('\n')[0]?.slice(0, 160) ?? '';
  return { verdict, reason, model: MODEL, raw_unparseable: trimmed.slice(0, 200) };
}

/** Build the prompt sent to the judge. Exported for testing. */
export function buildJudgePrompt(skillName: string, userMsg: string, context = ''): string {
  const parts: string[] = [`Skill invoked: \`${skillName}\``];
  if (context) {
    parts.push(`\nContext (what skill produced):\n${context.slice(0, 600)}`);
  }
  parts.push(`\nUser's next message:\n${userMsg.slice(0, 400)}`);
  return parts.join('\n');
}

/** Strip env vars set by a wrapping Claude Code session (mirrors enrichment.ts). */
function stripNestedCcEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_CODE_IPC_PORT',
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  ]) {
    delete env[k];
  }
  return env;
}

/** Single-turn message generator for the Agent SDK (mirrors enrichment.ts pattern). */
async function* singleTurn(text: string): AsyncGenerator<{
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}

/**
 * Call the judge LLM (Haiku 4.5) to classify a user message as a correction or not.
 *
 * Returns null on any failure so the caller can fall back to heuristic-only classification.
 * Uses OAuth subscription auth (CLAUDE_CODE_OAUTH_TOKEN) - no API key needed.
 *
 * @param skillName - The skill that was invoked.
 * @param userMsg - The user subsequent message.
 * @param context - Optional context about what the skill produced.
 * @param abortController - Optional AbortController for cancellation.
 */
export async function judge(
  skillName: string,
  userMsg: string,
  context = '',
  abortController?: AbortController,
): Promise<JudgeResult | null> {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    logger.debug('CLAUDE_CODE_OAUTH_TOKEN not set; skipping judge call');
    return null;
  }

  const prompt = buildJudgePrompt(skillName, userMsg, context);
  let rawText = '';
  let costUsd: number | null = null;
  let durationMs: number | null = null;
  const startMs = Date.now();

  const timeoutSignal = AbortSignal.timeout(JUDGE_TIMEOUT_MS);

  try {
    const controller = abortController ?? new AbortController();
    // Combine with timeout: abort on whichever fires first.
    timeoutSignal.addEventListener('abort', () => controller.abort());

    for await (const event of query({
      prompt: singleTurn(prompt),
      options: {
        model: MODEL,
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        env: stripNestedCcEnv(),
        ...(abortController ? { abortController } : {}),
      },
    })) {
      const ev = event as Record<string, unknown>;

      if (ev['type'] === 'assistant') {
        const msg = ev['message'] as Record<string, unknown> | undefined;
        const content = msg?.['content'];
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b['type'] === 'text' && typeof b['text'] === 'string') {
              rawText += b['text'];
            }
          }
        }
      }

      if (ev['type'] === 'result') {
        const r = ev['result'];
        if (typeof r === 'string' && r) rawText = r;
        costUsd = (ev['total_cost_usd'] as number | undefined) ?? null;
        durationMs = Date.now() - startMs;
      }
    }
  } catch (err) {
    logger.warn({ err }, 'skill-annotations judge() SDK call failed');
    return null;
  }

  const parsed = parseJudgeOutput(rawText);
  if (!parsed) return null;

  return {
    ...parsed,
    model: MODEL,
    duration_ms: durationMs,
    cost_usd_reported: costUsd,
  };
}
