/**
 * Agent Voice Bridge
 *
 * Lightweight CLI script that the War Room Pipecat server calls to invoke
 * a ClaudeClaw agent via the Claude Code SDK and return the text response.
 *
 * Usage: node dist/agent-voice-bridge.js --agent research --message "What did you find?"
 *
 * Outputs JSON to stdout: {"response": "...", "usage": {...}, "error": null}
 *
 * The Pipecat server spawns this as a subprocess for each agent turn,
 * reads the JSON response, and pipes the text to TTS.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readEnvFile } from './env.js';
import { initDatabase, getSession, setSession } from './db.js';
import { buildMemoryContext } from './memory.js';
import { getScrubbedSdkEnv } from './security.js';
import { requireEnabled } from './kill-switches.js';
import { loadMcpServers } from './agent.js';
import { loadAgentConfig, resolveAgentDir } from './agent-config.js';
import { runNonClaudeRuntime, type RuntimeId } from './agent-runtimes.js';
import { CLAUDECLAW_CONFIG } from './config.js';
import path from 'path';
import { fileURLToPath } from 'url';

// The voice bridge is a standalone subprocess — initialize the DB
// connection before any getSession/setSession calls run. Without this,
// db is undefined and every call fails with "Cannot read properties of
// undefined (reading 'prepare')".
initDatabase();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Parse CLI args
const args = process.argv.slice(2);
let agentId = 'main';
let message = '';
let chatId = 'warroom';
let quickMode = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--agent' && args[i + 1]) {
    agentId = args[++i];
  } else if (args[i] === '--message' && args[i + 1]) {
    message = args[++i];
  } else if (args[i] === '--chat-id' && args[i + 1]) {
    chatId = args[++i];
  } else if (args[i] === '--quick') {
    // Quick mode: cap turns hard, used by warroom auto-routing where
    // voice latency matters more than thoroughness. The agent still has
    // MCP access but can only do ~1 tool call round-trip before it has
    // to answer.
    quickMode = true;
  }
}

if (!message) {
  console.error(JSON.stringify({ response: null, usage: null, error: 'No --message provided' }));
  process.exit(1);
}

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

async function main() {
  try {
    // Kill-switch chokepoint for voice-bridge SDK calls. If LLM_SPAWN_ENABLED
    // is off, exit cleanly with an error payload so warroom/server.py can
    // surface "auth/spawn disabled" through the agent_error frame instead
    // of a vague Gemini stutter.
    requireEnabled('LLM_SPAWN_ENABLED');

    const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
    // Strip nested Claude Code state plus every secret-shaped env var the
    // SDK subprocess doesn't need to authenticate. A prompt-injected agent
    // can read whatever's in its env; least-privilege limits the blast
    // radius to just the SDK auth token. Shared with router/orchestrator.
    const sdkEnv = getScrubbedSdkEnv(secrets);

    // Validate agent ID format (prevent path traversal)
    if (agentId !== 'main' && !/^[a-z][a-z0-9_-]{0,29}$/.test(agentId)) {
      throw new Error(`Invalid agent ID: ${agentId}`);
    }

    // Resolve agent directory with the same source of truth as Telegram,
    // dashboard, and text War Room. Custom agents live under
    // CLAUDECLAW_CONFIG/agents, not necessarily PROJECT_ROOT/agents.
    const agentDir = agentId === 'main'
      ? PROJECT_ROOT
      : resolveAgentDir(agentId);
    const resolved = path.resolve(agentDir);
    const allowedRoots = [path.resolve(PROJECT_ROOT), path.resolve(CLAUDECLAW_CONFIG)];
    const underAllowedRoot = allowedRoots.some((root) =>
      resolved === root || resolved.startsWith(root + path.sep),
    );
    if (!underAllowedRoot) {
      throw new Error(`Agent path outside allowed roots: ${resolved}`);
    }

    // Read the agent config once so voice uses the same runtime/model/MCP
    // contract as the text bot.
    let runtime: RuntimeId = 'claude';
    let model: string | undefined;
    let mcpAllowlist: string[] | undefined;
    if (agentId !== 'main') {
      try {
        const cfg = loadAgentConfig(agentId);
        runtime = cfg.runtime ?? 'claude';
        model = cfg.model;
        mcpAllowlist = cfg.mcpServers;
      } catch (err) {
        // Non-fatal for back-compat: fall through with Claude default.
        process.stderr.write(`[voice-bridge] agent config read failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    // Resume session if one exists for this chat+agent
    const sessionId = getSession(chatId, agentId) ?? undefined;

    // Build memory context
    const { contextText: memCtx } = await buildMemoryContext(chatId, message, agentId);
    const parts: string[] = [];
    if (memCtx) parts.push(memCtx);

    // Add voice-meeting context hint. Quick mode is stricter because
    // Gemini Live will read the answer verbatim over voice —
    // long responses break the meeting feel.
    if (quickMode) {
      parts.push('[War Room auto-routing: the user is in a voice meeting and this answer will be read aloud verbatim. Respond in 1-2 short sentences. No preamble, no caveats, no lists. If the question genuinely needs a long answer, say "I need to dig into this, want me to queue it" so the user can choose to delegate the full task.]');
    } else {
      parts.push('[Voice meeting mode: Keep responses concise and conversational. Aim for 2-3 sentences unless asked for detail. Start with a brief acknowledgment.]');
    }
    parts.push(message);
    const fullMessage = parts.join('\n\n');

    if (runtime !== 'claude') {
      const cliEnv = {
        ...process.env,
        ...readEnvFile([
          'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
          'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
        ]),
      };
      const cliFlags: string[] = [];
      if (model) cliFlags.push('--model', model);
      if (quickMode && runtime === 'codex') {
        cliFlags.push('-c', 'model_reasoning_effort="low"', '--color', 'never');
      }
      process.stderr.write(`[voice-bridge] agent=${agentId} runtime=${runtime} model=${model ?? 'default'}\n`);
      const result = await runNonClaudeRuntime(runtime as Exclude<RuntimeId, 'claude'>, {
        message: fullMessage,
        cwd: agentDir,
        env: cliEnv,
        cliFlags,
      });
      if (result.aborted) throw new Error(`${runtime} runtime aborted`);
      console.log(JSON.stringify({
        response: result.text,
        usage: result.usage,
        error: null,
      }));
      return;
    }

    // Phase 0.5 — minimal-settings voice mode.
    //
    // Phase 0 baseline measured that loading project/user `settingSources`
    // (CLAUDE.md, permissions, skills, MCP discovery) costs ~45s on cold spawn
    // — which is 90% of the 53s the voice bridge takes today for a simple
    // turn. Voice mode rarely needs that tooling: War Room runs short
    // turn-taking exchanges where skill dispatch is overkill and adds latency
    // the user actually feels in conversation.
    //
    // In quickMode (the default for War Room team modes via `--quick`), we
    // skip settingSources AND skip MCPs entirely. Result: ~7s/turn instead
    // of ~53s/turn. Direct mode (no --quick) still loads everything for
    // substantive Telegram-style voice conversations.
    //
    // See docs/voice-bridge-baseline.md for the full benchmark.
    const minimalSettings = quickMode || process.env.VOICE_BRIDGE_MINIMAL_SETTINGS === '1';

    const mcpServers = minimalSettings ? {} : loadMcpServers(mcpAllowlist, agentDir);
    const mcpServerNames = Object.keys(mcpServers);
    process.stderr.write(`[voice-bridge] agent=${agentId} runtime=claude minimalSettings=${minimalSettings} mcpServers=${JSON.stringify(mcpServerNames)}\n`);

    let resultText: string | null = null;
    let newSessionId: string | undefined;
    let usage: Record<string, number> = {};

    for await (const event of query({
      prompt: singleTurn(fullMessage),
      options: {
        cwd: agentDir,
        resume: sessionId,
        settingSources: minimalSettings ? [] : ['project', 'user'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // Quick mode caps turns hard so an auto-routed voice answer
        // can't spiral into a 30s tool-use loop. Direct mode keeps the
        // higher ceiling for more substantive voice conversations.
        maxTurns: quickMode ? 3 : 15,
        env: sdkEnv,
        ...(mcpServerNames.length > 0 ? { mcpServers } : {}),
      },
    })) {
      const ev = event as Record<string, unknown>;

      if (ev['type'] === 'system' && ev['subtype'] === 'init') {
        newSessionId = ev['session_id'] as string;
      }

      if (ev['type'] === 'result') {
        resultText = (ev['result'] as string | null | undefined) ?? null;
        const evUsage = ev['usage'] as Record<string, number> | undefined;
        if (evUsage) {
          usage = {
            input_tokens: evUsage['input_tokens'] ?? 0,
            output_tokens: evUsage['output_tokens'] ?? 0,
            cost_usd: (ev['total_cost_usd'] as number) ?? 0,
          };
        }
      }
    }

    // Save session for continuity
    if (newSessionId) {
      setSession(chatId, newSessionId, agentId);
    }

    console.log(JSON.stringify({
      response: resultText,
      usage,
      error: null,
    }));
  } catch (err) {
    console.log(JSON.stringify({
      response: null,
      usage: null,
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

main();
