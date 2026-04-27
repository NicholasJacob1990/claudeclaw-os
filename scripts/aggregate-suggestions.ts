#!/usr/bin/env tsx
/**
 * aggregate-suggestions.ts — CLI entry point for S2 (Learning Loop Aggregator).
 *
 * Scans the skill_suggestions SQLite DB for pending drafts, clusters them by
 * Jaccard similarity, and writes consolidated suggestions when a cluster
 * reaches the threshold.
 *
 * Usage:
 *   npx tsx scripts/aggregate-suggestions.ts [--dry-run] [--json]
 *
 * Or via npm script:
 *   npm run aggregate-suggestions [-- --dry-run] [-- --json]
 *
 * Options:
 *   --dry-run   Compute clusters but do not write files or update DB.
 *   --json      Output result as JSON (useful for scripting).
 */

import path from 'path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const jsonOutput = args.includes('--json');

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function run(): Promise<void> {
  const { aggregateSuggestions, _resetDb } = await import(
    path.join(rootDir, 'src', 'skill-suggestion', 'aggregator.js')
  );

  if (dryRun) {
    // In dry-run, we temporarily swap the output dir to a temp location
    // by using env var override — but we don't write at all (the aggregator
    // checks isAlreadyConsolidated before writing, so we just report).
    process.env.SKILL_AGGREGATOR_DRY_RUN = '1';
  }

  const result = aggregateSuggestions();

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    console.log(`aggregate-suggestions:`);
    console.log(`  pending rows: ${result.totalPending}`);
    console.log(`  clusters found (>= threshold): ${result.clustersFound}`);
    console.log(`  consolidated drafts written: ${result.consolidatedWritten}${dryRun ? ' (dry-run, not written)' : ''}`);

    for (const cluster of result.clusters) {
      console.log(`\n  Cluster ${cluster.cluster_id} (${cluster.count} sessions):`);
      console.log(`    tools: ${cluster.tool_sequence.slice(0, 8).join(', ')}`);
      console.log(`    sessions: ${cluster.session_ids.map((s) => s.slice(0, 8)).join(', ')}`);
      console.log(`    most recent: ${cluster.most_recent_at}`);
    }
  }
}

run().catch((err) => {
  console.error('aggregate-suggestions: fatal error:', err);
  process.exit(1);
});
