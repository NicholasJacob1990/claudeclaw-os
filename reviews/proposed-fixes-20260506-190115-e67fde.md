# Claudex Multi-Round Proposed Fixes — 20260506-190115-e67fde

**Rounds completed:** 3 of 3

---

# Round 1

## High - Constrain Voxtral reference audio to a safe directory

Proposed patch:

```diff
diff --git a/src/dashboard.ts b/src/dashboard.ts
@@
   const WARROOM_VOICES_PATH = path.join(PROJECT_ROOT, 'warroom', 'voices.json');
+  const WARROOM_REF_AUDIO_ROOT = path.resolve(
+    process.env.WARROOM_REF_AUDIO_ROOT || path.join(PROJECT_ROOT, 'warroom', 'ref-audio'),
+  );
+  const WARROOM_REF_AUDIO_EXTS = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.flac']);
+  const WARROOM_REF_AUDIO_MAX_BYTES = 25 * 1024 * 1024;
+
+  function validateRefAudioPath(raw: string): string {
+    const value = raw.trim();
+    if (!value) return '';
+    const resolved = path.resolve(value);
+    const real = fs.realpathSync(resolved);
+    const root = WARROOM_REF_AUDIO_ROOT;
+    if (real !== root && !real.startsWith(root + path.sep)) {
+      throw new Error(`voxtral_ref_audio_path must be under ${root}`);
+    }
+    const ext = path.extname(real).toLowerCase();
+    if (!WARROOM_REF_AUDIO_EXTS.has(ext)) {
+      throw new Error('voxtral_ref_audio_path must be an audio file (.wav, .mp3, .m4a, .ogg, .flac)');
+    }
+    const lstat = fs.lstatSync(resolved);
+    if (lstat.isSymbolicLink()) throw new Error('voxtral_ref_audio_path must not be a symlink');
+    const st = fs.statSync(real);
+    if (!st.isFile()) throw new Error('voxtral_ref_audio_path must point to a file');
+    if (st.size > WARROOM_REF_AUDIO_MAX_BYTES) {
+      throw new Error('voxtral_ref_audio_path exceeds 25MB');
+    }
+    return real;
+  }
@@
     const configured = readVoicesFile();
+    const validAgents = new Set(['main', ...listAgentIds().filter((id) => id !== 'main')]);
     const errors: string[] = [];
     for (const u of updates) {
       if (!u.agent || typeof u.agent !== 'string') {
         errors.push('each update must have an agent id');
         continue;
       }
+      if (!validAgents.has(u.agent)) {
+        errors.push(`${u.agent}: unknown agent`);
+        continue;
+      }
@@
       if (u.voxtral_ref_audio_path !== undefined) {
         if (typeof u.voxtral_ref_audio_path !== 'string') {
           errors.push(`${u.agent}: voxtral_ref_audio_path must be a string`);
           continue;
         }
-        entry.voxtral_ref_audio_path = u.voxtral_ref_audio_path.trim();
+        try {
+          entry.voxtral_ref_audio_path = validateRefAudioPath(u.voxtral_ref_audio_path);
+        } catch (err) {
+          errors.push(`${u.agent}: ${err instanceof Error ? err.message : String(err)}`);
+          continue;
+        }
       }
diff --git a/warroom/server.py b/warroom/server.py
@@
 VALID_AGENTS = _load_agent_roster()
+REF_AUDIO_ROOT = Path(os.environ.get("WARROOM_REF_AUDIO_ROOT", PROJECT_ROOT / "warroom" / "ref-audio")).resolve()
+REF_AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".ogg", ".flac"}
+REF_AUDIO_MAX_BYTES = 25 * 1024 * 1024
+
+def _safe_ref_audio_b64(path: str) -> str:
+    if not path:
+        return ""
+    try:
+        import base64
+        resolved = Path(path).expanduser().resolve(strict=True)
+        if resolved != REF_AUDIO_ROOT and REF_AUDIO_ROOT not in resolved.parents:
+            logger.warning("Rejected voxtral ref_audio outside safe root: %s", resolved)
+            return ""
+        if resolved.suffix.lower() not in REF_AUDIO_EXTS:
+            logger.warning("Rejected voxtral ref_audio with invalid extension: %s", resolved)
+            return ""
+        st = resolved.stat()
+        if not resolved.is_file() or st.st_size > REF_AUDIO_MAX_BYTES:
+            logger.warning("Rejected voxtral ref_audio invalid file/size: %s", resolved)
+            return ""
+        return base64.b64encode(resolved.read_bytes()).decode()
+    except OSError as exc:
+        logger.warning("Could not read voxtral ref_audio %s: %s", path, exc)
+        return ""
@@
-    def _read_ref_audio(path: str) -> str:
-        if not path:
-            return ""
-        try:
-            import base64
-            with open(path, "rb") as f:
-                return base64.b64encode(f.read()).decode()
-        except OSError as exc:
-            logger.warning("Could not read voxtral ref_audio %s: %s", path, exc)
-            return ""
-
@@
-                ref_audio = _read_ref_audio(ref_audio_path)
+                ref_audio = _safe_ref_audio_b64(ref_audio_path)
```

