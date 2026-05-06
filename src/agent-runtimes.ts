/**
 * Pluggable agent runtimes — claude (SDK), codex (CLI), gemini (CLI).
 *
 * Cada CLI carrega seu próprio set de skills/MCPs/extensões a partir de
 * ~/.codex/ e ~/.gemini/, então não precisamos re-implementar tool dispatch
 * aqui. Este módulo é só um adapter que padroniza input/output pra que
 * `agent.ts:runAgent` possa ramificar sem precisar conhecer cada CLI.
 *
 * Approach C — CLI subprocess (mais completo pra tools sem reescrever
 * mapping per provider). Ver REBUILD_TODO ou plan doc pra rationale.
 */

import { spawn } from 'child_process';
import { logger } from './logger.js';
import type { AgentResult, UsageInfo } from './agent.js';

export type RuntimeId = 'claude' | 'codex' | 'gemini' | 'openai-sdk' | 'gemini-sdk';

export interface RuntimeRunInput {
  message: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  abortController?: AbortController;
  onStreamText?: (accumulatedText: string) => void;
  /** Per-agent CLI overrides (model alias, profile, etc). Optional. */
  cliFlags?: string[];
}

export interface RuntimeRunResult {
  text: string | null;
  usage: UsageInfo | null;
  newSessionId?: string;
  aborted?: boolean;
}

/** Spawns a CLI in headless/json mode and aggregates stdout into the
 *  result. Streams partial text to `onStreamText` line-by-line so
 *  Telegram can show progressive updates. */
async function runCliRuntime(opts: {
  bin: string;
  args: string[];
  input: RuntimeRunInput;
}): Promise<RuntimeRunResult> {
  const { bin, args, input } = opts;
  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let aborted = false;
    const aborter = () => {
      aborted = true;
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
    };
    input.abortController?.signal.addEventListener('abort', aborter);

    // Send the prompt via stdin so we don't have to escape it for argv.
    if (proc.stdin) {
      proc.stdin.write(input.message);
      proc.stdin.end();
    }

    let stdoutBuf = '';
    let stderrBuf = '';

    proc.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;
      // Emit partial text — caller may chunk for Telegram.
      input.onStreamText?.(stdoutBuf);
    });

    proc.stderr?.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });

    proc.on('error', (err) => {
      logger.error({ bin, err: err.message }, 'CLI runtime spawn error');
      input.abortController?.signal.removeEventListener('abort', aborter);
      resolve({
        text: `[runtime error: ${bin} not found or failed to start: ${err.message}]`,
        usage: null,
        aborted: false,
      });
    });

    proc.on('close', (code) => {
      input.abortController?.signal.removeEventListener('abort', aborter);
      if (aborted) {
        resolve({ text: null, usage: null, aborted: true });
        return;
      }
      if (code !== 0 && stdoutBuf.trim().length === 0) {
        resolve({
          text: `[runtime ${bin} exited ${code}]\n${stderrBuf.slice(-500)}`,
          usage: null,
          aborted: false,
        });
        return;
      }
      // Strip ANSI + CR; codex/gemini sometimes emit progress UI in stdout.
      const clean = stdoutBuf.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '').trim();
      resolve({ text: clean, usage: null, aborted: false });
    });
  });
}

/**
 * Codex CLI runtime. Calls `codex exec` (headless mode, deterministic
 * single-shot) and pipes the prompt via stdin. Codex auto-loads
 * ~/.codex/AGENTS.md + skills + MCPs configured in ~/.codex/config.toml.
 *
 * Note: requires `codex` CLI installed (npm i -g @openai/codex or
 * equivalent). Codex headless mode emits cleaner output than `codex`
 * interactive — verbose dump issue mentioned in mem0 was for the
 * mesh-call wrapper, not the CLI itself.
 */
export async function runCodexRuntime(input: RuntimeRunInput): Promise<RuntimeRunResult> {
  const args = ['exec', '--quiet', ...(input.cliFlags ?? [])];
  return runCliRuntime({ bin: 'codex', args, input });
}

