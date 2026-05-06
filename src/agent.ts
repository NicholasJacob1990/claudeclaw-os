import fs from 'fs';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { AGENT_ID, AGENT_MAX_TURNS, AGENT_USE_V2_SESSIONS, PROJECT_ROOT, agentCwd } from './config.js';
import { readEnvFile } from './env.js';
import { classifyError, AgentError } from './errors.js';
import { logger } from './logger.js';
import { getScrubbedSdkEnv } from './security.js';
import { requireEnabled } from './kill-switches.js';
import { runPooledTurn, sessionPoolKey } from './claude-session-pool.js';
import { loadAgentConfig } from './agent-config.js';
import { runNonClaudeRuntime } from './agent-runtimes.js';

// ── MCP server loading ──────────────────────────────────────────────
// The Agent SDK's settingSources loads CLAUDE.md and permissions from
// project/user settings, but does NOT load mcpServers from those files.
// We read them ourselves and pass them via the `mcpServers` option.

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Merge MCP server configs from user settings (~/.claude/settings.json) and
 * project settings (.claude/settings.json in cwd), optionally filtered by
 * an allowlist (e.g. from an agent's agent.yaml `mcp_servers` field).
 *
 * Exported so the voice bridge can reuse the exact same loader the text
 * bot uses — keeping behavior consistent across channels.
 */
export function loadMcpServers(allowlist?: string[], projectCwd?: string): Record<string, McpStdioConfig> {
  const merged: Record<string, McpStdioConfig> = {};

  // Load from project settings (.claude/settings.json in cwd). `projectCwd`
  // lets callers (e.g. the voice bridge) target a specific sub-agent's
  // settings file without needing the module-level `agentCwd` to be set.
  const projectSettings = path.join(projectCwd ?? agentCwd ?? PROJECT_ROOT, '.claude', 'settings.json');
  // Load from user settings (~/.claude/settings.json)
  const userSettings = path.join(
    process.env.HOME ?? '/tmp',
    '.claude',
    'settings.json',
  );

  for (const file of [userSettings, projectSettings]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const servers = raw?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const [name, config] of Object.entries(servers)) {
          const cfg = config as Record<string, unknown>;
          if (cfg.command && typeof cfg.command === 'string') {
            merged[name] = {
              command: cfg.command,
              ...(cfg.args ? { args: cfg.args as string[] } : {}),
              ...(cfg.env ? { env: cfg.env as Record<string, string> } : {}),
            };
          }
        }
      }
    } catch {
      // File doesn't exist or is invalid — skip
    }
  }

  // If an allowlist is provided, only keep the MCPs in that list
  if (allowlist) {
    const allowed = new Set(allowlist);
    for (const name of Object.keys(merged)) {
      if (!allowed.has(name)) delete merged[name];
    }
  }

  return merged;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  /** True if the SDK auto-compacted context during this turn */
  didCompact: boolean;
  /** Token count before compaction (if it happened) */
  preCompactTokens: number | null;
  /**
   * The cache_read_input_tokens from the LAST API call in the turn.
   * Unlike the cumulative cacheReadInputTokens, this reflects the actual
   * context window size (cumulative overcounts on multi-step tool-use turns).
   */
  lastCallCacheRead: number;
  /**
   * The input_tokens from the LAST API call in the turn.
   * This is the actual context window size: system prompt + conversation
   * history + tool results for that call. Use this for context warnings.
   */
  lastCallInputTokens: number;
}

/** Progress event emitted during agent execution for Telegram feedback. */
export interface AgentProgressEvent {
  type: 'task_started' | 'task_completed' | 'tool_active';
  description: string;
}

/** Map SDK tool names to human-readable labels. */
const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading file',
  Write: 'Writing file',
  Edit: 'Editing file',
  Bash: 'Running command',
  Grep: 'Searching code',
  Glob: 'Finding files',
  WebSearch: 'Web search',
  WebFetch: 'Fetching page',
  Agent: 'Sub-agent',
  NotebookEdit: 'Editing notebook',
  AskUserQuestion: 'User question',
};

function toolLabel(toolName: string): string {
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
  // MCP tools: mcp__server__tool → "server: tool"
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return parts.length >= 3 ? `${parts[1]}: ${parts.slice(2).join(' ')}` : toolName;
  }
  return toolName;
}

export interface AgentResult {
  text: string | null;
  newSessionId: string | undefined;
  usage: UsageInfo | null;
  aborted?: boolean;
}

