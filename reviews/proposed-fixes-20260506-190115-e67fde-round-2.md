## High - Scrub environment for Codex/Gemini CLI runtimes

Proposed patch:

```diff
diff --git a/src/security.ts b/src/security.ts
@@
 export function getScrubbedSdkEnv(
   authSecrets?: Partial<Record<typeof SDK_AUTH_VARS[number], string>>,
 ): Record<string, string | undefined> {
@@
   return env;
 }
+
+type CliRuntimeAuthVar = 'OPENAI_API_KEY' | 'GEMINI_API_KEY' | 'GOOGLE_API_KEY';
+
+export function getScrubbedCliRuntimeEnv(
+  runtime: 'codex' | 'gemini',
+  authSecrets?: Partial<Record<CliRuntimeAuthVar, string>>,
+): Record<string, string | undefined> {
+  const env = getScrubbedSdkEnv();
+
+  // Claude SDK auth is not needed by Codex/Gemini CLI children.
+  delete env.CLAUDE_CODE_OAUTH_TOKEN;
+  delete env.ANTHROPIC_API_KEY;
+
+  // Re-inject only the auth material required by the selected CLI. The CLI
+  // can still use its normal home-directory auth/config, but model-controlled
+  // tools do not receive unrelated service tokens.
+  if (runtime === 'codex' && authSecrets?.OPENAI_API_KEY) {
+    env.OPENAI_API_KEY = authSecrets.OPENAI_API_KEY;
+  }
+  if (runtime === 'gemini') {
+    if (authSecrets?.GEMINI_API_KEY) env.GEMINI_API_KEY = authSecrets.GEMINI_API_KEY;
+    if (authSecrets?.GOOGLE_API_KEY) env.GOOGLE_API_KEY = authSecrets.GOOGLE_API_KEY;
+  }
+  return env;
+}
diff --git a/src/agent.ts b/src/agent.ts
@@
-import { getScrubbedSdkEnv } from './security.js';
+import { getScrubbedCliRuntimeEnv, getScrubbedSdkEnv } from './security.js';
@@
   if (resolvedRuntime !== 'claude') {
-    const cliEnv = readEnvFile([
-      'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
-      'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
-    ]);
-    const cliSdkEnv = { ...process.env, ...cliEnv };
+    const runtime = resolvedRuntime as 'codex' | 'gemini';
+    const cliEnv = readEnvFile(['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']);
+    const cliSdkEnv = getScrubbedCliRuntimeEnv(runtime, cliEnv);
@@
-    return runNonClaudeRuntime(resolvedRuntime as Exclude<typeof resolvedRuntime, 'claude'>, {
+    return runNonClaudeRuntime(runtime, {
diff --git a/src/agent-voice-bridge.ts b/src/agent-voice-bridge.ts
@@
-import { getScrubbedSdkEnv } from './security.js';
+import { getScrubbedCliRuntimeEnv, getScrubbedSdkEnv } from './security.js';
@@
     if (runtime !== 'claude') {
-      const cliEnv = {
-        ...process.env,
-        ...readEnvFile([
-          'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
-          'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
-        ]),
-      };
+      const cliEnv = getScrubbedCliRuntimeEnv(runtime as 'codex' | 'gemini', readEnvFile([
+        'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
+      ]));
```

Why this addresses it:

The Claude path already recognized that model-controlled subprocesses can read their environment. This extends the same boundary to Codex/Gemini while preserving only the provider auth needed by the chosen CLI. It also removes unrelated Claude, dashboard, database, Slack, GitHub, and payment secrets from CLI tool execution.

Add tests by mocking `runNonClaudeRuntime`, setting `process.env.DASHBOARD_TOKEN`, `DB_ENCRYPTION_KEY`, and provider auth vars, then asserting the captured `env` contains only the selected runtime auth keys.

## Medium - Do not fallback from an explicit mixed TTS provider

Proposed patch:

```diff
diff --git a/warroom/server.py b/warroom/server.py
@@
         def _provider_ready(self, provider: str) -> bool:
@@
             if provider == "groq":
                 return bool(os.environ.get("GROQ_API_KEY"))
             return False
+
+        def _provider_missing_reason(self, provider: str) -> str:
+            if provider == "xai":
+                return "XAI_API_KEY is not configured"
+            if provider == "elevenlabs":
+                return "ELEVENLABS_API_KEY and an ElevenLabs voice id are required"
+            if provider == "voxtral":
+                return "MISTRAL_API_KEY is not configured"
+            if provider == "groq":
+                return "GROQ_API_KEY is not configured"
+            return f"unsupported mixed TTS provider: {provider or '(empty)'}"

-        def _select_provider(self) -> str:
+        def _select_provider(self) -> tuple[str, str | None]:
+            explicit = _normalize_provider(self._provider)
+            if explicit:
+                if self._provider_ready(explicit):
+                    return explicit, None
+                return "", self._provider_missing_reason(explicit)
+
             candidates = [
-                self._provider,
                 _normalize_provider(os.environ.get("WARROOM_MIXED_DEFAULT_PROVIDER", "")),
                 "xai",
                 "elevenlabs",
@@
                 if provider in seen:
                     continue
                 seen.add(provider)
                 if self._provider_ready(provider):
-                    return provider
-            return ""
+                    return provider, None
+            return "", "no mixed TTS provider is available"

         async def run_tts(self, text: str, context_id: str):
-            provider = self._select_provider()
+            provider, unavailable_reason = self._select_provider()
             if not provider:
                 yield ErrorFrame(
                     error=(
-                        "Mixed War Room TTS has no available provider. Configure XAI_API_KEY, "
-                        "or ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID, or MISTRAL_API_KEY, "
-                        "or GROQ_API_KEY."
+                        f"Mixed War Room TTS provider unavailable: {unavailable_reason}. "
+                        "Fix the selected per-agent provider or clear audio_provider for automatic fallback."
                     )
                 )
                 return

-            preferred = self._provider or "auto"
-            if self._provider and provider != self._provider:
-                logger.warning("mixed TTS provider %s unavailable, falling back to %s", preferred, provider)
```

