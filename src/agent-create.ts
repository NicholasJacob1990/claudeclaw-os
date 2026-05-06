import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execSync, spawn } from 'child_process';
import yaml from 'js-yaml';

import { CLAUDECLAW_CONFIG, PROJECT_ROOT, STORE_DIR } from './config.js';
import { listAgentIds, loadAgentConfig, resolveAgentDir, refreshWarRoomRoster } from './agent-config.js';
import { refreshAgentRegistry } from './orchestrator.js';
import { atomicEnvWrite } from './env-write.js';
import { logger } from './logger.js';
import { IS_WINDOWS, IS_MACOS, IS_LINUX, killProcess, isProcessAlive, claudeCodeHandoff, findProcessesByPattern } from './platform.js';

// Documentation block injected into every newly-created agent's
// CLAUDE.md if the template they were generated from doesn't already
// teach the file-send markers. The plumbing in src/bot.ts:637
// (extractFileMarkers) supports these for every agent — agents just
// need to know the syntax exists.
const FILE_SEND_SECTION = `
## Sending Files via Telegram

When the user asks you to create a file and send it back (PDF, spreadsheet, image, screenshot, etc.), include a file marker in your response. The bot wrapper parses these markers and sends the files as Telegram attachments — you do NOT call any tool, just include the literal marker text in your reply.

**Syntax:**
- \`[SEND_FILE:/absolute/path/to/file.pdf]\` — sends as a document attachment
- \`[SEND_PHOTO:/absolute/path/to/image.png]\` — sends as an inline photo
- \`[SEND_FILE:/absolute/path/to/file.pdf|Optional caption]\` — with a caption

**Rules:**
- Always use absolute paths (no \`~\`, no relative paths)
- Create the file first, then include the marker
- Place the marker on its own line
- Multiple markers in one response are fine
- Max file size: 50 MB (Telegram limit)
- The marker text gets stripped from the visible message

**Example:**
\`\`\`
Here's the report you asked for.
[SEND_FILE:/tmp/q1-report.pdf|Q1 2026 Report]
\`\`\`

For images you generated, prefer \`[SEND_PHOTO:...]\` so they preview inline.

### Do NOT try to send files any other way

The marker is the ONLY supported way to send files back to the user. Specifically, **do not**:

- \`curl https://api.telegram.org/bot<token>/sendDocument\` — your subprocess does not have a valid token in its env, and any token you find by reading \`.env\` belongs to a DIFFERENT bot (the main bot or another sub-agent), not yours. You will get a 401 and waste a turn diagnosing it.
- Use the \`plugin:telegram:telegram\` MCP skill (\`reply\`, \`download_attachment\`, etc.) to send outgoing files. That skill is wired to a Claude-in-Chrome / @claude.ai session, not your agent's own bot, and its stored token may be stale or unrelated. Use that skill ONLY for incoming attachments the user sent you.
- Read the user-uploaded file with the \`Read\` tool and paste base64 / hex into chat. The marker handles binary properly.

If a marker doesn't appear to send and the user asks why, say so plainly — DO NOT fall back to one of the above paths. The marker is reliable; if it failed, the bot wrapper logged it and the maintainer can debug from logs.

## Setting Your Profile Picture (the bot's avatar on Telegram)

If the user asks you to "set this as your profile picture" or "make this your avatar," **you cannot do this via any API or skill.** The Telegram Bot API has no \`setMyProfilePhoto\` method. The avatar Telegram users see for your bot can ONLY be changed by:

1. **The dashboard's per-agent avatar uploader** (Agents tab → click your card → camera icon on the avatar). That sets the avatar shown inside ClaudeClaw (sidebar, mission control, war room) — NOT the one on Telegram.
2. **@BotFather → /setuserpic** in Telegram, by the bot owner. This is the only way to change what Telegram shows.

When asked, **respond with that explanation** and mention the file path of the image you generated so the user can re-use it for the @BotFather step. **Do not**:

- Run \`curl ... /setProfilePhoto\` or any sendMessage to BotFather (you can't act as the user)
- Spawn the \`banana-squad\` or any image-generation pipeline a second time
- Save the file to a different path hoping the avatar will pick it up
- Suggest "I've updated my profile picture" — you have not, and the user will see no change

Sample reply when asked:
> I can't set my own Telegram avatar — Telegram's Bot API doesn't expose that and it has to go through @BotFather. The image is saved at \`~/.claudeclaw/agents/<id>/profile.png\`. To set it on Telegram: open @BotFather, send /setuserpic, pick this bot, and upload that file.
`.trim();

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Kill the warroom Python subprocess so main's respawn logic brings up
 * a fresh one with the updated /tmp/warroom-agents.json. Pipecat reads
 * VALID_AGENTS at import time, so a new agent only becomes a legal
 * voice-room target after respawn. Fire-and-forget.
 */
