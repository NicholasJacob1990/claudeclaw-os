/**
 * annotator.ts - Orchestrates the full skill annotation pipeline.
 *
 * Flow:
 *   1. Parse JSONL transcript
 *   2. Find (Skill invocation, next user message) pairs
 *   3. For each pair that passes the keyword gate: call LLM judge
 *   4. If verdict == "yes": append annotation to the SKILL.md file
 *
 * Idempotence: uses a hash of (skill + session_id + excerpt_hash) to avoid
 * duplicate annotations both in-memory (SQLite) and on-disk (existing notes).
 *
 * Append-only: never rewrites skill body, only appends under the section header.
 * Hard cap of ANNOTATION_CAP notes per skill to prevent runaway growth.
 *
 * Ported from annotate_skills.py in the Python learning-loop.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { logger } from '../logger.js';
import { judge } from './judge.js';
import { findCorrectionPairs, parseTranscript } from './transcript-parser.js';
import { passesHeuristicOnly } from './keyword-score.js';
import type { AnnotationResult, CorrectionPair } from './types.js';

// -- Config -----------------------------------------------------------------------

export const SECTION_HEADER = '## Notas de uso (auto-coletadas)';
export const CAP_MARKER = '<!-- annotation cap reached, human review needed -->';
export const ANNOTATION_CAP = 10;

function skillsDir(): string {
  return process.env.SKILL_ANNOTATIONS_SKILLS_DIR
    ? path.resolve(process.env.SKILL_ANNOTATIONS_SKILLS_DIR.replace(/^~/, os.homedir()))
    : path.join(os.homedir(), '.claude', 'skills');
}

function storeDir(): string {
  return process.env.CLAUDECLAW_STORE_DIR
    ? path.resolve(process.env.CLAUDECLAW_STORE_DIR)
    : path.join(os.homedir(), '.claudeclaw', 'store');
}

// -- Database ----------------------------------------------------------------------

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const sd = storeDir();
  fs.mkdirSync(sd, { recursive: true });
  const dbPath = path.join(sd, 'skill-annotations.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS skill_annotations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      skill       TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      excerpt_hash TEXT NOT NULL,
      verdict     TEXT NOT NULL,
      reason      TEXT,
      model       TEXT,
      cost_usd    REAL,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sa_key
      ON skill_annotations(skill, session_id, excerpt_hash);
  `);
  return _db;
}

export function _resetDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// -- Helpers -----------------------------------------------------------------------

function excerptHash(s: string): string {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 8);
}

function isAlreadyAnnotated(skill: string, sessionId: string, exHash: string): boolean {
  try {
    const row = getDb()
      .prepare(
        `SELECT id FROM skill_annotations WHERE skill = ? AND session_id = ? AND excerpt_hash = ? LIMIT 1`,
      )
      .get(skill, sessionId, exHash);
    return !!row;
  } catch {
    return false;
  }
}

function recordAnnotation(
  skill: string,
  sessionId: string,
  exHash: string,
  verdict: string,
  reason: string,
  model: string,
  costUsd: number | null,
): void {
  try {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO skill_annotations (skill, session_id, excerpt_hash, verdict, reason, model, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(skill, sessionId, exHash, verdict, reason, model, costUsd);
  } catch (err) {
    logger.warn({ err }, 'skill_annotations DB insert failed (non-fatal)');
  }
}

// -- Skill file operations ----------------------------------------------------------

function resolveSkillPath(skillName: string): string | null {
  if (skillName.includes(':')) return null; // plugin namespace, read-only
  const p = path.join(skillsDir(), skillName, 'SKILL.md');
  return fs.existsSync(p) ? p : null;
}

function isHermesSkill(text: string): boolean {
  const parts = text.split('\n---\n');
  const head = parts[0] ?? '';
  const body = parts[1] ?? '';
  return head.includes('author: Hermes Agent') || body.includes('author: Hermes Agent');
}

/** Returns [sectionStart, sectionEnd] indices, or null if section not found. */
function findSectionBounds(text: string): [number, number] | null {
  const idx = text.indexOf(SECTION_HEADER);
  if (idx < 0) return null;
  const rest = text.slice(idx + SECTION_HEADER.length);
  const nxt = /\n## /.exec(rest);
  const end = idx + SECTION_HEADER.length + (nxt ? nxt.index : rest.length);
  return [idx, end];
}

function existingHashes(sectionBody: string): Set<string> {
  const matches = [...sectionBody.matchAll(/<!-- h:([0-9a-f]{8}) -->/g)];
  return new Set(matches.map((m) => m[1]));
}

function countExistingNotes(sectionBody: string): number {
  return [...sectionBody.matchAll(/^- \d{4}-\d{2}-\d{2} \u2014/gm)].length;
}

