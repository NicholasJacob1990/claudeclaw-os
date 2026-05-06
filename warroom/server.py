"""
War Room Voice Server for ClaudeClaw.

Two modes, selected by the WARROOM_MODE environment variable:

  live   (default)   Gemini Live native-audio model + tool-calling.
                     WebSocket → user aggregator → Gemini Live → assistant aggregator → WebSocket.
                     Gemini handles speech-to-speech in real time. For execution work, it
                     calls tools that hand off to sub-agents via mission-cli (async) or run
                     inline (synchronous, fast answers like "what time is it").

  legacy             The original stitched STT → router → Claude-bridge → TTS chain.
                     Higher latency, but every utterance goes through the full Claude Code
                     stack with skills/MCP. Kept around so you can toggle back without
                     reverting the file.

Usage:
    python warroom/server.py

Environment variables:
    WARROOM_MODE         "live" (default) or "legacy"
    WARROOM_PORT         port to listen on (default: 7860)
    WARROOM_LIVE_MODEL   Gemini Live model id (default: whatever Pipecat ships)
    WARROOM_LIVE_VOICE   Gemini Live voice name (default: "Charon")

    GOOGLE_API_KEY       required for live mode
    DEEPGRAM_API_KEY     required for legacy mode
    CARTESIA_API_KEY     required for legacy mode
"""

import sys

# Check Python version early so the user gets a clear error instead of
# cryptic import failures deep in pipecat.
if sys.version_info < (3, 10):
    print(
        f"Error: Python 3.10+ required, but you have {sys.version}.\n"
        "Install a newer Python: https://www.python.org/downloads/\n"
        "Then recreate the venv: python3 -m venv warroom/.venv",
        file=sys.stderr,
    )
    sys.exit(1)

import asyncio
import datetime
import json
import logging
import os
import shutil
import signal
import subprocess
from pathlib import Path

# Ensure the warroom package is importable when run as a script
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Resolve project root for error messages
_PROJECT_DIR = str(Path(__file__).resolve().parent.parent)

# Check for required dependencies before importing them.
# If pip install failed in setup, the venv won't have pipecat-ai.
try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    print(
        "Error: python-dotenv not found in the War Room venv.\n"
        "The Python dependencies were not installed successfully.\n"
        "\n"
        "To fix this, run:\n"
        f"  cd {_PROJECT_DIR}\n"
        "  python3 -m venv warroom/.venv\n"
        "  source warroom/.venv/bin/activate\n"
        "  pip install -r warroom/requirements.txt\n",
        file=sys.stderr,
    )
    sys.exit(1)

try:
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineTask, PipelineParams
    from pipecat.transports.network.websocket_server import WebsocketServerTransport, WebsocketServerParams
    from pipecat.serializers.protobuf import ProtobufFrameSerializer
except ModuleNotFoundError as e:
    print(
        f"Error: pipecat-ai dependency not found: {e}\n"
        "The Python dependencies were not installed successfully.\n"
        "\n"
        "To fix this, run:\n"
        f"  cd {_PROJECT_DIR}\n"
        "  source warroom/.venv/bin/activate\n"
        "  pip install -r warroom/requirements.txt\n",
        file=sys.stderr,
    )
    sys.exit(1)

from config import PROJECT_ROOT, AGENT_VOICES, DEFAULT_AGENT


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("warroom.server")


# ─── Shared helpers ────────────────────────────────────────────────────────

def load_env():
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        load_dotenv(env_path)
        logger.info("Loaded env from %s", env_path)
    else:
        logger.warning("No .env found at %s, relying on shell environment", env_path)
    refresh_runtime_config_from_env()


def check_required_keys(required: dict):
    missing = []
    for key, description in required.items():
        if not os.environ.get(key):
            missing.append(f"  {key} - {description}")
    if missing:
        print("Missing required API keys:", file=sys.stderr)
        for line in missing:
            print(line, file=sys.stderr)
        print("\nSet these in your project .env or export them in your shell.", file=sys.stderr)
        sys.exit(1)


def make_transport(port: int, audio_in_sr: int = 16000, audio_out_sr: int = 24000) -> WebsocketServerTransport:
    # Input defaults to 16 kHz because that's what the bundled
    # @pipecat-ai/client-js ships audio at for server-side VAD/STT pipelines,
    # AND Gemini Live's native-audio endpoint locks to whatever rate arrives
    # first ("Sample rate changed from previously X to Y, which is not
    # supported"). Output stays at 24 kHz — Gemini Live emits 24 kHz audio
    # and Pipecat passes it through unchanged.
    return WebsocketServerTransport(
        host="0.0.0.0",
        port=port,
        params=WebsocketServerParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=audio_in_sr,
            audio_out_sample_rate=audio_out_sr,
            vad_analyzer=None,
            serializer=ProtobufFrameSerializer(),
        ),
    )


def print_ready(port: int, mode: str):
    connection_info = {
        "ws_url": f"ws://localhost:{port}",
        "status": "ready",
        "transport": "websocket",
        "mode": mode,
    }
    print(json.dumps(connection_info), flush=True)


# ─── Tool handlers (live mode) ─────────────────────────────────────────────

# Paths to the Node-side CLIs. The voice bridge already deals with path
# traversal / argument validation, so the Python tool handlers stay thin
# and only pass validated arguments through. NODE_BIN resolves via PATH
# (honouring NODE_BIN env override) so this works across Apple Silicon
# Homebrew, Intel Homebrew, nvm/volta, and Linux installs, rather than
# dying with FileNotFoundError when Node isn't at /opt/homebrew/bin/node.
NODE_BIN = os.environ.get("NODE_BIN") or shutil.which("node") or "node"
MISSION_CLI = PROJECT_ROOT / "dist" / "mission-cli.js"
VOICE_BRIDGE = PROJECT_ROOT / "dist" / "agent-voice-bridge.js"
# Load agent roster dynamically from the file Node writes on startup.
# Falls back to the default 5 if the file doesn't exist.
def _load_agent_roster():
    roster_path = Path("/tmp/warroom-agents.json")
    try:
        if roster_path.exists():
            agents = json.loads(roster_path.read_text())
            return {a["id"] for a in agents}
    except Exception as exc:
        logger.warning("Could not read agent roster from %s: %s", roster_path, exc)
    return {"main", "research", "comms", "content", "ops"}

VALID_AGENTS = _load_agent_roster()


def _load_agent_roster_entries() -> list[dict]:
    """Return the dynamic roster entries in UI order."""
    roster_path = Path("/tmp/warroom-agents.json")
    try:
        if roster_path.exists():
            agents = json.loads(roster_path.read_text())
            if isinstance(agents, list):
                entries = []
                for a in agents:
                    if not isinstance(a, dict):
                        continue
                    aid = a.get("id")
                    if isinstance(aid, str) and aid in VALID_AGENTS:
                        entries.append({
                            "id": aid,
                            "name": a.get("name") if isinstance(a.get("name"), str) else aid.title(),
                            "description": a.get("description") if isinstance(a.get("description"), str) else "",
                        })
                if entries:
                    return entries
    except Exception as exc:
        logger.warning("Could not read agent roster entries: %s", exc)
    return [
        {"id": "main", "name": "Main", "description": "General ops and triage"},
        {"id": "research", "name": "Research", "description": "Web research and analysis"},
        {"id": "comms", "name": "Comms", "description": "Messaging and external communications"},
        {"id": "content", "name": "Content", "description": "Writing and content production"},
        {"id": "ops", "name": "Ops", "description": "Scheduling, systems, and automations"},
    ]


def _agent_label(agent_id: str) -> str:
    for entry in _load_agent_roster_entries():
        if entry["id"] == agent_id:
            return entry.get("name") or agent_id.title()
    return agent_id.title()


def _voice_entry(agent_id: str) -> dict:
    entry = AGENT_VOICES.get(agent_id)
    if isinstance(entry, dict):
        return entry
    return {}


def _voice_value(agent_id: str, field: str, default: str = "") -> str:
    value = _voice_entry(agent_id).get(field)
    if isinstance(value, str) and value:
        return value
    value = _voice_entry("main").get(field)
    if isinstance(value, str) and value:
        return value
    return default


def _team_participants(mode: str) -> list[str]:
    """Return agents that should produce first-pass answers for team modes."""
    ids = [entry["id"] for entry in _load_agent_roster_entries() if entry["id"] in VALID_AGENTS]
    if mode == "broadcast":
        return ids or ["main"]
    specialists = [aid for aid in ids if aid != "main"]
    return specialists or ids or ["main"]

# Chat id used for agent-voice-bridge session persistence. The warroom is
# a single shared meeting, not per-chat, so we use a fixed id unless the
# environment provides an override (e.g. for running two warroom instances
# side by side during testing).
WARROOM_CHAT_ID = os.environ.get("WARROOM_CHAT_ID", "warroom")

# Timeout for synchronous answer_as_agent invocations. Claude SDK agents
# usually return quickly, but Codex/Gemini CLI-backed agents can take longer
# on first turn. Past this ceiling we fail the tool call and let Gemini
# recover conversationally.
def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning("Invalid %s=%r; using %.1fs", name, raw, default)
        return default


ANSWER_TIMEOUT_SEC = _env_float("WARROOM_ANSWER_TIMEOUT", 45.0)
TEAM_AGENT_TIMEOUT_SEC = _env_float("WARROOM_TEAM_AGENT_TIMEOUT", ANSWER_TIMEOUT_SEC)
TOOL_TIMEOUT_GRACE_SEC = _env_float("WARROOM_TOOL_TIMEOUT_GRACE", 10.0)
TEAM_TOOL_TIMEOUT_SEC: float | None = None


