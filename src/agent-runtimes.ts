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

export type RuntimeId = 'claude' | 'codex' | 'gemini';

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
 * Adapter front-door used by `agent.ts:runAgent` when `agent.runtime` is
 * not 'claude'. Returns a minimal subset of AgentResult that matches what
 * the Telegram dispatch path actually consumes (text + usage + aborted).
 *
 * Skills/MCPs/permissions are intentionally NOT re-projected — each CLI
 * loads its own config from $HOME, so the user's existing setup just works.
 * If you need a tool to be available to all 3 runtimes, install the MCP
 * in all three CLI configs (~/.claude/mcp.json, ~/.codex/config.toml,
 * ~/.gemini/extensions/).
 */
export async function runNonClaudeRuntime(
  runtime: Exclude<RuntimeId, 'claude'>,
  input: RuntimeRunInput,
): Promise<AgentResult> {
  logger.info({ runtime, cwd: input.cwd }, 'Running non-Claude agent runtime');
  const result = runtime === 'codex'
    ? await runCodexRuntime(input)
    : await runGeminiRuntime(input);

  return {
    text: result.text,
    newSessionId: result.newSessionId,
    usage: result.usage,
    aborted: result.aborted ?? false,
  };
}