/**
 * Gemini CLI runtime. Uses `gemini` headless mode with `-p` flag for
 * prompt. Auto-loads ~/.gemini/extensions + GEMINI.md + skills.
 *
 * Requires `gemini` CLI (npm i -g @google/gemini-cli) and
 * GEMINI_API_KEY in env. The CLI handles auth itself when first run.
 */
export async function runGeminiRuntime(input: RuntimeRunInput): Promise<RuntimeRunResult> {
  // Gemini CLI takes prompt via stdin OR --prompt flag. Stdin is safer
  // because long prompts blow argv limits. We pass --yolo to skip
  // interactive prompts (skill grants, etc.) — same UX as codex --quiet.
  const args = ['--yolo', ...(input.cliFlags ?? [])];
  return runCliRuntime({ bin: 'gemini', args, input });
}

/**
 * OpenAI Agents SDK runtime — uses @openai/agents in-process. Unlike the
 * Codex CLI path, this gets HOSTED TOOLS (web_search_preview, file_search,
 * code_interpreter) that exist only in the Responses API. No subprocess
 * overhead. Skills from ~/.codex/ are NOT loaded (separate config domain).
 *
 * Default model: env OPENAI_DEFAULT_MODEL or 'gpt-5.5'. Hosted tools opt-in
 * via env OPENAI_HOSTED_TOOLS='web_search,file_search,code_interpreter'
 * (comma-separated, names match Responses API tool types).
 *
 * Lazy-imports @openai/agents so the rest of the app doesn't require it
 * when only claude/codex/gemini-cli are in use.
 */
export async function runOpenAISdkRuntime(input: RuntimeRunInput): Promise<RuntimeRunResult> {
  let agentsLib: typeof import('@openai/agents');
  try {
    agentsLib = await import('@openai/agents');
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '@openai/agents not installed');
    return {
      text: '[runtime error: @openai/agents not installed. Run: npm i @openai/agents]',
      usage: null, aborted: false,
    };
  }

  const apiKey = input.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      text: '[runtime error: OPENAI_API_KEY not set in .env]',
      usage: null, aborted: false,
    };
  }

  // Hosted tools opt-in via env. Each name maps to a Responses API tool type.
  const enabledHostedTools = (input.env.OPENAI_HOSTED_TOOLS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const hostedTools: Array<Record<string, unknown>> = [];
  if (enabledHostedTools.includes('web_search')) hostedTools.push({ type: 'web_search_preview' });
  if (enabledHostedTools.includes('file_search')) hostedTools.push({ type: 'file_search' });
  if (enabledHostedTools.includes('code_interpreter')) hostedTools.push({ type: 'code_interpreter', container: { type: 'auto' } });

  const model = input.env.OPENAI_DEFAULT_MODEL || 'gpt-5.5';
  const { Agent, run } = agentsLib;

  try {
    const agent = new Agent({
      name: 'CC-OS Agent (OpenAI SDK)',
      instructions: 'Você é um assistente. Responda de forma concisa e útil em português brasileiro.',
      model,
      // Casting to the lib's expected tool shape — hosted tools have a
      // looser contract than locally-defined ones.
      tools: hostedTools as never,
    });
    // Process env precisa ter OPENAI_API_KEY pra SDK pegar. Set inline
    // antes do run pra evitar pollution global.
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = apiKey;
    try {
      const result = await run(agent, input.message, {
        // signal intentionally typed as `unknown`-cast — Agents SDK accepts
        // AbortSignal in newer versions but typing varies between minor
        // releases. Cast keeps us forward-compatible.
        signal: input.abortController?.signal as never,
      });
      return {
        text: typeof result.finalOutput === 'string' ? result.finalOutput : JSON.stringify(result.finalOutput ?? ''),
        usage: null, aborted: false,
      };
    } finally {
      if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey;
      else delete process.env.OPENAI_API_KEY;
    }
  } catch (err) {
    if (input.abortController?.signal.aborted) {
      return { text: null, usage: null, aborted: true };
    }
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'OpenAI SDK runtime error');
    return {
      text: `[OpenAI SDK error: ${err instanceof Error ? err.message : String(err)}]`,
      usage: null, aborted: false,
    };
  }
}