def refresh_runtime_config_from_env():
    """Refresh runtime tunables after .env has been loaded."""
    global ANSWER_TIMEOUT_SEC, TEAM_AGENT_TIMEOUT_SEC, TOOL_TIMEOUT_GRACE_SEC, TEAM_TOOL_TIMEOUT_SEC
    ANSWER_TIMEOUT_SEC = _env_float("WARROOM_ANSWER_TIMEOUT", 45.0)
    TEAM_AGENT_TIMEOUT_SEC = _env_float("WARROOM_TEAM_AGENT_TIMEOUT", ANSWER_TIMEOUT_SEC)
    TOOL_TIMEOUT_GRACE_SEC = _env_float("WARROOM_TOOL_TIMEOUT_GRACE", 10.0)
    raw_team_tool_timeout = os.environ.get("WARROOM_TEAM_TOOL_TIMEOUT")
    TEAM_TOOL_TIMEOUT_SEC = None
    if raw_team_tool_timeout is not None:
        try:
            TEAM_TOOL_TIMEOUT_SEC = float(raw_team_tool_timeout)
        except ValueError:
            logger.warning("Invalid WARROOM_TEAM_TOOL_TIMEOUT=%r; using computed timeout", raw_team_tool_timeout)

ROUTER_MODES = {"auto", "router"}
SINGLE_MODES = {"single"}
TEAM_MODES = {"broadcast", "debate", "ensemble", "consensus"}


def _answer_tool_timeout() -> float:
    return ANSWER_TIMEOUT_SEC + TOOL_TIMEOUT_GRACE_SEC


def _team_tool_timeout(mode: str) -> float:
    if TEAM_TOOL_TIMEOUT_SEC is not None:
        return TEAM_TOOL_TIMEOUT_SEC
    participants = _team_participants(mode)
    call_count = len(participants)
    if mode in {"debate", "ensemble", "consensus"} and "main" in VALID_AGENTS and any(a != "main" for a in participants):
        call_count += 1
    return max(_answer_tool_timeout(), call_count * TEAM_AGENT_TIMEOUT_SEC + TOOL_TIMEOUT_GRACE_SEC)


async def _run_subprocess(cmd: list[str], timeout: float = 20.0) -> tuple[int, str, str]:
    """Run a subprocess with timeout. Returns (exit_code, stdout, stderr).

    Runs the child in its own process group via ``start_new_session`` so a
    timeout kill terminates the whole group. Without this, timing out an
    agent-voice-bridge wrapper leaves the nested Claude Code process (and
    whatever tools it spawned) running in the background and producing
    spurious work after the voice turn has already failed.
    """
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(PROJECT_ROOT),
        start_new_session=True,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        pgid = None
        try:
            pgid = os.getpgid(proc.pid)
        except (ProcessLookupError, OSError):
            pass
        if pgid is not None:
            try:
                os.killpg(pgid, signal.SIGTERM)
            except (ProcessLookupError, OSError):
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    pass
                try:
                    await proc.wait()
                except Exception:
                    pass
        else:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass
        return -1, "", "timeout"
    return proc.returncode or 0, stdout.decode(errors="replace").strip(), stderr.decode(errors="replace").strip()


def _parse_voice_bridge_payload(out: str) -> dict:
    """Parse the JSON payload printed by agent-voice-bridge.

    The bridge itself writes one JSON object, but runtime adapters can log
    progress to stdout before that final line. Read from the bottom so those
    logs don't make the War Room treat a successful agent response as
    "invalid bridge output".
    """
    for line in reversed((out or "").splitlines()):
        text = line.strip()
        if not text.startswith("{"):
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    raise json.JSONDecodeError("no JSON object in voice bridge stdout", out or "", 0)


async def _push_server_event(params, payload: dict, source: str = "warroom") -> None:
    """Best-effort server-message event for the browser transcript/agent cards."""
    from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame
    from pipecat.processors.frame_processor import FrameDirection

    try:
        await params.llm.push_frame(
            RTVIServerMessageFrame(data=payload),
            FrameDirection.DOWNSTREAM,
        )
    except Exception as exc:
        logger.warning("%s: push %s frame failed: %s", source, payload.get("event"), exc)


def _bridge_error_message(code: int, out: str, err: str) -> str:
    bridge_error = ""
    try:
        payload = _parse_voice_bridge_payload(out) if out else {}
        bridge_error = str(payload.get("error") or "")
    except json.JSONDecodeError:
        bridge_error = ""
    err_short = (bridge_error or err or f"voice bridge exited {code}")[:300]
    err_lower = (err_short + "\n" + (err or "")).lower()
    if any(s in err_lower for s in ("oauth", "401", "unauthorized", "token", "credentials")):
        return "auth failed (token expired?). Run `claude login` and restart the war room."
    return err_short


async def _call_voice_agent(
    agent: str,
    question: str,
    *,
    chat_id: str | None = None,
    timeout: float | None = None,
) -> dict:
    """Invoke one configured agent through the Node voice bridge."""
    if agent not in VALID_AGENTS:
        return {"ok": False, "agent": agent, "error": f"invalid agent: {agent}"}
    if not isinstance(question, str) or not question.strip():
        return {"ok": False, "agent": agent, "error": "question is required"}
    if not VOICE_BRIDGE.exists():
        return {
            "ok": False,
            "agent": agent,
            "error": "agent-voice-bridge not built; run `npm run build` from the project root",
        }

    cmd = [
        NODE_BIN, str(VOICE_BRIDGE),
        "--quick",
        "--agent", agent,
        "--chat-id", chat_id or WARROOM_CHAT_ID,
        "--message", question,
    ]
    code, out, err = await _run_subprocess(cmd, timeout=timeout or ANSWER_TIMEOUT_SEC)
    if code != 0:
        err_short = _bridge_error_message(code, out, err)
        logger.error("_call_voice_agent failed: agent=%s code=%d error=%s stderr=%s", agent, code, err_short, err[:200])
        return {"ok": False, "agent": agent, "error": err_short}

    try:
        payload = _parse_voice_bridge_payload(out)
    except json.JSONDecodeError:
        logger.error("_call_voice_agent: invalid JSON from bridge: %r", out[:200])
        return {"ok": False, "agent": agent, "error": "invalid bridge output"}

    response_text = payload.get("response")
    if payload.get("error") or not response_text:
        return {"ok": False, "agent": agent, "error": payload.get("error") or "empty response"}
    return {"ok": True, "agent": agent, "text": response_text, "usage": payload.get("usage")}


def _build_team_agent_prompt(mode: str, agent: str, question: str, prior: list[dict]) -> str:
    label = _agent_label(agent)
    if mode == "broadcast":
        return (
            "[War Room broadcast mode]\n"
            "Answer the user's prompt independently in 1-2 short sentences. "
            "No preamble, no lists.\n\n"
            f"User prompt: {question}"
        )
    if mode == "debate":
        previous = "\n".join(
            f"{_agent_label(r['agent'])}: {r.get('text')}"
            for r in prior
            if r.get("ok") and r.get("text")
        )
        return (
            "[War Room debate mode]\n"
            "Give a concise debate contribution in 1-2 short sentences. "
            "If prior views are present, explicitly add a useful counterpoint, caveat, or agreement. "
            "No preamble.\n\n"
            f"User topic: {question}\n\n"
            f"Prior views:\n{previous or '(none yet)'}\n\n"
            f"Your turn as {label}:"
        )
    if mode == "ensemble":
        return (
            "[War Room ensemble mode]\n"
            "Produce an independent candidate answer or approach in 1-2 short sentences. "
            "Focus on your specialty. No preamble.\n\n"
            f"User prompt: {question}"
        )
    if mode == "consensus":
        return (
            "[War Room consensus mode]\n"
            "Give your independent view in 1-2 short sentences, with the key reason. "
            "No preamble.\n\n"
            f"User prompt: {question}"
        )
    return question


def _build_team_judge_prompt(mode: str, question: str, responses: list[dict]) -> str:
    joined = "\n".join(
        f"- {_agent_label(r['agent'])}: {r.get('text') or r.get('error')}"
        for r in responses
    )
    if mode == "debate":
        task = "Synthesize the debate into a short conclusion and name the main disagreement if any."
    elif mode == "ensemble":
        task = "Select the strongest answer and combine useful parts into a concise final response."
    else:
        task = "Synthesize a concise consensus, naming any unresolved split if there is one."
    return (
        f"[War Room {mode} judge]\n"
        f"{task} Answer in 2-3 short sentences. No preamble.\n\n"
        f"User prompt: {question}\n\n"
        f"Agent responses:\n{joined}"
    )


def _format_team_response(mode: str, responses: list[dict]) -> str:
    label = {
        "broadcast": "Broadcast",
        "debate": "Debate",
        "ensemble": "Ensemble",
        "consensus": "Consensus",
    }.get(mode, mode.title())
    lines = [f"{label}:"]
    for r in responses:
        name = _agent_label(r["agent"])
        text = r.get("text") if r.get("ok") else f"[failed: {r.get('error', 'unknown error')}]"
        role = "Judge" if r.get("role") == "judge" else name
        lines.append(f"{role}: {text}")
    return "\n".join(lines)