async function bounceVoiceWarRoom(reason: string): Promise<void> {
  try {
    const pids = await findProcessesByPattern('warroom/server.py');
    for (const pid of pids) killProcess(pid);
    if (pids.length > 0) {
      logger.info({ pids, reason }, 'bounced voice warroom for roster change');
    }
  } catch (err) {
    // Promote to error: a swallowed bounce failure leaves voice VALID_AGENTS
    // stale (frozen at last successful Pipecat startup) while text War Room
    // sees the new roster live. The two surfaces silently diverge.
    logger.error({ err, reason }, 'bounceVoiceWarRoom FAILED — voice roster may be stale until manual respawn');
  }
}

// ── Types ────────────────────────────────────────────────────────────

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
}

export interface BotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

export interface CreateAgentOpts {
  id: string;
  name: string;
  description: string;
  model?: string;
  /** Runtime backend: claude (SDK, default) | codex (CLI) | gemini (CLI)
   *  | openai-sdk | gemini-sdk. Persisted as `runtime:` em agent.yaml. */
  runtime?: 'claude' | 'codex' | 'gemini' | 'openai-sdk' | 'gemini-sdk';
  template?: string;
  botToken: string;
}

export interface CreateAgentResult {
  agentId: string;
  agentDir: string;
  envKey: string;
  plistPath: string | null;
  botInfo: BotInfo;
}

// ── Auto-color palette for new agents ────────────────────────────────

const AGENT_COLOR_PALETTE = [
  '#4f46e5', '#0ea5e9', '#f59e0b', '#10b981', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
  '#e11d48', '#06b6d4', '#d97706', '#7c3aed', '#059669',
];

// ── Validation ───────────────────────────────────────────────────────

const VALID_ID_RE = /^[a-z][a-z0-9_-]{0,29}$/;

export function validateAgentId(id: string): { ok: boolean; error?: string } {
  if (!id) return { ok: false, error: 'Agent ID is required' };
  if (!VALID_ID_RE.test(id)) {
    return {
      ok: false,
      error: 'Agent ID must be lowercase, start with a letter, and contain only a-z, 0-9, hyphens, or underscores (max 30 chars)',
    };
  }
  if (id === 'main') return { ok: false, error: '"main" is reserved for the primary bot' };
  if (id.startsWith('_')) return { ok: false, error: 'Agent IDs starting with _ are reserved for templates' };

  // Check for collisions
  const existing = listAgentIds();
  if (existing.includes(id)) {
    return { ok: false, error: `Agent "${id}" already exists` };
  }

  return { ok: true };
}