/**
 * A minimal AsyncIterable that yields a single user message then closes.
 * This is the format the Claude Agent SDK expects for its `prompt` parameter.
 * The SDK drives the agentic loop internally (tool use, multi-step reasoning)
 * and surfaces a final `result` event when done.
 */
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
 * Run a single user message through Claude Code and return the result.
 *
 * Uses `resume` to continue the same session across Telegram messages,
 * giving Claude persistent context without re-sending history.
 *
 * Auth: The SDK spawns the `claude` CLI subprocess which reads OAuth auth
 * from ~/.claude/ automatically (the same auth used in the terminal).
 * No explicit token needed if you're already logged in via `claude login`.
 * Optionally override with CLAUDE_CODE_OAUTH_TOKEN in .env.
 *
 * @param message    The user's text (may include transcribed voice prefix)
 * @param sessionId  Claude Code session ID to resume, or undefined for new session
 * @param onTyping   Called every TYPING_REFRESH_MS while waiting — sends typing action to Telegram
 * @param onProgress Called when sub-agents start/complete — sends status updates to Telegram
 */
export async function runAgent(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  model?: string,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
  mcpAllowlist?: string[],
  poolKey?: string,
): Promise<AgentResult> {
  // Centralized kill-switch enforcement. Throws KillSwitchDisabledError if
  // LLM_SPAWN_ENABLED has been flipped off — caller is expected to surface
  // a "feature disabled" message rather than retry. This is the SINGLE
  // chokepoint for Telegram, scheduler, mission worker, and any other
  // path that ends up here; the war-room and voice paths have their own
  // requireEnabled calls at their own SDK boundaries.
  requireEnabled('LLM_SPAWN_ENABLED');

  // ── Runtime branching ────────────────────────────────────────────────
  // Per-agent runtime selection. agent.yaml `runtime: codex|gemini` shells
  // out to the corresponding CLI; default 'claude' keeps the SDK path
  // below. CLIs auto-load their own skills/MCPs/extensions from $HOME so
  // we don't replicate tool dispatch here. Skips claude-only optimizations
  // (v2 sessions pool, in-process MCP) — codex/gemini paths are simpler
  // single-shot subprocess calls.
  try {
    const cfg = loadAgentConfig(AGENT_ID);
    const runtime = cfg.runtime ?? 'claude';
    if (runtime === 'codex' || runtime === 'gemini') {
      const cliEnv = readEnvFile([
        'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
      ]);
      const cliSdkEnv = { ...process.env, ...cliEnv };
      logger.info({ runtime, agentId: AGENT_ID }, 'Routing to non-Claude runtime');
      return runNonClaudeRuntime(runtime, {
        message,
        cwd: agentCwd ?? PROJECT_ROOT,
        env: cliSdkEnv,
        abortController,
        onStreamText,
      });
    }
  } catch (err) {
    // If config doesn't load (main agent has no agent.yaml), fall through
    // to default Claude SDK path. Don't fail the request just because the
    // runtime field couldn't be read.
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'No per-agent config; using Claude default');
  }

  // Read secrets from .env without polluting process.env.
  // CLAUDE_CODE_OAUTH_TOKEN is optional — the subprocess finds auth via ~/.claude/
  // automatically. Only needed if you want to override which account is used.
  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  // Strip secret-shaped env vars (DASHBOARD_TOKEN, third-party API keys,
  // DB_ENCRYPTION_KEY, etc.) before handing process.env to the SDK
  // subprocess. A prompt-injected agent that calls `env` or `cat .env`
  // can otherwise read every credential the parent process holds.
  const sdkEnv = getScrubbedSdkEnv(secrets);

  let newSessionId: string | undefined;
  let resultText: string | null = null;
  let usage: UsageInfo | null = null;
  let didCompact = false;
  let preCompactTokens: number | null = null;
  let lastCallCacheRead = 0;
  let lastCallInputTokens = 0;
  let streamedText = '';

  // Refresh typing indicator on an interval while Claude works.
  // Telegram's "typing..." action expires after ~5s.
  const typingInterval = setInterval(onTyping, 4000);

  try {
    // Load MCP servers from project + user settings files, filtered by agent allowlist
    const mcpServers = loadMcpServers(mcpAllowlist);
    const mcpServerNames = Object.keys(mcpServers);
    logger.info(
      { sessionId: sessionId ?? 'new', messageLen: message.length, mcpServers: mcpServerNames },
      'Starting agent query',
    );

    // SDK Options.mcpServers expects Record<string, McpServerConfig>
    const mcpServerSpecs = mcpServerNames.length > 0 ? mcpServers : undefined;

    // ── Persistent subprocess pool path (v2 sessions) ────────────────
    // Reuse a long-lived `claude` subprocess keyed by (poolKey × cwd × model × mcpset)
    // to skip the ~50s spawn+MCP load cost on every turn after the first.
    // On any failure, fall through to the v1 `query()` path below.
    if (AGENT_USE_V2_SESSIONS && poolKey) {
      const effectiveModel = model ?? 'claude-sonnet-4-6';
      const effectiveCwd = agentCwd ?? PROJECT_ROOT;
      const key = sessionPoolKey({
        chatId: poolKey,
        agentId: agentCwd ? path.basename(agentCwd) : 'main',
        cwd: effectiveCwd,
        model: effectiveModel,
        mcpNames: mcpServerNames,
      });

      try {
        const pooled = await runPooledTurn(
          key,
          message,
          {
            model: effectiveModel,
            cwd: effectiveCwd,
            env: sdkEnv,
            mcpServers: mcpServerSpecs,
            settingSources: ['project', 'user'],
            permissionMode: 'bypassPermissions',
            ...(AGENT_MAX_TURNS > 0 ? { maxTurns: AGENT_MAX_TURNS } : {}),
            ...(sessionId ? { resume: sessionId } : {}),
            ...(abortController ? { abortController } : {}),
          },
          {
            onInit: (sid) => {
              newSessionId = sid;
              logger.info({ newSessionId, pooled: true }, 'Session initialized');
            },
            onCompact: (trigger, preTokens) => {
              didCompact = true;
              preCompactTokens = preTokens;
              logger.warn({ trigger, preCompactTokens }, 'Context window compacted');
            },
            onTaskStarted: (desc) => onProgress?.({ type: 'task_started', description: desc }),
            onTaskCompleted: (status, summary) => onProgress?.({
              type: 'task_completed',
              description: status === 'failed' ? `Failed: ${summary}` : summary,
            }),
            onAssistant: (ev) => {
              const msg = ev['message'] as Record<string, unknown> | undefined;
              const msgUsage = msg?.['usage'] as Record<string, number> | undefined;
              const callCacheRead = msgUsage?.['cache_read_input_tokens'] ?? 0;
              const callInputTokens = msgUsage?.['input_tokens'] ?? 0;
              if (callCacheRead > 0) lastCallCacheRead = callCacheRead;
              if (callInputTokens > 0) lastCallInputTokens = callInputTokens;

              if (onProgress) {
                const content = msg?.['content'] as Array<{ type: string; name?: string }> | undefined;
                if (Array.isArray(content)) {
                  for (const block of content) {
                    if (block.type === 'tool_use' && block.name) {
                      onProgress({ type: 'tool_active', description: toolLabel(block.name) });
                    }
                  }
                }
              }
            },
            onStream: (ev) => {
              if (!onStreamText || ev['parent_tool_use_id'] !== null) return;
              const streamEvent = ev['event'] as Record<string, unknown> | undefined;
              if (streamEvent?.['type'] === 'message_start') streamedText = '';
              if (streamEvent?.['type'] === 'content_block_delta') {
                const delta = streamEvent['delta'] as Record<string, unknown> | undefined;
                if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
                  streamedText += delta['text'];
                  onStreamText(streamedText);
                }
              }
            },
            onResult: (ev) => {
              resultText = (ev['result'] as string | null | undefined) ?? null;
              const evUsage = ev['usage'] as Record<string, number> | undefined;
              if (evUsage) {
                usage = {
                  inputTokens: evUsage['input_tokens'] ?? 0,
                  outputTokens: evUsage['output_tokens'] ?? 0,
                  cacheReadInputTokens: evUsage['cache_read_input_tokens'] ?? 0,
                  totalCostUsd: (ev['total_cost_usd'] as number) ?? 0,
                  didCompact,
                  preCompactTokens,
                  lastCallCacheRead,
                  lastCallInputTokens,
                };
                logger.info(
                  {
                    inputTokens: usage.inputTokens,
                    cacheReadTokens: usage.cacheReadInputTokens,
                    lastCallCacheRead: usage.lastCallCacheRead,
                    lastCallInputTokens: usage.lastCallInputTokens,
                    costUsd: usage.totalCostUsd,
                    didCompact,
                    pooled: true,
                  },
                  'Turn usage',
                );
              }
              logger.info(
                { hasResult: !!resultText, subtype: ev['subtype'], pooled: true },
                'Agent result received',
              );
            },
          },
        );
        if (pooled.sessionId && !newSessionId) newSessionId = pooled.sessionId;
        clearInterval(typingInterval);
        return { text: resultText, newSessionId, usage };
      } catch (poolErr) {
        if (abortController?.signal.aborted) {
          clearInterval(typingInterval);
          return { text: null, newSessionId, usage, aborted: true };
        }
        logger.warn(
          { err: (poolErr as Error)?.message, key },
          'Pooled session failed, falling back to v1 query',
        );
        // reset per-turn state that may have been partially populated
        newSessionId = undefined;
        resultText = null;
        usage = null;
        didCompact = false;
        preCompactTokens = null;
        lastCallCacheRead = 0;
        lastCallInputTokens = 0;
        streamedText = '';
      }
    }

    for await (const event of query({
      prompt: singleTurn(message),
      options: {
        // cwd = agent directory (if running as agent) or project root.
        // Claude Code loads CLAUDE.md from cwd via settingSources: ['project'].
        cwd: agentCwd ?? PROJECT_ROOT,

        // Resume the previous session for this chat (persistent context)
        resume: sessionId,

        // 'project' loads CLAUDE.md from cwd; 'user' loads ~/.claude/skills/ and user settings
        settingSources: ['project', 'user'],

        // Skip all permission prompts — this is a trusted personal bot on your own machine
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,

        // Cap agentic turns to prevent runaway tool-use loops (e.g. retrying
        // stale cookies 40+ times). Configurable via AGENT_MAX_TURNS in .env.
        ...(AGENT_MAX_TURNS > 0 ? { maxTurns: AGENT_MAX_TURNS } : {}),

        // Pass secrets to the subprocess without polluting our own process.env
        env: sdkEnv,

        // MCP servers loaded from .claude/settings.json and ~/.claude/settings.json
        ...(mcpServerSpecs ? { mcpServers: mcpServerSpecs } : {}),

        // Stream partial text so Telegram can show progressive updates
        includePartialMessages: !!onStreamText,

        // Model override (e.g. 'claude-haiku-4-5', 'claude-sonnet-4-5')
        ...(model ? { model } : {}),

        // Abort support — signals the SDK to kill the subprocess
        ...(abortController ? { abortController } : {}),
      },
    })) {
      const ev = event as Record<string, unknown>;

      if (ev['type'] === 'system' && ev['subtype'] === 'init') {
        newSessionId = ev['session_id'] as string;
        logger.info({ newSessionId }, 'Session initialized');
      }

      // Detect auto-compaction (context window was getting full)
      if (ev['type'] === 'system' && ev['subtype'] === 'compact_boundary') {
        didCompact = true;
        const meta = ev['compact_metadata'] as { trigger: string; pre_tokens: number } | undefined;
        preCompactTokens = meta?.pre_tokens ?? null;
        logger.warn(
          { trigger: meta?.trigger, preCompactTokens },
          'Context window compacted',
        );
      }

      // Track per-call token usage and detect tool use from assistant message events.
      // Each assistant message represents one API call; its usage reflects
      // that single call's context size (not cumulative across the turn).
      if (ev['type'] === 'assistant') {
        const msg = ev['message'] as Record<string, unknown> | undefined;
        const msgUsage = msg?.['usage'] as Record<string, number> | undefined;
        const callCacheRead = msgUsage?.['cache_read_input_tokens'] ?? 0;
        const callInputTokens = msgUsage?.['input_tokens'] ?? 0;
        if (callCacheRead > 0) {
          lastCallCacheRead = callCacheRead;
        }
        if (callInputTokens > 0) {
          lastCallInputTokens = callInputTokens;
        }

        // Extract tool_use blocks from assistant content for progress reporting
        if (onProgress) {
          const content = msg?.['content'] as Array<{ type: string; name?: string }> | undefined;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use' && block.name) {
                onProgress({ type: 'tool_active', description: toolLabel(block.name) });
              }
            }
          }
        }
      }

      // Sub-agent lifecycle events — surface to Telegram for user feedback
      if (ev['type'] === 'system' && ev['subtype'] === 'task_started' && onProgress) {
        const desc = (ev['description'] as string) ?? 'Sub-agent started';
        onProgress({ type: 'task_started', description: desc });
      }
      if (ev['type'] === 'system' && ev['subtype'] === 'task_notification' && onProgress) {
        const summary = (ev['summary'] as string) ?? 'Sub-agent finished';
        const status = (ev['status'] as string) ?? 'completed';
        onProgress({
          type: 'task_completed',
          description: status === 'failed' ? `Failed: ${summary}` : summary,
        });
      }

      // Stream text deltas for progressive Telegram updates.
      // Only stream the outermost assistant response (parent_tool_use_id === null)
      // to avoid showing internal tool-use reasoning.
      if (ev['type'] === 'stream_event' && onStreamText && ev['parent_tool_use_id'] === null) {
        const streamEvent = ev['event'] as Record<string, unknown> | undefined;
        if (streamEvent?.['type'] === 'content_block_delta') {
          const delta = streamEvent['delta'] as Record<string, unknown> | undefined;
          if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            streamedText += delta['text'];
            onStreamText(streamedText);
          }
        }
        if (streamEvent?.['type'] === 'message_start') {
          streamedText = '';
        }
      }

      if (ev['type'] === 'result') {
        resultText = (ev['result'] as string | null | undefined) ?? null;

        // Extract usage info from result event
        const evUsage = ev['usage'] as Record<string, number> | undefined;
        if (evUsage) {
          usage = {
            inputTokens: evUsage['input_tokens'] ?? 0,
            outputTokens: evUsage['output_tokens'] ?? 0,
            cacheReadInputTokens: evUsage['cache_read_input_tokens'] ?? 0,
            totalCostUsd: (ev['total_cost_usd'] as number) ?? 0,
            didCompact,
            preCompactTokens,
            lastCallCacheRead,
            lastCallInputTokens,
          };
          logger.info(
            {
              inputTokens: usage.inputTokens,
              cacheReadTokens: usage.cacheReadInputTokens,
              lastCallCacheRead: usage.lastCallCacheRead,
              lastCallInputTokens: usage.lastCallInputTokens,
              costUsd: usage.totalCostUsd,
              didCompact,
            },
            'Turn usage',
          );
        }

        logger.info(
          { hasResult: !!resultText, subtype: ev['subtype'] },
          'Agent result received',
        );
      }
    }
  } catch (err) {
    if (abortController?.signal.aborted) {
      logger.info('Agent query aborted by user');
      return { text: null, newSessionId, usage, aborted: true };
    }

    // Classify the error and attach context-aware metadata
    const contextTokens = lastCallInputTokens || lastCallCacheRead || 0;
    const classified = classifyError(err, contextTokens || undefined);
    logger.error(
      { category: classified.category, recovery: classified.recovery, originalMsg: (err as Error)?.message },
      'Agent query failed (classified)',
    );
    throw classified;
  } finally {
    clearInterval(typingInterval);
  }

  return { text: resultText, newSessionId, usage };
}

