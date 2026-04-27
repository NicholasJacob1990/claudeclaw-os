import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { logger } from '../logger.js';
import { detect } from './detector.js';
import { enrich } from './enrichment.js';
import type { EnrichedSuggestion, Suggestion, TranscriptMessage } from './types.js';

// ── Config (resolved at call time to allow test overrides) ───────────────────

function outputDir(): string {
  const raw = process.env.SKILL_SUGGESTION_OUTPUT_DIR;
  return raw
    ? path.resolve(raw.replace(/^~/, os.homedir()))
    : path.join(os.homedir(), '.claude', 'skills', 'auto-suggested', '_pending');
}

function approvedDir(): string {
  return path.join(os.homedir(), '.claude', 'skills', 'auto-suggested');
}

function storeDir(): string {
  return process.env.CLAUDECLAW_STORE_DIR
    ? path.resolve(process.env.CLAUDECLAW_STORE_DIR)
    : path.join(os.homedir(), '.claudeclaw', 'store');
}

// ── Database ────────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const sd = storeDir();
  fs.mkdirSync(sd, { recursive: true });
  const dbPath = path.join(sd, 'skill-suggestions.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS skill_suggestions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      signature     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      draft_path    TEXT,
      skill_name    TEXT,
      model         TEXT,
      duration_ms   INTEGER,
      cost_usd      REAL,
      signals       TEXT NOT NULL DEFAULT '{}',
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ss_signature ON skill_suggestions(signature);
    CREATE INDEX IF NOT EXISTS idx_ss_session ON skill_suggestions(session_id);
    CREATE INDEX IF NOT EXISTS idx_ss_status ON skill_suggestions(status, created_at DESC);
  `);
  return _db;
}

// ── Idempotency ──────────────────────────────────────────────────────────────

function alreadyHandled(sig: string, sessionId: string): boolean {
  // Fast path: check DB record.
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT id FROM skill_suggestions WHERE signature = ? OR session_id = ? LIMIT 1`,
    ).get(sig, sessionId);
    if (row) return true;
  } catch {
    // DB unavailable — fall through to filesystem check.
  }

  // Filesystem fallback: scan _pending/ and approved/ dirs.
  const pendingDir = outputDir();
  const approvDir = approvedDir();
  const sidShort = sessionId.slice(0, 8);

  if (fs.existsSync(pendingDir)) {
    for (const entry of fs.readdirSync(pendingDir)) {
      if (!entry.startsWith('SUGGESTION-') || !entry.endsWith('.md')) continue;
      if (entry.includes(sig)) return true;
      try {
        const head = fs.readFileSync(path.join(pendingDir, entry), 'utf-8').slice(0, 500);
        if (sidShort && head.includes(`session_id: ${sidShort}`)) return true;
        if (sessionId && head.includes(`session_id: ${sessionId}`)) return true;
      } catch { /* skip unreadable files */ }
    }
  }
  if (fs.existsSync(approvDir)) {
    for (const entry of fs.readdirSync(approvDir)) {
      if (entry.includes(sig)) return true;
    }
  }
  return false;
}

// ── Draft rendering (template fallback) ─────────────────────────────────────

function renderDraft(suggestion: Suggestion): string {
  const { signature: sig, session_id: sid, signals: sigs, tool_sequence: seq, files_touched: files, first_user_msg: first, last_user_msg: last, danger_hits: danger } = suggestion;
  const now = new Date().toISOString();

  let dangerSection = '';
  if (danger.length > 0) {
    const items = danger.slice(0, 5).map((d) => `  - \`${d}\``).join('\n');
    dangerSection = `\n## Security flag\n${danger.length} potentially dangerous Bash command(s) detected:\n${items}\n\nReview carefully before promoting this skill.\n`;
  }

  const filesMd = files.length > 0 ? files.map((p) => `- \`${p}\``).join('\n') : '(none)';
  const seqMd = seq.map((n, i) => `${i + 1}. \`${n}\``).join('\n');

  return `---
type: skill-suggestion
generated: ${now}
session_id: ${sid}
signature: ${sig}
status: pending
---

# Skill suggestion (auto-detected)

> Complex session detected — crossed complexity threshold. Review and decide if it becomes a skill.

## Signals
- \`tool_calls\`: ${sigs.tool_calls}
- \`distinct_files_edited\`: ${sigs.distinct_files_edited}
- \`distinct_tool_types\`: ${sigs.distinct_tool_types}
- \`skill_invocations\`: ${sigs.skill_invocations}
- \`user_turns\`: ${sigs.user_turns}

## Task context

**First user message:**
> ${first}

**Last user message:**
> ${last}

## Tools used (unique sequence, top 20)
${seqMd}

## Files touched (top 30)
${filesMd}
${dangerSection}
## What to do

- **If worth a skill:** invoke \`/skill-creator\` using this draft as input. Move to \`~/.claude/skills/auto-suggested/<slug>/SKILL.md\`
- **If not:** delete this file
`;
}

