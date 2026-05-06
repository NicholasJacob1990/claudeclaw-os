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
