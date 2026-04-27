/**
 * aggregator.ts - Multi-session learning loop aggregator (S2).
 *
 * Scans persisted skill suggestion drafts (SQLite + _pending/ directory)
 * accumulated across MULTIPLE sessions, clusters them by signature similarity
 * (Jaccard over tool-sequence tokens), and emits "consolidated suggestions"
 * when a cluster reaches the threshold.
 *
 * Design decision (no distinct Python source for S2):
 *   The Python learning-loop only has a single-session hook (hook.py / S5).
 *   S2 is implied by the _pending/ directory pattern: drafts accumulate from
 *   multiple Stop hook firings. This aggregator is the TS-native implementation
 *   of the cross-session analysis layer. It reads from the same SQLite DB
 *   written by service.ts (skill_suggestions table) so it shares state with S5
 *   rather than needing a separate DB.
 *
 * Algorithm:
 *   1. Load all "pending" rows from skill_suggestions table (or scan _pending/ files).
 *   2. Parse their signals JSON to reconstruct tool_sequence.
 *   3. Cluster rows pairwise using Jaccard similarity on tool-sequence token sets.
 *   4. When a cluster reaches >= CLUSTER_THRESHOLD members: emit a consolidated
 *      suggestion with merged signals (max counts) and ranked file list.
 *   5. Mark contributing rows as "clustered" in the DB (idempotent).
 *   6. Write consolidated suggestion to _pending/ with a "consolidated-" prefix.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { logger } from '../logger.js';

// -- Config -----------------------------------------------------------------------

/** Minimum cluster size to emit a consolidated suggestion. */
const CLUSTER_THRESHOLD = parseInt(process.env.SKILL_AGGREGATOR_CLUSTER_THRESHOLD ?? '3', 10);

/** Minimum Jaccard similarity to consider two suggestions in the same cluster. */
const JACCARD_MIN = parseFloat(process.env.SKILL_AGGREGATOR_JACCARD_MIN ?? '0.40');

function storeDir(): string {
  return process.env.CLAUDECLAW_STORE_DIR
    ? path.resolve(process.env.CLAUDECLAW_STORE_DIR)
    : path.join(os.homedir(), '.claudeclaw', 'store');
}

function pendingDir(): string {
  const raw = process.env.SKILL_SUGGESTION_OUTPUT_DIR;
  return raw
    ? path.resolve(raw.replace(/^~/, os.homedir()))
    : path.join(os.homedir(), '.claude', 'skills', 'auto-suggested', '_pending');
}

// -- Database (shared with service.ts) -------------------------------------------

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const sd = storeDir();
  fs.mkdirSync(sd, { recursive: true });
  const dbPath = path.join(sd, 'skill-suggestions.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  // Add clustered_at column if it doesn't exist (migration-safe)
  try {
    _db.exec(`ALTER TABLE skill_suggestions ADD COLUMN clustered_at INTEGER DEFAULT NULL`);
  } catch {
    // Column already exists — that's fine
  }
  return _db;
}

export function _resetDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// -- Types -----------------------------------------------------------------------

interface SuggestionRow {
  id: number;
  session_id: string;
  signature: string;
  status: string;
  draft_path: string | null;
  skill_name: string | null;
  signals: string;
  created_at: number;
}

export interface AggregatorCluster {
  /** Cluster ID: sha1 of sorted member signatures. */
  cluster_id: string;
  /** Number of sessions in this cluster. */
  count: number;
  /** Merged signals (max across members). */
  merged_signals: {
    tool_calls: number;
    distinct_files_edited: number;
    distinct_tool_types: number;
    skill_invocations: number;
    user_turns: number;
  };
  /** Union of all tool sequences, sorted by frequency. */
  tool_sequence: string[];
  /** Signature of the most recent member. */
  representative_signature: string;
  /** All session IDs in this cluster. */
  session_ids: string[];
  /** ISO timestamp of the most recent session. */
  most_recent_at: string;
}

export interface AggregateResult {
  totalPending: number;
  clustersFound: number;
  consolidatedWritten: number;
  clusters: AggregatorCluster[];
}

// -- Jaccard similarity ----------------------------------------------------------

/**
 * Compute the Jaccard similarity between two sets of tokens.
 * Returns a value in [0, 1] where 1 = identical sets.
 *
 * Pure function — exported for testing.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersectionSize = 0;
  for (const item of a) {
    if (b.has(item)) intersectionSize++;
  }
  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * Extract a tool-sequence set from a signals JSON string.
 * Falls back to empty set on parse errors.
 *
 * Pure function — exported for testing.
 */