async def delegate_to_agent_handler(params):
    """Tool: delegate a unit of work to one of the sub-agents via mission-cli.

    The sub-agent picks up the mission within ~60s via its own launchd polling
    loop and runs it through the full Claude Code stack (skills, MCP, file
    access). On completion the sub-agent fires a Telegram notification on its
    own bot token, so the user sees results in Telegram without Gemini Live
    needing to wait for execution.

    CRITICAL: we pass run_llm=False on the result so Pipecat does NOT trigger
    a follow-up Gemini inference after the tool returns. Without this flag
    Gemini generates a second audio turn about the tool result, producing the
    "Kicked it over to comms... kicked it over to comms" duplicate-speech bug.
    Gemini already verbally acknowledged the delegation in the same turn it
    called the tool, so we just let that stand.
    """
    from pipecat.frames.frames import FunctionCallResultProperties

    # Shared flag: suppress follow-up LLM turn so Gemini does not duplicate
    # the verbal acknowledgment it already gave during the same conversation
    # turn it called the tool in.
    silent = FunctionCallResultProperties(run_llm=False)

    args = params.arguments or {}
    agent = args.get("agent")
    title = args.get("title") or "voice-delegated task"
    prompt = args.get("prompt")
    priority = int(args.get("priority", 5))

    if agent not in VALID_AGENTS or not prompt:
        # Validation failures DO want a follow-up turn so Gemini can
        # verbally report the error to the user. Leave run_llm default.
        await params.result_callback({
            "ok": False,
            "error": f"invalid args: agent must be one of {sorted(VALID_AGENTS)} and prompt is required",
        })
        return

    if not MISSION_CLI.exists():
        await params.result_callback({
            "ok": False,
            "error": "mission-cli not built; run `npm run build` from the project root",
        })
        return

    cmd = [
        NODE_BIN, str(MISSION_CLI), "create",
        "--agent", agent,
        "--title", str(title),
        "--priority", str(priority),
        str(prompt),
    ]
    logger.info("delegate_to_agent: spawning mission-cli: agent=%s title=%r", agent, title)
    code, out, err = await _run_subprocess(cmd, timeout=15.0)
    if code != 0:
        logger.error("delegate_to_agent failed: code=%d stderr=%s", code, err)
        # Error path: let Gemini speak the error so the user hears it.
        await params.result_callback({"ok": False, "error": err or "mission-cli failed"})
        return

    # Happy path: queued successfully. Suppress the follow-up turn.
    await params.result_callback({"ok": True, "agent": agent}, properties=silent)


async def get_time_handler(params):
    """Tool: get the current wall clock time (user's local timezone)."""
    now = datetime.datetime.now().astimezone()
    await params.result_callback({
        "ok": True,
        "iso": now.isoformat(timespec="seconds"),
        "human": now.strftime("%A %B %-d, %-I:%M %p %Z"),
    })


async def list_agents_handler(params):
    """Tool: list the sub-agents Gemini can delegate to, with one-line descriptions."""
    # Build roster from the dynamic agent list + hardcoded descriptions for known agents
    _known_descriptions = {
        "main": "The Hand of the King. General ops, triage, defaults if unsure.",
        "research": "Grand Maester. Web research, academic sources, competitive intel.",
        "comms": "Master of Whisperers. Email, Slack, Telegram, customer comms.",
        "content": "The Royal Bard. Writing, scripts, LinkedIn, YouTube, blog posts.",
        "ops": "Master of War. Calendar, scheduling, internal tools, automations.",
    }
    roster = {}
    # Start with dynamic roster from /tmp/warroom-agents.json
    try:
        agents = json.loads(Path("/tmp/warroom-agents.json").read_text())
        for a in agents:
            aid = a["id"]
            roster[aid] = _known_descriptions.get(aid, a.get("description", "Specialist agent"))
    except Exception:
        roster = dict(_known_descriptions)
    await params.result_callback({"ok": True, "agents": roster})


async def answer_as_agent_handler(params):
    """Tool: synchronously invoke a sub-agent and return its text response.

    Used by auto/hand-raise mode. Unlike delegate_to_agent (which queues
    an async mission task and returns immediately), this one blocks until
    the agent produces a response, then returns the text verbatim so
    Gemini Live can read it out loud as-is.

    Also pushes an RTVIServerMessageFrame before the subprocess spawn so
    the browser's onServerMessage callback can trigger a hand-up animation
    on the chosen agent's sidebar card while the user waits for audio.
    PipelineTask enables RTVI by default, so the auto-attached RTVIObserver
    converts our frame into a wire-format "server-message" that the
    Pipecat JS client delivers to onServerMessage.

    Unlike delegate_to_agent, success MUST allow a follow-up Gemini inference:
    the agent text is returned as a tool result and Gemini Live then reads the
    text field aloud. Error paths stay silent because the browser receives a
    visible agent_error event.
    """
    from pipecat.frames.frames import FunctionCallResultProperties
    silent = FunctionCallResultProperties(run_llm=False)
    speak = FunctionCallResultProperties(run_llm=True)

    args = params.arguments or {}
    agent = args.get("agent")
    question = args.get("question")

    if agent not in VALID_AGENTS or not isinstance(question, str) or not question.strip():
        await params.result_callback({
            "ok": False,
            "error": f"invalid args: agent must be one of {sorted(VALID_AGENTS)} and question is required",
        }, properties=silent)
        return

    # Fire the hand-up signal to the browser BEFORE the expensive
    # subprocess call. The RTVIObserver in the pipeline picks this up
    # and wraps it into an RTVI "server-message" envelope that the JS
    # client surfaces via onServerMessage. This is how the user sees
    # "research has their hand up" a beat before hearing the answer.
    await _push_server_event(params, {"event": "agent_selected", "agent": agent}, source="answer_as_agent")

    logger.info("answer_as_agent: agent=%s question=%r", agent, question[:80])

    result = await _call_voice_agent(agent, question, chat_id=WARROOM_CHAT_ID, timeout=ANSWER_TIMEOUT_SEC)
    if not result.get("ok"):
        # Tell the browser to drop the hand-up animation immediately and
        # surface a visible error so the user knows the agent did NOT
        # answer rather than silently waiting for nothing. This covers both
        # the 25s timeout path (silent stuck hand-up was the main UX bug)
        # and OAuth-token-expired / bridge-failed paths (Gemini would have
        # mumbled a vague recovery line; now the user sees a real banner).
        err_msg = str(result.get("error") or "voice bridge failed")
        await _push_server_event(params, {"event": "hand_down", "agent": agent}, source="answer_as_agent")
        await _push_server_event(params, {"event": "agent_error", "agent": agent, "error": err_msg[:200]}, source="answer_as_agent")
        await params.result_callback({
            "ok": False,
            "agent": agent,
            "error": err_msg,
        }, properties=silent)
        return

    # Success: drop the hand-up animation now that the agent has actually
    # answered. The browser's 6s auto-clear is a fallback; this fires the
    # instant the spoken response arrives, which feels natural.
    await _push_server_event(params, {"event": "hand_down", "agent": agent}, source="answer_as_agent")

    await params.result_callback({
        "ok": True,
        "agent": agent,
        "text": result.get("text"),
    }, properties=speak)


async def answer_team_handler(params, active_mode: str):
    """Tool: run a whole-team voice turn using mesh-like modes."""
    from pipecat.frames.frames import FunctionCallResultProperties
    silent = FunctionCallResultProperties(run_llm=False)
    speak = FunctionCallResultProperties(run_llm=True)

    args = params.arguments or {}
    question = args.get("question")
    if active_mode not in TEAM_MODES:
        await params.result_callback({"ok": False, "error": f"invalid team mode: {active_mode}"}, properties=silent)
        return
    if not isinstance(question, str) or not question.strip():
        await params.result_callback({"ok": False, "error": "question is required"}, properties=silent)
        return

    participants = _team_participants(active_mode)
    logger.info("answer_team: mode=%s participants=%s question=%r", active_mode, participants, question[:80])

    responses: list[dict] = []
    chat_id = f"{WARROOM_CHAT_ID}:{active_mode}"

    # Phase 1 — parallelize where it's semantically valid.
    #
    # broadcast/ensemble/consensus: each agent answers independently of the
    # others, so we fan out and asyncio.gather the calls. Wall-clock then
    # collapses from sum(per_agent) to max(per_agent) — for our 3-agent
    # roster (~13s + ~14s + ~18s), that's ~45s sequential vs ~18s parallel.
    #
    # debate: each contribution explicitly references prior speakers, so
    # the prompt for agent N depends on responses[0..N-1]. Stays sequential.
    #
    # Per-agent errors (timeout, exit code) DON'T abort the whole turn —
    # we collect a result dict for every participant so the user gets
    # whatever responded, plus explicit "agent_error" events for the rest.

    async def _run_one(agent: str, prior: list[dict]) -> dict:
        prompt = _build_team_agent_prompt(active_mode, agent, question, prior)
        await _push_server_event(params, {"event": "agent_selected", "agent": agent}, source="answer_team")
        try:
            result = await _call_voice_agent(agent, prompt, chat_id=chat_id, timeout=TEAM_AGENT_TIMEOUT_SEC)
        except Exception as exc:
            logger.exception("answer_team: agent=%s raised", agent)
            result = {"ok": False, "agent": agent, "error": f"unexpected: {exc}"[:200]}
        await _push_server_event(params, {"event": "hand_down", "agent": agent}, source="answer_team")
        if not result.get("ok"):
            await _push_server_event(
                params,
                {"event": "agent_error", "agent": agent, "error": str(result.get("error") or "failed")[:200]},
                source="answer_team",
            )
        return result

    PARALLEL_MODES = {"broadcast", "ensemble", "consensus"}
    if active_mode in PARALLEL_MODES:
        # No shared prior — every agent gets the same `prior=[]` so the
        # prompt builder produces the same baseline for everyone. Order
        # of `responses` follows `participants` (zip with raw_results).
        raw_results = await asyncio.gather(
            *[_run_one(agent, []) for agent in participants],
            return_exceptions=False,  # _run_one already wraps exceptions in result dicts
        )
        responses.extend(raw_results)
    else:
        # debate (or any future sequential mode): each agent sees prior
        # contributions so the call_count×timeout fan-out is intentional.
        for agent in participants:
            responses.append(await _run_one(agent, responses))

    if active_mode in {"debate", "ensemble", "consensus"} and "main" in VALID_AGENTS and any(r["agent"] != "main" for r in responses):
        judge_prompt = _build_team_judge_prompt(active_mode, question, responses)
        await _push_server_event(params, {"event": "agent_selected", "agent": "main"}, source="answer_team")
        judge = await _call_voice_agent("main", judge_prompt, chat_id=chat_id, timeout=TEAM_AGENT_TIMEOUT_SEC)
        await _push_server_event(params, {"event": "hand_down", "agent": "main"}, source="answer_team")
        if not judge.get("ok"):
            await _push_server_event(
                params,
                {"event": "agent_error", "agent": "main", "error": str(judge.get("error") or "failed")[:200]},
                source="answer_team",
            )
        judge["role"] = "judge"
        responses.append(judge)

    text = _format_team_response(active_mode, responses)
    await params.result_callback({
        "ok": any(r.get("ok") for r in responses),
        "mode": active_mode,
        "text": text,
        "responses": responses,
    }, properties=speak)