Why this addresses it:

The dashboard stops persisting arbitrary paths and rejects unknown agent keys. The Python server also enforces the same boundary before reading and uploading bytes, so hand-edited `voices.json` cannot bypass the HTTP validation.

## Medium - Make main runtime overrides compatible with existing model overrides

Proposed patch:

```diff
diff --git a/src/bot.ts b/src/bot.ts
@@
-export function setMainRuntimeOverride(runtime: 'claude' | 'codex' | 'gemini'): void {
-  if (ALLOWED_CHAT_ID) chatRuntimeOverride.set(ALLOWED_CHAT_ID, runtime);
+export function setMainRuntimeOverride(runtime: 'claude' | 'codex' | 'gemini'): { ok: boolean; clearedModel?: string } {
+  if (!ALLOWED_CHAT_ID) return { ok: false };
+  chatRuntimeOverride.set(ALLOWED_CHAT_ID, runtime);
+  const currentModel = chatModelOverride.get(ALLOWED_CHAT_ID);
+  if (currentModel && inferRuntimeFromModel(currentModel) !== runtime) {
+    chatModelOverride.delete(ALLOWED_CHAT_ID);
+    return { ok: true, clearedModel: currentModel };
+  }
+  return { ok: true };
 }
diff --git a/src/dashboard.ts b/src/dashboard.ts
@@
         }
         const { setMainRuntimeOverride } = await import('./bot.js');
-        setMainRuntimeOverride(runtime);
-        return c.json({ ok: true, agent: agentId, runtime, restartRequired: false });
+        const result = setMainRuntimeOverride(runtime);
+        if (!result.ok) {
+          return c.json({ error: 'Cannot set main runtime without ALLOWED_CHAT_ID configured' }, 400);
+        }
+        return c.json({
+          ok: true,
+          agent: agentId,
+          runtime,
+          restartRequired: false,
+          clearedModel: result.clearedModel,
+        });
       }
```

Why this addresses it:

The API no longer reports success when the state cannot be stored. Clearing incompatible model overrides prevents `agent.ts` from forwarding a `gpt-*` model to Gemini CLI or a `gemini-*` model to Codex CLI on the next turn.

## Medium - Add provider dependency contract and readiness checks

Proposed patch:

```diff
diff --git a/warroom/requirements.txt b/warroom/requirements.txt
-pipecat-ai[websocket,deepgram,cartesia,silero]==0.0.108
+pipecat-ai[websocket,deepgram,cartesia,silero,groq,elevenlabs,xai]==0.0.108
 python-dotenv>=1.0.0
+aiohttp>=3.9
+groq>=0.13
+mistralai>=2.4
diff --git a/warroom/server.py b/warroom/server.py
@@
 def read_provider_pin() -> str | None:
@@
     return provider
+
+def validate_provider_dependencies(provider: str) -> None:
+    if provider in {"groq", "elevenlabs", "mixed"}:
+        from pipecat.services.groq.stt import GroqSTTService  # noqa: F401
+    if provider == "groq":
+        from pipecat.services.groq.tts import GroqTTSService  # noqa: F401
+    if provider == "elevenlabs":
+        from pipecat.services.elevenlabs.tts import ElevenLabsTTSService  # noqa: F401
+    if provider == "xai":
+        from pipecat.services.xai.realtime.llm import GrokRealtimeLLMService  # noqa: F401
+    if provider in {"voxtral", "mixed"}:
+        from mistralai.client import Mistral  # noqa: F401
+    if provider == "mixed":
+        import aiohttp  # noqa: F401
+        from groq import AsyncGroq  # noqa: F401
@@
 async def run_warroom():
     load_env()
     # Provider pin from dashboard takes precedence over WARROOM_MODE env.
     pinned_provider = read_provider_pin()
+    if pinned_provider:
+        try:
+            validate_provider_dependencies(pinned_provider)
+        except ImportError as exc:
+            raise RuntimeError(
+                f"War Room provider {pinned_provider!r} is missing Python dependencies. "
+                "Run `warroom/.venv/bin/pip install -r warroom/requirements.txt`."
+            ) from exc
```

Why this addresses it:

The requirements file now matches the provider surface exposed by the dashboard, and startup fails with a deterministic dependency error before the pipeline gets halfway through a provider-specific import path. For an even better UX, mirror `validate_provider_dependencies` in the dashboard before writing `/tmp/warroom-provider.json`.

---

# Round 2

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

---

# Round 3

## Medium - Model/runtime override plumbing is still inconsistent across dashboard main and SDK runtimes

Proposed patch:

```diff
diff --git a/src/agent-runtimes.ts b/src/agent-runtimes.ts
@@
 export interface RuntimeRunInput {
   message: string;
   cwd: string;
   env: NodeJS.ProcessEnv;
+  model?: string;
   abortController?: AbortController;
   onStreamText?: (accumulatedText: string) => void;
   /** Per-agent CLI overrides (model alias, profile, etc). Optional. */
   cliFlags?: string[];
 }
@@
-  const model = input.env.OPENAI_DEFAULT_MODEL || 'gpt-5.5';
+  const model = input.model || input.env.OPENAI_DEFAULT_MODEL || 'gpt-5.5';
@@
-  const model = input.env.GEMINI_DEFAULT_MODEL || 'gemini-3.1-pro-preview';
+  const model = input.model || input.env.GEMINI_DEFAULT_MODEL || 'gemini-3.1-pro-preview';
diff --git a/src/agent.ts b/src/agent.ts
@@
   } else {
     try {
       const cfg = loadAgentConfig(AGENT_ID);
       resolvedRuntime = cfg.runtime ?? 'claude';
+      if (!resolvedModel) resolvedModel = cfg.model;
     } catch (err) {
       logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'No per-agent config; using Claude default');
     }
   }
 
   if (resolvedRuntime !== 'claude') {
+    if (resolvedModel && !isRuntimeModelCompatible(resolvedRuntime, resolvedModel)) {
+      return {
+        text: `[runtime config error: model ${resolvedModel} is not compatible with runtime ${resolvedRuntime}]`,
+        usage: null,
+        aborted: false,
+      };
+    }
@@
     const cliFlags: string[] = [];
-    if (resolvedModel) cliFlags.push('--model', resolvedModel);
+    if (resolvedModel && (resolvedRuntime === 'codex' || resolvedRuntime === 'gemini')) {
+      cliFlags.push('--model', resolvedModel);
+    }
@@
       env: cliSdkEnv,
+      model: resolvedModel,
       abortController,
       onStreamText,
       cliFlags,
     });
   }
```