Why this addresses it:

An explicit per-agent provider becomes a hard routing decision. Speech text is no longer sent to a different vendor because of missing credentials or voice ids. Automatic fallback remains available only for agents that leave `audio_provider` empty.

## Medium - Restrict War Room port cleanup to managed processes

Proposed patch:

```diff
diff --git a/src/platform.ts b/src/platform.ts
@@
 export function findListeningPidsByPort(port: number): number[] {
@@
 }
+
+export function getProcessCommandLine(pid: number): string | null {
+  if (!Number.isInteger(pid) || pid <= 0) return null;
+  try {
+    if (IS_WINDOWS) {
+      const out = execSync(
+        `wmic process where ProcessId=${pid} get CommandLine /value`,
+        { stdio: 'pipe', encoding: 'utf-8' },
+      );
+      return out.split(/\r?\n/).find((line) => line.startsWith('CommandLine='))?.slice('CommandLine='.length) || null;
+    }
+    return execSync('ps -p ' + pid + ' -o command=', {
+      stdio: 'pipe',
+      encoding: 'utf-8',
+    }).trim() || null;
+  } catch {
+    return null;
+  }
+}
+
+export function isWarRoomServerPid(pid: number): boolean {
+  const cmd = getProcessCommandLine(pid);
+  return !!cmd && cmd.includes('warroom/server.py');
+}
diff --git a/src/index.ts b/src/index.ts
@@
-import { findListeningPidsByPort, getVenvPython, killProcess } from './platform.js';
+import { findListeningPidsByPort, getVenvPython, isWarRoomServerPid, killProcess } from './platform.js';
@@
         const clearWarroomPort = (): void => {
-          const pids = findListeningPidsByPort(WARROOM_PORT)
-            .filter((pid) => pid !== currentProc?.pid);
+          const listeners = findListeningPidsByPort(WARROOM_PORT)
+            .filter((pid) => pid !== currentProc?.pid);
+          const pids = listeners.filter(isWarRoomServerPid);
+          const conflicts = listeners.filter((pid) => !isWarRoomServerPid(pid));
+          if (conflicts.length > 0) {
+            logger.error({ conflicts, port: WARROOM_PORT }, 'War Room port is occupied by an unmanaged process; refusing to kill it');
+          }
           if (pids.length === 0) return;
diff --git a/src/dashboard.ts b/src/dashboard.ts
@@
-import { killProcess, isProcessAlive, findListeningPidsByPort, findProcessesByPattern } from './platform.js';
+import { killProcess, isProcessAlive, findListeningPidsByPort, findProcessesByPattern, isWarRoomServerPid } from './platform.js';
@@
-      const portPids = findListeningPidsByPort(WARROOM_PORT);
+      const portPids = findListeningPidsByPort(WARROOM_PORT).filter(isWarRoomServerPid);
```

Why this addresses it:

The cleanup still removes orphaned War Room servers, but it stops terminating arbitrary listeners that merely happen to use the same port. Unmanaged conflicts become diagnosable instead of destructive.

## Medium - Honor sub-agent model config for non-Claude text runtimes

Proposed patch:

```diff
diff --git a/src/agent.ts b/src/agent.ts
@@
   } else {
     try {
       const cfg = loadAgentConfig(AGENT_ID);
       resolvedRuntime = cfg.runtime ?? 'claude';
+      if (cfg.model && !resolvedModel) resolvedModel = cfg.model;
     } catch (err) {
       logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'No per-agent config; using Claude default');
     }
   }

   if (resolvedRuntime !== 'claude') {
+    if (resolvedModel) {
+      const expectedRuntime = resolvedModel.startsWith('gpt-')
+        ? 'codex'
+        : resolvedModel.startsWith('gemini-')
+          ? 'gemini'
+          : 'claude';
+      if (expectedRuntime !== resolvedRuntime) {
+        return {
+          text: `[runtime config error: model ${resolvedModel} is not compatible with ${resolvedRuntime}]`,
+          usage: null,
+        };
+      }
+    }
     const cliEnv = readEnvFile([
```

Why this addresses it:

The normal text path now matches the voice bridge behavior: `agent.yaml` model settings actually reach Codex/Gemini as `--model`. The compatibility guard prevents sending a Gemini model to Codex CLI or a GPT model to Gemini CLI.
