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