export function signalsToToolSet(signalsJson: string): Set<string> {
  try {
    const parsed = JSON.parse(signalsJson) as Record<string, unknown>;
    const seq = parsed['tool_sequence'];
    if (Array.isArray(seq)) return new Set(seq as string[]);
  } catch {
    // fall through
  }
  return new Set();
}

// -- Clustering (greedy single-linkage) ------------------------------------------

/**
 * Cluster rows by Jaccard similarity on tool-sequence token sets.
 * Uses greedy single-linkage: each row is added to the first existing cluster
 * that has at least one member with similarity >= JACCARD_MIN. Otherwise
 * a new singleton cluster is created.
 *
 * Returns only clusters with >= CLUSTER_THRESHOLD members.
 *
 * Pure function (given stable input) — exported for testing.
 */
export function clusterRows(
  rows: SuggestionRow[],
  jaccardMin = JACCARD_MIN,
  threshold = CLUSTER_THRESHOLD,
): SuggestionRow[][] {
  const tokenSets = rows.map((r) => signalsToToolSet(r.signals));
  const clusters: number[][] = []; // each cluster: array of row indices

  for (let i = 0; i < rows.length; i++) {
    let placed = false;
    for (const cluster of clusters) {
      // Check if any existing member is similar enough.
      const similar = cluster.some(
        (j) => jaccardSimilarity(tokenSets[i]!, tokenSets[j]!) >= jaccardMin,
      );
      if (similar) {
        cluster.push(i);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([i]);
  }

  return clusters
    .filter((c) => c.length >= threshold)
    .map((c) => c.map((idx) => rows[idx]!));
}

// -- Merge cluster into a consolidated suggestion --------------------------------

function mergeCluster(cluster: SuggestionRow[]): AggregatorCluster {
  let maxToolCalls = 0;
  let maxFiles = 0;
  let maxToolTypes = 0;
  let maxSkillInvocations = 0;
  let maxUserTurns = 0;

  const toolFreq = new Map<string, number>();
  const sessionIds: string[] = [];
  let latestTs = 0;
  let repSig = cluster[0]!.signature;

  for (const row of cluster) {
    sessionIds.push(row.session_id);
    if (row.created_at > latestTs) {
      latestTs = row.created_at;
      repSig = row.signature;
    }

    try {
      const parsed = JSON.parse(row.signals) as Record<string, unknown>;
      maxToolCalls = Math.max(maxToolCalls, (parsed['tool_calls'] as number | undefined) ?? 0);
      maxFiles = Math.max(maxFiles, (parsed['distinct_files_edited'] as number | undefined) ?? 0);
      maxToolTypes = Math.max(maxToolTypes, (parsed['distinct_tool_types'] as number | undefined) ?? 0);
      maxSkillInvocations = Math.max(maxSkillInvocations, (parsed['skill_invocations'] as number | undefined) ?? 0);
      maxUserTurns = Math.max(maxUserTurns, (parsed['user_turns'] as number | undefined) ?? 0);

      const seq = parsed['tool_sequence'];
      if (Array.isArray(seq)) {
        for (const t of seq as string[]) {
          toolFreq.set(t, (toolFreq.get(t) ?? 0) + 1);
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  // Sort tools by frequency desc, then alphabetically for stability.
  const toolSequence = [...toolFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t)
    .slice(0, 20);

  const sigInput = cluster
    .map((r) => r.signature)
    .sort()
    .join(',');
  const clusterId = crypto.createHash('sha1').update(sigInput, 'utf8').digest('hex').slice(0, 8);

  return {
    cluster_id: clusterId,
    count: cluster.length,
    merged_signals: {
      tool_calls: maxToolCalls,
      distinct_files_edited: maxFiles,
      distinct_tool_types: maxToolTypes,
      skill_invocations: maxSkillInvocations,
      user_turns: maxUserTurns,
    },
    tool_sequence: toolSequence,
    representative_signature: repSig,
    session_ids: sessionIds,
    most_recent_at: new Date(latestTs * 1000).toISOString(),
  };
}

// -- Consolidated draft rendering ------------------------------------------------

function renderConsolidated(cluster: AggregatorCluster): string {
  const now = new Date().toISOString();
  const { merged_signals: sigs, tool_sequence: seq } = cluster;
  const seqMd = seq.map((n, i) => `${i + 1}. \`${n}\``).join('\n');

  return `---
type: skill-suggestion-consolidated
generated: ${now}
cluster_id: ${cluster.cluster_id}
session_count: ${cluster.count}
most_recent_at: ${cluster.most_recent_at}
representative_signature: ${cluster.representative_signature}
status: pending
---

# Consolidated skill suggestion (${cluster.count} sessions)

> ${cluster.count} sessions matched a similar tool-use pattern. Strong signal for a reusable skill.

## Aggregated signals (max across sessions)
- \`tool_calls\`: ${sigs.tool_calls}
- \`distinct_files_edited\`: ${sigs.distinct_files_edited}
- \`distinct_tool_types\`: ${sigs.distinct_tool_types}
- \`skill_invocations\`: ${sigs.skill_invocations}
- \`user_turns\`: ${sigs.user_turns}

## Contributing sessions (${cluster.count})
${cluster.session_ids.map((s) => `- \`${s.slice(0, 16)}\``).join('\n')}

## Tools used across sessions (frequency-ranked, top 20)
${seqMd}

## What to do

- **If worth a skill:** invoke \`/skill-creator\` using this consolidated context.
  Move result to \`~/.claude/skills/auto-suggested/<slug>/SKILL.md\`
- **If not:** delete this file
`;
}

// -- Main public API -------------------------------------------------------------

/**
 * Load pending suggestion rows from the shared SQLite DB.
 * Only loads rows that have not yet been clustered.
 */
function loadPendingRows(): SuggestionRow[] {
  try {
    return getDb()
      .prepare(
        `SELECT id, session_id, signature, status, draft_path, skill_name, signals, created_at
         FROM skill_suggestions
         WHERE status = 'pending' AND clustered_at IS NULL
         ORDER BY created_at ASC`,
      )
      .all() as SuggestionRow[];
  } catch {
    return [];
  }
}

function markClustered(ids: number[]): void {
  if (ids.length === 0) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    const placeholders = ids.map(() => '?').join(',');
    getDb()
      .prepare(`UPDATE skill_suggestions SET clustered_at = ? WHERE id IN (${placeholders})`)
      .run(now, ...ids);
  } catch (err) {
    logger.warn({ err }, 'aggregator: failed to mark rows as clustered (non-fatal)');
  }
}

function isAlreadyConsolidated(clusterId: string): boolean {
  const dir = pendingDir();
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => f.includes(`consolidated-${clusterId}`));
}

/**
 * Run the full aggregation pipeline:
 *   1. Load pending suggestion rows
 *   2. Cluster by Jaccard similarity
 *   3. Emit consolidated drafts for clusters >= CLUSTER_THRESHOLD
 *   4. Mark contributing rows as clustered (idempotent)
 */
export function aggregateSuggestions(): AggregateResult {
  const rows = loadPendingRows();

  if (rows.length < CLUSTER_THRESHOLD) {
    logger.debug(
      { count: rows.length, threshold: CLUSTER_THRESHOLD },
      'aggregator: not enough pending suggestions to cluster',
    );
    return { totalPending: rows.length, clustersFound: 0, consolidatedWritten: 0, clusters: [] };
  }

  const rawClusters = clusterRows(rows);
  if (rawClusters.length === 0) {
    logger.debug({ totalPending: rows.length }, 'aggregator: no clusters met threshold');
    return { totalPending: rows.length, clustersFound: 0, consolidatedWritten: 0, clusters: [] };
  }

  const mergedClusters = rawClusters.map(mergeCluster);
  let written = 0;

  const outDir = pendingDir();
  fs.mkdirSync(outDir, { recursive: true });

  for (const cluster of mergedClusters) {
    if (isAlreadyConsolidated(cluster.cluster_id)) {
      logger.debug({ clusterId: cluster.cluster_id }, 'aggregator: cluster already consolidated');
      continue;
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outPath = path.join(outDir, `SUGGESTION-consolidated-${ts}-${cluster.cluster_id}.md`);
    fs.writeFileSync(outPath, renderConsolidated(cluster), 'utf-8');

    const memberIds = rawClusters
      .find((c) => c.some((r) => r.signature === cluster.representative_signature))
      ?.map((r) => r.id) ?? [];
    markClustered(memberIds);

    logger.info(
      { file: path.basename(outPath), count: cluster.count, clusterId: cluster.cluster_id },
      'aggregator: wrote consolidated suggestion',
    );
    written++;
  }

  return {
    totalPending: rows.length,
    clustersFound: mergedClusters.length,
    consolidatedWritten: written,
    clusters: mergedClusters,
  };
}