// ── Persist record ────────────────────────────────────────────────────────────

function persistRecord(
  suggestion: Suggestion,
  draftPath: string | null,
  enriched: EnrichedSuggestion | null,
): void {
  try {
    getDb().prepare(`
      INSERT OR IGNORE INTO skill_suggestions
        (session_id, signature, status, draft_path, skill_name, model, duration_ms, cost_usd, signals)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(
      suggestion.session_id,
      suggestion.signature,
      draftPath,
      enriched?.name ?? null,
      enriched?.model ?? null,
      enriched?.duration_ms ?? null,
      enriched?.cost_usd_reported ?? null,
      JSON.stringify(suggestion.signals),
    );
  } catch (err) {
    logger.warn({ err }, 'skill_suggestions DB insert failed (non-fatal)');
  }
}

// ── Result type ───────────────────────────────────────────────────────────────

export type ProcessResult =
  | { triggered: false; reason: string }
  | { triggered: true; draftPath: string; enriched: boolean; suggestion: Suggestion };

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Process a session's transcript messages through the full pipeline:
 *   detect → idempotency check → enrich (optional) → write draft → persist to DB.
 *
 * Returns a ProcessResult so callers can surface Telegram notifications.
 */
export async function processSession(
  messages: TranscriptMessage[],
  sessionId: string,
  abortController?: AbortController,
): Promise<ProcessResult> {
  let suggestion: Suggestion | null;

  try {
    suggestion = detect(messages, sessionId);
  } catch (err) {
    logger.error({ err }, 'skill-suggestion detect() threw');
    return { triggered: false, reason: 'detect error' };
  }

  if (!suggestion) {
    return { triggered: false, reason: 'below threshold' };
  }

  if (alreadyHandled(suggestion.signature, sessionId)) {
    logger.debug(
      { sig: suggestion.signature, session: sessionId.slice(0, 8) },
      'skill-suggestion: already handled',
    );
    return { triggered: false, reason: 'already handled (idempotent)' };
  }

  const outDir = outputDir();
  fs.mkdirSync(outDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sig = suggestion.signature;

  // Try LLM enrichment first (Sonnet via subscription, $0 real).
  let enrichedResult: EnrichedSuggestion | null = null;
  try {
    enrichedResult = await enrich(suggestion, abortController);
  } catch (err) {
    logger.warn({ err }, 'skill-suggestion enrich() threw; using template fallback');
  }

  let draftPath: string;

  if (enrichedResult) {
    draftPath = path.join(outDir, `SUGGESTION-${ts}-${sig}-${enrichedResult.name}.md`);
    const audit = [
      '\n\n<!-- audit',
      `session_id: ${sessionId}`,
      `signature: ${sig}`,
      `model: ${enrichedResult.model}`,
      `duration_ms: ${enrichedResult.duration_ms ?? 'null'}`,
      `cost_usd_reported: ${enrichedResult.cost_usd_reported ?? 'null'}  (estimate; subscription = $0 real)`,
      '-->',
      '',
    ].join('\n');
    fs.writeFileSync(draftPath, enrichedResult.skill_md + audit, 'utf-8');
    logger.info(
      { file: path.basename(draftPath), sig, model: enrichedResult.model, dur: enrichedResult.duration_ms },
      'skill-suggestion: wrote enriched draft',
    );
  } else {
    draftPath = path.join(outDir, `SUGGESTION-${ts}-${sig}.md`);
    fs.writeFileSync(draftPath, renderDraft(suggestion), 'utf-8');
    logger.info(
      { file: path.basename(draftPath), sig, calls: suggestion.signals.tool_calls },
      'skill-suggestion: wrote template draft (enrichment skipped or failed)',
    );
  }

  persistRecord(suggestion, draftPath, enrichedResult);

  return {
    triggered: true,
    draftPath,
    enriched: enrichedResult !== null,
    suggestion,
  };
}

/**
 * Parse a JSONL transcript file and run processSession().
 * Convenience wrapper for the post-session hook.
 */
export async function processTranscriptFile(
  transcriptPath: string,
  sessionId: string,
): Promise<ProcessResult> {
  let messages: TranscriptMessage[];
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    messages = raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as TranscriptMessage; }
        catch { return null; }
      })
      .filter((m): m is TranscriptMessage => m !== null);
  } catch (err) {
    logger.error({ err, transcriptPath }, 'skill-suggestion: failed to read transcript');
    return { triggered: false, reason: 'transcript read error' };
  }

  return processSession(messages, sessionId);
}

/** Exposed for tests: reset the cached DB connection. */
export function _resetDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Small helper exposed for tests. */
export function _mockSignature(): string {
  return crypto.randomBytes(4).toString('hex');
}
