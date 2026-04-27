import { query } from '@anthropic-ai/claude-agent-sdk';

import { logger } from '../logger.js';
import type { EnrichedSuggestion, Suggestion } from './types.js';

const MODEL = process.env.SKILL_SUGGESTION_MODEL ?? 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You convert a Claude Code session summary into a reusable SKILL.md draft.

Rules:
- Output ONLY valid SKILL.md content. No prose before or after.
- Frontmatter MUST include: name (kebab-case, <=40 chars), description (one sentence, <=120 chars).
- Body sections (h2): "When to use", "Approach", "Files / Tools", "Notes".
- Body total <=180 lines (Claude Code skill threshold).
- Be concrete: name the actual tools, file paths, decisions from the session.
- If insufficient signal to make a useful skill, output exactly: SKIP-NO-SIGNAL`;

function buildPrompt(suggestion: Suggestion): string {
  const { signals: sigs, tool_sequence: seq, files_touched: files, first_user_msg: first, last_user_msg: last, danger_hits: danger } = suggestion;

  const lines: string[] = [
    'Session summary:',
    `- tool_calls: ${sigs.tool_calls}`,
    `- distinct_files_edited: ${sigs.distinct_files_edited}`,
    `- distinct_tool_types: ${sigs.distinct_tool_types}`,
    `- skill_invocations: ${sigs.skill_invocations}`,
    '',
    'First user message:',
    `> ${first}`,
    '',
    'Last user message:',
    `> ${last}`,
    '',
    `Tools used (sequence): ${seq.join(', ')}`,
    '',
    'Files touched:',
    ...files.slice(0, 30).map((p) => `- ${p}`),
  ];

  if (danger.length > 0) {
    lines.push('', 'Bash commands flagged dangerous:');
    lines.push(...danger.slice(0, 5).map((d) => `- ${d.slice(0, 120)}`));
  }

  lines.push('', 'Generate the SKILL.md draft now. Be specific, not generic.');
  return lines.join('\n');
}

function extractName(skillMd: string): string | null {
  const match = /^name:\s*([a-z0-9][a-z0-9._-]*)\s*$/m.exec(skillMd);
  return match?.[1] ?? null;
}

/** Single-turn prompt generator for the Agent SDK. */
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

/** Strip env vars set by a wrapping Claude Code session (same pattern as src/agent.ts). */
function stripNestedCcEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of [
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_IPC_PORT',
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  ]) {
    delete env[k];
  }
  return env;
}

/**
 * Enrich a heuristic suggestion using Sonnet via the Claude Agent SDK.
 * Uses subscription auth (CLAUDE_CODE_OAUTH_TOKEN) — $0 real cost.
 * Returns null on any failure so the caller can fall back to the template.
 */
export async function enrich(
  suggestion: Suggestion,
  abortController?: AbortController,
): Promise<EnrichedSuggestion | null> {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    logger.debug('CLAUDE_CODE_OAUTH_TOKEN not set; skipping enrichment');
    return null;
  }

  const prompt = buildPrompt(suggestion);
  const startMs = Date.now();

  let text = '';
  let costUsd: number | null = null;

  try {
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
              text += b['text'];
            }
          }
        }
      }

      if (ev['type'] === 'result') {
        const r = ev['result'];
        if (typeof r === 'string' && r) text = r;
        costUsd = (ev['total_cost_usd'] as number | undefined) ?? null;
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Enrichment SDK call failed');
    return null;
  }

  text = text.trim();
  if (!text || text === 'SKIP-NO-SIGNAL') return null;

  // Ensure output starts with YAML frontmatter — salvage if LLM added preamble prose.
  if (!text.startsWith('---')) {
    const idx = text.indexOf('\n---');
    if (idx > 0) {
      text = text.slice(idx + 1);
    } else {
      logger.warn('Enrichment output missing frontmatter; discarding');
      return null;
    }
  }

  const name = extractName(text);
  if (!name) {
    logger.warn('Enrichment output missing `name` in frontmatter; discarding');
    return null;
  }

  return {
    skill_md: text,
    name,
    model: MODEL,
    duration_ms: Date.now() - startMs,
    cost_usd_reported: costUsd,
  };
}

/** Exported for testing — builds the prompt without calling the SDK. */
export { buildPrompt, SYSTEM_PROMPT };