/**
 * Google Gen AI SDK runtime — uses @google/genai in-process. Different from
 * Gemini CLI path: gets GROUNDING (Google Search), code_execution sandbox,
 * Files API with vector store, thinking config. CLI doesn't expose these.
 *
 * Default model: env GEMINI_DEFAULT_MODEL or 'gemini-3.1-pro-preview'. Grounding
 * opt-in via env GEMINI_USE_GROUNDING=true. code_execution opt-in via
 * GEMINI_USE_CODE_EXEC=true. Thinking budget via GEMINI_THINKING_BUDGET.
 */
export async function runGeminiSdkRuntime(input: RuntimeRunInput): Promise<RuntimeRunResult> {
  let genAiLib: typeof import('@google/genai');
  try {
    genAiLib = await import('@google/genai');
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '@google/genai not installed');
    return {
      text: '[runtime error: @google/genai not installed. Run: npm i @google/genai]',
      usage: null, aborted: false,
    };
  }

  const apiKey = input.env.GEMINI_API_KEY || input.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return {
      text: '[runtime error: GEMINI_API_KEY (ou GOOGLE_API_KEY) not set in .env]',
      usage: null, aborted: false,
    };
  }

  const useGrounding = (input.env.GEMINI_USE_GROUNDING || '').toLowerCase() === 'true';
  const useCodeExec = (input.env.GEMINI_USE_CODE_EXEC || '').toLowerCase() === 'true';
  const thinkingBudgetRaw = input.env.GEMINI_THINKING_BUDGET;
  const thinkingBudget = thinkingBudgetRaw ? parseInt(thinkingBudgetRaw, 10) : undefined;

  const model = input.env.GEMINI_DEFAULT_MODEL || 'gemini-3.1-pro-preview';
  const { GoogleGenAI } = genAiLib;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const tools: Array<Record<string, unknown>> = [];
    if (useGrounding) tools.push({ googleSearch: {} });
    if (useCodeExec)  tools.push({ codeExecution: {} });

    const config: Record<string, unknown> = {};
    if (tools.length > 0) config.tools = tools;
    if (thinkingBudget !== undefined && !Number.isNaN(thinkingBudget)) {
      config.thinkingConfig = { thinkingBudget };
    }

    const response = await ai.models.generateContent({
      model,
      contents: input.message,
      config: Object.keys(config).length > 0 ? config : undefined,
    });

    const text = response.text ?? null;
    return { text, usage: null, aborted: false };
  } catch (err) {
    if (input.abortController?.signal.aborted) {
      return { text: null, usage: null, aborted: true };
    }
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Gemini SDK runtime error');
    return {
      text: `[Gemini SDK error: ${err instanceof Error ? err.message : String(err)}]`,
      usage: null, aborted: false,
    };
  }
}

/**
 * Adapter front-door used by `agent.ts:runAgent` when `agent.runtime` is
 * not 'claude'. Routes to the right adapter — CLI subprocess for codex/gemini
 * (uses local CLI config + skills) or in-process SDK for openai-sdk/gemini-sdk
 * (gets hosted tools that CLIs don't expose).
 */
export async function runNonClaudeRuntime(
  runtime: Exclude<RuntimeId, 'claude'>,
  input: RuntimeRunInput,
): Promise<AgentResult> {
  logger.info({ runtime, cwd: input.cwd }, 'Running non-Claude agent runtime');
  let result: RuntimeRunResult;
  switch (runtime) {
    case 'codex':       result = await runCodexRuntime(input); break;
    case 'gemini':      result = await runGeminiRuntime(input); break;
    case 'openai-sdk':  result = await runOpenAISdkRuntime(input); break;
    case 'gemini-sdk':  result = await runGeminiSdkRuntime(input); break;
  }

  return {
    text: result.text,
    newSessionId: result.newSessionId,
    usage: result.usage,
    aborted: result.aborted ?? false,
  };
}