export async function validateBotToken(token: string): Promise<{ ok: boolean; botInfo?: BotInfo; error?: string }> {
  if (!token || !token.includes(':')) {
    return { ok: false, error: 'Invalid token format. Tokens look like 123456789:ABCdefGHIjklMNO...' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json() as { ok: boolean; result?: BotInfo; description?: string };

    if (!data.ok || !data.result) {
      return { ok: false, error: data.description || 'Token validation failed' };
    }

    if (!data.result.is_bot) {
      return { ok: false, error: 'Token does not belong to a bot' };
    }

    return { ok: true, botInfo: data.result };
  } catch {
    return { ok: false, error: 'Could not reach Telegram API. Check your network connection.' };
  }
}

// ── Templates ────────────────────────────────────────────────────────

export function listTemplates(): AgentTemplate[] {
  const templates: AgentTemplate[] = [];
  const agentsDir = path.join(PROJECT_ROOT, 'agents');

  if (!fs.existsSync(agentsDir)) return templates;

  for (const dir of fs.readdirSync(agentsDir)) {
    // Include _template and any agent dir that has an agent.yaml.example or agent.yaml
    const fullDir = path.join(agentsDir, dir);
    if (!fs.statSync(fullDir).isDirectory()) continue;

    const yamlExample = path.join(fullDir, 'agent.yaml.example');
    const yamlFile = path.join(fullDir, 'agent.yaml');
    const hasConfig = fs.existsSync(yamlExample) || fs.existsSync(yamlFile);
    if (!hasConfig) continue;

    // Read name + description from whichever config exists
    let name = dir === '_template' ? 'Blank' : dir;
    let description = dir === '_template' ? 'Start from a blank template' : '';

    try {
      const configPath = fs.existsSync(yamlFile) ? yamlFile : yamlExample;
      const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      if (raw['name'] && typeof raw['name'] === 'string') name = raw['name'];
      if (raw['description'] && typeof raw['description'] === 'string') description = raw['description'];
    } catch { /* use defaults */ }

    templates.push({ id: dir, name, description });
  }

  // Sort: _template (blank) last, others alphabetical
  templates.sort((a, b) => {
    if (a.id === '_template') return 1;
    if (b.id === '_template') return -1;
    return a.id.localeCompare(b.id);
  });

  return templates;
}

// ── Create ───────────────────────────────────────────────────────────

export async function createAgent(opts: CreateAgentOpts): Promise<CreateAgentResult> {
  const { id, name, description, model, runtime, template, botToken } = opts;

  // Validate ID
  const idCheck = validateAgentId(id);
  if (!idCheck.ok) throw new Error(idCheck.error);

  // Max agent limit
  const existing = listAgentIds();
  if (existing.length >= 20) throw new Error('Maximum of 20 agents reached. Delete unused agents first.');

  // Validate token
  const tokenCheck = await validateBotToken(botToken);
  if (!tokenCheck.ok || !tokenCheck.botInfo) throw new Error(tokenCheck.error || 'Token validation failed');

  // Check token isn't already in use by another agent
  for (const existingId of existing) {
    try {
      const existingConfig = loadAgentConfig(existingId);
      if (existingConfig.botToken === botToken) {
        throw new Error(`This bot token is already used by agent "${existingId}"`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('already used')) throw err;
      // Skip agents with broken configs
    }
  }

  // Determine agent directory (prefer CLAUDECLAW_CONFIG if it exists)
  let agentDir: string;
  const externalAgentsDir = path.join(CLAUDECLAW_CONFIG, 'agents');
  if (fs.existsSync(CLAUDECLAW_CONFIG)) {
    agentDir = path.join(externalAgentsDir, id);
  } else {
    agentDir = path.join(PROJECT_ROOT, 'agents', id);
  }

  fs.mkdirSync(agentDir, { recursive: true });

  // Resolve template directory
  const templateId = template || '_template';
  const templateDir = path.join(PROJECT_ROOT, 'agents', templateId);

  // Copy CLAUDE.md from template
  const claudeMdSources = [
    path.join(templateDir, 'CLAUDE.md'),
    path.join(templateDir, 'CLAUDE.md.example'),
    path.join(PROJECT_ROOT, 'agents', '_template', 'CLAUDE.md'),
  ];
  for (const src of claudeMdSources) {
    if (fs.existsSync(src)) {
      let content = fs.readFileSync(src, 'utf-8');
      // Replace template agent ID references with the new agent ID
      content = content.replace(/\[AGENT_ID\]/g, id);
      // Guarantee the file-send section regardless of which template was
      // picked. The _template version has it, but Comms/Content/Ops/etc.
      // (which users can pick as templates) might not — those files are
      // gated by the pre-commit hook so we can't modify them in-repo.
      // Appending here ensures every newly-created agent knows about the
      // [SEND_FILE:...] / [SEND_PHOTO:...] markers without exception.
      if (!/\[SEND_FILE:/.test(content) && !/\[SEND_PHOTO:/.test(content)) {
        content = content.replace(/\s*$/, '') + '\n' + FILE_SEND_SECTION + '\n';
      }
      fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), content, 'utf-8');
      break;
    }
  }

  // Create agent.yaml
  const envKey = `${id.toUpperCase().replace(/-/g, '_')}_BOT_TOKEN`;
  const agentYaml: Record<string, unknown> = {
    name,
    description,
    telegram_bot_token_env: envKey,
    runtime: runtime || 'claude',
    model: model || 'claude-sonnet-4-6',
  };
  fs.writeFileSync(
    path.join(agentDir, 'agent.yaml'),
    yaml.dump(agentYaml, { lineWidth: -1 }),
    'utf-8',
  );

  // Write bot token to .env
  const envPath = path.join(PROJECT_ROOT, '.env');
  writeBotTokenToEnv(envPath, envKey, botToken, id);

  // Generate launchd plist (or systemd unit)
  const plistPath = generateServiceConfig(id);

  logger.info({ agentId: id, agentDir, envKey, bot: tokenCheck.botInfo.username }, 'Agent created');

  // Propagate the new agent into all delegation surfaces without a bot
  // restart:
  //   - Text War Room reads listAllAgents() live each turn — already current.
  //   - Voice War Room snapshots /tmp/warroom-agents.json at Pipecat startup
  //     — we rewrite it and SIGKILL Pipecat so respawn picks up the change.
  //   - Orchestrator agentRegistry is cached at main startup — refresh it
  //     so @delegate: syntax sees the new agent immediately.
  refreshWarRoomRoster();
  refreshAgentRegistry();
  void bounceVoiceWarRoom('agent created: ' + id);

  return {
    agentId: id,
    agentDir,
    envKey,
    plistPath,
    botInfo: tokenCheck.botInfo,
  };
}

// ── .env management ──────────────────────────────────────────────────

function writeBotTokenToEnv(envPath: string, envKey: string, token: string, agentId: string): void {
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch { /* .env might not exist yet */ }

  const lines = content.split('\n');
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith(`${envKey}=`)) {
      lines[i] = `${envKey}=${token}`;
      found = true;
      break;
    }
  }

  if (!found) {
    // Append with a comment
    if (content.length > 0 && !content.endsWith('\n')) {
      lines.push('');
    }
    lines.push(`# Agent: ${agentId}`);
    lines.push(`${envKey}=${token}`);
  }

  atomicEnvWrite(envPath, lines.join('\n'));
}