Add a small helper near the runtime branch:

```ts
function isRuntimeModelCompatible(runtime: 'codex' | 'gemini' | 'openai-sdk' | 'gemini-sdk', model: string): boolean {
  if (runtime === 'codex' || runtime === 'openai-sdk') return model.startsWith('gpt-');
  if (runtime === 'gemini' || runtime === 'gemini-sdk') return model.startsWith('gemini-');
  return true;
}
```

Patch dashboard-message model selection in `src/bot.ts`:

```diff
@@
     const result = await runAgent(
       fullMessage,
       sessionId,
       () => {}, // no typing action for dashboard
       onProgress,
-      agentDefaultModel,
+      chatModelOverride.get(chatIdStr) ?? agentDefaultModel,
       abortCtrl,
       undefined, // no streaming for dashboard
       agentMcpAllowlist,
     );
```

Patch the voice bridge similarly:

```diff
diff --git a/src/agent-voice-bridge.ts b/src/agent-voice-bridge.ts
@@
       const cliFlags: string[] = [];
-      if (model) cliFlags.push('--model', model);
+      if (model && (runtime === 'codex' || runtime === 'gemini')) cliFlags.push('--model', model);
@@
         cwd: agentDir,
         env: cliEnv,
+        model,
         cliFlags,
       });
```

Why this fixes it: model becomes an explicit part of the runtime contract rather than a CLI-only side channel. Dashboard main messages now honor the same per-chat override that `/model` and the dashboard model endpoint store, sub-agent configs are read for text runtime, SDK runtimes receive the selected model directly, and incompatible model/runtime combinations fail before a subprocess or SDK call starts.

## Medium - Team/single voice modes are accepted for audio stacks that ignore them

Minimum defensive patch:

```diff
diff --git a/src/dashboard.ts b/src/dashboard.ts
@@
   const VALID_PIN_MODES = new Set(['direct', 'auto', 'router', 'single', 'broadcast', 'debate', 'ensemble', 'consensus']);
+  const GEMINI_LIVE_PROVIDERS = new Set(['gemini-live', 'gemini-live-25']);
+  const GEMINI_ONLY_PIN_MODES = new Set(['auto', 'router', 'single', 'broadcast', 'debate', 'ensemble', 'consensus']);
@@
     if (!VALID_PIN_MODES.has(nextMode)) {
       return c.json({ ok: false, error: 'invalid mode; must be one of direct, auto, router, single, broadcast, debate, ensemble, consensus' }, 400);
     }
+    const pinnedProvider = readProviderState().provider ?? 'gemini-live';
+    if (GEMINI_ONLY_PIN_MODES.has(nextMode) && !GEMINI_LIVE_PROVIDERS.has(pinnedProvider)) {
+      return c.json({
+        ok: false,
+        error: `${nextMode} mode requires Gemini Live. Current audio provider is ${pinnedProvider}; switch provider to gemini-live or use direct mode.`,
+      }, 400);
+    }
```

Optional UI hardening in `web/src/pages/WarRoom.tsx`:

```diff
@@
 const VOICE_MODES: Array<{ value: VoiceRoutingMode; label: string; hint: string }> = [
@@
 ];
+const GEMINI_ONLY_VOICE_MODES = new Set<VoiceRoutingMode>(['auto', 'router', 'single', 'broadcast', 'debate', 'ensemble', 'consensus']);
```

Then load `/api/warroom/provider` in `VoicePane` and disable mode buttons when the selected provider is not `gemini-live` / `gemini-live-25`.

Why this fixes it: until the stitched STT/TTS stacks implement mode-aware routing, the backend stops accepting state it cannot honor. That makes the UI contract honest and prevents “Consensus”, “Debate”, and similar modes from silently running as a single pinned-agent turn under `mixed`, `groq`, `elevenlabs`, `voxtral`, or `cartesia`.

