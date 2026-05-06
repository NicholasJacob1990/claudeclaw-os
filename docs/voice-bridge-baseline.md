# Voice Bridge Baseline — Phase 0

**Date:** 2026-05-06
**Methodology:** Wall-clock time of `agent-voice-bridge.js` invocations (subprocess) and an in-process equivalent that imports `@anthropic-ai/claude-agent-sdk` directly.

## Cold subprocess baseline (current production path)

3 sequential cold spawns of `node dist/agent-voice-bridge.js --quick --agent X --message ...`

| agent | runtime | cold1 | cold2 | cold3 | mean |
|---|---|---|---|---|---|
| main | claude SDK | 55367ms | 52322ms | 52308ms | **~53s** |
| advogado | codex CLI | 14801ms | 12785ms | 14783ms | **~14s** |
| pesquisador | gemini CLI | 20310ms | 17775ms | 16760ms | **~18s** |

**Note:** OS page cache + dyld cache provide negligible savings between cold spawns. Each cold pays the full cost.

## Claude SDK isolated — in-process warm

Same Node process, 3 sequential `query()` calls. Tests two configurations:

### A) `settingSources: []`, no MCPs (minimal voice mode)

| turn | ttft | total |
|---|---|---|
| 1 | 3508ms | **7151ms** |
| 2 | 3024ms | **7274ms** |
| 3 | 3309ms | **6639ms** |

`importMs: 43`

### B) `settingSources: ['project', 'user']`, no MCPs (matches current voice bridge)

| turn | ttft | total |
|---|---|---|
| 1 | 42145ms | **46544ms** |
| 2 | 41113ms | **45039ms** |
| 3 | 40622ms | **45062ms** |

`importMs: 48`

## Findings

### F1 — Cold start is dominated by Claude Code subprocess settings load

Difference between cold subprocess (53s) and in-process warm WITH skills/MCP (46s) is only **7s** — that 7s is Node startup + `initDatabase()` + `buildMemoryContext()` + SDK imports. The remaining **~45s is the Claude Code subprocess loading project/user `settingSources`** (CLAUDE.md, permissions, skill metadata, MCP discovery).

### F2 — Claude SDK re-spawns Claude Code on EVERY `query()` call

`@anthropic-ai/claude-agent-sdk/sdk.mjs` calls `spawnLocalProcess` per query. There is no persistent SDK session that keeps the Claude Code subprocess alive between queries. **An in-process Node "pool" therefore CANNOT eliminate the 45s skills/MCP load** — it would re-pay it on each turn.

### F3 — Disabling settingSources cuts latency 7×

Same SDK, same query, but with `settingSources: []`: turn time drops from 45s to 7s. **Voice mode does not need project skills loaded.** The voice bridge already has a `quickMode` flag that is the natural place to disable them.

### F4 — Codex CLI is much cheaper than Claude SDK voice bridge

Codex CLI (14s) is ~3.7× faster than Claude SDK with skills (53s) and only ~2× the SDK without skills (7s). Gemini CLI (18s) sits between.

### F5 — Gemini Live (current War Room provider) is irrelevant to this baseline

War Room currently uses the Gemini Live e2e WebSocket provider, NOT `agent-voice-bridge.js`. The voice bridge is only invoked for `_call_voice_agent` calls in team modes (broadcast/debate/router). So the 53s pain only shows up in those modes.

## Recommendations (revised plan)

### Phase 0.5 (NEW, was not in v2 plan) — Voice-mode minimal settings

**Effort:** ~1 hour. **Win:** 53s → 7s for Claude SDK voice turns.

In `src/agent-voice-bridge.ts`, when `quickMode` is true:

```ts
options: {
  ...,
  settingSources: quickMode ? [] : ['project', 'user'],
  ...(quickMode ? {} : (mcpServerNames.length > 0 ? { mcpServers } : {})),
}
```

Optional: also pass an env var override `VOICE_BRIDGE_MINIMAL_SETTINGS=1` so War Room can opt in independently of `quickMode`.

This single change closes most of the latency gap without ANY pool, ANY refactor, ANY new file. **It should ship before Phase 1.**

### Phase 1 (unchanged) — Parallelize team modes

Even with Phase 0.5, broadcast/ensemble/consensus still run sequentially in `warroom/server.py:_run_team_round`. Parallelizing turns 3 sequential 7-15s calls into one 15s call (dominated by slowest agent).

**Effort:** ~4-6 hours.

### Phase 2 (DOWNGRADED) — Pool deferred