function removeBotTokenFromEnv(envPath: string, envKey: string, agentId: string): void {
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');
  const filtered: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Skip the token line
    if (trimmed.startsWith(`${envKey}=`)) continue;
    // Skip the "# Agent: id" comment right before the token
    if (trimmed === `# Agent: ${agentId}` && i + 1 < lines.length && lines[i + 1].trim().startsWith(`${envKey}=`)) {
      continue;
    }
    filtered.push(lines[i]);
  }

  atomicEnvWrite(envPath, filtered.join('\n'));
}

// ── Service config generation ────────────────────────────────────────

function generateServiceConfig(agentId: string): string | null {
  if (IS_MACOS) return generateLaunchdPlist(agentId);
  if (IS_LINUX) return generateSystemdUnit(agentId);
  // Windows: no per-agent service config. Main bot spawns agents as
  // detached child processes at activate time (see activateWindows).
  return null;
}

function generateLaunchdPlist(agentId: string): string {
  const plistDir = path.join(PROJECT_ROOT, 'launchd');
  fs.mkdirSync(plistDir, { recursive: true });

  const label = `com.claudeclaw.${agentId}`;
  const plistPath = path.join(plistDir, `${label}.plist`);

  // Use the same Node binary that's running this process (works with nvm, homebrew, or system node)
  const nodePath = process.execPath;
  const nodeBinDir = path.dirname(nodePath);

  // Build PATH: node's bin dir first, then standard system paths
  const systemPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const allPaths = [nodeBinDir, ...systemPaths.filter(p => p !== nodeBinDir)];
  const envPath = allPaths.join(':');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>dist/index.js</string>
    <string>--agent</string>
    <string>${agentId}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>__PROJECT_DIR__</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>${envPath}</string>
    <key>HOME</key>
    <string>__HOME__</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>__LOG_DIR__/${agentId}.log</string>
  <key>StandardErrorPath</key>
  <string>__LOG_DIR__/${agentId}.log</string>
</dict>
</plist>
`;

  fs.writeFileSync(plistPath, plist, 'utf-8');
  return plistPath;
}

function generateSystemdUnit(agentId: string): string {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });

  const serviceName = `com.claudeclaw.agent-${agentId}`;
  const unitPath = path.join(unitDir, `${serviceName}.service`);

  const nodePath = process.execPath;

  const unit = `[Unit]
Description=ClaudeClaw Agent: ${agentId}
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${PROJECT_ROOT}/dist/index.js --agent ${agentId}
WorkingDirectory=${PROJECT_ROOT}
Environment=NODE_ENV=production
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;

  fs.writeFileSync(unitPath, unit, 'utf-8');
  return unitPath;
}