function buildNote(pair: CorrectionPair, sessionId: string, reason: string): string {
  const date = pair.ts.slice(0, 10);
  const h = excerptHash(pair.excerpt);
  const excerpt = pair.excerpt.replace(/\n/g, ' ').replace(/"/g, "'").slice(0, 160);
  const sidShort = sessionId.slice(0, 8) || '?';
  const reasonText = reason ? ` Motivo: ${reason.slice(0, 100)}.` : '';
  return `- ${date} \u2014 sinal de corre\u00e7\u00e3o p\u00f3s-invoca\u00e7\u00e3o. Trecho: "${excerpt}"${reasonText} Sess\u00e3o: ${sidShort} <!-- h:${h} -->`;
}

/**
 * Append an annotation note to the SKILL.md at skillPath.
 * Returns an AnnotationResult string describing the outcome.
 *
 * @param skillPath - Absolute path to SKILL.md.
 * @param pair - The correction pair detected.
 * @param sessionId - The Claude Code session ID.
 * @param reason - Reason from the judge.
 * @param dryRun - If true, simulate but do not write.
 */
export function annotateSkillFile(
  skillPath: string,
  pair: CorrectionPair,
  sessionId: string,
  reason: string,
  dryRun = false,
): AnnotationResult {
  let text: string;
  try {
    text = fs.readFileSync(skillPath, 'utf-8');
  } catch (err) {
    return `error:read:${String(err).slice(0, 80)}` as AnnotationResult;
  }

  if (isHermesSkill(text)) return 'skip:hermes';

  const exHash = excerptHash(pair.excerpt);
  const note = buildNote(pair, sessionId, reason);

  const bounds = findSectionBounds(text);
  if (bounds) {
    const [secStart, secEnd] = bounds;
    const sectionBody = text.slice(secStart, secEnd);

    if (existingHashes(sectionBody).has(exHash)) return 'skip:dup';

    if (countExistingNotes(sectionBody) >= ANNOTATION_CAP) {
      if (!text.includes(CAP_MARKER)) {
        const newText = text.slice(0, secEnd).trimEnd() + `\n\n${CAP_MARKER}\n` + text.slice(secEnd);
        if (!dryRun) fs.writeFileSync(skillPath, newText, 'utf-8');
        return 'cap:marked';
      }
      return 'skip:capped';
    }

    const insertion = `\n${note}`;
    const newText = text.slice(0, secEnd).trimEnd() + insertion + '\n' + text.slice(secEnd);
    if (!dryRun) fs.writeFileSync(skillPath, newText, 'utf-8');
    return 'appended';
  } else {
    // Create section at end of file
    const newText = text.trimEnd() + `\n\n${SECTION_HEADER}\n\n${note}\n`;
    if (!dryRun) fs.writeFileSync(skillPath, newText, 'utf-8');
    return 'created+appended';
  }
}

// -- Public API ------------------------------------------------------------------

export interface AnnotateTranscriptOptions {
  transcriptPath: string;
  sessionId: string;
  dryRun?: boolean;
  abortController?: AbortController;
}

export interface AnnotateTranscriptResult {
  pairsFound: number;
  pairsProcessed: number;
  results: Array<{ skill: string; result: AnnotationResult }>;
}

/**
 * Full pipeline: parse transcript, find correction pairs, judge with LLM,
 * annotate SKILL.md files.
 */
export async function annotateTranscript(
  opts: AnnotateTranscriptOptions,
): Promise<AnnotateTranscriptResult> {
  const { transcriptPath, sessionId, dryRun = false, abortController } = opts;

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(transcriptPath, 'utf-8');
  } catch (err) {
    logger.error({ err, transcriptPath }, 'skill-annotations: failed to read transcript');
    return { pairsFound: 0, pairsProcessed: 0, results: [] };
  }

  const entries = parseTranscript(rawContent);
  const pairs = findCorrectionPairs(entries);

  if (pairs.length === 0) {
    logger.debug({ transcriptPath }, 'skill-annotations: no correction pairs found');
    return { pairsFound: 0, pairsProcessed: 0, results: [] };
  }

  const results: Array<{ skill: string; result: AnnotationResult }> = [];

  for (const pair of pairs) {
    const skillPath = resolveSkillPath(pair.skill);
    if (!skillPath) {
      results.push({ skill: pair.skill, result: 'skip:not-local' });
      continue;
    }

    const exHash = excerptHash(pair.excerpt);

    // Idempotency check
    if (isAlreadyAnnotated(pair.skill, sessionId, exHash)) {
      results.push({ skill: pair.skill, result: 'skip:dup' });
      continue;
    }

    // LLM judge gate
    let verdictYes = false;
    let reason = '';
    let model = 'heuristic';
    let costUsd: number | null = null;

    const judgeResult = await judge(pair.skill, pair.excerpt, '', abortController).catch(() => null);

    if (judgeResult) {
      verdictYes = judgeResult.verdict === 'yes';
      reason = judgeResult.reason;
      model = judgeResult.model;
      costUsd = judgeResult.cost_usd_reported ?? null;
    } else {
      // Fallback: heuristic-only
      verdictYes = passesHeuristicOnly(pair.excerpt);
      reason = `keyword score=${pair.score} (LLM unavailable)`;
    }

    if (!verdictYes) {
      results.push({ skill: pair.skill, result: 'skip:dup' }); // reuse skip for non-correction
      continue;
    }

    const annotResult = annotateSkillFile(skillPath, pair, sessionId, reason, dryRun);
    results.push({ skill: pair.skill, result: annotResult });

    if (!dryRun && (annotResult === 'appended' || annotResult === 'created+appended')) {
      recordAnnotation(pair.skill, sessionId, exHash, 'yes', reason, model, costUsd);
    }
  }

  logger.info(
    { pairsFound: pairs.length, pairsProcessed: results.length, sessionId: sessionId.slice(0, 8) },
    'skill-annotations: done',
  );

  return { pairsFound: pairs.length, pairsProcessed: results.length, results };
}