# ─── Mode 1: Gemini Live (speech-to-speech + tools) ────────────────────────

# Shared with the dashboard — any HTTP POST to /api/warroom/pin writes here.
PIN_PATH = Path("/tmp/warroom-pin.json")
LANGUAGE_PATH = Path("/tmp/warroom-language.json")
PROVIDER_PATH = Path("/tmp/warroom-provider.json")

VALID_MODES = {"direct", "auto", "router", "single", "broadcast", "debate", "ensemble", "consensus"}
VALID_PROVIDERS = {
    "gemini-live",
    "gemini-live-25",
    "xai",
    "groq",
    "cartesia",
    "elevenlabs",
    "voxtral",
    "mixed",
}


def read_provider_pin() -> str | None:
    """Return the voice-stack provider chosen via the dashboard, or None.

    Values:
      - "gemini-live"     Gemini 3.1 Flash Live (current default, audio E2E)
      - "gemini-live-25"  Gemini 2.5 native-audio (lower latency, mature)
      - "xai"             xAI Grok realtime Voice Agent
      - "groq"            Groq Whisper STT + Claude bridge + Groq PlayAI TTS
      - "cartesia"        Deepgram STT + Claude bridge + Cartesia TTS (legacy)
      - "elevenlabs"      Groq Whisper STT + Claude bridge + ElevenLabs TTS
      - "voxtral"         Voxtral STT/TTS + Claude bridge
      - "mixed"           Groq Whisper STT + Claude bridge + per-agent TTS

    Falls back to WARROOM_MODE env when None.
    """
    if not PROVIDER_PATH.exists():
        return None
    try:
        with open(PROVIDER_PATH, "r") as f:
            data = json.load(f)
        p = data.get("provider") if isinstance(data, dict) else None
        return p if isinstance(p, str) and p in VALID_PROVIDERS else None
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def read_language_pin() -> str | None:
    """Return the language code pinned via the dashboard, or None.

    Highest-priority language source. Falls back (in server start_live) to
    per-agent voices.json then WARROOM_LANGUAGE env then no pin.
    """
    if not LANGUAGE_PATH.exists():
        return None
    try:
        with open(LANGUAGE_PATH, "r") as f:
            data = json.load(f)
        lang = data.get("language") if isinstance(data, dict) else None
        return lang if isinstance(lang, str) and lang else None
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def read_pin_state() -> tuple[str, str]:
    """Return (agent, mode) tuple from the pin file.

    Defaults to ("main", "direct") if the file is missing or malformed.
    The Pipecat server reads this on startup to decide which agent's
    voice, persona, and tool set to load. Changing either field requires
    a respawn (handled by the dashboard's /api/warroom/pin endpoint).
    """
    if not PIN_PATH.exists():
        return "main", "direct"
    try:
        with open(PIN_PATH, "r") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return "main", "direct"
        agent = data.get("agent")
        if not isinstance(agent, str) or agent not in VALID_AGENTS:
            agent = "main"
        mode = data.get("mode")
        if not isinstance(mode, str) or mode not in VALID_MODES:
            mode = "direct"
        return agent, mode
    except (OSError, json.JSONDecodeError, ValueError):
        return "main", "direct"


def read_pinned_agent() -> str:
    """Back-compat wrapper: return just the agent id."""
    agent, _ = read_pin_state()
    return agent