// ── Activate / Deactivate ────────────────────────────────────────────

export interface ActivationResult {
  ok: boolean;
  error?: string;
  pid?: number;
}

export function activateAgent(agentId: string): ActivationResult {
  if (!VALID_ID_RE.test(agentId)) {
    return { ok: false, error: `Invalid agent ID format: ${agentId}` };
  }
  try {
    if (IS_MACOS) return activateLaunchd(agentId);
    if (IS_LINUX) return activateSystemd(agentId);
    if (IS_WINDOWS) {
      const result = activateWindows(agentId);
      if (!result.ok) {
        return {
          ok: false,
          error:
            `${result.error ?? 'Windows activation failed'}\n` +
            claudeCodeHandoff({
              projectRoot: PROJECT_ROOT,
              what: `Activating agent "${agentId}"`,
              error: result.error,
              file: 'src/agent-create.ts (activateWindows function)',
            }),
        };
      }
      return result;
    }
    return { ok: false, error: `Unsupported platform: ${os.platform()}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function activateLaunchd(agentId: string): ActivationResult {
  const label = `com.claudeclaw.${agentId}`;
  const templatePlist = path.join(PROJECT_ROOT, 'launchd', `${label}.plist`);
  const destPlist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

  if (!fs.existsSync(templatePlist)) {
    return { ok: false, error: `Plist not found: ${templatePlist}` };
  }

  // launchd silently exits with code 78 (EX_CONFIG) when StandardOutPath /
  // StandardErrorPath contain spaces. PROJECT_ROOT can contain spaces if
  // the user installed under a folder name with whitespace. Route logs
  // through ~/Library/Logs/claudeclaw/<agent>.log instead, which lives
  // under the macOS home directory (space-free for any normal username).
  const logDir = path.join(os.homedir(), 'Library', 'Logs', 'claudeclaw');
  fs.mkdirSync(logDir, { recursive: true });
  if (logDir.includes(' ')) {
    return { ok: false, error: `Log directory contains spaces (launchd exit 78 risk): ${logDir}` };
  }

  // Substitute placeholders
  let content = fs.readFileSync(templatePlist, 'utf-8');
  content = content.replace(/__PROJECT_DIR__/g, PROJECT_ROOT);
  content = content.replace(/__HOME__/g, os.homedir());
  content = content.replace(/__LOG_DIR__/g, logDir);

  // Ensure LaunchAgents directory exists
  fs.mkdirSync(path.dirname(destPlist), { recursive: true });

  // Unload if already loaded
  try {
    execSync(`launchctl unload "${destPlist}" 2>/dev/null`, { stdio: 'ignore' });
  } catch { /* not loaded */ }

  fs.writeFileSync(destPlist, content, 'utf-8');
  execSync(`launchctl load "${destPlist}"`);

  // Wait briefly and check if process started
  let pid: number | undefined;
  for (let i = 0; i < 5; i++) {
    const pidFile = path.join(STORE_DIR, `agent-${agentId}.pid`);
    if (fs.existsSync(pidFile)) {
      const p = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!isNaN(p) && isProcessAlive(p)) { pid = p; break; }
    }
    // Brief synchronous wait
    execSync('sleep 1', { stdio: 'ignore' });
  }

  logger.info({ agentId, pid }, 'Agent activated (launchd)');
  return { ok: true, pid };
}

function activateSystemd(agentId: string): ActivationResult {
  const serviceName = `com.claudeclaw.agent-${agentId}`;
  try {
    execSync(`systemctl --user daemon-reload`, { stdio: 'ignore' });
    execSync(`systemctl --user enable "${serviceName}"`, { stdio: 'ignore' });
    execSync(`systemctl --user start "${serviceName}"`, { stdio: 'ignore' });
    logger.info({ agentId }, 'Agent activated (systemd)');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Activate an agent on Windows by spawning a detached child process.
 * The main bot owns it; to deactivate we kill the PID. No schtasks,
 * no service, no UAC. If the main bot exits the agent will exit too,
 * which is fine since the user controls main bot lifecycle (terminal,
 * PM2, or the scheduled task the wizard installed).
 */
function activateWindows(agentId: string): ActivationResult {
  const entry = path.join(PROJECT_ROOT, 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    return { ok: false, error: `Build output missing: ${entry}. Run "npm run build" first.` };
  }

  const logsDir = path.join(PROJECT_ROOT, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `${agentId}.log`);
  const out = fs.openSync(logFile, 'a');

  try {
    const child = spawn(process.execPath, [entry, '--agent', agentId], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, NODE_ENV: 'production' },
      windowsHide: true,
    });
    child.unref();

    if (!child.pid) {
      return { ok: false, error: 'Failed to spawn agent child process' };
    }

    // Persist the PID so deactivate/restart can find it across restarts
    // of the main bot.
    fs.writeFileSync(path.join(STORE_DIR, `agent-${agentId}.pid`), String(child.pid), 'utf-8');

    logger.info({ agentId, pid: child.pid }, 'Agent activated (Windows detached child)');
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function deactivateAgent(agentId: string): { ok: boolean; error?: string } {
  if (!VALID_ID_RE.test(agentId)) {
    return { ok: false, error: `Invalid agent ID format: ${agentId}` };
  }
  try {
    if (IS_MACOS) {
      const label = `com.claudeclaw.${agentId}`;
      const destPlist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      if (fs.existsSync(destPlist)) {
        try { execSync(`launchctl unload "${destPlist}"`, { stdio: 'ignore' }); } catch { /* ok */ }
        fs.unlinkSync(destPlist);
      }
    } else if (IS_LINUX) {
      const serviceName = `com.claudeclaw.agent-${agentId}`;
      try {
        execSync(`systemctl --user stop "${serviceName}"`, { stdio: 'ignore' });
        execSync(`systemctl --user disable "${serviceName}"`, { stdio: 'ignore' });
      } catch { /* ok */ }
      const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', `${serviceName}.service`);
      if (fs.existsSync(unitPath)) fs.unlinkSync(unitPath);
      try { execSync('systemctl --user daemon-reload', { stdio: 'ignore' }); } catch { /* ok */ }
    }
    // On Windows there's no service to unregister. The shared kill logic
    // below handles stopping the detached child via its PID file.

    // Kill the process if still running (cross-platform)
    const pidFile = path.join(STORE_DIR, `agent-${agentId}.pid`);
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!isNaN(pid)) killProcess(pid);
      try { fs.unlinkSync(pidFile); } catch { /* ok */ }
    }

    logger.info({ agentId }, 'Agent deactivated');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Delete ───────────────────────────────────────────────────────────

export function deleteAgent(agentId: string): { ok: boolean; error?: string } {
  if (!VALID_ID_RE.test(agentId)) {
    return { ok: false, error: `Invalid agent ID format: ${agentId}` };
  }
  // Deactivate first
  deactivateAgent(agentId);

  const envKey = `${agentId.toUpperCase().replace(/-/g, '_')}_BOT_TOKEN`;

  try {
    // Remove agent directory (both possible locations)
    for (const baseDir of [
      path.join(CLAUDECLAW_CONFIG, 'agents'),
      path.join(PROJECT_ROOT, 'agents'),
    ]) {
      const agentDir = path.join(baseDir, agentId);
      if (fs.existsSync(agentDir)) {
        fs.rmSync(agentDir, { recursive: true, force: true });
      }
    }

    // Remove launchd plist template (macOS)
    const plistTemplate = path.join(PROJECT_ROOT, 'launchd', `com.claudeclaw.${agentId}.plist`);
    if (fs.existsSync(plistTemplate)) fs.unlinkSync(plistTemplate);

    // Remove token from .env
    removeBotTokenFromEnv(path.join(PROJECT_ROOT, '.env'), envKey, agentId);

    // Remove log files (both the legacy in-project location and the new
    // ~/Library/Logs/claudeclaw location written by activateLaunchd).
    const legacyLog = path.join(PROJECT_ROOT, 'logs', `${agentId}.log`);
    if (fs.existsSync(legacyLog)) fs.unlinkSync(legacyLog);
    const macLog = path.join(os.homedir(), 'Library', 'Logs', 'claudeclaw', `${agentId}.log`);
    if (fs.existsSync(macLog)) fs.unlinkSync(macLog);

    logger.info({ agentId }, 'Agent deleted');
    // Keep all delegation surfaces in sync. Voice stack needs the
    // subprocess bounce so the deleted agent stops appearing in its
    // roster (VALID_AGENTS is imported once at module load).
    refreshWarRoomRoster();
    refreshAgentRegistry();
    void bounceVoiceWarRoom('agent deleted: ' + agentId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Suggest a bot display name and username based on agent ID. */
export function suggestBotNames(agentId: string): { displayName: string; username: string } {
  const label = agentId.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return {
    displayName: `ClaudeClaw ${label}`,
    username: `claudeclaw_${agentId.replace(/-/g, '_')}_bot`,
  };
}

/** Pick a color for a new agent (avoids colors already used by existing agents). */
export function pickAgentColor(existingCount: number): string {
  return AGENT_COLOR_PALETTE[existingCount % AGENT_COLOR_PALETTE.length];
}

/** Check if an agent process is currently running. */
/**
 * Restart an agent by deactivating then reactivating its service.
 * Works on both macOS (launchd) and Linux (systemd).
 */
export function restartAgent(agentId: string): { ok: boolean; error?: string } {
  // Validate agent ID format to prevent shell injection
  if (!VALID_ID_RE.test(agentId)) {
    return { ok: false, error: `Invalid agent ID format: ${agentId}` };
  }
  try {
    if (IS_MACOS) {
      const label = `com.claudeclaw.${agentId}`;
      const destPlist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      if (!fs.existsSync(destPlist)) {
        return { ok: false, error: `Agent ${agentId} is not installed (no plist found)` };
      }
      const uid = os.userInfo().uid;
      try {
        execSync(`launchctl kickstart -k gui/${uid}/${label}`, { stdio: 'ignore' });
      } catch {
        try { execSync(`launchctl unload "${destPlist}"`, { stdio: 'ignore' }); } catch { /* ok */ }
        execSync(`launchctl load "${destPlist}"`);
      }
      logger.info({ agentId }, 'Agent restarted (launchd)');
      return { ok: true };
    } else if (IS_LINUX) {
      const serviceName = `com.claudeclaw.agent-${agentId}`;
      execSync(`systemctl --user restart "${serviceName}"`, { stdio: 'ignore' });
      logger.info({ agentId }, 'Agent restarted (systemd)');
      return { ok: true };
    } else if (IS_WINDOWS) {
      // Kill existing child (if any) then re-spawn.
      const pidFile = path.join(STORE_DIR, `agent-${agentId}.pid`);
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
        if (!isNaN(pid)) killProcess(pid, true);
        try { fs.unlinkSync(pidFile); } catch { /* ok */ }
      }
      const result = activateWindows(agentId);
      if (!result.ok) return { ok: false, error: result.error };
      logger.info({ agentId, pid: result.pid }, 'Agent restarted (Windows detached child)');
      return { ok: true };
    }
    return { ok: false, error: `Unsupported platform: ${os.platform()}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function isAgentRunning(agentId: string): boolean {
  const pidFile = path.join(STORE_DIR, `agent-${agentId}.pid`);
  if (!fs.existsSync(pidFile)) return false;
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    return isProcessAlive(pid);
  } catch {
    return false;
  }
}