// ── Retry wrapper ─────────────────────────────────────────────────

const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MULTIPLIER = 4; // 2s, 8s

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the agent with automatic retry for transient errors.
 * Only retries errors where recovery.shouldRetry is true.
 * Calls onRetry before each retry so the caller can notify the user.
 */
export async function runAgentWithRetry(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  model?: string,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
  onRetry?: (attempt: number, error: AgentError) => void,
  fallbackModels?: string[],
  mcpAllowlist?: string[],
  poolKey?: string,
): Promise<AgentResult> {
  let lastError: AgentError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const currentModel =
        attempt === 0 ? model
        : lastError?.recovery.shouldSwitchModel && fallbackModels?.length
          ? fallbackModels[Math.min(attempt - 1, fallbackModels.length - 1)]
          : model;

      return await runAgent(
        message, sessionId, onTyping, onProgress,
        currentModel, abortController, onStreamText,
        mcpAllowlist, poolKey,
      );
    } catch (err) {
      if (!(err instanceof AgentError)) throw err;
      lastError = err;

      // Don't retry non-retryable errors or if aborted
      if (!err.recovery.shouldRetry || abortController?.signal.aborted) {
        throw err;
      }

      // Don't retry past the limit
      if (attempt >= MAX_RETRIES) {
        throw err;
      }

      const delayMs = Math.min(
        BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, attempt),
        60000,
      );
      // Add jitter (0-25% of delay)
      const jitter = Math.random() * delayMs * 0.25;

      logger.warn(
        { attempt: attempt + 1, category: err.category, delayMs: Math.round(delayMs + jitter) },
        'Retrying agent query',
      );

      onRetry?.(attempt + 1, err);
      await sleep(delayMs + jitter);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError ?? new Error('Retry loop exhausted');
}