async def run_live_mode():
    """Gemini Live native-audio pipeline with tool calling."""
    from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
    from pipecat.adapters.schemas.function_schema import FunctionSchema
    from pipecat.adapters.schemas.tools_schema import ToolsSchema
    from pipecat.frames.frames import LLMContextFrame
    from personas import get_persona

    check_required_keys({"GOOGLE_API_KEY": "Google AI (Gemini Live native audio)"})

    port = int(os.environ.get("WARROOM_PORT", "7860"))
    model = os.environ.get("WARROOM_LIVE_MODEL")  # None = use Pipecat's default

    # Determine which agent + mode is active. Defaults: ("main", "direct").
    # If the user has clicked an agent card or a mode button on the
    # dashboard, /api/warroom/pin wrote both fields here and then killed
    # the warroom subprocess so this fresh process picks up the new pin.
    active_agent, active_mode = read_pin_state()
    logger.info("Active agent=%s mode=%s", active_agent, active_mode)

    # Router/team modes use main as the Gemini front desk. Direct and single
    # modes use the pinned/default agent voice so per-agent voice edits take
    # effect when the user intentionally talks to one agent.
    voice_agent = "main" if active_mode in ROUTER_MODES | TEAM_MODES else active_agent
    active_entry = AGENT_VOICES.get(voice_agent) or AGENT_VOICES.get("main", {})
    configured_voice = active_entry.get("gemini_voice") or "Charon"
    voice = os.environ.get("WARROOM_LIVE_VOICE", configured_voice)
    # Language resolution (top wins):
    #   1. dashboard pick (/tmp/warroom-language.json)
    #   2. per-agent voices.json "language"
    #   3. WARROOM_LANGUAGE env var (handled inside get_persona)
    resolved_language = read_language_pin() or active_entry.get("language")
    system_prompt = get_persona(active_agent, mode=active_mode, language=resolved_language)

    transport = make_transport(port)

    # Define the toolset Gemini can call ----------------------------------
    delegate_schema = FunctionSchema(
        name="delegate_to_agent",
        description=(
            "Delegate a unit of work to one of the user's sub-agents. The sub-agent "
            "runs the task asynchronously through its full Claude Code environment "
            "and pings the user on Telegram when finished. Use this for anything that "
            "requires real execution: research, drafting messages, file operations, "
            "scheduling, running code. After calling this, tell the user verbally that "
            "you've queued it and they'll be notified when done. DO NOT wait."
        ),
        properties={
            "agent": {
                "type": "string",
                "enum": sorted(VALID_AGENTS),
                "description": "Which sub-agent should handle this work.",
            },
            "title": {
                "type": "string",
                "description": "Short 3-8 word label for the task (for the Telegram notification).",
            },
            "prompt": {
                "type": "string",
                "description": "Full instructions for the sub-agent. Be specific about what the user wants.",
            },
            "priority": {
                "type": "integer",
                "description": "Task priority 0-10 (default 5). Use 8+ only for truly urgent work.",
            },
        },
        required=["agent", "title", "prompt"],
    )

    get_time_schema = FunctionSchema(
        name="get_time",
        description="Get the current wall clock time in the user's local timezone. Use when they ask what time it is.",
        properties={},
        required=[],
    )

    list_agents_schema = FunctionSchema(
        name="list_agents",
        description="List the user's sub-agents with their one-line role descriptions. Use when they ask 'who's on my team' or 'who can I delegate to'.",
        properties={},
        required=[],
    )

    # answer_as_agent is registered in router and single modes. In direct mode,
    # Gemini should not be routing calls away from the pinned agent —
    # the pinned agent IS the one answering, via its own persona.
    standard_tools = [delegate_schema, get_time_schema, list_agents_schema]
    if active_mode in ROUTER_MODES | SINGLE_MODES:
        answer_schema = FunctionSchema(
            name="answer_as_agent",
            description=(
                "Invoke exactly one specialist agent through the real agent runtime and return "
                "their answer verbatim. In router mode, pick the best-fit agent unless the "
                "user names one. In single mode, use the named agent if present, otherwise "
                "use the pinned/default agent from the system instruction. If the user names "
                "an agent at the start, use that agent even for greetings or small talk. Speak "
                "a one-word acknowledgment BEFORE calling this tool, then when it returns, "
                "read the 'text' field verbatim with no commentary."
            ),
            properties={
                "agent": {
                    "type": "string",
                    "enum": sorted(VALID_AGENTS),
                    "description": "Which specialist should answer.",
                },
                "question": {
                    "type": "string",
                    "description": "The user's full question, cleaned up grammatically if needed.",
                },
            },
            required=["agent", "question"],
        )
        standard_tools.append(answer_schema)
    if active_mode in TEAM_MODES:
        team_schema = FunctionSchema(
            name="answer_team",
            description=(
                f"Run the current War Room team mode ({active_mode}) through the real agent runtimes. "
                "Use this for EVERY substantive user turn in broadcast, debate, ensemble, or consensus "
                "mode. Return the combined team response verbatim. Do not answer the substantive "
                "question yourself."
            ),
            properties={
                "question": {
                    "type": "string",
                    "description": "The user's full prompt or topic for the team.",
                },
            },
            required=["question"],
        )
        standard_tools.append(team_schema)

    tools = ToolsSchema(standard_tools=standard_tools)

    # Seed the LLM context with an empty message list + tools. Gemini Live
    # uses the tools from the context, not from the service constructor.
    context = LLMContext(messages=[], tools=tools)

    # Build the service -----------------------------------------------------
    live_kwargs = dict(
        api_key=os.environ["GOOGLE_API_KEY"],
        system_instruction=system_prompt,
        # inference_on_context_initialization=False prevents Gemini from
        # proactively speaking when the session opens; wait for the user to
        # say something first.
        inference_on_context_initialization=False,
    )
    if model:
        live_kwargs["model"] = model

    # Pipecat 0.0.108 still accepts the old voice_id argument, but the
    # canonical API is Settings(voice=...). Set both so current installs and
    # newer Pipecat versions pick up the dashboard voice consistently.
    live_kwargs["voice_id"] = voice
    settings_kwargs = {"voice": voice}

    # Pin Gemini Live's input speech recognition to the same language we
    # ask it to respond in. system_instruction only controls OUTPUT;
    # Settings.language controls STT (wired to SpeechConfig.language_code
    # in pipecat/.../gemini_live/llm.py:1277).
    #
    # Three regimes:
    #   - resolved_language is a real BCP-47 code → lock STT + output
    #   - resolved_language == "auto" → DO NOT pin STT (Pipecat default
    #     en-US is sent, but the native-audio model handles multilingual
    #     under the hood and accepts code-switching). The persona prefix
    #     tells the model to mirror the user's language on output.
    #   - resolved_language is None → no STT pin, no output directive
    #     (legacy auto-detect behavior — drifts).
    if resolved_language and resolved_language != "auto":
        try:
            settings_kwargs["language"] = resolved_language
            logger.info("Gemini Live STT language pinned to %s", resolved_language)
        except Exception as exc:
            logger.warning("Could not set Gemini Live STT language to %s: %s", resolved_language, exc)
    elif resolved_language == "auto":
        logger.info("Gemini Live in multilingual auto mode (output mirrors user's language)")
    live_kwargs["settings"] = GeminiLiveLLMService.Settings(**settings_kwargs)
    logger.info("Gemini Live voice=%s voice_agent=%s mode=%s", voice, voice_agent, active_mode)

    llm = GeminiLiveLLMService(**live_kwargs)

    # Register the tool handlers. register_function binds a Python async
    # callable to a named function on the LLM side; when Gemini emits a
    # tool_call Pipecat calls our handler with FunctionCallParams.
    llm.register_function("delegate_to_agent", delegate_to_agent_handler)
    llm.register_function("get_time", get_time_handler)
    llm.register_function("list_agents", list_agents_handler)
    if active_mode in ROUTER_MODES | SINGLE_MODES:
        llm.register_function(
            "answer_as_agent",
            answer_as_agent_handler,
            timeout_secs=_answer_tool_timeout(),
        )
    if active_mode in TEAM_MODES:
        async def _active_answer_team_handler(params):
            await answer_team_handler(params, active_mode)

        llm.register_function(
            "answer_team",
            _active_answer_team_handler,
            timeout_secs=_team_tool_timeout(active_mode),
        )

    # Context aggregator pair. This is the piece that was missing before —
    # it routes user speech / Gemini responses into the LLMContext and
    # triggers `set_context()` on the service so `_ready_for_realtime_input`
    # flips True and audio actually flows.
    aggregators = LLMContextAggregatorPair(context)

    pipeline = Pipeline([
        transport.input(),
        aggregators.user(),
        llm,
        aggregators.assistant(),
        transport.output(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
        ),
        # CRITICAL: disable the default 5-minute idle timeout. Without this,
        # Pipecat cancels the pipeline after 5 min of no BotSpeaking/UserSpeaking
        # frames, which triggers main's respawn logic and leaves the subprocess
        # mid-init for ~5s. That's what caused "first click always fails" after
        # being away from the warroom page. Main still owns the subprocess
        # lifecycle via launchd + the exit handler in src/index.ts, so we don't
        # need Pipecat second-guessing it.
        idle_timeout_secs=None,
        cancel_on_idle_timeout=False,
    )

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected; keeping pipeline alive for next meeting")

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected (live mode); resetting context and pushing LLMContextFrame")
        # Clear stale messages from previous meeting sessions. The context
        # object is created once on server startup and reused across clients
        # because the pipeline stays alive. Without this, Gemini's context
        # accumulates conversation history across meetings.
        context.messages.clear()
        # CRITICAL: Gemini Live won't accept any incoming audio until the
        # service has seen an LLMContextFrame (the service uses this to
        # install its tools + system prompt and flip _ready_for_realtime_input
        # to True). Without VAD on the transport, the user aggregator never
        # fires an end-of-turn, so nothing would ever push a context frame
        # into the pipeline. We seed it manually here, on every new client.
        await task.queue_frame(LLMContextFrame(context=context))

    print_ready(port, "live")
    runner = PipelineRunner(handle_sigterm=True)
    logger.info(
        "War Room LIVE mode on ws://0.0.0.0:%d (agent=%s mode=%s voice=%s model=%s tools=%d)",
        port, active_agent, active_mode, voice, model or "pipecat-default", len(standard_tools),
    )
    await runner.run(task)
    logger.info("War Room session ended.")


# ─── Mode 2: Legacy stitched pipeline ──────────────────────────────────────

async def run_legacy_mode():
    """Original Deepgram → router → Claude bridge → Cartesia pipeline."""
    from pipecat.services.cartesia.tts import CartesiaTTSService
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from router import AgentRouter
    from agent_bridge import ClaudeAgentBridge

    check_required_keys({
        "DEEPGRAM_API_KEY": "Deepgram (speech-to-text)",
        "CARTESIA_API_KEY": "Cartesia (text-to-speech)",
    })

    port = int(os.environ.get("WARROOM_PORT", "7860"))

    default_voice = AGENT_VOICES.get(DEFAULT_AGENT, {})
    default_voice_id = default_voice.get("voice_id", "a0e99841-438c-4a64-b679-ae501e7d6091")

    transport = make_transport(port)

    stt = DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"])
    tts = CartesiaTTSService(api_key=os.environ["CARTESIA_API_KEY"], voice_id=default_voice_id)

    router = AgentRouter()
    bridge = ClaudeAgentBridge()

    pipeline = Pipeline([
        transport.input(),
        stt,
        router,
        bridge,
        tts,
        transport.output(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
        ),
    )

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected; keeping pipeline alive for next meeting")

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected (legacy mode)")

    print_ready(port, "legacy")
    runner = PipelineRunner(handle_sigterm=True)
    logger.info("War Room LEGACY mode on ws://0.0.0.0:%d", port)
    await runner.run(task)
    logger.info("War Room session ended.")


# ─── Mode 3: xAI Grok Voice Agent (E2E realtime, similar to Gemini Live) ──

async def run_xai_mode():
    """xAI Grok Voice Agent: E2E audio realtime (like Gemini Live).

    Grok handles STT + LLM + TTS in one session. Voices: Ara (default), Rex,
    Sal, Eve, Leo. Configure via WARROOM_XAI_VOICE env or voices.json field.
    Tools (delegate_to_agent etc.) are not yet wired here — future work.
    """
    from pipecat.services.xai.realtime.llm import GrokRealtimeLLMService
    from pipecat.services.xai.realtime import events as xai_events
    from personas import get_persona

    check_required_keys({
        "XAI_API_KEY": "xAI Grok (Voice Agent realtime)",
    })

    port = int(os.environ.get("WARROOM_PORT", "7860"))

    active_agent, active_mode = read_pin_state()
    agent_entry = AGENT_VOICES.get(active_agent, {})
    # Per-agent voice from voices.json wins over env default ("Ara").
    voice = agent_entry.get("xai_voice") or os.environ.get("WARROOM_XAI_VOICE", "Ara")
    resolved_language = read_language_pin() or agent_entry.get("language")
    system_prompt = get_persona(active_agent, mode=active_mode, language=resolved_language)

    transport = make_transport(port)

    session_properties = xai_events.SessionProperties(
        instructions=system_prompt,
        voice=voice,
    )

    llm = GrokRealtimeLLMService(
        api_key=os.environ["XAI_API_KEY"],
        session_properties=session_properties,
    )

    pipeline = Pipeline([
        transport.input(),
        llm,
        transport.output(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(allow_interruptions=True, enable_metrics=True),
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected (xai mode, voice=%s)", voice)

    print_ready(port, "xai")
    runner = PipelineRunner(handle_sigterm=True)
    logger.info("War Room XAI mode on ws://0.0.0.0:%d (voice=%s agent=%s)", port, voice, active_agent)
    await runner.run(task)
    logger.info("War Room session ended.")


# ─── Mode 4: Groq stitched pipeline (low latency, Claude in the middle) ──

async def run_groq_mode():
    """Groq Whisper STT → Claude Code bridge → Groq PlayAI TTS.

    Lower-latency alternative to Gemini Live for users who want Claude (with
    full skills/MCPs) handling the LLM step instead of Gemini. The TTS stays
    on Groq's PlayAI Orpheus model — multilingual, ~200ms first-byte.
    """
    from pipecat.services.groq.stt import GroqSTTService
    from pipecat.services.groq.tts import GroqTTSService
    from router import AgentRouter
    from agent_bridge import ClaudeAgentBridge

    check_required_keys({
        "GROQ_API_KEY": "Groq (Whisper STT + PlayAI TTS)",
    })

    port = int(os.environ.get("WARROOM_PORT", "7860"))

    transport = make_transport(port)

    # Whisper-large-v3 is Groq's default; multilingual.
    stt = GroqSTTService(api_key=os.environ["GROQ_API_KEY"])
    # Voice override from env, otherwise Orpheus default ("autumn", en-US-ish
    # but handles PT/ES decently). Per-agent voice via voices.json could be
    # added later once we have a voice catalog mapping.
    tts_voice = os.environ.get("WARROOM_GROQ_VOICE", "autumn")
    tts = GroqTTSService(api_key=os.environ["GROQ_API_KEY"], voice_id=tts_voice)

    router = AgentRouter()
    bridge = ClaudeAgentBridge()

    pipeline = Pipeline([
        transport.input(),
        stt,
        router,
        bridge,
        tts,
        transport.output(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(allow_interruptions=True, enable_metrics=True),
    )

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected; keeping pipeline alive for next meeting")

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected (groq mode, voice=%s)", tts_voice)

    print_ready(port, "groq")
    runner = PipelineRunner(handle_sigterm=True)
    logger.info("War Room GROQ mode on ws://0.0.0.0:%d (voice=%s)", port, tts_voice)
    await runner.run(task)
    logger.info("War Room session ended.")


async def run_elevenlabs_mode():
    """Groq Whisper STT → Claude bridge → ElevenLabs TTS.

    ElevenLabs is the highest-quality multilingual TTS but is *not* end-to-end
    (no streaming STT of its own). We pair it with Groq Whisper which is
    cheap, ~200ms-first-token, and shares the multilingual property. The LLM
    step stays on Claude (with full skills/MCPs) via the same bridge as Groq
    mode — only the TTS service differs.

    Voice picks per-agent voices.json `elevenlabs_voice_id`, falling back to
    ELEVENLABS_VOICE_ID. The bridge can switch voices per routed response.
    """
    from pipecat.services.groq.stt import GroqSTTService
    from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
    from router import AgentRouter
    from agent_bridge import ClaudeAgentBridge

    check_required_keys({
        "GROQ_API_KEY": "Whisper STT (ElevenLabs has no STT of its own)",
        "ELEVENLABS_API_KEY": "ElevenLabs TTS",
    })

    port = int(os.environ.get("WARROOM_PORT", "7860"))
    transport = make_transport(port)

    active_agent, _active_mode = read_pin_state()
    stt = GroqSTTService(api_key=os.environ["GROQ_API_KEY"])
    voice_id = _voice_value(active_agent, "elevenlabs_voice_id", os.environ.get("ELEVENLABS_VOICE_ID", ""))
    if not voice_id:
        raise RuntimeError(
            "ElevenLabs voice not configured. Set ELEVENLABS_VOICE_ID or per-agent "
            "voices.json field `elevenlabs_voice_id`."
        )
    tts = ElevenLabsTTSService(
        api_key=os.environ["ELEVENLABS_API_KEY"],
        settings=ElevenLabsTTSService.Settings(
            voice=voice_id,
            # Multilingual v2 handles PT-BR + EN code-switch reliably; eleven_turbo_v2_5
            # is faster but EN-only by default. Override with WARROOM_ELEVENLABS_MODEL.
            model=os.environ.get("WARROOM_ELEVENLABS_MODEL", "eleven_multilingual_v2"),
        ),
    )

    router = AgentRouter()
    bridge = ClaudeAgentBridge(voice_field="elevenlabs_voice_id", default_voice=voice_id)

    pipeline = Pipeline([
        transport.input(),
        stt,
        router,
        bridge,
        tts,
        transport.output(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(allow_interruptions=True, enable_metrics=True),
    )

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected; keeping pipeline alive for next meeting")

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected (elevenlabs mode, voice=%s)", voice_id)

    print_ready(port, "elevenlabs")
    runner = PipelineRunner(handle_sigterm=True)
    logger.info(
        "War Room ELEVENLABS mode on ws://0.0.0.0:%d (voice=%s, stt=groq-whisper)",
        port, voice_id,
    )
    await runner.run(task)
    logger.info("War Room session ended.")


async def run_voxtral_mode():
    """Mistral Voxtral realtime STT (sub-200ms WS) → Claude bridge → Voxtral TTS streaming.

    Voxtral is Mistral's audio stack released 2025: realtime STT via WebSocket
    (`voxtral-mini-transcribe-realtime-2602`) and streaming TTS with zero-shot
    voice cloning (`voxtral-mini-tts-2603`). Pipecat doesn't ship official
    services for these yet (only Mistral LLM), so this mode wraps the raw
    Mistral SDK in custom pipecat FrameProcessors defined inline below.

    LLM stays on Claude (with skills/MCPs) for parity with groq/elevenlabs
    modes — Voxtral STT/TTS bookends the Claude bridge. Set
    WARROOM_VOXTRAL_VOICE_ID to a saved voice; otherwise falls back to base64
    ref_audio from WARROOM_VOXTRAL_REF_AUDIO_PATH (zero-shot clone) or the
    default Voxtral preset voice.
    """
    from pipecat.services.groq.stt import GroqSTTService
    from router import AgentRouter
    from agent_bridge import ClaudeAgentBridge

    check_required_keys({
        "MISTRAL_API_KEY": "Voxtral STT/TTS via Mistral API",
    })

    # Voxtral STT/TTS pipecat frame processors — defined here because pipecat
    # has no upstream service yet. Lazy-imports mistralai SDK so other modes
    # don't fail if the package isn't installed.
    voxtral_stt, voxtral_tts = await _build_voxtral_services()

    # Allow overriding STT to Groq Whisper if the user wants Voxtral TTS only
    # (e.g. while debugging the realtime WS path). Default uses Voxtral STT.
    use_voxtral_stt = os.environ.get("WARROOM_VOXTRAL_STT", "true").strip().lower() != "false"
    stt = voxtral_stt if use_voxtral_stt else GroqSTTService(api_key=os.environ.get("GROQ_API_KEY", ""))

    port = int(os.environ.get("WARROOM_PORT", "7860"))
    transport = make_transport(port)

    router = AgentRouter()
    bridge = ClaudeAgentBridge(
        voice_field="voxtral_voice_id",
        default_voice=os.environ.get("WARROOM_VOXTRAL_VOICE_ID", ""),
        ref_audio_field="voxtral_ref_audio_path",
    )

    pipeline = Pipeline([
        transport.input(),
        stt,
        router,
        bridge,
        voxtral_tts,
        transport.output(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(allow_interruptions=True, enable_metrics=True),
    )

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected; keeping pipeline alive for next meeting")

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected (voxtral mode, stt=%s)", "voxtral" if use_voxtral_stt else "groq")

    print_ready(port, "voxtral")
    runner = PipelineRunner(handle_sigterm=True)
    logger.info(
        "War Room VOXTRAL mode on ws://0.0.0.0:%d (stt=%s, tts=voxtral-mini-tts-2603)",
        port, "voxtral-realtime" if use_voxtral_stt else "groq-whisper",
    )
    await runner.run(task)
    logger.info("War Room session ended.")


async def _build_voxtral_services():
    """Construct custom pipecat STT + TTS services backed by the Mistral SDK.

    Imports are deferred so missing mistralai package only breaks voxtral mode,
    not other providers. Both services subclass pipecat AIService so they
    plug into the standard Pipeline.
    """
    try:
        from mistralai.client import Mistral
    except ImportError as exc:
        raise RuntimeError(
            "mistralai SDK not installed. Run: warroom/.venv/bin/pip install 'mistralai>=2.4'"
        ) from exc

    from pipecat.frames.frames import (
        Frame,
        InputAudioRawFrame,
        TranscriptionFrame,
        TTSAudioRawFrame,
        TTSStartedFrame,
        TTSStoppedFrame,
        TTSUpdateSettingsFrame,
        TextFrame,
    )
    from pipecat.services.ai_service import AIService

    api_key = os.environ["MISTRAL_API_KEY"]
    stt_model = os.environ.get(
        "WARROOM_VOXTRAL_STT_MODEL", "voxtral-mini-transcribe-realtime-2602"
    )
    tts_model = os.environ.get("WARROOM_VOXTRAL_TTS_MODEL", "voxtral-mini-tts-2603")
    default_voice_id = os.environ.get("WARROOM_VOXTRAL_VOICE_ID", "")
    default_ref_audio_path = os.environ.get("WARROOM_VOXTRAL_REF_AUDIO_PATH", "")

    def _read_ref_audio(path: str) -> str:
        if not path:
            return ""
        try:
            import base64
            with open(path, "rb") as f:
                return base64.b64encode(f.read()).decode()
        except OSError as exc:
            logger.warning("Could not read voxtral ref_audio %s: %s", path, exc)
            return ""

    class VoxtralRealtimeSTT(AIService):
        """Streams PcmS16le 16kHz audio frames to Voxtral realtime WebSocket
        and emits TranscriptionFrame on each text delta.

        Lazy-connects on first audio frame; reconnects on disconnect. Does NOT
        re-encode — pipecat's transport already delivers 16kHz PCM frames so
        we forward bytes directly to the WS.
        """
        def __init__(self):
            super().__init__()
            self._mistral = Mistral(api_key=api_key)
            self._stream_ctx = None
            self._stream_iter = None
            self._audio_queue: asyncio.Queue[bytes] = asyncio.Queue()
            self._stream_task: asyncio.Task | None = None

        async def _audio_generator(self):
            while True:
                chunk = await self._audio_queue.get()
                if chunk is None:  # sentinel for shutdown
                    return
                yield chunk

        async def _ensure_stream(self):
            if self._stream_task is not None:
                return
            try:
                from mistralai.extra.realtime.transcription import (
                    RealtimeTranscription, AudioFormat,
                )
            except ImportError:
                logger.error(
                    "mistralai>=2.4 with realtime extras required for Voxtral STT realtime"
                )
                raise

            client = RealtimeTranscription(api_key=api_key)
            self._stream_iter = client.transcribe_stream(
                self._audio_generator(),
                stt_model,
                audio_format=AudioFormat(encoding="pcm_s16le", sample_rate=16000),
            )
            self._stream_task = asyncio.create_task(self._consume_transcripts())

        async def _consume_transcripts(self):
            assert self._stream_iter is not None
            async for event in self._stream_iter:
                if event.type == "transcription.text.delta":
                    await self.push_frame(TranscriptionFrame(event.text, "voxtral", None))
                elif event.type == "transcription.done":
                    break
                elif event.type == "error":
                    logger.error("Voxtral STT realtime error: %s", event.error)
                    break

        async def process_frame(self, frame: Frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, InputAudioRawFrame):
                await self._ensure_stream()
                await self._audio_queue.put(frame.audio)
            else:
                await self.push_frame(frame, direction)

        async def cleanup(self):
            await self._audio_queue.put(None)  # sentinel
            if self._stream_task is not None:
                self._stream_task.cancel()
            await super().cleanup()

    class VoxtralStreamingTTS(AIService):
        """Calls Mistral /v1/audio/speech with stream=true and forwards PCM
        audio chunks as TTSAudioRawFrame. Re-encodes from opus → pcm via
        base64 decode + (optional) ffmpeg if pipecat transport requires PCM.
        """
        def __init__(self):
            super().__init__()
            self._client = Mistral(api_key=api_key)
            self._voice_id = default_voice_id
            self._ref_audio_path = default_ref_audio_path
            self._ref_audio_b64 = _read_ref_audio(default_ref_audio_path) if not default_voice_id else ""

        async def _synthesize(self, text: str):
            kwargs = {
                "model": tts_model,
                "input": text,
                "response_format": "pcm",  # match transport output sample format
                "stream": True,
            }
            if self._voice_id:
                kwargs["voice_id"] = self._voice_id
            elif self._ref_audio_b64:
                kwargs["ref_audio"] = self._ref_audio_b64
            # Else: Mistral uses its preset default voice.

            await self.push_frame(TTSStartedFrame())
            stream = await self._client.audio.speech.complete_async(**kwargs)
            try:
                async for event in stream:
                    if getattr(event, "event", None) == "speech.audio.delta":
                        import base64
                        audio_bytes = base64.b64decode(event.data.audio_data)
                        await self.push_frame(TTSAudioRawFrame(audio_bytes, 24000, 1))
            finally:
                await self.push_frame(TTSStoppedFrame())

        async def process_frame(self, frame: Frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, TTSUpdateSettingsFrame):
                voice = frame.settings.get("voice") if isinstance(frame.settings, dict) else None
                ref_audio_path = frame.settings.get("ref_audio_path") if isinstance(frame.settings, dict) else None
                if isinstance(voice, str):
                    self._voice_id = voice
                    if voice:
                        self._ref_audio_b64 = ""
                if isinstance(ref_audio_path, str) and ref_audio_path != self._ref_audio_path:
                    self._ref_audio_path = ref_audio_path
                    if not self._voice_id:
                        self._ref_audio_b64 = _read_ref_audio(ref_audio_path)
                return
            if isinstance(frame, TextFrame) and frame.text:
                await self._synthesize(frame.text)
            else:
                await self.push_frame(frame, direction)

    return VoxtralRealtimeSTT(), VoxtralStreamingTTS()


def _build_mixed_tts_service():
    """Construct a TTS service that switches providers per agent response.

    The Claude bridge emits TTSUpdateSettingsFrame(settings={provider, voice,
    ref_audio_path}) before each TextFrame. This service consumes that metadata
    and synthesizes the next response with xAI, ElevenLabs, Voxtral, or Groq.
    """
    from pipecat.frames.frames import (
        ErrorFrame,
        Frame,
        TTSAudioRawFrame,
        TTSUpdateSettingsFrame,
    )
    from pipecat.processors.frame_processor import FrameDirection
    from pipecat.services.tts_service import TTSService

    def _normalize_provider(provider: str | None) -> str:
        value = (provider or "").strip().lower()
        if value == "grok":
            return "xai"
        return value

    def _read_ref_audio(path: str) -> str:
        if not path:
            return ""
        try:
            import base64
            with open(path, "rb") as f:
                return base64.b64encode(f.read()).decode()
        except OSError as exc:
            logger.warning("Could not read voxtral ref_audio %s: %s", path, exc)
            return ""

    class MixedProviderTTSService(TTSService):
        """HTTP/SDK-backed TTS router for War Room mixed provider mode."""

        def __init__(self):
            super().__init__(
                push_start_frame=True,
                push_stop_frames=True,
                pause_frame_processing=True,
            )
            self._provider = _normalize_provider(os.environ.get("WARROOM_MIXED_DEFAULT_PROVIDER", ""))
            self._voice = ""
            self._ref_audio_path = ""
            self._http_session = None
            self._groq_client = None
            self._mistral_client = None

        async def _session(self):
            if self._http_session is None or self._http_session.closed:
                import aiohttp
                self._http_session = aiohttp.ClientSession()
            return self._http_session

        async def stop(self, frame):
            await super().stop(frame)
            await self._close()

        async def cancel(self, frame):
            await super().cancel(frame)
            await self._close()

        async def _close(self):
            if self._http_session and not self._http_session.closed:
                await self._http_session.close()
            self._http_session = None

        async def process_frame(self, frame: Frame, direction: FrameDirection):
            if isinstance(frame, TTSUpdateSettingsFrame) and frame.service in (None, self):
                settings = frame.settings if isinstance(frame.settings, dict) else {}
                if any(key in settings for key in ("provider", "voice", "ref_audio_path")):
                    if "provider" in settings:
                        self._provider = _normalize_provider(str(settings.get("provider") or ""))
                    if "voice" in settings:
                        self._voice = str(settings.get("voice") or "").strip()
                    if "ref_audio_path" in settings:
                        self._ref_audio_path = str(settings.get("ref_audio_path") or "").strip()
                    logger.info(
                        "mixed TTS route provider=%s voice=%s ref_audio=%s",
                        self._provider or "auto",
                        self._voice or "default",
                        bool(self._ref_audio_path),
                    )
                    return
            await super().process_frame(frame, direction)

        def _provider_ready(self, provider: str) -> bool:
            if provider == "xai":
                return bool(os.environ.get("XAI_API_KEY"))
            if provider == "elevenlabs":
                return bool(os.environ.get("ELEVENLABS_API_KEY")) and bool(
                    self._voice or os.environ.get("ELEVENLABS_VOICE_ID")
                )
            if provider == "voxtral":
                return bool(os.environ.get("MISTRAL_API_KEY"))
            if provider == "groq":
                return bool(os.environ.get("GROQ_API_KEY"))
            return False

        def _select_provider(self) -> str:
            candidates = [
                self._provider,
                _normalize_provider(os.environ.get("WARROOM_MIXED_DEFAULT_PROVIDER", "")),
                "xai",
                "elevenlabs",
                "voxtral",
                "groq",
            ]
            seen: set[str] = set()
            for provider in candidates:
                provider = _normalize_provider(provider)
                if not provider or provider in seen:
                    continue
                seen.add(provider)
                if self._provider_ready(provider):
                    return provider
            return ""

        async def run_tts(self, text: str, context_id: str):
            provider = self._select_provider()
            if not provider:
                yield ErrorFrame(
                    error=(
                        "Mixed War Room TTS has no available provider. Configure XAI_API_KEY, "
                        "or ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID, or MISTRAL_API_KEY, "
                        "or GROQ_API_KEY."
                    )
                )
                return

            preferred = self._provider or "auto"
            if self._provider and provider != self._provider:
                logger.warning("mixed TTS provider %s unavailable, falling back to %s", preferred, provider)

            if provider == "xai":
                async for frame in self._run_xai_tts(text, context_id):
                    yield frame
            elif provider == "elevenlabs":
                async for frame in self._run_elevenlabs_tts(text, context_id):
                    yield frame
            elif provider == "voxtral":
                async for frame in self._run_voxtral_tts(text, context_id):
                    yield frame
            elif provider == "groq":
                async for frame in self._run_groq_tts(text, context_id):
                    yield frame
            else:
                yield ErrorFrame(error=f"Unsupported mixed TTS provider: {provider}")

        async def _run_xai_tts(self, text: str, context_id: str):
            voice = self._voice or os.environ.get("WARROOM_XAI_VOICE", "Ara")
            sample_rate = self.sample_rate or 24000
            session = await self._session()
            payload = {
                "text": text,
                "voice_id": voice,
                "output_format": {"codec": "pcm", "sample_rate": sample_rate},
            }
            language = read_language_pin() or os.environ.get("WARROOM_LANGUAGE", "")
            if language and language != "auto":
                payload["language"] = {
                    "pt-BR": "pt",
                    "pt-PT": "pt",
                    "en-US": "en",
                    "en-GB": "en",
                    "es-ES": "es",
                    "fr-FR": "fr",
                    "de-DE": "de",
                }.get(language, language)
            headers = {
                "Authorization": f"Bearer {os.environ['XAI_API_KEY']}",
                "Content-Type": "application/json",
            }
            measuring_ttfb = True
            try:
                async with session.post("https://api.x.ai/v1/tts", json=payload, headers=headers) as response:
                    if response.status != 200:
                        error = await response.text(errors="ignore")
                        yield ErrorFrame(error=f"xAI TTS failed ({response.status}): {error[:300]}")
                        return
                    await self.start_tts_usage_metrics(text)
                    async for chunk in response.content.iter_chunked(self.chunk_size):
                        if not chunk:
                            continue
                        if measuring_ttfb:
                            await self.stop_ttfb_metrics()
                            measuring_ttfb = False
                        yield TTSAudioRawFrame(chunk, sample_rate, 1, context_id=context_id)
            except Exception as exc:
                yield ErrorFrame(error=f"xAI TTS failed: {exc}")

        async def _run_elevenlabs_tts(self, text: str, context_id: str):
            from pipecat.services.elevenlabs.tts import output_format_from_sample_rate

            voice = self._voice or os.environ.get("ELEVENLABS_VOICE_ID", "")
            if not voice:
                yield ErrorFrame(error="ElevenLabs voice not configured for mixed TTS")
                return
            sample_rate = self.sample_rate or 24000
            model = os.environ.get("WARROOM_ELEVENLABS_MODEL", "eleven_multilingual_v2")
            session = await self._session()
            url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice}/stream"
            params = {"output_format": output_format_from_sample_rate(sample_rate)}
            payload = {"text": text, "model_id": model}
            headers = {
                "xi-api-key": os.environ["ELEVENLABS_API_KEY"],
                "Content-Type": "application/json",
            }
            measuring_ttfb = True
            try:
                async with session.post(url, params=params, json=payload, headers=headers) as response:
                    if response.status != 200:
                        error = await response.text(errors="ignore")
                        yield ErrorFrame(error=f"ElevenLabs TTS failed ({response.status}): {error[:300]}")
                        return
                    await self.start_tts_usage_metrics(text)
                    async for chunk in response.content.iter_chunked(self.chunk_size):
                        if not chunk:
                            continue
                        if measuring_ttfb:
                            await self.stop_ttfb_metrics()
                            measuring_ttfb = False
                        yield TTSAudioRawFrame(chunk, sample_rate, 1, context_id=context_id)
            except Exception as exc:
                yield ErrorFrame(error=f"ElevenLabs TTS failed: {exc}")

        async def _run_voxtral_tts(self, text: str, context_id: str):
            if self._mistral_client is None:
                try:
                    from mistralai.client import Mistral
                except ImportError as exc:
                    yield ErrorFrame(error="mistralai SDK not installed for Voxtral mixed TTS")
                    return
                self._mistral_client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])

            voice = self._voice or os.environ.get("WARROOM_VOXTRAL_VOICE_ID", "")
            ref_audio_path = self._ref_audio_path or os.environ.get("WARROOM_VOXTRAL_REF_AUDIO_PATH", "")
            kwargs = {
                "model": os.environ.get("WARROOM_VOXTRAL_TTS_MODEL", "voxtral-mini-tts-2603"),
                "input": text,
                "response_format": "pcm",
                "stream": True,
            }
            if voice:
                kwargs["voice_id"] = voice
            else:
                ref_audio = _read_ref_audio(ref_audio_path)
                if ref_audio:
                    kwargs["ref_audio"] = ref_audio

            measuring_ttfb = True
            try:
                stream = await self._mistral_client.audio.speech.complete_async(**kwargs)
                await self.start_tts_usage_metrics(text)
                async for event in stream:
                    audio_data = None
                    if getattr(event, "event", None) == "speech.audio.delta":
                        audio_data = getattr(getattr(event, "data", None), "audio_data", None)
                    elif isinstance(event, (bytes, bytearray)):
                        if measuring_ttfb:
                            await self.stop_ttfb_metrics()
                            measuring_ttfb = False
                        yield TTSAudioRawFrame(bytes(event), 24000, 1, context_id=context_id)
                        continue
                    if not audio_data:
                        continue
                    import base64
                    if measuring_ttfb:
                        await self.stop_ttfb_metrics()
                        measuring_ttfb = False
                    yield TTSAudioRawFrame(base64.b64decode(audio_data), 24000, 1, context_id=context_id)
            except Exception as exc:
                yield ErrorFrame(error=f"Voxtral TTS failed: {exc}")

        async def _run_groq_tts(self, text: str, context_id: str):
            if self._groq_client is None:
                from groq import AsyncGroq
                self._groq_client = AsyncGroq(api_key=os.environ["GROQ_API_KEY"])
            voice = self._voice or os.environ.get("WARROOM_GROQ_VOICE", "autumn")
            model = os.environ.get("WARROOM_GROQ_TTS_MODEL", "canopylabs/orpheus-v1-english")
            measuring_ttfb = True
            try:
                response = await self._groq_client.audio.speech.create(
                    model=model,
                    voice=voice,
                    response_format="wav",
                    speed=1.0,
                    input=text,
                )
                await self.start_tts_usage_metrics(text)
                chunks = []
                async for data in response.iter_bytes():
                    if data and measuring_ttfb:
                        await self.stop_ttfb_metrics()
                        measuring_ttfb = False
                    if data:
                        chunks.append(data)
                if not chunks:
                    yield ErrorFrame(error="Groq TTS returned no audio")
                    return
                import io
                import wave
                with wave.open(io.BytesIO(b"".join(chunks))) as wav:
                    channels = wav.getnchannels()
                    frame_rate = wav.getframerate()
                    audio = wav.readframes(wav.getnframes())
                yield TTSAudioRawFrame(audio, frame_rate, channels, context_id=context_id)
            except Exception as exc:
                yield ErrorFrame(error=f"Groq TTS failed: {exc}")

    return MixedProviderTTSService()


async def run_mixed_mode():
    """Groq Whisper STT → Claude bridge → per-agent TTS provider router."""
    from pipecat.services.groq.stt import GroqSTTService
    from router import AgentRouter
    from agent_bridge import ClaudeAgentBridge

    check_required_keys({
        "GROQ_API_KEY": "Groq Whisper STT for War Room mixed provider",
    })

    port = int(os.environ.get("WARROOM_PORT", "7860"))
    transport = make_transport(port)

    stt = GroqSTTService(api_key=os.environ["GROQ_API_KEY"])
    router = AgentRouter()
    bridge = ClaudeAgentBridge(
        provider_field="audio_provider",
        default_provider=os.environ.get("WARROOM_MIXED_DEFAULT_PROVIDER", ""),
    )
    tts = _build_mixed_tts_service()

    pipeline = Pipeline([
        transport.input(),
        stt,
        router,
        bridge,
        tts,
        transport.output(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(allow_interruptions=True, enable_metrics=True),
    )

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected; keeping pipeline alive for next meeting")

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected (mixed mode)")

    print_ready(port, "mixed")
    runner = PipelineRunner(handle_sigterm=True)
    logger.info("War Room MIXED mode on ws://0.0.0.0:%d (stt=groq, tts=per-agent)", port)
    await runner.run(task)
    logger.info("War Room session ended.")


# ─── Entry point ───────────────────────────────────────────────────────────

async def run_warroom():
    load_env()
    # Provider pin from dashboard takes precedence over WARROOM_MODE env.
    pinned_provider = read_provider_pin()
    if pinned_provider == "xai":
        await run_xai_mode()
        return
    if pinned_provider == "groq":
        await run_groq_mode()
        return
    if pinned_provider == "cartesia":
        await run_legacy_mode()
        return
    if pinned_provider == "elevenlabs":
        await run_elevenlabs_mode()
        return
    if pinned_provider == "voxtral":
        await run_voxtral_mode()
        return
    if pinned_provider == "mixed":
        await run_mixed_mode()
        return
    if pinned_provider == "gemini-live-25":
        # Override the model env so the live path picks the older fast model
        os.environ["WARROOM_LIVE_MODEL"] = "models/gemini-2.5-flash-native-audio-preview-12-2025"
        # Fall through to live mode

    mode = os.environ.get("WARROOM_MODE", "live").strip().lower()
    if mode == "legacy":
        await run_legacy_mode()
    elif mode == "live":
        await run_live_mode()
    else:
        logger.error(
            "Unknown WARROOM_MODE=%r. Expected 'live' or 'legacy'. Defaulting to 'live'.",
            mode,
        )
        await run_live_mode()


def main():
    try:
        asyncio.run(run_warroom())
    except KeyboardInterrupt:
        logger.info("War Room shut down by user.")
    except Exception as exc:
        logger.error("War Room crashed: %s", exc, exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