ROI for a process pool is now **~9s saved per turn** (Node startup + import). With Phase 0.5 already at 7s/turn, the marginal benefit isn't worth the engineering cost (~1 day) and operational complexity (worker lifecycle, fallback, hot reload).

**Recommendation:** ship Phase 0.5 + Phase 1, measure user-perceived latency in real War Room sessions, only revisit pool if it still feels slow.

### Phase 4 (UPGRADED) — `openai-sdk` / `gemini-sdk` in-process for advogado/pesquisador

Codex CLI (14s) and Gemini CLI (18s) cold are inherent to the CLI binaries. To make non-Claude voice realtime, the path is `runtime: openai-sdk` and `runtime: gemini-sdk` (in-process REST, ~3-5s/turn). This is now the **highest-value remaining work** for sub-agent voice latency.

**Trade-off:** loses ChatGPT/Google login auth (needs API keys), loses CLI skills, but gains realtime latency.

## Updated roadmap

| Phase | Effort | Win | Status |
|---|---|---|---|
| 0 | done | baseline | ✅ done |
| 0.5 | 1h | 53s → **13s** measured cold (4× speedup) | ✅ **shipped** |
| 1 | 4-6h | broadcast/ensemble/consensus parallel; max(per_agent) instead of sum | ✅ **shipped** |
| 2 | 1d | ~6s residual savings | **DEFERRED** (low ROI) |
| 3 | 0.5d | hot reload | optional |
| 4 | 1-2d | codex/gemini realtime via SDK | high value, requires API keys |

## Phase 1 — Parallelize team modes (post-patch)

Patch in `warroom/server.py:answer_team_handler`. The three independent-answer modes now run with `asyncio.gather`:

```python
PARALLEL_MODES = {"broadcast", "ensemble", "consensus"}
if active_mode in PARALLEL_MODES:
    raw_results = await asyncio.gather(
        *[_run_one(agent, []) for agent in participants],
    )
    responses.extend(raw_results)
else:  # debate
    for agent in participants:
        responses.append(await _run_one(agent, responses))
```

`_run_one` wraps each agent call in its own try/except so a single failure (timeout, exit code) does not abort the parallel turn — the user gets partial results plus per-agent error events for the missing ones.

**Predicted wall-clock for 3-agent broadcast** (main+advogado+pesquisador):

| | Sequential (pre-Phase-1) | Parallel (post-Phase-1) |
|---|---|---|
| With pre-Phase-0.5 cold (53s+14s+18s) | ~85s (always timeout @ 45s) | max ≈ 53s (still timeout) |
| With Phase-0.5 voice-mode (13s+14s+18s) | ~45s | **max ≈ 18s** ✅ |

`debate` stays sequential by design — each contribution depends on prior — so a 3-round 3-agent debate is still ~3 × 3 × 18s = ~160s. That's the next target if needed (e.g. cap rounds, only let main + 1 specialist debate, etc.).

## Phase 0.5 measured result (post-patch)

After applying `settingSources: []` + skipping MCPs in `quickMode`:

| agent | runtime | turn1 | turn2 | turn3 | mean |
|---|---|---|---|---|---|
| main (post-Phase-0.5) | claude SDK | 15344ms | 13294ms | 13288ms | **~13s** |
| advogado (no change) | codex CLI | 14801ms | 12785ms | 14783ms | ~14s |
| pesquisador (no change) | gemini CLI | 20310ms | 17775ms | 16760ms | ~18s |

Main is now in line with the codex CLI baseline (both ~13-14s cold). The 6s residual gap vs the in-process warm number (7s) is Node startup + DB init + memory context that a future pool (Phase 2) would eliminate — but that's only worth ~6s saved per turn, hence deferred.

Patch: `src/agent-voice-bridge.ts` — `quickMode || VOICE_BRIDGE_MINIMAL_SETTINGS=1` env override now disables `settingSources` and MCPs.

## Repro

```bash
# Cold subprocess baseline (3 spawns per agent)
bash /tmp/bench-cold.sh main cold1
bash /tmp/bench-cold.sh main cold2
bash /tmp/bench-cold.sh main cold3
# (repeat for advogado, pesquisador)

# In-process warm (Claude SDK)
node bench-warm.mjs                    # without skills (settingSources: [])
BENCH_HEAVY=1 node bench-warm.mjs      # with skills (matches current)
```

Source files: `bench-warm.mjs` (project root, can be deleted after baseline), `/tmp/bench-cold.sh`.
