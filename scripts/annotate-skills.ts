#!/usr/bin/env tsx
/**
 * annotate-skills.ts — CLI entry point for S4 (Skill Annotations).
 *
 * Usage:
 *   npx tsx scripts/annotate-skills.ts <transcript.jsonl> [session_id] [--dry-run]
 *
 * Or via npm script:
 *   npm run annotate-skills -- <transcript.jsonl> [session_id] [--dry-run]
 *
 * When no arguments are provided, reads Stop hook JSON from stdin:
 *   echo '{"transcript_path": "...", "session_id": "..."}' | npm run annotate-skills
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// Resolve to src at runtime (tsx handles TS), dist for compiled JS
const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Dynamic import to support both tsx (source) and node (dist)
async function run(): Promise<void> {
  let transcriptPath: string | null = null;
  let sessionId = '';
  let dryRun = false;

  const args = process.argv.slice(2);

  if (args.length > 0 && !args[0]?.startsWith('--')) {
    transcriptPath = path.resolve(args[0]);
    if (args[1] && !args[1].startsWith('--')) {
      sessionId = args[1];
    }
    dryRun = args.includes('--dry-run');
  } else {
    // Stop hook mode: read JSON from stdin
    const raw = fs.readFileSync('/dev/stdin', 'utf-8').trim();
    if (raw) {
      try {
        const payload = JSON.parse(raw) as Record<string, unknown>;
        transcriptPath = (payload['transcript_path'] as string | undefined) ?? null;
        sessionId = (payload['session_id'] as string | undefined) ?? '';
        dryRun = args.includes('--dry-run');
      } catch (err) {
        console.error('annotate-skills: failed to parse stdin JSON:', err);
        process.exit(0); // fail-safe, don't crash the hook
      }
    }
  }

  if (!transcriptPath) {
    console.error('Usage: annotate-skills <transcript.jsonl> [session_id] [--dry-run]');
    process.exit(1);
  }

  if (!fs.existsSync(transcriptPath)) {
    console.error(`annotate-skills: transcript not found: ${transcriptPath}`);
    process.exit(0);
  }

  // Import the annotator module
  const { annotateTranscript } = await import(
    path.join(rootDir, 'src', 'skill-annotations', 'annotator.js')
  );

  const result = await annotateTranscript({
    transcriptPath,
    sessionId,
    dryRun,
  });

  console.log(`skill-annotations: pairs_found=${result.pairsFound} processed=${result.pairsProcessed}${dryRun ? ' (dry-run)' : ''}`);
  for (const r of result.results) {
    console.log(`  ${r.skill}: ${r.result}`);
  }
}

run().catch((err) => {
  console.error('annotate-skills: fatal error:', err);
  process.exit(0); // fail-safe for Stop hook usage
});
